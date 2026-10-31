/**
 * The Trust Center's records (#20, "Records"): receipts, incidents, remediation runs, and the
 * diagnostic journal in NewTabNoteTrust, through a trust store (ports.js), with every bound
 * the scope sets applied in the same transaction as the write that could pass it.
 *
 * - A receipt is stored with `transition` set when its status differs from the provider's
 *   receipt before it. Each provider keeps its latest receipt and its 20 newest transitions.
 * - An incident is keyed by provider, fault, and subject, so a repeat updates the one record.
 *   Sightings, resolutions, and dismissals are operations, applied by incidents.js's reducer,
 *   where timestamps decide. Open incidents, dismissed included, always stay; resolved ones
 *   stay 90 days, 200 at most.
 * - Runs keep the newest 200, and any still running.
 * - The journal keeps 2,000 events, none older than 14 days.
 * Reads apply the age bounds too, so a quiet month with no write shows nothing past them, and
 * opening prunes the store.
 *
 * When NewTabNoteTrust won't open, or a write to it fails, the records are in `fallback`:
 * - Memory holds the incident operations that couldn't be written, in order, not snapshots of
 *   their result, and the latest receipt per provider, runs, and journal events. Reads lay the
 *   operations over what the store answers by running them through the same reducer a write
 *   uses, so a held operation reads as it would have written.
 * - Every later write tries the store again (a store that never opened is tried at most every
 *   30 seconds, and a connection Chrome closed is reopened at once), and the first that
 *   succeeds replays the held operations through the reducer in one transaction and leaves
 *   `fallback`.
 * - A sighting of a storage incident (capture or storage) is also copied to
 *   chrome.storage.local, under `trust.lastStorageIncident`, which keeps the latest 16 such
 *   operations, so they outlive the context. Whichever context next opens NewTabNoteTrust
 *   replays them too, then removes what it replayed from the copy. A replayed operation's id
 *   goes into its incident's `appliedOps`, so one held in two places, or replayed twice
 *   because removing it failed, counts once. Writing and removing the copy happens under
 *   Web Lock `trust.lastStorageIncident`. Every extension context in Chrome has Web Locks; a
 *   host without them (`locks: null`, as some tests run) has no exclusion there, and relies on
 *   `appliedOps` alone.
 * - Memory is bounded. Operations of incidents that end resolved go first; an open sighting
 *   that still has to go, and isn't in the settings copy, is counted (`dropped()`), with one
 *   `trust.fallback-dropped` event per kind that keeps the running count.
 *
 * A random `trust.installId` is written to the settings area once, under a Web Lock when the
 * host has them, and stamps every receipt.
 *
 * Every record is checked against its schema (records.js) before it's written, so nothing
 * outside the evidence allowlist reaches a store, the settings area, or memory.
 */

import * as v from '../../lib/valibot/index.mjs';
import { UnavailableError } from '../../kernel/core/contracts/outcomes.js';
import { capability, checkEvidence, faultCode, providerId, recordId, subjectId } from './evidence.js';
import { applyDismiss, applyOp, applyRaise, applyResolve, inOrder, raiseOp, raiseOpSchema } from './incidents.js';
import { SETTINGS_KEYS } from './ports.js';
import { BOUNDS, incidentSchema, journalEventSchema, parseRecord, receiptSchema, runSchema } from './records.js';
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
/** @typedef {import('./incidents.js').IncidentOp} IncidentOp */
/** @typedef {import('./incidents.js').RaiseOp} RaiseOp */
/** @typedef {import('./vocabulary.js').Severity} Severity */

/** How much the memory fallback holds of each kind, and how many sightings the settings copy keeps */
export const FALLBACK_LIMITS = Object.freeze({ operations: 200, receipts: 64, runs: 50, events: 200, copy: 16 });

/** How long a context whose store never opened waits before a write tries to open it again */
export const RETRY_OPEN_MS = 30_000;

/** The Web Lock a context holds while it writes or trims the settings copy */
const COPY_LOCK = 'trust.lastStorageIncident';

/** The journal event schema without the seq the store assigns */
const newEventSchema = v.omit(journalEventSchema, ['seq']);

/** The settings copy: the latest storage sightings no store may have replayed yet */
export const storageCopySchema = v.strictObject({
  ops: v.pipe(v.array(raiseOpSchema), v.maxLength(FALLBACK_LIMITS.copy)),
});

/** @typedef {v.InferOutput<typeof storageCopySchema>} StorageCopy */

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

/** What the memory fallback had to drop that it would have kept: open sightings, running runs, and events */
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

