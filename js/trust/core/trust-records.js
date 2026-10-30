/**
 * The Trust Center's records (#20, "Records"): receipts, incidents, remediation runs, and the
 * diagnostic journal in NewTabNoteTrust, through a trust store (ports.js), with every bound
 * the scope sets applied in the same transaction as the write that could pass it.
 *
 * - A receipt is stored with `transition` set when its status differs from the provider's
 *   receipt before it. Each provider keeps its latest receipt and its 20 newest transitions.
 * - An incident is keyed by provider, fault, and subject, so a repeat updates the one record:
 *   one more occurrence, a later lastSeenAt, the worse severity while it's open, and the
 *   dismissed flag cleared. A resolved incident that comes back reopens. Open incidents,
 *   dismissed included, always stay; resolved ones stay 90 days, 200 at most.
 * - Runs keep the newest 200, and any still running.
 * - The journal keeps 2,000 events, none older than 14 days.
 *
 * When NewTabNoteTrust won't open, or a write to it fails, the records fall back to memory:
 * incidents by key, the latest receipt per provider, runs, and journal events, each bounded.
 * The latest storage incident (capture or storage) also goes to chrome.storage.local, through
 * the settings port, under `trust.lastStorageIncident`, so it outlives the context. The next
 * open that succeeds reconciles all of it into the database and clears the key. Reconciling
 * twice adds nothing, since an incident already stored as late as the copy is left alone.
 *
 * A random `trust.installId` is written to the settings area once, under a Web Lock when the
 * host has them, and stamps every receipt.
 *
 * Every record is checked against its schema (records.js) before it's written, so nothing
 * outside the evidence allowlist reaches a store or the fallback.
 */

import * as v from '../../lib/valibot/index.mjs';
import { UnavailableError } from '../../kernel/core/contracts/outcomes.js';
import { checkEvidence, isCodeList, opaqueId } from './evidence.js';
import { SETTINGS_KEYS } from './ports.js';
import {
  BOUNDS,
  incidentKey,
  incidentSchema,
  journalEventSchema,
  receiptSchema,
  refOf,
  runSchema,
  worseSeverity,
} from './records.js';
import { FINISHED_RUN_STATES, SEVERITIES, STORAGE_PROVIDERS } from './vocabulary.js';

/** @typedef {import('./ports.js').TrustStore} TrustStore */
/** @typedef {import('./ports.js').TrustTx} TrustTx */
/** @typedef {import('./ports.js').SettingsPort} SettingsPort */
/** @typedef {import('./ports.js').Locks} Locks */
/** @typedef {import('./ports.js').Clock} Clock */
/** @typedef {import('./ports.js').Ids} Ids */
/** @typedef {import('./records.js').HealthReceipt} HealthReceipt */
/** @typedef {import('./records.js').Incident} Incident */
/** @typedef {import('./records.js').RemediationRun} RemediationRun */
/** @typedef {import('./records.js').JournalEvent} JournalEvent */
/** @typedef {import('./vocabulary.js').Severity} Severity */

/** How much the memory fallback holds of each kind */
export const FALLBACK_LIMITS = Object.freeze({ incidents: 50, receipts: 64, runs: 50, events: 200 });

/** The journal event schema without the seq the store assigns */
const newEventSchema = v.omit(journalEventSchema, ['seq']);

/**
 * An incident as recovery.raise and the journal raise it
 * @typedef {object} RaiseInput
 * @property {string} providerId
 * @property {string} faultCode
 * @property {string | null} [subjectId]
 * @property {Severity} severity
 * @property {readonly string[]} [affected]
 * @property {readonly string[]} [preserved]
 * @property {Readonly<Record<string, unknown>>} [evidence]
 */

/**
 * A receipt as a check produced it, before it's stamped and stored
 * @typedef {Omit<HealthReceipt, 'id' | 'installId' | 'transition'>} ReceiptInput
 */

/**
 * @typedef {'closed' | 'open' | 'fallback'} RecordsState
 */

/**
 * @template T
 * @param {T} value
 * @returns {T}
 */
const copy = value => JSON.parse(JSON.stringify(value));

