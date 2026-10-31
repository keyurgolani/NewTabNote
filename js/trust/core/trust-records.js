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
 *   except that the held storage incidents show over them: this context's and, read on every
 *   read and write, the settings copy's, whichever context wrote it.
 * - Only storage incidents are held: the latest sighting of each capture or storage key (at
 *   most HELD_KEYS of them, besides the records' own two), with the occurrences no store has
 *   counted, in memory and in the settings copy. NewTabNoteTrust failing to open in this
 *   context holds `storage/open-failed` for it (see below).
 * - Every failed write, whatever it wrote, counts one occurrence of `storage/write-failed`, and
 *   answers as not recorded (`recorded: false`). A failed sighting of a storage incident is
 *   also held itself, at a time no earlier than the store's record holds when the store can be
 *   read. Nothing else a failed write carried is kept: a provider's incidents come back on its
 *   next check, and the write-failed incident says how many writes failed.
 * - Every later write tries the store again, before it takes the copy's lock, so a slow open
 *   holds up no other context. A store that failed to open is tried at most every 30 seconds
 *   (RETRY_OPEN_MS), one the adapter answered `open-pending` for (still connecting) at most every
 *   second (PENDING_RETRY_MS), and a connection Chrome closed at once. Every write that succeeds
 *   replays the held storage incidents first, in its transaction, in fallback or not, so a
 *   healthy context also writes what a context that died held.
 * - `storage/open-failed/NewTabNoteTrust` is the records' own. It's held whenever this context
 *   finds the store won't open: open(), and every failed write while the store isn't open here,
 *   except while the adapter is still connecting, until that has lasted RETRY_OPEN_MS (then
 *   with `errorCode: 'open-pending'`), so its occurrences count failed writes while the store
 *   wasn't open here, not failed opens (each also sets the settings copy once more). The first
 *   write after the store opens in this context, the first time or after this context held a
 *   sighting, resolves the sightings no later than that open (`openedAt`), in the transaction
 *   that replays them; a later sighting, from a context that still can't open, stays open. A
 *   plain reconnect that never failed resolves nothing. No check resolves it, whatever its
 *   `looked` says, an entry for every subject included, and no check may observe
 *   `write-failed` (families.js), so the records' own two incidents resolve only here.
 * - Known limit: a fresh context's first open also resolves sightings from a context that's
 *   still stuck, until that context's next failed write sights it again. On a new-tab page
 *   fresh contexts are constant, so `open-failed` can read resolved between a stuck context's
 *   writes.
 * - Reads give each caller its own answer: `incidentsRead()` says whether its read of the
 *   settings copy answered (one that fails, or passes COPY_READ_MS when the host passes timers,
 *   doesn't) and whether its read of NewTabNoteTrust did, so the summary doesn't call anything
 *   safe that it couldn't read.
 * - A held sighting is unseen by definition: a copy entry's new count, or an occurrence only
 *   this context's memory holds, reopens a resolved incident and undismisses a dismissed one
 *   whatever the clocks say. A sighting that reached the lock after a resolve can so reopen it:
 *   a false alarm, never a false all clear.
 * - Known limit: the settings copy is the only channel between contexts. When
 *   chrome.storage.local takes no writes (over its quota, say) while reads still work, a
 *   context's failures stay in its own memory until its store takes a write, so another context
 *   can answer that nothing needs action while this one's writes fail, or call capture safe
 *   while this one holds a capture-risk incident.
 * - The settings copy holds one entry per key, which a context adds its occurrences to under
 *   Web Lock `trust.lastStorageIncident`; every write takes the same lock, replays the copy, and
 *   then removes only the entries it replayed. Each entry keeps the lineage of its first
 *   version, and the incident's `appliedOps` keeps each lineage with the highest count applied,
 *   so an entry replayed twice (because removing it failed, or a context died between the
 *   commit and the trim) adds only what's new. A copy this build can't read is left as it is,
 *   and counted as a failed write. Every extension context in Chrome has Web Locks; a host
 *   without them (`locks: null`, as some tests run) gets a lock inside this context only, so
 *   writes in one context still take turns, and across contexts relies on the lineages, which
 *   cover the copy's entries but not what one context's memory holds.
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
/** @typedef {import('./ports.js').Timers} Timers */
/** @typedef {import('./records.js').HealthReceipt} HealthReceipt */
/** @typedef {import('./records.js').Incident} Incident */
/** @typedef {import('./records.js').RemediationRun} RemediationRun */
/** @typedef {import('./records.js').JournalEvent} JournalEvent */
/** @typedef {import('./incidents.js').RaiseOp} RaiseOp */
/** @typedef {import('./incidents.js').Sighting} Sighting */
/** @typedef {import('./vocabulary.js').Severity} Severity */

/** How many capture and storage keys a context holds, besides the records' own two */
export const HELD_KEYS = 8;

/** How many entries the settings copy keeps */
export const COPY_ENTRIES = 16;

/** How long a read of the settings copy may take before it counts as unread, given timers */
export const COPY_READ_MS = 2_000;

/** The storage incident every failed write counts in */
export const WRITE_FAILED_KEY = incidentKey('storage', 'write-failed', null);

/** The storage incident a failed open() holds: NewTabNoteTrust itself won't open */
export const OPEN_FAILED_KEY = incidentKey('storage', 'open-failed', 'NewTabNoteTrust');

/** The records' own storage incidents, which the HELD_KEYS bound never turns away */
const OWN_KEYS = new Set([WRITE_FAILED_KEY, OPEN_FAILED_KEY]);

/**
 * How long a context whose store failed to open waits before a write tries to open it again,
 * and how long an open may stay pending before it counts as failed
 */
export const RETRY_OPEN_MS = 30_000;

/** How long a write waits to ask again after the adapter answered that it's still connecting */
export const PENDING_RETRY_MS = 1_000;

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

/**
 * Whether `error` is the adapter's answer for a connection still being made
 * @param {unknown} error
 */
const stillOpening = error => error instanceof UnavailableError && error.code === 'open-pending';

/** @param {string} provider */
const isStorageProvider = provider => /** @type {readonly string[]} */ (STORAGE_PROVIDERS).includes(provider);

/**
 * @param {{
 *   store: TrustStore,
 *   settings: SettingsPort,
 *   clock: Clock,
 *   ids: Ids,
 *   locks?: Locks | null,
 *   timers?: Timers | null,
 * }} options - `timers` bound the settings copy's reads; without them a read waits as long as
 *   the settings area does
 */
export function createTrustRecords({ store, settings, clock, ids, locks = null, timers = null }) {
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
  /** Keys with a hold in flight, by how many, which settle() leaves in memory */
  /** @type {Map<string, number>} */
  const holding = new Map();
  /** @type {Promise<string> | null} */
  let installing = null;
  /** When the store first opened in this context, or null */
  /** @type {number | null} */
  let openedAt = null;
  /** Set when the store first opens in this context: the next write resolves open-failed */
  let resolveOpenFailed = false;
  /** Whether this context held an open-failed sighting since the store last opened here */
  let heldOpenFailed = false;
  /** Since when the adapter has answered that it's still connecting, or null */
  /** @type {number | null} */
  let pendingSince = null;
  /** The copy lock inside this context, for a host without Web Locks */
  /** @type {Promise<unknown>} */
  let localTurn = Promise.resolve();

  // ============ Held storage incidents ============

  /**
   * Runs `run` under the copy's Web Lock, when the host has locks
   * @template T
   * @param {() => Promise<T>} run
   * @returns {Promise<T>}
   */
  const underCopyLock = run => {
    if (locks) return locks.request(COPY_LOCK, run);
    const turn = localTurn.then(run);
    localTurn = turn.catch(() => {});
    return turn;
  };

  /**
   * The settings area's answer for `keys`, or an UnavailableError once COPY_READ_MS pass, when
   * the host passed timers
   * @param {string[]} keys
   * @returns {Promise<Record<string, unknown>>}
   */
  const boundedGet = keys => {
    const got = settings.get(keys);
    if (!timers) return got;
    const bound = timers;
    return new Promise((resolve, reject) => {
      const handle = bound.set(() => reject(new UnavailableError('storage', 'timed-out', true)), COPY_READ_MS);
      got.then(
        value => {
          bound.clear(handle);
          resolve(value);
        },
        error => {
          bound.clear(handle);
          reject(error);
        },
      );
    });
  };

  /**
   * The settings copy's entries. Rejects when the settings area can't be read, or holds a copy
   * this build can't read, which is left as it is rather than written over.
   * @returns {Promise<RaiseOp[]>}
   */
  const readCopy = async () => {
    const key = SETTINGS_KEYS.lastStorageIncident;
    const stored = (await boundedGet([key]))[key];
    if (stored === undefined || stored === null) return [];
    if (!v.is(storageCopySchema, stored)) throw new UnavailableError('storage', 'unreadable', false);
    return [.../** @type {StorageCopy} */ (stored).entries];
  };

  /**
   * Adds this context's uncounted occurrences of `entry`, and one more, to its key's entry in
   * the settings copy, which keeps its lineage. Answers whether it did, and whether the copy
   * was unreadable, so memory counts the occurrence instead.
   * @param {Held} entry
   * @returns {Promise<{ok: boolean, unreadable: boolean}>}
   */
  const addToCopy = entry =>
    underCopyLock(async () => {
      /** @type {RaiseOp[]} */
      let entries;
      try {
        entries = await readCopy();
      } catch (error) {
        return { ok: false, unreadable: error instanceof UnavailableError && error.code === 'unreadable' };
      }
      const current = entries.find(item => item.key === entry.key);
      const rest = entries.filter(item => item !== current);
      if (rest.length + 1 > COPY_ENTRIES) return { ok: false, unreadable: false };
      const newer = !current || entry.at >= current.at;
      const opId = ids.next();
      /** @type {RaiseOp} */
      const next = {
        opId,
        kind: 'raise',
        at: newer ? entry.at : /** @type {RaiseOp} */ (current).at,
        key: entry.key,
        incidentId: current ? current.incidentId : entry.incidentId,
        sighting: newer ? entry.sighting : /** @type {RaiseOp} */ (current).sighting,
        count: (current ? current.count : 0) + entry.remainder + 1,
        lineage: current ? current.lineage : opId,
      };
      await settings.set({ [SETTINGS_KEYS.lastStorageIncident]: { entries: [...rest, next] } });
      entry.incidentId = next.incidentId;
      entry.copied = next.opId;
      entry.remainder = 0;
      return { ok: true, unreadable: false };
    }).catch(() => ({ ok: false, unreadable: false }));

  /**
   * Holds one sighting of storage incident `key`: in the copy, or counted in memory when the
   * copy can't take it. Its time is no earlier than what the store's record holds, when the
   * store can be read, so a clock that stepped back can't file it behind a resolution. Answers
   * null when this context already holds HELD_KEYS other keys, besides the records' own.
   * @param {string} key
   * @param {Sighting} sighting
   * @param {number} at
   * @param {{counted?: boolean}} [options] - the operation already counted its failed write
   * @returns {Promise<Held | null>}
   */
  const holdSighting = async (key, sighting, at, { counted = false } = {}) => {
    holding.set(key, (holding.get(key) || 0) + 1);
    try {
      // A store that isn't open here isn't asked again just to time the sighting
      const stored = opened
        ? await run(['incidents'], 'readonly', async tx => (await tx.getAllByIndex('incidents', 'key', key))[0])
        : { ok: false };
      const when = stored.ok
        ? directAt(/** @type {Incident | undefined} */ (/** @type {{value: unknown}} */ (stored).value), 'raise', at)
        : at;
      let entry = held.get(key);
      if (!entry) {
        const others = [...held.keys()].filter(item => !OWN_KEYS.has(item)).length;
        if (!OWN_KEYS.has(key) && others >= HELD_KEYS) return null;
        entry = { key, incidentId: ids.next(), at: when, sighting, copied: null, remainder: 0, remainderId: ids.next() };
        held.set(key, entry);
      } else if (when >= entry.at) {
        entry.at = when;
        entry.sighting = sighting;
      }
      const added = await addToCopy(entry);
      if (!added.ok) entry.remainder += 1;
      // A copy this build can't read is a failed write too, unless the operation counted one
      if (added.unreadable && key !== WRITE_FAILED_KEY && !counted) {
        const failed = held.get(WRITE_FAILED_KEY);
        if (failed) failed.remainder += 1;
        else held.set(WRITE_FAILED_KEY, { ...writeFailedEntry(when, 'unreadable'), remainder: 1 });
      }
      return entry;
    } finally {
      const left = (holding.get(key) || 1) - 1;
      if (left > 0) holding.set(key, left);
      else holding.delete(key);
    }
  };

  /**
   * A fresh held entry for `storage/write-failed`
   * @param {number} at
   * @param {string} errorCode
   * @returns {Held}
   */
  const writeFailedEntry = (at, errorCode) => ({
    key: WRITE_FAILED_KEY,
    incidentId: ids.next(),
    at,
    sighting: writeFailedSighting(errorCode),
    copied: null,
    remainder: 0,
    remainderId: ids.next(),
  });

  /**
   * @param {string} errorCode
   * @returns {Sighting}
   */
  const writeFailedSighting = errorCode => ({
    providerId: 'storage',
    faultCode: 'write-failed',
    subjectId: null,
    severity: 'data-risk',
    affected: [],
    preserved: [],
    evidence: /** @type {Sighting['evidence']} */ (checkEvidence({ errorCode }).ok ? { errorCode } : {}),
  });

  /**
   * Counts a write that failed with `error` in `storage/write-failed`, and notes the fallback
   * @param {unknown} error
   */
  const failedWrite = async error => {
    if (state !== 'fallback') failureCode = codeOf(error);
    state = 'fallback';
    await holdSighting(WRITE_FAILED_KEY, writeFailedSighting(codeOf(error)), clock.now());
    // It failed because the store won't open here: so is NewTabNoteTrust's own incident
    if (openFails(error)) await holdOpenFailed(error, true);
  };

  /**
   * Whether `error` says the store won't open in this context: it isn't open, and the adapter
   * isn't still connecting, or has been for RETRY_OPEN_MS
   * @param {unknown} error
   */
  const openFails = error =>
    !opened &&
    (!stillOpening(error) || (pendingSince !== null && clock.now() - pendingSince >= RETRY_OPEN_MS));

  /**
   * Holds a sighting of `storage/open-failed/NewTabNoteTrust`
   * @param {unknown} error
   * @param {boolean} counted - the operation already counted its failed write
   */
  const holdOpenFailed = async (error, counted) => {
    heldOpenFailed = true;
    const errorCode = codeOf(error);
    await holdSighting(
      OPEN_FAILED_KEY,
      {
        providerId: 'storage',
        faultCode: 'open-failed',
        subjectId: 'NewTabNoteTrust',
        severity: 'data-risk',
        affected: [],
        preserved: [],
        evidence: /** @type {Sighting['evidence']} */ (checkEvidence({ errorCode }).ok ? { errorCode } : {}),
      },
      clock.now(),
      { counted },
    );
  };

  /**
   * The held storage sightings to replay: the settings copy's entries, which other contexts may
   * have written and which replay by lineage, and this context's uncounted occurrences
   * @returns {Promise<{ops: RaiseOp[], copied: RaiseOp[], tracked: Set<string>, read: boolean}>}
   */
  const heldOps = async () => {
    /** @type {RaiseOp[]} */
    let copied = [];
    let read = true;
    try {
      copied = await readCopy();
    } catch {
      read = false;
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
        lineage: entry.remainderId,
      }));
    return {
      ops: /** @type {RaiseOp[]} */ (inOrder([...copied, ...remainders])),
      copied,
      tracked: new Set(copied.map(entry => entry.opId)),
      read,
    };
  };

  /**
   * After a write that replayed `ops` committed: memory forgets the occurrences it replayed,
   * and the copy loses the entries it replayed, only if they're still the ones it read. An
   * entry this context wrote that the copy (when `read`) no longer has was replayed, or taken
   * into a later version, by another context, so memory forgets it too. A key with a hold in
   * flight stays in memory.
   * @param {RaiseOp[]} ops
   * @param {RaiseOp[]} copied
   * @param {boolean} read - whether `copied` is what the copy held
   */
  const settle = async (ops, copied, read) => {
    const replayed = new Set(ops.map(op => op.opId));
    const inCopy = new Set(copied.map(entry => entry.opId));
    for (const entry of held.values()) {
      if (replayed.has(entry.remainderId)) {
        entry.remainder -= /** @type {RaiseOp} */ (ops.find(op => op.opId === entry.remainderId)).count;
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
        // The copy keeps them, and replaying them again adds nothing (their lineage is applied)
      }
    }
    for (const [key, entry] of held) {
      if (entry.remainder <= 0 && entry.copied === null && !holding.has(key)) held.delete(key);
    }
  };

  // ============ The store ============

  /**
   * Whether the store can be tried: it's open in this context, or it opens now. A store that
   * failed to open is tried again at most every RETRY_OPEN_MS, and one still connecting at most
   * every PENDING_RETRY_MS.
   * @returns {Promise<{ok: true} | {ok: false, error: unknown}>}
   */
  const reachable = async () => {
    if (opened) return { ok: true };
    const wait = pendingSince === null ? RETRY_OPEN_MS : PENDING_RETRY_MS;
    if (clock.now() - triedOpenAt < wait) {
      const code = pendingSince === null ? currentFailure() || 'open-failed' : 'open-pending';
      return { ok: false, error: new UnavailableError('storage', code, true) };
    }
    triedOpenAt = clock.now();
    try {
      await store.open();
      opened = true;
      pendingSince = null;
      // The first open here, or one after this context sighted open-failed, vouches for the
      // sightings before it
      if (openedAt === null || heldOpenFailed) {
        openedAt = clock.now();
        resolveOpenFailed = true;
        heldOpenFailed = false;
      }
      return { ok: true };
    } catch (error) {
      if (state !== 'fallback') failureCode = codeOf(error);
      state = 'fallback';
      // Still connecting: the adapter answers as soon as the connection is up, so a write asks
      // again soon; anything else waits the full RETRY_OPEN_MS
      if (stillOpening(error)) {
        if (pendingSince === null) pendingSince = triedOpenAt;
      } else {
        pendingSince = null;
      }
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
   * A write: the held storage sightings (the settings copy's, whichever context wrote them, and
   * this context's) replay first, then `unit`, in one transaction, under the copy's lock. Once
   * it commits the records are open again. A write that fails is counted in
   * `storage/write-failed` by its caller (failedWrite), outside the copy's lock.
   * @template T
   * @param {readonly TrustStoreName[]} stores
   * @param {(tx: TrustTx) => Promise<T>} unit
   * @returns {Promise<{ok: true, value: T} | {ok: false, error: unknown}>}
   */
  const write = async (stores, unit) => {
    const go = async () => {
      const { ops, copied, tracked, read } = await heldOps();
      const ending = resolveOpenFailed;
      const names = /** @type {TrustStoreName[]} */ ([
        ...new Set([
          ...stores,
          ...(ops.length > 0 ? /** @type {TrustStoreName[]} */ (['incidents', 'journal']) : []),
          ...(ending ? /** @type {TrustStoreName[]} */ (['incidents']) : []),
        ]),
      ]);
      const done = await run(names, 'readwrite', async tx => {
        if (ops.length > 0) await replay(tx, ops, tracked);
        if (ending) await resolveOwnOpenFailed(tx);
        return unit(tx);
      });
      if (!done.ok) return done;
      if (ending) resolveOpenFailed = false;
      state = 'open';
      failureCode = null;
      await settle(ops, copied, read);
      return done;
    };
    // Opening goes first, outside the lock, so a pending open holds up no other context
    const can = await reachable();
    if (!can.ok) return { ok: false, error: errorOf(can) };
    return underCopyLock(go);
  };

  /**
   * Resolves `storage/open-failed/NewTabNoteTrust`, which the records raise themselves, once the
   * store has first opened in this context: after the replay, so a held sighting of it is
   * counted first, and only when every sighting is no later than that open, since a later one
   * is a context that still can't open
   * @param {TrustTx} tx
   */
  const resolveOwnOpenFailed = async tx => {
    const [existing] = /** @type {Incident[]} */ (await tx.getAllByIndex('incidents', 'key', OPEN_FAILED_KEY));
    if (!existing || existing.state === 'resolved') return;
    if (openedAt === null || existing.lastSeenAt > openedAt) return;
    const next = applyResolve(existing, {
      opId: ids.next(),
      kind: 'resolve',
      at: directAt(existing, 'resolve', clock.now()),
      key: OPEN_FAILED_KEY,
    });
    if (next && next.state === 'resolved') tx.put('incidents', parseRecord(incidentSchema, next, 'incident'));
  };

  /**
   * Replays `ops` in `tx`, through the reducer, and journals how many. The copy's entries
   * (`tracked`) replay by lineage; this context's own occurrences replay as they are.
   * @param {TrustTx} tx
   * @param {RaiseOp[]} ops
   * @param {Set<string>} tracked
   */
  const replay = async (tx, ops, tracked) => {
    /** @type {Map<string, Incident | undefined>} */
    const touched = new Map();
    for (const op of ops) {
      const before = touched.has(op.key)
        ? touched.get(op.key)
        : /** @type {Incident | undefined} */ ((await tx.getAllByIndex('incidents', 'key', op.key))[0]);
      touched.set(op.key, applyOp(before, op, { track: tracked.has(op.opId), unseen: true }));
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
    const entry = await holdSighting(key, sighting, now, { counted: true });
    const shown = entry ? (await incidents()).find(item => item.key === key) || null : null;
    return { recorded: false, held: entry !== null, incident: shown, created: false };
  };

  /**
   * Resolves the provider's open incidents whose key isn't in `still`. Answers the ones it
   * resolved, or `recorded: false` when the store won't take the write, which isn't "nothing to
   * resolve". A check passes `looked`, what it really looked at (checks.js), so only those
   * incidents resolve, never the records' own (`open-failed` for NewTabNoteTrust and
   * `write-failed`), and `seenBy`, when it started, so a sighting from while it ran stays.
   * @param {string} provider
   * @param {readonly string[]} still - keys of the faults the check still reports
   * @param {{looked?: readonly {faultCode: string, subjectId?: string | null}[], seenBy?: number}} [options]
   * @returns {Promise<{recorded: true, resolved: Incident[]} | {recorded: false}>}
   */
  const resolve = async (provider, still, { looked, seenBy } = {}) => {
    const now = clock.now();
    const stored = await write(['incidents'], async tx => {
      const open = [
        ...(/** @type {Incident[]} */ (await tx.getAllByIndex('incidents', 'state', 'open'))),
        ...(/** @type {Incident[]} */ (await tx.getAllByIndex('incidents', 'state', 'remediating'))),
      ].filter(
        incident =>
          incident.providerId === provider &&
          !still.includes(incident.key) &&
          (seenBy === undefined || incident.lastSeenAt <= seenBy) &&
          (!looked ||
            (!OWN_KEYS.has(incident.key) &&
              looked.some(
              item =>
                item.faultCode === incident.faultCode &&
                  (item.subjectId === undefined || item.subjectId === incident.subjectId),
              ))),
      );
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
    if (stored.ok) return { recorded: true, resolved: stored.value };
    await failedWrite(errorOf(stored));
    return { recorded: false };
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
      const stored = (await boundedGet([key]))[key];
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
   * Appends a journal event the journal already checked. An `internal` event (one the trust
   * code writes about itself, such as a refusal count) that fails isn't counted in
   * `storage/write-failed`, so one failed operation counts once.
   * @param {Omit<JournalEvent, 'seq'>} event
   * @param {{internal?: boolean}} [options]
   * @returns {Promise<{recorded: boolean}>}
   */
  const append = async (event, { internal = false } = {}) => {
    const checked = /** @type {Omit<JournalEvent, 'seq'>} */ (parseRecord(newEventSchema, event, 'journal event'));
    const stored = await write(['journal'], async tx => {
      await tx.append('journal', checked);
      await pruneJournal(tx);
    });
    if (stored.ok) return { recorded: true };
    if (internal) {
      if (state !== 'fallback') failureCode = codeOf(errorOf(stored));
      state = 'fallback';
    } else {
      await failedWrite(errorOf(stored));
    }
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
    if (!can.ok) {
      const error = errorOf(can);
      // The scope's own case: NewTabNoteTrust won't open, so its storage incident is held. One
      // still connecting (the adapter answered within its 5 s, and keeps connecting) holds
      // nothing yet, and a write asks again soon.
      if (openFails(error)) await holdOpenFailed(error, false);
      return { ok: false, code: stillOpening(error) ? 'open-pending' : currentFailure() || 'open-failed' };
    }
    state = 'open';
    failureCode = null;
    try {
      const done = await write(
        ['incidents', 'journal'],
        async tx => {
          await pruneIncidents(tx);
          await pruneJournal(tx);
        },
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

  /**
   * What the store answers for `name`, and whether it answered
   * @param {TrustStoreName} name
   * @returns {Promise<{rows: unknown[], ok: boolean}>}
   */
  const readRows = async name => {
    const stored = await run([name], 'readonly', tx => tx.getAll(name));
    return stored.ok ? { rows: copy(/** @type {unknown[]} */ (stored.value)), ok: true } : { rows: [], ok: false };
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
   * incidents replayed over them as a write would. `copyRead` and `recordsRead` say whether this
   * read of the settings copy, and of NewTabNoteTrust, answered: when either didn't, incidents
   * may be missing, so nothing should be called safe.
   * @returns {Promise<{incidents: Incident[], copyRead: boolean, recordsRead: boolean}>}
   */
  async function incidentsRead() {
    const stored = await readRows('incidents');
    /** @type {Map<string, Incident | undefined>} */
    const byKey = new Map(/** @type {Incident[]} */ (stored.rows).map(item => [item.key, item]));
    const { ops, tracked, read } = await heldOps();
    for (const op of ops) {
      byKey.set(op.key, applyOp(byKey.get(op.key), op, { track: tracked.has(op.opId), unseen: true }));
    }
    const all = /** @type {Incident[]} */ ([...byKey.values()].filter(Boolean));
    return {
      incidents: copy(all.filter(item => !resolvedTooLongAgo(item))).sort(byTime('firstSeenAt')),
      copyRead: read,
      recordsRead: stored.ok,
    };
  }

  /**
   * Every incident within its bounds, oldest first, as incidentsRead() gives them
   * @returns {Promise<Incident[]>}
   */
  async function incidents() {
    return (await incidentsRead()).incidents;
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
    incidentsRead,
    runs,
    events,
    /** @returns {RecordsState} */
    state: () => state,
    /** @returns {string | null} why NewTabNoteTrust isn't taking writes, as a code */
    failureCode: () => failureCode,
  });
}

/** @typedef {ReturnType<typeof createTrustRecords>} TrustRecords */