/** @param {string} providerId */
const isStorageProvider = providerId => /** @type {readonly string[]} */ (STORAGE_PROVIDERS).includes(providerId);

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
  /** Whether the store is open in this context */
  let opened = false;
  /** When this context last tried to open a store that isn't open */
  let triedOpenAt = Number.NEGATIVE_INFINITY;
  /** @type {string | null} */
  let failureCode = null;
  /** Read through a call, so a check after an await sees what the await changed */
  const currentFailure = () => failureCode;
  /** @type {IncidentOp[]} */
  const heldOps = [];
  /** The held sightings this context copied to the settings area */
  const copiedOps = new Set();
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

  /**
   * Counts something memory had to drop, in one held event per kind that keeps the count
   * @param {'open' | 'running'} kind
   */
  const noteDropped = kind => {
    const total = kind === 'open' ? ++dropped.incidents : ++dropped.runs;
    const fields = { count: total, state: kind };
    const at = heldEvents.findIndex(event => event.code === 'trust.fallback-dropped' && event.fields.state === kind);
    if (at === -1) holdEvent({ at: clock.now(), code: 'trust.fallback-dropped', fields });
    else heldEvents[at] = { at: clock.now(), code: 'trust.fallback-dropped', fields };
  };

  /** Keeps held operations within their limit: those of incidents that end resolved go first */
  const trimOps = () => {
    while (heldOps.length > FALLBACK_LIMITS.operations) {
      /** @type {Map<string, IncidentOp['kind']>} */
      const latest = new Map();
      for (const op of heldOps) latest.set(op.key, op.kind);
      let index = heldOps.findIndex(op => latest.get(op.key) === 'resolve');
      const resolvedFirst = index !== -1;
      if (!resolvedFirst) index = 0;
      const [victim] = heldOps.splice(index, 1);
      if (!resolvedFirst && victim.kind === 'raise' && !copiedOps.has(victim.opId)) noteDropped('open');
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
      if (finished.length === 0) noteDropped('running');
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
  const holding = () => heldOps.length + heldReceipts.size + heldRuns.size + heldEvents.length > 0;

  /**
   * Runs `run` under the copy's Web Lock, when the host has locks
   * @template T
   * @param {() => Promise<T>} run
   * @returns {Promise<T>}
   */
  const underCopyLock = run => (locks ? locks.request(COPY_LOCK, run) : run());

  /**
   * The settings copy's sightings, none past the resolved-incident bound. Rejects when the
   * settings area can't be read.
   * @returns {Promise<RaiseOp[]>}
   */
  const readCopy = async () => {
    const stored = (await settings.get([SETTINGS_KEYS.lastStorageIncident]))[SETTINGS_KEYS.lastStorageIncident];
    if (!v.is(storageCopySchema, stored)) return [];
    const cutoff = clock.now() - BOUNDS.resolvedIncidentAgeMs;
    return /** @type {StorageCopy} */ (stored).ops.filter(op => op.at >= cutoff);
  };

  /**
   * Holds an operation that couldn't be written. A storage sighting is also copied to the
   * settings area, best effort.
   * @param {IncidentOp} op
   */
  const holdOp = async op => {
    heldOps.push(op);
    if (op.kind === 'raise' && isStorageProvider(op.sighting.providerId)) {
      try {
        await underCopyLock(async () => {
          const ops = [...(await readCopy()), op].slice(-FALLBACK_LIMITS.copy);
          await settings.set({ [SETTINGS_KEYS.lastStorageIncident]: { ops } });
        });
        copiedOps.add(op.opId);
      } catch {
        // Memory still holds it
      }
    }
    trimOps();
  };

  // ============ The store ============

  /**
   * Whether the store can be tried: it's open in this context, or it opens now. A store that
   * isn't open is tried again at most every RETRY_OPEN_MS.
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
   * Runs `unit` on the store. Answers {ok: false} after falling back when the store can't. A
   * connection Chrome closed is opened again, and the unit run once more.
   * @template T
   * @param {readonly TrustStoreName[]} stores
   * @param {'readonly' | 'readwrite'} mode
   * @param {(tx: TrustTx) => Promise<T>} unit
   * @returns {Promise<{ok: true, value: T} | {ok: false}>}
   */
  const run = async (stores, mode, unit) => {
    for (let attempt = 0; attempt < 2; attempt++) {
      if (!(await reachable())) return { ok: false };
      try {
        return { ok: true, value: await store.run(stores, mode, unit) };
      } catch (error) {
        if (!(error instanceof UnavailableError)) throw error;
        if (error.code === 'database-closed' && attempt === 0) {
          opened = false;
          triedOpenAt = Number.NEGATIVE_INFINITY;
          continue;
        }
        fallBack(error);
        return { ok: false };
      }
    }
    return { ok: false };
  };

  /**
   * A write. Once it succeeds the records are open again, and what memory holds is replayed.
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
   * Replays the held operations, and with `withCopy` the settings copy's, through the reducer
   * in one transaction, writes what memory holds of the rest, and prunes. Reconciles run one at
   * a time, each taking what's held when it starts, so nothing is written twice; whatever one
   * throws leaves everything held, the copy included.
   * @param {{withCopy: boolean}} options
   */
  const reconcile = ({ withCopy }) => {
    const turn = reconciling.then(() => {
      const touchesCopy = withCopy || heldOps.some(op => copiedOps.has(op.opId));
      return touchesCopy ? underCopyLock(() => reconcileOnce(withCopy, true)) : reconcileOnce(false, false);
    });
    reconciling = turn.catch(() => {});
    return turn.catch(error => fallBack(error));
  };

  /**
   * @param {boolean} withCopy - replay the settings copy's sightings too
   * @param {boolean} trimCopy - remove what was replayed from the copy after
   */
  const reconcileOnce = async (withCopy, trimCopy) => {
    /** @type {RaiseOp[]} */
    let copied = [];
    if (withCopy) {
      try {
        copied = await readCopy();
      } catch {
        copied = [];
      }
    }
    const held = [...heldOps];
    const ops = inOrder([...held, ...copied]);
    const receipts = [...heldReceipts.values()];
    const runs = [...heldRuns.values()];
    const events = [...heldEvents];
    /** @type {{ok: true, value: number} | {ok: false}} */
    let done;
    try {
      done = await run(['incidents', 'receipts', 'runs', 'journal'], 'readwrite', async tx => {
        /** @type {Map<string, Incident | undefined>} */
        const touched = new Map();
        for (const op of ops) {
          const before = touched.has(op.key)
            ? touched.get(op.key)
            : /** @type {Incident | undefined} */ ((await tx.getAllByIndex('incidents', 'key', op.key))[0]);
          touched.set(op.key, applyOp(before, op, { track: true }));
        }
        for (const incident of touched.values()) {
          if (incident) tx.put('incidents', parseRecord(incidentSchema, incident, 'incident'));
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
        if (ops.length > 0) await tx.append('journal', { at: clock.now(), code: 'trust.reconciled', fields: { count: ops.length } });
        await pruneJournal(tx);
        return ops.length;
      });
    } catch (error) {
      // A store that throws something other than an UnavailableError still leaves all of it held
      fallBack(error);
      return;
    }
    if (!done.ok) return;
    state = 'open';
    failureCode = null;
    // Only what this reconcile wrote leaves memory; anything held since stays for the next
    const replayed = new Set(ops.map(op => op.opId));
    for (let index = heldOps.length - 1; index >= 0; index--) if (replayed.has(heldOps[index].opId)) heldOps.splice(index, 1);
    for (const receipt of receipts) if (heldReceipts.get(receipt.providerId) === receipt) heldReceipts.delete(receipt.providerId);
    for (const item of runs) if (heldRuns.get(item.id) === item) heldRuns.delete(item.id);
    heldEvents.splice(0, events.length);
    if (trimCopy) {
      try {
        const remaining = (await readCopy()).filter(op => !replayed.has(op.opId));
        await settings.set({ [SETTINGS_KEYS.lastStorageIncident]: remaining.length > 0 ? { ops: remaining } : null });
        for (const opId of replayed) copiedOps.delete(opId);
      } catch {
        // The copy keeps them, and a replay of them adds nothing (appliedOps)
      }
    }
  };

  // ============ Incidents ============

  /**
   * What recovery.raise and the journal pass in, checked, as a sighting, so nothing outside
   * the allowlist is stored and every key it makes is a valid one. Throws a TypeError naming
   * only the rule.
   * @param {RaiseInput} input
   * @returns {import('./incidents.js').Sighting}
   */
  const sightingOf = input => {
    if (!v.is(providerId, input.providerId)) throw new TypeError('recovery.raise: providerId must be a registered provider');
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
    return /** @type {import('./incidents.js').Sighting} */ ({
      providerId: input.providerId,
      faultCode: input.faultCode,
      subjectId: input.subjectId ?? null,
      severity: input.severity,
      affected: [...(input.affected || [])],
      preserved: [...(input.preserved || [])],
      evidence: evidence.value,
    });
  };

  /**
   * Raises an incident, or updates the one with its key. `held` says it's only in memory and,
   * for a storage incident, the settings copy.
   * @param {RaiseInput} input
   * @returns {Promise<{incident: Incident, created: boolean, held: boolean}>}
   */
  const raise = async input => {
    const op = raiseOp(ids, sightingOf(input), clock.now());
    const stored = await write(['incidents'], async tx => {
      const [existing] = /** @type {Incident[]} */ (await tx.getAllByIndex('incidents', 'key', op.key));
      const incident = parseRecord(incidentSchema, applyRaise(existing, op), 'incident');
      tx.put('incidents', incident);
      await pruneIncidents(tx);
      return { incident, created: !existing };
    });
    if (stored.ok) return { ...stored.value, held: false };
    const before = (await incidents()).find(item => item.key === op.key);
    await holdOp(op);
    const shown = (await incidents()).find(item => item.key === op.key) || applyRaise(undefined, op);
    return { incident: shown, created: !before, held: true };
  };

  /**
   * Resolves the provider's open incidents whose key isn't in `still`, after a check of it
   * passed. Answers the ones it resolved.
   * @param {string} provider
   * @param {readonly string[]} still - keys of the faults the check still reports
   * @returns {Promise<Incident[]>}
   */
  const resolve = async (provider, still) => {
    const at = clock.now();
    /** @param {string} key @returns {import('./incidents.js').ResolveOp} */
    const resolveOp = key => ({ opId: ids.next(), kind: 'resolve', at, key });
    const stored = await write(['incidents'], async tx => {
      const open = [
        ...(/** @type {Incident[]} */ (await tx.getAllByIndex('incidents', 'state', 'open'))),
        ...(/** @type {Incident[]} */ (await tx.getAllByIndex('incidents', 'state', 'remediating'))),
      ].filter(incident => incident.providerId === provider && !still.includes(incident.key));
      /** @type {Incident[]} */
      const done = [];
      for (const incident of open) {
        const next = applyResolve(incident, resolveOp(incident.key));
        if (next && next.state === 'resolved') {
          tx.put('incidents', next);
          done.push(next);
        }
      }
      await pruneIncidents(tx);
      return done;
    });
    if (stored.ok) return stored.value;
    const open = (await incidents()).filter(
      incident => incident.providerId === provider && incident.state !== 'resolved' && !still.includes(incident.key),
    );
    /** @type {Incident[]} */
    const done = [];
    for (const incident of open) {
      const op = resolveOp(incident.key);
      const next = applyResolve(incident, op);
      if (!next || next.state !== 'resolved') continue;
      await holdOp(op);
      done.push(next);
    }
    return done;
  };

  /**
   * Sets or clears an open incident's dismissed flag, unless it was seen again since. A
   * resolved one is left as it is.
   * @param {string} id
   * @param {boolean} dismissed
   * @returns {Promise<Incident | null>}
   */
  const dismiss = async (id, dismissed) => {
    const at = clock.now();
    const stored = await write(['incidents'], async tx => {
      const incident = /** @type {Incident | undefined} */ (await tx.get('incidents', id));
      if (!incident) return null;
      const next = applyDismiss(incident, { opId: ids.next(), kind: 'dismiss', at, key: incident.key, dismissed });
      if (!next || next === incident) return null;
      tx.put('incidents', next);
      return next;
    });
    if (stored.ok) return stored.value;
    const shown = (await incidents()).find(incident => incident.id === id);
    if (!shown) return null;
    /** @type {import('./incidents.js').DismissOp} */
    const op = { opId: ids.next(), kind: 'dismiss', at, key: shown.key, dismissed };
    const next = applyDismiss(shown, op);
    if (!next || next === shown) return null;
    await holdOp(op);
    return next;
  };

  // ============ Receipts, runs, and the journal ============

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
   * Opens NewTabNoteTrust, replays the settings copy and what memory holds, and prunes. When
   * it won't open, the records are in fallback, and every later write tries again. It never
   * rejects for a store that fails.
   * @returns {Promise<{ok: true} | {ok: false, code: string}>}
   */
  const open = async () => {
    triedOpenAt = Number.NEGATIVE_INFINITY;
    if (!(await reachable())) {
      state = 'fallback';
      return { ok: false, code: currentFailure() || 'open-failed' };
    }
    state = 'open';
    failureCode = null;
    await reconcile({ withCopy: true });
    const failed = currentFailure();
    return failed === null ? { ok: true } : { ok: false, code: failed };
  };

  // ============ Reads: the store, with the held operations replayed over it ============

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

  /**
   * Every incident within its bounds, oldest first: the store's, with this context's held
   * operations replayed over them, and while the records aren't open, the settings copy's too
   * @returns {Promise<Incident[]>}
   */
  async function incidents() {
    const stored = await run(['incidents'], 'readonly', tx => tx.getAll('incidents'));
    /** @type {Map<string, Incident | undefined>} */
    const byKey = new Map((stored.ok ? /** @type {Incident[]} */ (stored.value) : []).map(item => [item.key, item]));
    /** @type {RaiseOp[]} */
    let copied = [];
    if (state !== 'open') {
      try {
        copied = await readCopy();
      } catch {
        copied = [];
      }
    }
    for (const op of inOrder([...heldOps, ...copied])) byKey.set(op.key, applyOp(byKey.get(op.key), op, { track: true }));
    const all = /** @type {Incident[]} */ ([...byKey.values()].filter(Boolean));
    return copy(all.filter(item => !resolvedTooLongAgo(item))).sort(byTime('firstSeenAt'));
  }

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
