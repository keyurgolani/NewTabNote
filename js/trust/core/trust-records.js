/**
 * The Trust Center's records (#20, "Records"): receipts, incidents, remediation runs, and the
 * diagnostic journal in NewTabNoteTrust, through a trust store (ports.js), with every bound
 * the scope sets applied in the same transaction as the write that could pass it.
 *
 * - A receipt is stored with `transition` set when its status differs from the provider's
 *   receipt before it. Each provider keeps its latest receipt and its 20 newest transitions.
 * - An incident is keyed by provider, fault, and subject, so a repeat updates the one record:
 *   one more occurrence, a later lastSeenAt, the worse severity while it's open, and the
 *   dismissed flag cleared. A resolved incident that comes back reopens, and one a remediation
 *   is working on stays `remediating`. Open incidents, dismissed included, always stay;
 *   resolved ones stay 90 days, 200 at most.
 * - Runs keep the newest 200, and any still running.
 * - The journal keeps 2,000 events, none older than 14 days.
 * Reads apply the age bounds too, so a quiet month with no write shows nothing past them, and
 * opening prunes the store.
 *
 * When NewTabNoteTrust won't open, or a write to it fails, the records are in `fallback`:
 * - What the write would have stored is held in memory: incidents by key, each with the
 *   occurrences added since it was last reconciled, the latest receipt per provider, runs, and
 *   journal events. Each is bounded. Resolved incidents and finished runs go first, and an open
 *   incident or a running run that still has to go is counted (`dropped()`) and journaled.
 * - Reads still go to the store whenever it answers, with what memory holds laid over it, so
 *   one failed write never hides what NewTabNoteTrust already holds.
 * - Every later write tries the store again (a store that never opened is retried at most
 *   every 30 seconds), and the first that succeeds reconciles what memory holds and leaves
 *   `fallback`.
 * - The latest storage incident (capture or storage) also goes to chrome.storage.local, under
 *   `trust.lastStorageIncident`, with the occurrences it adds, so it outlives the context.
 *   Each occurrence is counted in one place: the copy, or, when the copy can't be written or a
 *   newer storage incident replaces it, this context's memory. Whichever context next opens
 *   NewTabNoteTrust takes the copy under Web Lock `trust.lastStorageIncident` (the lock a
 *   context holding a copy takes too) by clearing it, then reconciles it once. A clear that
 *   fails leaves the copy for later, and a reconcile that fails puts it back.
 *
 * A random `trust.installId` is written to the settings area once, under a Web Lock when the
 * host has them, and stamps every receipt.
 *
 * Every record is checked against its schema (records.js) before it's written, so nothing
 * outside the evidence allowlist reaches a store, the settings area, or memory.
 */

import * as v from '../../lib/valibot/index.mjs';
import { count } from '../../kernel/core/contracts/fields.js';
import { UnavailableError } from '../../kernel/core/contracts/outcomes.js';
import { capability, checkEvidence, contributionId, faultCode, recordId, subjectId } from './evidence.js';
import { SETTINGS_KEYS } from './ports.js';
import {
  BOUNDS,
  incidentKey,
  incidentSchema,
  journalEventSchema,
  parseRecord,
  receiptSchema,
  refOf,
  runSchema,
  worseSeverity,
} from './records.js';
import { FINISHED_RUN_STATES, SEVERITIES, STORAGE_PROVIDERS } from './vocabulary.js';

/** @typedef {import('./ports.js').TrustStore} TrustStore */
/** @typedef {import('./ports.js').TrustStoreName} TrustStoreName */
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

/** How long a context whose store never opened waits before a write tries to open it again */
export const RETRY_OPEN_MS = 30_000;

/** The Web Lock a context holds while it writes or takes the settings copy */
const COPY_LOCK = 'trust.lastStorageIncident';

/** The journal event schema without the seq the store assigns */
const newEventSchema = v.omit(journalEventSchema, ['seq']);

/**
 * The settings copy of the latest storage incident: the incident as it was last seen, the
 * occurrences it holds that no store has counted, and a token that names this copy
 */
export const storageCopySchema = v.strictObject({
  incident: incidentSchema,
  added: v.pipe(count, v.minValue(1)),
  token: recordId,
});