/**
 * The code of an error a store threw, never its message
 * @param {unknown} error
 */
const codeOf = error => (error instanceof UnavailableError ? error.code : 'adapter-failed');

/**
 * @param {unknown} error
 * @returns {import('../../kernel/core/contracts/outcomes.js').UnavailableCause}
 */
const causeOf = error => (error instanceof UnavailableError ? error.unavailableCause : 'adapter');

/**
 * Orders by a numeric field, then by id, oldest first
 * @param {string} field
 */
const byTime = field => (/** @type {any} */ a, /** @type {any} */ b) => a[field] - b[field] || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/**
 * @param {{
 *   store: TrustStore,
 *   settings: SettingsPort,
 *   clock: Clock,
 *   ids: Ids,
 *   locks?: Locks | null,
 * }} options
 */
export function createTrustRecords({ store, settings, clock, ids, locks = null }) {
  /** @type {RecordsState} */
  let state = 'closed';
  /** @type {string | null} */
  let failureCode = null;
  /** @type {Map<string, Incident>} */
  const pendingIncidents = new Map();
  /** @type {Map<string, HealthReceipt>} */
  const pendingReceipts = new Map();
  /** @type {Map<string, RemediationRun>} */
  const pendingRuns = new Map();
  /** @type {Omit<JournalEvent, 'seq'>[]} */
  const pendingEvents = [];
  /** @type {Promise<string> | null} */
  let installing = null;

  // ============ The memory fallback ============

  /**
   * Keeps `map` to `limit` entries, dropping the oldest by `field`
   * @template {Record<string, any>} R
   * @param {Map<string, R>} map
   * @param {number} limit
   * @param {string} field
   */
  const trim = (map, limit, field) => {
    while (map.size > limit) {
      const [oldest] = [...map.entries()].sort(([, a], [, b]) => a[field] - b[field]);
      map.delete(oldest[0]);
    }
  };

  /**
   * @param {Omit<JournalEvent, 'seq'>} event
   */
  const holdEvent = event => {
    pendingEvents.push(event);
    if (pendingEvents.length > FALLBACK_LIMITS.events) pendingEvents.splice(0, pendingEvents.length - FALLBACK_LIMITS.events);
  };

  /**
   * Falls back to memory after `error`, which a store threw, and journals it once
   * @param {unknown} error
   */
  const fallBack = error => {
    if (state !== 'fallback') {
      failureCode = codeOf(error);
      holdEvent({ at: clock.now(), code: 'trust.storage-fallback', fields: { cause: causeOf(error), errorCode: failureCode } });
    }
    state = 'fallback';
  };

  /**
   * Holds `incident` in memory, and in the settings area when it's a storage incident
   * @param {Incident} incident
   */
  const holdIncident = async incident => {
    pendingIncidents.set(incident.key, incident);
    trim(pendingIncidents, FALLBACK_LIMITS.incidents, 'lastSeenAt');
    if (!(/** @type {readonly string[]} */ (STORAGE_PROVIDERS).includes(incident.providerId))) return;
    try {
      await settings.set({ [SETTINGS_KEYS.lastStorageIncident]: incident });
    } catch {
      // Memory still holds it
    }
  };

  /** The storage incident the settings area holds, when it's a valid one */
  const storedFallbackIncident = async () => {
    try {
      const stored = (await settings.get([SETTINGS_KEYS.lastStorageIncident]))[SETTINGS_KEYS.lastStorageIncident];
      return v.is(incidentSchema, stored) ? /** @type {Incident} */ (stored) : null;
    } catch {
      return null;
    }
  };

  /**
   * Runs `unit` on the store, or answers null after falling back when the store can't
   * @template T
   * @param {readonly import('./ports.js').TrustStoreName[]} stores
   * @param {'readonly' | 'readwrite'} mode
   * @param {(tx: TrustTx) => Promise<T>} unit
   * @returns {Promise<{ok: true, value: T} | {ok: false}>}
   */
  const attempt = async (stores, mode, unit) => {
    if (state !== 'open') return { ok: false };
    try {
      return { ok: true, value: await store.run(stores, mode, unit) };
    } catch (error) {
      if (!(error instanceof UnavailableError)) throw error;
      fallBack(error);
      return { ok: false };
    }
  };

  // ============ Bounds, each inside the write that could pass it ============

  /**
   * @param {TrustTx} tx
   * @param {string} providerId
   */
  const pruneReceipts = async (tx, providerId) => {
    const all = /** @type {HealthReceipt[]} */ (await tx.getAllByIndex('receipts', 'providerId', providerId)).sort(
      byTime('verifiedAt'),
    );
    const latest = all[all.length - 1];
    const transitions = all.filter(receipt => receipt.transition).slice(-BOUNDS.receiptTransitions);
    const keep = new Set([latest && latest.id, ...transitions.map(receipt => receipt.id)]);
    for (const receipt of all) if (!keep.has(receipt.id)) tx.delete('receipts', receipt.id);
  };

  /**
   * @param {TrustTx} tx
   */
  const pruneIncidents = async tx => {
    const resolved = /** @type {Incident[]} */ (await tx.getAllByIndex('incidents', 'state', 'resolved'));
    const cutoff = clock.now() - BOUNDS.resolvedIncidentAgeMs;
    const newestFirst = resolved.sort((a, b) => (b.resolvedAt ?? 0) - (a.resolvedAt ?? 0) || (a.id < b.id ? -1 : 1));
    newestFirst.forEach((incident, index) => {
      if (index >= BOUNDS.resolvedIncidents || (incident.resolvedAt ?? 0) < cutoff) tx.delete('incidents', incident.id);
    });
  };

  /**
   * @param {TrustTx} tx
   */
  const pruneRuns = async tx => {
    const all = /** @type {RemediationRun[]} */ (await tx.getAll('runs'));
    if (all.length <= BOUNDS.runs) return;
    const finished = all
      .filter(run => /** @type {readonly string[]} */ (FINISHED_RUN_STATES).includes(run.state))
      .sort(byTime('startedAt'));
    let over = all.length - BOUNDS.runs;
    for (const run of finished) {
      if (over-- <= 0) break;
      tx.delete('runs', run.id);
    }
  };

  /**
   * @param {TrustTx} tx
   */
  const pruneJournal = async tx => {
    for (const seq of await tx.keys('journal', { index: 'at', below: clock.now() - BOUNDS.journalAgeMs })) {
      tx.delete('journal', seq);
    }
    const count = await tx.count('journal');
    if (count > BOUNDS.journalEvents) {
      for (const seq of await tx.keys('journal', { limit: count - BOUNDS.journalEvents })) tx.delete('journal', seq);
    }
  };

  // ============ Writes ============

  /**
   * The incident `input` makes on top of `existing`, at `at`
   * @param {Incident | undefined} existing
   * @param {RaiseInput} input
   * @param {Readonly<Record<string, unknown>>} evidence
   * @param {number} at
   * @returns {Incident}
   */
  const merged = (existing, input, evidence, at) => {
    const key = incidentKey(input.providerId, input.faultCode, input.subjectId);
    const affected = [...(input.affected || [])];
    const preserved = [...(input.preserved || [])];
    if (!existing) {
      const id = ids.next();
      return {
        id,
        ref: refOf(id),
        key,
        providerId: input.providerId,
        faultCode: input.faultCode,
        subjectId: input.subjectId ?? null,
        severity: input.severity,
        state: 'open',
        dismissed: false,
        firstSeenAt: at,
        lastSeenAt: at,
        resolvedAt: null,
        occurrences: 1,
        affected,
        preserved,
        evidence: /** @type {Incident['evidence']} */ (evidence),
      };
    }
    const reopened = existing.state === 'resolved';
    return {
      ...existing,
      severity: reopened ? input.severity : worseSeverity(existing.severity, input.severity),
      state: reopened ? 'open' : existing.state,
      dismissed: false,
      lastSeenAt: Math.max(existing.lastSeenAt, at),
      resolvedAt: null,
      occurrences: existing.occurrences + 1,
      affected,
      preserved,
      evidence: /** @type {Incident['evidence']} */ (evidence),
    };
  };

  /**
   * Checks what recovery.raise and the journal pass in, so nothing outside the allowlist is
   * stored. Throws a TypeError naming only the field's rule.
   * @param {RaiseInput} input
   */
  const checkRaise = input => {
    if (!v.is(opaqueId, input.providerId)) throw new TypeError('recovery.raise: providerId must be an opaque id');
    if (input.subjectId != null && !v.is(opaqueId, input.subjectId)) {
      throw new TypeError('recovery.raise: subjectId must be an opaque id');
    }
    if (!(/** @type {readonly string[]} */ (SEVERITIES).includes(input.severity))) {
      throw new TypeError('recovery.raise: severity must be one of the severities');
    }
    for (const list of [input.affected, input.preserved]) {
      if (list !== undefined && !isCodeList(list)) throw new TypeError('recovery.raise: capabilities must be codes');
    }
    const evidence = checkEvidence(input.evidence);
    if (!evidence.ok) {
      const { reason } = /** @type {import('./evidence.js').RefusedEvidence} */ (evidence);
      throw new TypeError(`recovery.raise: evidence refused (${reason})`);
    }
    return evidence.value;
  };

  /**
   * Raises an incident, or updates the one with its key
   * @param {RaiseInput} input
   * @returns {Promise<{incident: Incident, created: boolean, held: boolean}>}
   */
  const raise = async input => {
    const evidence = checkRaise(input);
    const at = clock.now();
    const key = incidentKey(input.providerId, input.faultCode, input.subjectId);
    const stored = await attempt(['incidents'], 'readwrite', async tx => {
      const [existing] = /** @type {Incident[]} */ (await tx.getAllByIndex('incidents', 'key', key));
      const incident = v.parse(incidentSchema, merged(existing, input, evidence, at));
      tx.put('incidents', incident);
      await pruneIncidents(tx);
      return { incident, created: !existing };
    });
    if (stored.ok) return { ...stored.value, held: false };
    const incident = v.parse(incidentSchema, merged(pendingIncidents.get(key), input, evidence, at));
    await holdIncident(incident);
    return { incident, created: incident.occurrences === 1, held: true };
  };

  /**
   * Resolves the provider's open incidents whose key isn't in `still`, after a check of it
   * passed. Answers the ones it resolved.
   * @param {string} providerId
   * @param {readonly string[]} still - keys of the faults the check still reports
   * @returns {Promise<Incident[]>}
   */
  const resolve = async (providerId, still) => {
    const at = clock.now();
    /** @param {Incident} incident @returns {Incident} */
    const resolved = incident => ({ ...incident, state: 'resolved', resolvedAt: at, dismissed: false });
    const stored = await attempt(['incidents'], 'readwrite', async tx => {
      const open = [
        ...(/** @type {Incident[]} */ (await tx.getAllByIndex('incidents', 'state', 'open'))),
        ...(/** @type {Incident[]} */ (await tx.getAllByIndex('incidents', 'state', 'remediating'))),
      ].filter(incident => incident.providerId === providerId && !still.includes(incident.key));
      const done = open.map(resolved);
      for (const incident of done) tx.put('incidents', incident);
      await pruneIncidents(tx);
      return done;
    });
    if (stored.ok) return stored.value;
    const done = [...pendingIncidents.values()]
      .filter(incident => incident.providerId === providerId && incident.state !== 'resolved' && !still.includes(incident.key))
      .map(resolved);
    for (const incident of done) pendingIncidents.set(incident.key, incident);
    return done;
  };

  /**
   * Sets or clears an open incident's dismissed flag. A resolved one is left as it is.
   * @param {string} id
   * @param {boolean} dismissed
   * @returns {Promise<Incident | null>}
   */
  const dismiss = async (id, dismissed) => {
    const stored = await attempt(['incidents'], 'readwrite', async tx => {
      const incident = /** @type {Incident | undefined} */ (await tx.get('incidents', id));
      if (!incident || incident.state === 'resolved') return null;
      const next = { ...incident, dismissed };
      tx.put('incidents', next);
      return next;
    });
    if (stored.ok) return stored.value;
    const held = [...pendingIncidents.values()].find(incident => incident.id === id);
    if (!held || held.state === 'resolved') return null;
    const next = { ...held, dismissed };
    pendingIncidents.set(next.key, next);
    return next;
  };

  /** The random id that stamps receipts, written once */
  const installId = () => {
    if (installing) return installing;
    const read = async () => {
      const key = SETTINGS_KEYS.installId;
      const stored = (await settings.get([key]))[key];
      if (v.is(opaqueId, stored)) return /** @type {string} */ (stored);
      const id = ids.next();
      await settings.set({ [key]: id });
      return id;
    };
    installing = (locks ? locks.request('trust.installId', read) : read()).catch(error => {
      installing = null;
      throw error;
    });
    return installing;
  };

  /**
   * Stores a receipt, stamped with the install id
   * @param {ReceiptInput} input
   * @returns {Promise<HealthReceipt>}
   */
  const record = async input => {
    const stamped = { ...input, id: ids.next(), installId: await installId(), transition: true };
    v.parse(receiptSchema, stamped);
    const stored = await attempt(['receipts'], 'readwrite', async tx => {
      const all = /** @type {HealthReceipt[]} */ (await tx.getAllByIndex('receipts', 'providerId', input.providerId)).sort(
        byTime('verifiedAt'),
      );
      const before = all[all.length - 1];
      const receipt = { ...stamped, transition: !before || before.status !== input.status };
      tx.put('receipts', receipt);
      await pruneReceipts(tx, input.providerId);
      return receipt;
    });
    if (stored.ok) return stored.value;
    const before = pendingReceipts.get(input.providerId);
    const receipt = { ...stamped, transition: !before || before.status !== input.status };
    pendingReceipts.set(input.providerId, receipt);
    trim(pendingReceipts, FALLBACK_LIMITS.receipts, 'verifiedAt');
    return receipt;
  };

  /**
   * Stores a remediation run, or its next state
   * @param {RemediationRun} run
   * @returns {Promise<RemediationRun>}
   */
  const putRun = async run => {
    const checked = v.parse(runSchema, run);
    const stored = await attempt(['runs'], 'readwrite', async tx => {
      tx.put('runs', checked);
      await pruneRuns(tx);
      return checked;
    });
    if (stored.ok) return stored.value;
    pendingRuns.set(checked.id, checked);
    trim(pendingRuns, FALLBACK_LIMITS.runs, 'startedAt');
    return checked;
  };

  /**
   * Appends a journal event the journal already checked
   * @param {Omit<JournalEvent, 'seq'>} event
   * @returns {Promise<void>}
   */
  const append = async event => {
    const checked = /** @type {Omit<JournalEvent, 'seq'>} */ (v.parse(newEventSchema, event));
    const stored = await attempt(['journal'], 'readwrite', async tx => {
      await tx.append('journal', checked);
      await pruneJournal(tx);
    });
    if (!stored.ok) holdEvent(checked);
  };

  // ============ Opening and reconciling ============

  /** Writes what the fallback holds into the store, and clears it */
  const reconcile = async () => {
    const fromSettings = await storedFallbackIncident();
    const incidents = [...pendingIncidents.values()];
    if (fromSettings && !incidents.some(incident => incident.key === fromSettings.key)) incidents.push(fromSettings);
    let count = 0;
    const done = await attempt(['incidents', 'receipts', 'runs', 'journal'], 'readwrite', async tx => {
      for (const held of incidents) {
        const [existing] = /** @type {Incident[]} */ (await tx.getAllByIndex('incidents', 'key', held.key));
        // Already reconciled, or the store saw it as late
        if (existing && existing.lastSeenAt >= held.lastSeenAt) continue;
        const next = existing
          ? {
              ...existing,
              severity: existing.state === 'resolved' ? held.severity : worseSeverity(existing.severity, held.severity),
              state: held.state === 'resolved' ? existing.state : 'open',
              resolvedAt: held.state === 'resolved' ? existing.resolvedAt : null,
              dismissed: false,
              lastSeenAt: held.lastSeenAt,
              occurrences: existing.occurrences + held.occurrences,
              affected: held.affected,
              preserved: held.preserved,
              evidence: held.evidence,
            }
          : held;
        tx.put('incidents', v.parse(incidentSchema, next));
        count++;
      }
      await pruneIncidents(tx);
      for (const receipt of pendingReceipts.values()) {
        const all = /** @type {HealthReceipt[]} */ (await tx.getAllByIndex('receipts', 'providerId', receipt.providerId)).sort(
          byTime('verifiedAt'),
        );
        const before = all[all.length - 1];
        tx.put('receipts', { ...receipt, transition: !before || before.status !== receipt.status });
        await pruneReceipts(tx, receipt.providerId);
      }
      for (const run of pendingRuns.values()) tx.put('runs', run);
      await pruneRuns(tx);
      const held = pendingEvents.length + (count > 0 ? 1 : 0);
      for (const event of pendingEvents) await tx.append('journal', event);
      if (count > 0) await tx.append('journal', { at: clock.now(), code: 'trust.reconciled', fields: { count } });
      await pruneJournal(tx);
      return held;
    });
    if (!done.ok) return;
    pendingIncidents.clear();
    pendingReceipts.clear();
    pendingRuns.clear();
    pendingEvents.length = 0;
    if (fromSettings) {
      try {
        await settings.set({ [SETTINGS_KEYS.lastStorageIncident]: null });
      } catch {
        // The next open finds it already reconciled
      }
    }
  };

  /**
   * Opens NewTabNoteTrust and reconciles what a fallback held. When it won't open, the
   * records fall back to memory and the settings area, and the incident the settings area
   * held is read back so this context still reports it.
   * @returns {Promise<{ok: true} | {ok: false, code: string}>}
   */
  const open = async () => {
    try {
      await store.open();
    } catch (error) {
      fallBack(error);
      const held = await storedFallbackIncident();
      if (held && !pendingIncidents.has(held.key)) pendingIncidents.set(held.key, held);
      return { ok: false, code: /** @type {string} */ (failureCode) };
    }
    state = 'open';
    failureCode = null;
    await reconcile();
    return { ok: true };
  };

  // ============ Reads ============

  /** @returns {Promise<HealthReceipt[]>} every stored receipt, oldest first */
  const receipts = async () => {
    const stored = await attempt(['receipts'], 'readonly', tx => tx.getAll('receipts'));
    return copy(stored.ok ? stored.value : [...pendingReceipts.values()]).sort(byTime('verifiedAt'));
  };

  /** @returns {Promise<HealthReceipt[]>} each provider's latest receipt */
  const latestReceipts = async () => {
    /** @type {Map<string, HealthReceipt>} */
    const latest = new Map();
    for (const receipt of await receipts()) latest.set(receipt.providerId, receipt);
    return [...latest.values()];
  };

  /** @returns {Promise<Incident[]>} every incident, oldest first */
  const incidents = async () => {
    const stored = await attempt(['incidents'], 'readonly', tx => tx.getAll('incidents'));
    return copy(stored.ok ? stored.value : [...pendingIncidents.values()]).sort(byTime('firstSeenAt'));
  };

  /** @returns {Promise<RemediationRun[]>} every run, oldest first */
  const runs = async () => {
    const stored = await attempt(['runs'], 'readonly', tx => tx.getAll('runs'));
    return copy(stored.ok ? stored.value : [...pendingRuns.values()]).sort(byTime('startedAt'));
  };

  /** @returns {Promise<JournalEvent[]>} every journal event, oldest first */
  const events = async () => {
    const stored = await attempt(['journal'], 'readonly', tx => tx.getAll('journal'));
    if (stored.ok) return copy(stored.value);
    return pendingEvents.map((event, index) => ({ ...copy(event), seq: index + 1 }));
  };

  return Object.freeze({
    open,
    installId,
    record,
    raise,
    resolve,
    dismiss,
    putRun,
    append,
    receipts,
    latestReceipts,
    incidents,
    runs,
    events,
    /** @returns {RecordsState} */
    state: () => state,
    /** @returns {string | null} why NewTabNoteTrust isn't open, as a code */
    failureCode: () => failureCode,
  });
}

/** @typedef {ReturnType<typeof createTrustRecords>} TrustRecords */
