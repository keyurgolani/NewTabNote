/**
 * The Trust Center's records (#20, "Records"): receipts, incidents, remediation runs, and the
 * diagnostic journal in NewTabNoteTrust, through a trust store (ports.js), with every bound
 * the scope sets applied in the same transaction as the write that could pass it.
 *
 * - A receipt is stored with `transition` set when its status differs from the provider's
 *   receipt before it. Each provider keeps its latest receipt and its 20 newest transitions.
 * - An incident is keyed by provider, fault, and subject, so a repeat updates the one record.
 *   Sightings, resolutions, and dismissals go through incidents.js's reducer. Open incidents,
 *   dismissed included, always stay; resolved ones stay 90 days, 200 at most.
 * - Runs keep the newest 200, and any still running.
 * - The journal keeps 2,000 events, none older than 14 days.
 * Reads apply the age bounds too, so a quiet month with no write shows nothing past them, and
 * opening prunes the store.
 *
 * When NewTabNoteTrust won't open, or a write to it fails, the records are in `fallback`,
 * which follows the scope's rule: the latest storage incident goes to memory and to
 * chrome.storage.local (`trust.lastStorageIncident`) and reconciles later.
 * - Reads always come from the store when it answers. A failed write never changes them,
 *   except that the storage incidents held for it show over them.
 * - Only storage incidents are held: the latest sighting of each capture or storage key (at
 *   most HELD_KEYS of them, besides `storage/write-failed`), with the occurrences no store has
 *   counted, in memory and in the settings copy.
 * - Every failed write, whatever it wrote, counts one occurrence of `storage/write-failed`, and
 *   answers as not recorded (`recorded: false`). A failed sighting of a storage incident is
 *   also held itself. Nothing else a failed write carried is kept: a provider's incidents come
 *   back on its next check, and the write-failed incident says how many writes failed.
 * - Every later write tries the store again (a store that never opened is tried at most every
 *   30 seconds, and a connection Chrome closed is reopened at once). The write that succeeds
 *   first replays the held storage incidents, before its own operation, in its transaction.
 * - The settings copy holds one entry per key, which a context adds its occurrences to under
 *   Web Lock `trust.lastStorageIncident`. Whichever context next writes or opens the store
 *   replays it, and then, under the same lock, removes only the entries it replayed. A
 *   replayed entry's id, and the ids of the versions it supersedes, go into the incident's
 *   `appliedOps`, so an entry replayed twice (because removing it failed) counts once. Every
 *   extension context in Chrome has Web Locks; a host without them (`locks: null`, as some
 *   tests run) has no exclusion around the copy, and relies on `appliedOps` alone.
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
import {
  SUPERSEDES,
  applyDismiss,
  applyOp,
  applyRaise,
  applyResolve,
  directAt,
  inOrder,
  raiseOp,
  raiseOpSchema,
} from './incidents.js';
import { SETTINGS_KEYS } from './ports.js';
import { BOUNDS, incidentKey, incidentSchema, journalEventSchema, parseRecord, receiptSchema, runSchema } from './records.js';
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
/** @typedef {import('./incidents.js').RaiseOp} RaiseOp */
/** @typedef {import('./incidents.js').Sighting} Sighting */
/** @typedef {import('./vocabulary.js').Severity} Severity */

/** How many capture and storage keys a context holds, besides `storage/write-failed` */
export const HELD_KEYS = 8;

/** How many entries the settings copy keeps */
export const COPY_ENTRIES = 16;

/** The storage incident every failed write counts in */
export const WRITE_FAILED_KEY = incidentKey('storage', 'write-failed', null);

/** How long a context whose store never opened waits before a write tries to open it again */
export const RETRY_OPEN_MS = 30_000;

/** The Web Lock a context holds while it adds to, replays, or trims the settings copy */
const COPY_LOCK = 'trust.lastStorageIncident';

/** The journal event schema without the seq the store assigns */
const newEventSchema = v.omit(journalEventSchema, ['seq']);