/** @typedef {v.InferOutput<typeof storageCopySchema>} StorageCopy */

/**
 * An incident memory holds: what it should look like, and the occurrences it adds to the
 * stored record that no store or copy has counted yet
 * @typedef {{incident: Incident, added: number}} HeldIncident
 */

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

/** @typedef {'closed' | 'open' | 'fallback'} RecordsState */

/** What the memory fallback had to drop that it would have kept: open incidents, running runs, and events */
/** @typedef {{incidents: number, runs: number, events: number}} Dropped */

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
const byTime =
  field =>
  (/** @type {any} */ a, /** @type {any} */ b) =>
    a[field] - b[field] || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/**
 * The incident `held` makes of the stored record `stored`, adding `added` occurrences: the
 * stored record's id, ref, and first sighting, and from what's held its latest sighting,
 * severity, capabilities, evidence, and dismissed flag. A resolution held here resolves it
 * unless the store saw the fault again later. A remediating incident stays remediating.
 * @param {Incident | undefined} stored
 * @param {Incident} held
 * @param {number} added
 * @returns {Incident}
 */
export function combine(stored, held, added) {
  const occurrences = Math.max(1, (stored ? stored.occurrences : 0) + added);
  if (!stored) return { ...held, occurrences };
  if (held.state === 'resolved') {
    if (stored.state !== 'resolved' && stored.lastSeenAt > held.lastSeenAt) return { ...stored, occurrences };
    return { ...stored, state: 'resolved', resolvedAt: held.resolvedAt, dismissed: false, occurrences };
  }
  if (added === 0) {
    // Nothing new happened: only a dismissal, or the fields of a sighting another copy counts
    return stored.state === 'resolved' ? { ...stored } : { ...stored, dismissed: held.dismissed };
  }
  const reopened = stored.state === 'resolved';
  return {
    ...stored,
    severity: reopened ? held.severity : worseSeverity(stored.severity, held.severity),
    state: stored.state === 'remediating' ? 'remediating' : 'open',
    resolvedAt: null,
    dismissed: held.dismissed,
    firstSeenAt: Math.min(stored.firstSeenAt, held.firstSeenAt),
    lastSeenAt: Math.max(stored.lastSeenAt, held.lastSeenAt),
    occurrences,
    affected: held.affected,
    preserved: held.preserved,
    evidence: held.evidence,
  };
}

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
  /** Whether the store opened in this context */
  let opened = false;
  /** When this context last tried to open a store that never opened */
  let triedOpenAt = Number.NEGATIVE_INFINITY;
  /** @type {string | null} */
  let failureCode = null;
  /** Read through a call, so a check after an await sees what the await changed */
  const currentFailure = () => failureCode;
  /** @type {Map<string, HeldIncident>} */
  const heldIncidents = new Map();
  /** @type {Map<string, HealthReceipt>} */
  const heldReceipts = new Map();
  /** @type {Map<string, RemediationRun>} */
  const heldRuns = new Map();
  /** @type {Omit<JournalEvent, 'seq'>[]} */
  const heldEvents = [];
  /** @type {Dropped} */
  const dropped = { incidents: 0, runs: 0, events: 0 };
  /** @type {Promise<string> | null} */
  let installing = null;
  /** @type {Promise<unknown>} */
  let reconciling = Promise.resolve();

  // ============ The memory fallback ============

  /** @param {Omit<JournalEvent, 'seq'>} event */
  const holdEvent = event => {
    heldEvents.push(event);
    if (heldEvents.length > FALLBACK_LIMITS.events) {
      dropped.events += heldEvents.length - FALLBACK_LIMITS.events;
      heldEvents.splice(0, heldEvents.length - FALLBACK_LIMITS.events);
    }
  };

  /** Keeps held incidents within their limit: resolved ones go first, then the oldest open one, counted */
  const trimIncidents = () => {
    while (heldIncidents.size > FALLBACK_LIMITS.incidents) {
      const entries = [...heldIncidents.values()];
      const resolved = entries.filter(entry => entry.incident.state === 'resolved');
      const pool = resolved.length > 0 ? resolved : entries;
      const [victim] = pool.sort((a, b) => a.incident.lastSeenAt - b.incident.lastSeenAt);
      heldIncidents.delete(victim.incident.key);
      if (resolved.length === 0) {
        dropped.incidents++;
        holdEvent({ at: clock.now(), code: 'trust.fallback-dropped', fields: { count: dropped.incidents, state: 'open' } });
      }
    }
  };

  /** Keeps held runs within their limit: finished ones go first, then the oldest running one, counted */
  const trimRuns = () => {
    while (heldRuns.size > FALLBACK_LIMITS.runs) {
      const runs = [...heldRuns.values()];
      const finished = runs.filter(run => /** @type {readonly string[]} */ (FINISHED_RUN_STATES).includes(run.state));
      const pool = finished.length > 0 ? finished : runs;
      const [victim] = pool.sort(byTime('startedAt'));
      heldRuns.delete(victim.id);
      if (finished.length === 0) {
        dropped.runs++;
        holdEvent({ at: clock.now(), code: 'trust.fallback-dropped', fields: { count: dropped.runs, state: 'running' } });
      }
    }
  };

  /** Keeps held receipts within their limit, the oldest going first */
  const trimReceipts = () => {
    while (heldReceipts.size > FALLBACK_LIMITS.receipts) {
      const [oldest] = [...heldReceipts.values()].sort(byTime('verifiedAt'));
      heldReceipts.delete(oldest.providerId);
    }
  };

  /**
   * Notes that the store failed with `error`, and journals it once per spell
   * @param {unknown} error
   */
  const fallBack = error => {
    if (state !== 'fallback') {
      failureCode = codeOf(error);
      holdEvent({ at: clock.now(), code: 'trust.storage-fallback', fields: { cause: causeOf(error), errorCode: failureCode } });
    }
    state = 'fallback';
  };

  /** Whether memory holds anything a store hasn't */
  const holding = () => heldIncidents.size + heldReceipts.size + heldRuns.size + heldEvents.length > 0;

  /**
   * Runs `run` under the copy's Web Lock, when the host has locks
   * @template T
   * @param {() => Promise<T>} run
   * @returns {Promise<T>}
   */
  const underCopyLock = run => (locks ? locks.request(COPY_LOCK, run) : run());

  /**
   * The settings copy, when there's a valid one. Rejects when the settings area can't be read.
   * @returns {Promise<StorageCopy | null>}
   */
  const readCopy = async () => {
    const stored = (await settings.get([SETTINGS_KEYS.lastStorageIncident]))[SETTINGS_KEYS.lastStorageIncident];
    return v.is(storageCopySchema, stored) ? /** @type {StorageCopy} */ (stored) : null;
  };

  /**
   * Counts one occurrence of the storage incident `incident` in the settings copy. A copy of
   * another incident moves its occurrences into this context's memory first, since this copy
   * replaces it. Answers false when the settings area failed, so memory counts it instead.
   * @param {Incident} incident
   * @returns {Promise<boolean>}
   */
  const holdCopy = incident =>
    underCopyLock(async () => {
      const before = await readCopy();
      const same = before !== null && before.incident.key === incident.key;
      await settings.set({
        [SETTINGS_KEYS.lastStorageIncident]: { incident, added: (same ? before.added : 0) + 1, token: ids.next() },
      });
      if (before && !same) {
        const entry = heldIncidents.get(before.incident.key);
        heldIncidents.set(before.incident.key, {
          incident: entry ? entry.incident : before.incident,
          added: (entry ? entry.added : 0) + before.added,
        });
        trimIncidents();
      }
      return true;
    }).catch(() => false);

  // ============ The store ============

  /**
   * Whether the store can be tried: it opened in this context, or it opens now. A store that
   * never opened is tried again at most every RETRY_OPEN_MS.
   */
  const reachable = async () => {
    if (opened) return true;
    if (clock.now() - triedOpenAt < RETRY_OPEN_MS) return false;
    triedOpenAt = clock.now();
    try {
      await store.open();
      opened = true;
      return true;
    } catch (error) {
      fallBack(error);
      return false;
    }
  };

  /**
   * Runs `unit` on the store. Answers {ok: false} after falling back when the store can't.
   * @template T
   * @param {readonly TrustStoreName[]} stores
   * @param {'readonly' | 'readwrite'} mode
   * @param {(tx: TrustTx) => Promise<T>} unit
   * @returns {Promise<{ok: true, value: T} | {ok: false}>}
   */
  const run = async (stores, mode, unit) => {
    if (!(await reachable())) return { ok: false };
    try {
      return { ok: true, value: await store.run(stores, mode, unit) };
    } catch (error) {
      if (!(error instanceof UnavailableError)) throw error;
      fallBack(error);
      return { ok: false };
    }
  };

  /**
   * A write. Once it succeeds the records are open again, and what memory holds is reconciled.
   * @template T
   * @param {readonly TrustStoreName[]} stores
   * @param {(tx: TrustTx) => Promise<T>} unit
   * @returns {Promise<{ok: true, value: T} | {ok: false}>}
   */
  const write = async (stores, unit) => {
    const done = await run(stores, 'readwrite', unit);
    if (!done.ok) return done;
    const wasDown = state !== 'open';
    state = 'open';
    failureCode = null;
    if (wasDown || holding()) await reconcile({ withCopy: false });
    return done;
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

  /** @param {Incident} incident */
  const resolvedTooLongAgo = incident =>
    incident.state === 'resolved' && (incident.resolvedAt ?? 0) < clock.now() - BOUNDS.resolvedIncidentAgeMs;

  /** @param {TrustTx} tx */
  const pruneIncidents = async tx => {
    const resolved = /** @type {Incident[]} */ (await tx.getAllByIndex('incidents', 'state', 'resolved'));
    const newestFirst = resolved.sort((a, b) => (b.resolvedAt ?? 0) - (a.resolvedAt ?? 0) || (a.id < b.id ? -1 : 1));
    newestFirst.forEach((incident, index) => {
      if (index >= BOUNDS.resolvedIncidents || resolvedTooLongAgo(incident)) tx.delete('incidents', incident.id);
    });
  };

  /** @param {TrustTx} tx */
  const pruneRuns = async tx => {
    const all = /** @type {RemediationRun[]} */ (await tx.getAll('runs'));
    if (all.length <= BOUNDS.runs) return;
    const finished = all
      .filter(item => /** @type {readonly string[]} */ (FINISHED_RUN_STATES).includes(item.state))
      .sort(byTime('startedAt'));
    let over = all.length - BOUNDS.runs;
    for (const item of finished) {
      if (over-- <= 0) break;
      tx.delete('runs', item.id);
    }
  };

  /** @param {TrustTx} tx */
  const pruneJournal = async tx => {
    for (const seq of await tx.keys('journal', { index: 'at', below: clock.now() - BOUNDS.journalAgeMs })) {
      tx.delete('journal', seq);
    }
    const total = await tx.count('journal');
    if (total > BOUNDS.journalEvents) {
      for (const seq of await tx.keys('journal', { limit: total - BOUNDS.journalEvents })) tx.delete('journal', seq);
    }
  };

  // ============ Reconciling ============

  /**
   * Writes what memory holds, and with `withCopy` the settings copy, into the store, in one
   * transaction, and prunes. Reconciles run one at a time, each taking what's held when it
   * starts, so nothing is written twice.
   * @param {{withCopy: boolean}} options
   */
  const reconcile = ({ withCopy }) => {
    const turn = reconciling.then(() => (withCopy ? underCopyLock(() => reconcileOnce(true)) : reconcileOnce(false)));
    reconciling = turn.catch(() => {});
    return turn;
  };

  /**
   * @param {boolean} withCopy
   */
  const reconcileOnce = async withCopy => {
    // The copy is taken by clearing it first, under the lock a context holding one takes, so
    // no newer copy is lost and none is counted twice: a clear that fails leaves it for later
    /** @type {StorageCopy | null} */
    let taken = null;
    if (withCopy) {
      try {
        taken = await readCopy();
        if (taken) await settings.set({ [SETTINGS_KEYS.lastStorageIncident]: null });
      } catch {
        taken = null;
      }
    }
    const incidents = [...heldIncidents.values()];
    const receipts = [...heldReceipts.values()];
    const runs = [...heldRuns.values()];
    const events = [...heldEvents];
    const done = await run(['incidents', 'receipts', 'runs', 'journal'], 'readwrite', async tx => {
      let reconciled = 0;
      /** @type {Map<string, Incident>} */
      const next = new Map();
      /** @param {Incident} held @param {number} added */
      const apply = async (held, added) => {
        const before = next.get(held.key) || (await tx.getAllByIndex('incidents', 'key', held.key))[0];
        next.set(held.key, combine(before, held, added));
      };
      if (taken) await apply(taken.incident, taken.added);
      for (const entry of incidents) await apply(entry.incident, entry.added);
      for (const incident of next.values()) {
        tx.put('incidents', parseRecord(incidentSchema, incident, 'incident'));
        reconciled++;
      }
      await pruneIncidents(tx);
      for (const receipt of receipts) {
        const all = /** @type {HealthReceipt[]} */ (
          await tx.getAllByIndex('receipts', 'providerId', receipt.providerId)
        ).sort(byTime('verifiedAt'));
        const before = all[all.length - 1];
        tx.put('receipts', { ...receipt, transition: !before || before.status !== receipt.status });
        await pruneReceipts(tx, receipt.providerId);
      }
      for (const item of runs) tx.put('runs', item);
      await pruneRuns(tx);
      for (const event of events) await tx.append('journal', event);
      if (reconciled > 0) await tx.append('journal', { at: clock.now(), code: 'trust.reconciled', fields: { count: reconciled } });
      await pruneJournal(tx);
      return reconciled;
    });
    if (!done.ok) {
      // Put the copy back for whichever context opens the store next
      if (taken) await settings.set({ [SETTINGS_KEYS.lastStorageIncident]: taken }).catch(() => {});
      return;
    }
    state = 'open';
    failureCode = null;
    // Only what this reconcile wrote leaves memory; anything held since stays for the next
    for (const entry of incidents) if (heldIncidents.get(entry.incident.key) === entry) heldIncidents.delete(entry.incident.key);
    for (const receipt of receipts) if (heldReceipts.get(receipt.providerId) === receipt) heldReceipts.delete(receipt.providerId);
    for (const item of runs) if (heldRuns.get(item.id) === item) heldRuns.delete(item.id);
    heldEvents.splice(0, events.length);
  };

  // ============ Writes ============

  /**
   * The incident `input` makes on top of `existing`, at `at`
   * @param {Incident | undefined | null} existing
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
   * stored, and every key it makes is a valid one. Throws a TypeError naming only the rule.
   * @param {RaiseInput} input
   */
  const checkRaise = input => {
    if (!v.is(contributionId, input.providerId)) throw new TypeError('recovery.raise: providerId must be a contribution id');
    if (!v.is(faultCode, input.faultCode)) throw new TypeError('recovery.raise: faultCode must be a registered fault');
    if (input.subjectId != null && !v.is(subjectId, input.subjectId)) {
      throw new TypeError("recovery.raise: subjectId must be a record's id or a registered subject");
    }
    if (!(/** @type {readonly string[]} */ (SEVERITIES).includes(input.severity))) {
      throw new TypeError('recovery.raise: severity must be one of the severities');
    }
    for (const list of [input.affected, input.preserved]) {
      if (list !== undefined && !(Array.isArray(list) && list.length <= 32 && list.every(item => v.is(capability, item)))) {
        throw new TypeError('recovery.raise: capabilities must be registered ones');
      }
    }
    const evidence = checkEvidence(input.evidence);
    if (!evidence.ok) {
      const { reason } = /** @type {import('./evidence.js').RefusedEvidence} */ (evidence);
      throw new TypeError(`recovery.raise: evidence refused (${reason})`);
    }
    return evidence.value;
  };

  /**
   * The stored incident with `key`, when the store answers
   * @param {string} key
   * @returns {Promise<Incident | undefined>}
   */
  const storedIncident = async key => {
    const found = await run(['incidents'], 'readonly', async tx => (await tx.getAllByIndex('incidents', 'key', key))[0]);
    return found.ok ? /** @type {Incident | undefined} */ (found.value) : undefined;
  };

  /**
   * Raises an incident, or updates the one with its key. `held` says it's only in memory and,
   * for a storage incident, the settings copy.
   * @param {RaiseInput} input
   * @returns {Promise<{incident: Incident, created: boolean, held: boolean}>}
   */
  const raise = async input => {
    const evidence = checkRaise(input);
    const at = clock.now();
    const key = incidentKey(input.providerId, input.faultCode, input.subjectId);
    const stored = await write(['incidents'], async tx => {
      const [existing] = /** @type {Incident[]} */ (await tx.getAllByIndex('incidents', 'key', key));
      const incident = parseRecord(incidentSchema, merged(existing, input, evidence, at), 'incident');
      tx.put('incidents', incident);
      await pruneIncidents(tx);
      return { incident, created: !existing };
    });
    if (stored.ok) return { ...stored.value, held: false };
    const entry = heldIncidents.get(key);
    const base = await storedIncident(key);
    const incident = parseRecord(incidentSchema, merged(entry ? entry.incident : base, input, evidence, at), 'incident');
    const copied =
      /** @type {readonly string[]} */ (STORAGE_PROVIDERS).includes(input.providerId) && (await holdCopy(incident));
    const added = (entry ? entry.added : 0) + (copied ? 0 : 1);
    heldIncidents.set(key, { incident, added });
    trimIncidents();
    const shown = (await incidents()).find(item => item.key === key) || incident;
    return { incident: shown, created: !entry && !base, held: true };
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
    const stored = await write(['incidents'], async tx => {
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
    const done = (await incidents()).filter(
      incident => incident.providerId === providerId && incident.state !== 'resolved' && !still.includes(incident.key),
    );
    for (const incident of done) {
      const entry = heldIncidents.get(incident.key);
      heldIncidents.set(incident.key, { incident: resolved(entry ? entry.incident : incident), added: entry ? entry.added : 0 });
    }
    trimIncidents();
    return done.map(resolved);
  };

  /**
   * Sets or clears an open incident's dismissed flag. A resolved one is left as it is.
   * @param {string} id
   * @param {boolean} dismissed
   * @returns {Promise<Incident | null>}
   */
  const dismiss = async (id, dismissed) => {
    const stored = await write(['incidents'], async tx => {
      const incident = /** @type {Incident | undefined} */ (await tx.get('incidents', id));
      if (!incident || incident.state === 'resolved') return null;
      const next = { ...incident, dismissed };
      tx.put('incidents', next);
      return next;
    });
    if (stored.ok) return stored.value;
    const shown = (await incidents()).find(incident => incident.id === id);
    if (!shown || shown.state === 'resolved') return null;
    const entry = heldIncidents.get(shown.key);
    heldIncidents.set(shown.key, { incident: { ...(entry ? entry.incident : shown), dismissed }, added: entry ? entry.added : 0 });
    return { ...shown, dismissed };
  };

  /** The random id that stamps receipts, written once */
  const installId = () => {
    if (installing) return installing;
    const read = async () => {
      const key = SETTINGS_KEYS.installId;
      const stored = (await settings.get([key]))[key];
      if (v.is(recordId, stored)) return /** @type {string} */ (stored);
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
    parseRecord(receiptSchema, stamped, 'receipt');
    const stored = await write(['receipts'], async tx => {
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
    const before = heldReceipts.get(input.providerId);
    const receipt = { ...stamped, transition: !before || before.status !== input.status };
    heldReceipts.set(input.providerId, receipt);
    trimReceipts();
    return receipt;
  };

  /**
   * Stores a remediation run, or its next state
   * @param {RemediationRun} item
   * @returns {Promise<RemediationRun>}
   */
  const putRun = async item => {
    const checked = parseRecord(runSchema, item, 'run');
    const stored = await write(['runs'], async tx => {
      tx.put('runs', checked);
      await pruneRuns(tx);
      return checked;
    });
    if (stored.ok) return stored.value;
    heldRuns.set(checked.id, checked);
    trimRuns();
    return checked;
  };

  /**
   * Appends a journal event the journal already checked
   * @param {Omit<JournalEvent, 'seq'>} event
   * @returns {Promise<void>}
   */
  const append = async event => {
    const checked = /** @type {Omit<JournalEvent, 'seq'>} */ (parseRecord(newEventSchema, event, 'journal event'));
    const stored = await write(['journal'], async tx => {
      await tx.append('journal', checked);
      await pruneJournal(tx);
    });
    if (!stored.ok) holdEvent(checked);
  };

  /**
   * Opens NewTabNoteTrust, reconciles the settings copy and what memory holds, and prunes.
   * When it won't open, the records are in fallback, and every later write tries again.
   * @returns {Promise<{ok: true} | {ok: false, code: string}>}
   */
  const open = async () => {
    triedOpenAt = Number.NEGATIVE_INFINITY;
    if (!(await reachable())) {
      if (state !== 'fallback') state = 'fallback';
      return { ok: false, code: /** @type {string} */ (failureCode) };
    }
    state = 'open';
    failureCode = null;
    await reconcile({ withCopy: true });
    // The reconcile may have found the store failing after all
    const failed = currentFailure();
    return failed === null ? { ok: true } : { ok: false, code: failed };
  };

  // ============ Reads: the store, with what memory and the copy hold laid over it ============

  /** @returns {Promise<HealthReceipt[]>} every receipt, oldest first */
  const receipts = async () => {
    const stored = await run(['receipts'], 'readonly', tx => tx.getAll('receipts'));
    return copy([...(stored.ok ? stored.value : []), ...heldReceipts.values()]).sort(byTime('verifiedAt'));
  };

  /** @returns {Promise<HealthReceipt[]>} each provider's latest receipt */
  const latestReceipts = async () => {
    /** @type {Map<string, HealthReceipt>} */
    const latest = new Map();
    for (const receipt of await receipts()) latest.set(receipt.providerId, receipt);
    return [...latest.values()];
  };

  /** @returns {Promise<Incident[]>} every incident within its bounds, oldest first */
  const incidents = async () => {
    const stored = await run(['incidents'], 'readonly', tx => tx.getAll('incidents'));
    /** @type {Map<string, Incident>} */
    const byKey = new Map((stored.ok ? /** @type {Incident[]} */ (stored.value) : []).map(item => [item.key, item]));
    if (state !== 'open') {
      /** @type {StorageCopy | null} */
      let held = null;
      try {
        held = await readCopy();
      } catch {
        held = null;
      }
      if (held) byKey.set(held.incident.key, combine(byKey.get(held.incident.key), held.incident, held.added));
    }
    for (const entry of heldIncidents.values()) {
      byKey.set(entry.incident.key, combine(byKey.get(entry.incident.key), entry.incident, entry.added));
    }
    return copy([...byKey.values()].filter(item => !resolvedTooLongAgo(item))).sort(byTime('firstSeenAt'));
  };

  /** @returns {Promise<RemediationRun[]>} every run, oldest first */
  const runs = async () => {
    const stored = await run(['runs'], 'readonly', tx => tx.getAll('runs'));
    /** @type {Map<string, RemediationRun>} */
    const byId = new Map((stored.ok ? /** @type {RemediationRun[]} */ (stored.value) : []).map(item => [item.id, item]));
    for (const item of heldRuns.values()) byId.set(item.id, item);
    return copy([...byId.values()]).sort(byTime('startedAt'));
  };

  /** @returns {Promise<JournalEvent[]>} every journal event within its bounds, oldest first */
  const events = async () => {
    const stored = await run(['journal'], 'readonly', tx => tx.getAll('journal'));
    /** @type {JournalEvent[]} */
    const all = stored.ok ? copy(stored.value) : [];
    let seq = all.reduce((highest, event) => Math.max(highest, event.seq), 0);
    for (const event of heldEvents) all.push({ ...copy(event), seq: ++seq });
    const cutoff = clock.now() - BOUNDS.journalAgeMs;
    return all.filter(event => event.at >= cutoff).slice(-BOUNDS.journalEvents);
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
    /** @returns {string | null} why NewTabNoteTrust isn't taking writes, as a code */
    failureCode: () => failureCode,
    /** @returns {Readonly<Dropped>} what the memory fallback had to drop that it would have kept */
    dropped: () => Object.freeze({ ...dropped }),
  });
}

/** @typedef {ReturnType<typeof createTrustRecords>} TrustRecords */