/** The settings copy: the held storage sightings, one entry per key */
export const storageCopySchema = v.strictObject({
  entries: v.pipe(v.array(raiseOpSchema), v.maxLength(COPY_ENTRIES)),
});

/** @typedef {v.InferOutput<typeof storageCopySchema>} StorageCopy */

/**
 * A storage incident this context holds: its latest sighting, the copy entry this context last
 * wrote for it, and the occurrences only memory counts, which `remainderId` replays
 * @typedef {{key: string, incidentId: string, at: number, sighting: Sighting, copied: string | null,
 *   remainder: number, remainderId: string}} Held
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
 * Orders by a numeric field, then by id, oldest first
 * @param {string} field
 */
const byTime =
  field =>
  (/** @type {any} */ a, /** @type {any} */ b) =>
    a[field] - b[field] || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/**
 * The error a failed run answered with
 * @param {object} result
 * @returns {unknown}
 */
const errorOf = result => /** @type {{error?: unknown}} */ (result).error;

/** @param {string} provider */
const isStorageProvider = provider => /** @type {readonly string[]} */ (STORAGE_PROVIDERS).includes(provider);

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
  /** @type {Map<string, Held>} */
  const held = new Map();
  /** @type {Promise<string> | null} */
  let installing = null;

  // ============ Held storage incidents ============

  /**
   * Runs `run` under the copy's Web Lock, when the host has locks
   * @template T
   * @param {() => Promise<T>} run
   * @returns {Promise<T>}
   */
  const underCopyLock = run => (locks ? locks.request(COPY_LOCK, run) : run());

  /**
   * The settings copy's entries, none past the resolved-incident bound. Rejects when the
   * settings area can't be read.
   * @returns {Promise<RaiseOp[]>}
   */
  const readCopy = async () => {
    const stored = (await settings.get([SETTINGS_KEYS.lastStorageIncident]))[SETTINGS_KEYS.lastStorageIncident];
    if (!v.is(storageCopySchema, stored)) return [];
    const cutoff = clock.now() - BOUNDS.resolvedIncidentAgeMs;
    return /** @type {StorageCopy} */ (stored).entries.filter(entry => entry.at >= cutoff);
  };

  /** Whether reads and writes need the settings copy: in fallback, or while this context has entries in it */
  const usesCopy = () => state !== 'open' || [...held.values()].some(entry => entry.copied !== null);

  /**
   * Adds this context's uncounted occurrences of `entry`, and one more, to its key's entry in
   * the settings copy, superseding the one there. Answers false when the settings area failed
   * or the copy is full, so memory counts the occurrence instead.
   * @param {Held} entry
   * @returns {Promise<boolean>}
   */
  const addToCopy = entry =>
    underCopyLock(async () => {
      const entries = await readCopy();
      const current = entries.find(item => item.key === entry.key);
      const rest = entries.filter(item => item !== current);
      if (rest.length + 1 > COPY_ENTRIES) return false;
      const newer = !current || entry.at >= current.at;
      /** @type {RaiseOp} */
      const next = {
        opId: ids.next(),
        kind: 'raise',
        at: newer ? entry.at : /** @type {RaiseOp} */ (current).at,
        key: entry.key,
        incidentId: current ? current.incidentId : entry.incidentId,
        sighting: newer ? entry.sighting : /** @type {RaiseOp} */ (current).sighting,
        count: (current ? current.count : 0) + entry.remainder + 1,
        supersedes: current ? [current.opId, ...current.supersedes].slice(0, SUPERSEDES) : [],
      };
      await settings.set({ [SETTINGS_KEYS.lastStorageIncident]: { entries: [...rest, next] } });
      entry.incidentId = next.incidentId;
      entry.copied = next.opId;
      entry.remainder = 0;
      return true;
    }).catch(() => false);

  /**
   * Holds one sighting of storage incident `key`: in the copy, or counted in memory when the
   * copy can't take it. Answers null when this context already holds HELD_KEYS other keys.
   * @param {string} key
   * @param {Sighting} sighting
   * @param {number} at
   * @returns {Promise<Held | null>}
   */
  const holdSighting = async (key, sighting, at) => {
    let entry = held.get(key);
    if (!entry) {
      const others = [...held.keys()].filter(item => item !== WRITE_FAILED_KEY).length;
      if (key !== WRITE_FAILED_KEY && others >= HELD_KEYS) return null;
      entry = { key, incidentId: ids.next(), at, sighting, copied: null, remainder: 0, remainderId: ids.next() };
      held.set(key, entry);
    } else if (at >= entry.at) {
      entry.at = at;
      entry.sighting = sighting;
    }
    if (!(await addToCopy(entry))) entry.remainder += 1;
    return entry;
  };

  /**
   * Counts a write that failed with `error` in `storage/write-failed`, and notes the fallback
   * @param {unknown} error
   */
  const failedWrite = async error => {
    if (state !== 'fallback') failureCode = codeOf(error);
    state = 'fallback';
    const errorCode = codeOf(error);
    await holdSighting(
      WRITE_FAILED_KEY,
      {
        providerId: 'storage',
        faultCode: 'write-failed',
        subjectId: null,
        severity: 'data-risk',
        affected: [],
        preserved: [],
        evidence: /** @type {Sighting['evidence']} */ (checkEvidence({ errorCode }).ok ? { errorCode } : {}),
      },
      clock.now(),
    );
  };

  /**
   * The held storage sightings to replay: memory's uncounted occurrences, and with `withCopy`
   * the settings copy's entries
   * @param {boolean} withCopy
   * @returns {Promise<{ops: RaiseOp[], copied: RaiseOp[]}>}
   */
  const heldOps = async withCopy => {
    /** @type {RaiseOp[]} */
    let copied = [];
    if (withCopy) {
      try {
        copied = await readCopy();
      } catch {
        copied = [];
      }
    }
    /** @type {RaiseOp[]} */
    const remainders = [...held.values()]
      .filter(entry => entry.remainder > 0)
      .map(entry => ({
        opId: entry.remainderId,
        kind: 'raise',
        at: entry.at,
        key: entry.key,
        incidentId: entry.incidentId,
        sighting: entry.sighting,
        count: entry.remainder,
        supersedes: [],
      }));
    return { ops: /** @type {RaiseOp[]} */ (inOrder([...copied, ...remainders])), copied };
  };

  /**
   * After a write that replayed `ops` committed: memory forgets what it replayed, and the copy
   * loses the entries it replayed, only if they're still the ones it read. An entry this
   * context wrote that the copy (as read with `read`) no longer has was replayed, or taken into
   * a later entry, by another context, so memory forgets it too.
   * @param {RaiseOp[]} ops
   * @param {RaiseOp[]} copied
   * @param {boolean} read - whether `copied` is what the copy held
   */
  const settle = async (ops, copied, read) => {
    const replayed = new Set(ops.map(op => op.opId));
    const inCopy = new Set(copied.map(entry => entry.opId));
    for (const entry of held.values()) {
      if (replayed.has(entry.remainderId)) {
        entry.remainder = 0;
        entry.remainderId = ids.next();
      }
      if (read && entry.copied !== null && !inCopy.has(entry.copied)) entry.copied = null;
    }
    if (copied.length > 0) {
      try {
        const remaining = (await readCopy()).filter(entry => !replayed.has(entry.opId));
        await settings.set({ [SETTINGS_KEYS.lastStorageIncident]: remaining.length > 0 ? { entries: remaining } : null });
        for (const entry of held.values()) if (entry.copied !== null && replayed.has(entry.copied)) entry.copied = null;
      } catch {
        // The copy keeps them, and replaying them again adds nothing (appliedOps)
      }
    }
    for (const [key, entry] of held) if (entry.remainder === 0 && entry.copied === null) held.delete(key);
  };

  // ============ The store ============

  /**
   * Whether the store can be tried: it's open in this context, or it opens now. A store that
   * isn't open is tried again at most every RETRY_OPEN_MS.
   * @returns {Promise<{ok: true} | {ok: false, error: unknown}>}
   */
  const reachable = async () => {
    if (opened) return { ok: true };
    if (clock.now() - triedOpenAt < RETRY_OPEN_MS) {
      return { ok: false, error: new UnavailableError('storage', currentFailure() || 'open-failed', true) };
    }
    triedOpenAt = clock.now();
    try {
      await store.open();
      opened = true;
      return { ok: true };
    } catch (error) {
      if (state !== 'fallback') failureCode = codeOf(error);
      state = 'fallback';
      return { ok: false, error };
    }
  };

  /**
   * Runs `unit` on the store. Answers {ok: false} with the error when the store can't. A
   * connection Chrome closed is opened again, and the unit run once more.
   * @template T
   * @param {readonly TrustStoreName[]} stores
   * @param {'readonly' | 'readwrite'} mode
   * @param {(tx: TrustTx) => Promise<T>} unit
   * @returns {Promise<{ok: true, value: T} | {ok: false, error: unknown}>}
   */
  const run = async (stores, mode, unit) => {
    /** @type {unknown} */
    let last = null;
    for (let attempt = 0; attempt < 2; attempt++) {
      const can = await reachable();
      if (!can.ok) return { ok: false, error: errorOf(can) };
      try {
        return { ok: true, value: await store.run(stores, mode, unit) };
      } catch (error) {
        if (!(error instanceof UnavailableError)) throw error;
        last = error;
        if (error.code === 'database-closed' && attempt === 0) {
          opened = false;
          triedOpenAt = Number.NEGATIVE_INFINITY;
          continue;
        }
        return { ok: false, error };
      }
    }
    return { ok: false, error: last };
  };

  /**
   * A write: the held storage sightings replay first, then `unit`, in one transaction. Once it
   * commits the records are open again. A write that fails is counted in
   * `storage/write-failed` by its caller (failedWrite), outside the copy's lock.
   * @template T
   * @param {readonly TrustStoreName[]} stores
   * @param {(tx: TrustTx) => Promise<T>} unit
   * @param {{withCopy?: boolean}} [options] - read the copy whatever the state, as open() does
   * @returns {Promise<{ok: true, value: T} | {ok: false, error: unknown}>}
   */
  const write = async (stores, unit, { withCopy = false } = {}) => {
    const copying = withCopy || usesCopy();
    const go = async () => {
      const { ops, copied } = await heldOps(copying);
      const names = /** @type {TrustStoreName[]} */ ([
        ...new Set([...stores, ...(ops.length > 0 ? /** @type {TrustStoreName[]} */ (['incidents', 'journal']) : [])]),
      ]);
      const done = await run(names, 'readwrite', async tx => {
        if (ops.length > 0) await replay(tx, ops);
        return unit(tx);
      });
      if (!done.ok) return done;
      state = 'open';
      failureCode = null;
      if (ops.length > 0 || copying) await settle(ops, copied, copying);
      return done;
    };
    return copying ? underCopyLock(go) : go();
  };

  /**
   * Replays `ops` in `tx`, through the reducer, and journals how many
   * @param {TrustTx} tx
   * @param {RaiseOp[]} ops
   */
  const replay = async (tx, ops) => {
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
    await tx.append('journal', { at: clock.now(), code: 'trust.reconciled', fields: { count: ops.length } });
  };

  // ============ Bounds, each inside the write that could pass it ============

  /**
   * @param {TrustTx} tx
   * @param {string} provider
   */
  const pruneReceipts = async (tx, provider) => {
    const all = /** @type {HealthReceipt[]} */ (await tx.getAllByIndex('receipts', 'providerId', provider)).sort(
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

  // ============ Incidents ============

  /**
   * What recovery.raise and the journal pass in, checked, as a sighting, so nothing outside
   * the allowlist is stored and every key it makes is a valid one. Throws a TypeError naming
   * only the rule.
   * @param {RaiseInput} input
   * @returns {Sighting}
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
    return /** @type {Sighting} */ ({
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
   * Raises an incident, or updates the one with its key. When the store won't take it,
   * `recorded` is false, and a storage incident is `held` (in memory and the settings copy).
   * @param {RaiseInput} input
   * @returns {Promise<{recorded: boolean, held: boolean, incident: Incident | null, created: boolean}>}
   */
  const raise = async input => {
    const sighting = sightingOf(input);
    const now = clock.now();
    const stored = await write(['incidents'], async tx => {
      const key = incidentKey(sighting.providerId, sighting.faultCode, sighting.subjectId);
      const [existing] = /** @type {Incident[]} */ (await tx.getAllByIndex('incidents', 'key', key));
      const op = raiseOp(ids, sighting, directAt(existing, 'raise', now));
      const incident = parseRecord(incidentSchema, applyRaise(existing, op), 'incident');
      tx.put('incidents', incident);
      await pruneIncidents(tx);
      return { incident, created: !existing };
    });
    if (stored.ok) return { recorded: true, held: false, ...stored.value };
    await failedWrite(errorOf(stored));
    if (!isStorageProvider(sighting.providerId)) return { recorded: false, held: false, incident: null, created: false };
    const key = incidentKey(sighting.providerId, sighting.faultCode, sighting.subjectId);
    const entry = await holdSighting(key, sighting, now);
    const shown = entry ? (await incidents()).find(item => item.key === key) || null : null;
    return { recorded: false, held: entry !== null, incident: shown, created: false };
  };

  /**
   * Resolves the provider's open incidents whose key isn't in `still`, after a check of it
   * passed. Answers the ones it resolved, none when the store won't take the write.
   * @param {string} provider
   * @param {readonly string[]} still - keys of the faults the check still reports
   * @returns {Promise<Incident[]>}
   */
  const resolve = async (provider, still) => {
    const now = clock.now();
    const stored = await write(['incidents'], async tx => {
      const open = [
        ...(/** @type {Incident[]} */ (await tx.getAllByIndex('incidents', 'state', 'open'))),
        ...(/** @type {Incident[]} */ (await tx.getAllByIndex('incidents', 'state', 'remediating'))),
      ].filter(incident => incident.providerId === provider && !still.includes(incident.key));
      /** @type {Incident[]} */
      const done = [];
      for (const incident of open) {
        const next = applyResolve(incident, {
          opId: ids.next(),
          kind: 'resolve',
          at: directAt(incident, 'resolve', now),
          key: incident.key,
        });
        if (next && next.state === 'resolved') {
          tx.put('incidents', next);
          done.push(next);
        }
      }
      await pruneIncidents(tx);
      return done;
    });
    if (stored.ok) return stored.value;
    await failedWrite(errorOf(stored));
    return [];
  };

  /**
   * Sets or clears an open incident's dismissed flag. Answers the incident, or null when it's
   * resolved, missing, or the store won't take the write.
   * @param {string} id
   * @param {boolean} dismissed
   * @returns {Promise<Incident | null>}
   */
  const dismiss = async (id, dismissed) => {
    const now = clock.now();
    const stored = await write(['incidents'], async tx => {
      const incident = /** @type {Incident | undefined} */ (await tx.get('incidents', id));
      if (!incident) return null;
      const next = applyDismiss(incident, {
        opId: ids.next(),
        kind: 'dismiss',
        at: directAt(incident, 'dismiss', now),
        key: incident.key,
        dismissed,
      });
      if (!next || next === incident) return null;
      tx.put('incidents', next);
      return next;
    });
    if (stored.ok) return stored.value;
    await failedWrite(errorOf(stored));
    return null;
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
   * @returns {Promise<{recorded: true, receipt: HealthReceipt} | {recorded: false}>}
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
    if (stored.ok) return { recorded: true, receipt: stored.value };
    await failedWrite(errorOf(stored));
    return { recorded: false };
  };

  /**
   * Stores a remediation run, or its next state
   * @param {RemediationRun} item
   * @returns {Promise<{recorded: true, run: RemediationRun} | {recorded: false}>}
   */
  const putRun = async item => {
    const checked = parseRecord(runSchema, item, 'run');
    const stored = await write(['runs'], async tx => {
      tx.put('runs', checked);
      await pruneRuns(tx);
      return checked;
    });
    if (stored.ok) return { recorded: true, run: stored.value };
    await failedWrite(errorOf(stored));
    return { recorded: false };
  };

  /**
   * Appends a journal event the journal already checked
   * @param {Omit<JournalEvent, 'seq'>} event
   * @returns {Promise<{recorded: boolean}>}
   */
  const append = async event => {
    const checked = /** @type {Omit<JournalEvent, 'seq'>} */ (parseRecord(newEventSchema, event, 'journal event'));
    const stored = await write(['journal'], async tx => {
      await tx.append('journal', checked);
      await pruneJournal(tx);
    });
    if (stored.ok) return { recorded: true };
    await failedWrite(errorOf(stored));
    return { recorded: false };
  };

  /**
   * Opens NewTabNoteTrust, replays the settings copy and what memory holds, and prunes. When
   * it won't open, the records are in fallback, and every later write tries again. It never
   * rejects for a store that fails.
   * @returns {Promise<{ok: true} | {ok: false, code: string}>}
   */
  const open = async () => {
    triedOpenAt = Number.NEGATIVE_INFINITY;
    const can = await reachable();
    if (!can.ok) return { ok: false, code: currentFailure() || 'open-failed' };
    state = 'open';
    failureCode = null;
    try {
      const done = await write(
        ['incidents', 'journal'],
        async tx => {
          await pruneIncidents(tx);
          await pruneJournal(tx);
        },
        { withCopy: true },
      );
      if (!done.ok) await failedWrite(errorOf(done));
    } catch (error) {
      state = 'fallback';
      failureCode = codeOf(error);
    }
    const failed = currentFailure();
    return failed === null ? { ok: true } : { ok: false, code: failed };
  };

  // ============ Reads: the store, with the held storage incidents shown over it ============

  /**
   * What the store answers for `unit`, or `fallback` when it doesn't
   * @template T
   * @param {TrustStoreName} name
   * @param {T} fallback
   * @returns {Promise<T>}
   */
  const readAll = async (name, fallback) => {
    const stored = await run([name], 'readonly', tx => tx.getAll(name));
    return stored.ok ? /** @type {T} */ (copy(stored.value)) : fallback;
  };

  /** @returns {Promise<HealthReceipt[]>} every receipt, oldest first */
  const receipts = async () => /** @type {HealthReceipt[]} */ (await readAll('receipts', [])).sort(byTime('verifiedAt'));

  /** @returns {Promise<HealthReceipt[]>} each provider's latest receipt */
  const latestReceipts = async () => {
    /** @type {Map<string, HealthReceipt>} */
    const latest = new Map();
    for (const receipt of await receipts()) latest.set(receipt.providerId, receipt);
    return [...latest.values()];
  };

  /**
   * Every incident within its bounds, oldest first: the store's, with the held storage
   * incidents replayed over them as a write would
   * @returns {Promise<Incident[]>}
   */
  async function incidents() {
    /** @type {Map<string, Incident | undefined>} */
    const byKey = new Map(
      /** @type {Incident[]} */ (await readAll('incidents', [])).map(item => [item.key, item]),
    );
    if (held.size > 0 || usesCopy()) {
      const { ops } = await heldOps(usesCopy());
      for (const op of ops) byKey.set(op.key, applyOp(byKey.get(op.key), op, { track: true }));
    }
    const all = /** @type {Incident[]} */ ([...byKey.values()].filter(Boolean));
    return copy(all.filter(item => !resolvedTooLongAgo(item))).sort(byTime('firstSeenAt'));
  }

  /** @returns {Promise<RemediationRun[]>} every run, oldest first */
  const runs = async () => /** @type {RemediationRun[]} */ (await readAll('runs', [])).sort(byTime('startedAt'));

  /** @returns {Promise<JournalEvent[]>} every journal event within its bounds, oldest first */
  const events = async () => {
    const cutoff = clock.now() - BOUNDS.journalAgeMs;
    return /** @type {JournalEvent[]} */ (await readAll('journal', []))
      .filter(event => event.at >= cutoff)
      .slice(-BOUNDS.journalEvents);
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
  });
}

/** @typedef {ReturnType<typeof createTrustRecords>} TrustRecords */
