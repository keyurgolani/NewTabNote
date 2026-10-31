/**
 * The recovery-point purge (#17 PR 2b, Q16): deletion must delete. A note deleted for good,
 * or a folder deleted, leaves a tombstone in the delete's own transaction (deletion.js), and
 * this purges every row the tombstone's entity owns from every recovery point in
 * NewTabNoteRecovery, the pinned one included, so nothing deleted comes back through Settings'
 * pre-update export, or any restore from a point.
 *
 * Only the service worker runs it, under Web Lock `storage.migrate` held exclusive, as the
 * migration runner is, so it never interleaves with a copy, a verification, or keepVerified,
 * and a reader of points (legacy-export.js) takes the lock shared, so it never reads a point
 * between two of its batches. The worker sweeps once its run is in, at every start, and when a
 * page that deleted something wakes it (`storage.purge`). The worker root's
 * PURGE_RECOVERY_POINTS switch turns it off.
 *
 * One sweep handles every pending tombstone at once:
 * 1. Read the pending tombstones (the `purge` index). None: nothing to do.
 * 2. For each point, oldest first, take the tombstones of deletes after it was made. A point
 *    made at or after a delete holds nothing that delete took, so its rows under that id are a
 *    note made again since, which stays.
 * 3. Find the rows those tombstones' entities own (OWNERS), by key or by a field of the row,
 *    read in bounded readonly batches. A point that holds none is done, unread past that.
 * 4. Verify a point that holds some. One that doesn't verify is left as it was, with every
 *    tombstone still pending: the purge never purges a point it can't check, and never
 *    discards one. The points after it are still purged.
 * 5. Purge them in strict batches of at most 100 rows or 2 MB (recovery-points.js's
 *    purgeRows), each of which leaves the point verifying, and verify the point again after
 *    each. A point that doesn't verify after a batch gets that batch back, rows and record, so
 *    it's as it was before the batch, which it verified as, and the purge leaves that point.
 * 6. Once every point is purged, the tombstones lose their `purge` field (deletion.js).
 * Cut off anywhere, the next sweep finishes the rest: a batch commits whole or not at all, and a
 * tombstone stays pending until every point is purged of it.
 *
 * A sweep records each point it left, in `meta` (PURGE_STOP_KEY: the point's id, the code, when,
 * and the point as it was), and every later sweep backs off that point, reading none of it,
 * until it changes: verified again, say, or dropped. The other points go on being purged. The
 * worker root journals each stop and its end (`storage.purge-stopped`, `storage.purge-completed`),
 * with ids and codes only.
 *
 * Only a tombstone drives it, never a difference between a point and the live database, since
 * a point exists to recover what the live database lost, and a note that's in a point but
 * missing from CanvasTabDB can't be told apart from lost data. What it records of a purge is
 * the purged rows' keys, ids, in their store's `purged` list, never content.
 *
 * Left as they are: a note deleted on a database below version 10, which has no tombstones,
 * stays in its point (#17 PR 2b's declared gap), and so does deleted text in
 * chrome.storage.local's `auto_backup_*` and `recovery_backup_*` keys (#18).
 */

import { markPurged, pendingTombstones } from './deletion.js';
import { failureOf } from './failures.js';
import { approximateBytes } from './records.js';
import {
  DEFAULT_LIMITS,
  POINTS_LOCK,
  ROWS_STORE,
  listPoints,
  openRecovery,
  purgeRows,
  readBatch,
  restoreRows,
  rowRange,
  verifyPoint,
} from './recovery-points.js';
import { META_STORE } from './registry.js';
import { result } from './requests.js';
import { DB_NAME } from './schema.js';
import { openWithoutUpgrade } from './shapes.js';

/** @typedef {import('./recovery-points.js').Point} Point */
/** @typedef {import('./recovery-points.js').PointRow} PointRow */
/** @typedef {import('./recovery-points.js').Io} Io */
/** @typedef {import('./recovery-points.js').Limits} Limits */
/** @typedef {import('./records.js').Digester} Digester */
/** @typedef {import('../../core/domain/tombstone.js').TombstoneRecord} TombstoneRecord */
/** @typedef {import('../../core/domain/tombstone.js').TombstoneEntity} TombstoneEntity */
/** @typedef {import('../../core/ports/runtime.js').Clock} Clock */
/** @typedef {import('../../core/ports/runtime.js').Logger} Logger */

/**
 * Which entity owns a row of each store a point copies: the one its key names, or the one a
 * field of its value names. A store not listed holds nothing of a deleted note's or folder's:
 * `themes`, `meta`, `migrations`, and step 10's content-free stores.
 * @type {Readonly<Record<string, Readonly<{entity: TombstoneEntity, fields: readonly string[] | null}>>>}
 */
export const OWNERS = Object.freeze({
  canvases: Object.freeze({ entity: 'note', fields: null }),
  search_index: Object.freeze({ entity: 'note', fields: null }),
  vectors: Object.freeze({ entity: 'note', fields: null }),
  elements: Object.freeze({ entity: 'note', fields: Object.freeze(['canvasId']) }),
  media: Object.freeze({ entity: 'note', fields: Object.freeze(['canvasId']) }),
  snapshots: Object.freeze({ entity: 'note', fields: Object.freeze(['noteId']) }),
  links: Object.freeze({ entity: 'note', fields: Object.freeze(['fromNoteId', 'toNoteId']) }),
  conflicts: Object.freeze({ entity: 'note', fields: Object.freeze(['noteId']) }),
  folders: Object.freeze({ entity: 'folder', fields: null }),
});

/**
 * Web Locks, or anything with its request(name, options, callback)
 * @typedef {{request: (name: string, options: {mode: 'exclusive'}, callback: () => Promise<any>) => Promise<any>}} PurgeLocks
 */

/**
 * Where to wait between steps, so a test can stop the worker there
 * @typedef {{between?: (label: string) => void | Promise<void>}} PurgeHooks
 */

/**
 * @typedef {object} PurgeOptions
 * @property {IDBFactory} indexedDB
 * @property {typeof IDBKeyRange} keyRange - from the same IndexedDB as `indexedDB`
 * @property {PurgeLocks} locks
 * @property {Digester} crypto
 * @property {Clock} clock
 * @property {Logger} logger
 * @property {PurgeHooks} [hooks]
 * @property {Limits} [limits]
 */

/**
 * - `purged`: every pending tombstone's entity is out of every point, and the tombstones say so
 * - `nothing`: no tombstone was pending
 * - `stopped`: a point didn't verify, before a batch or after one, and was left as it was, while
 *   the points that verify were purged; the tombstones stay pending. Also what a sweep answers
 *   that backed off a point it left before (`stops`, `backedOff`).
 * - `failed`: IndexedDB or the lock failed; the tombstones stay pending
 * @typedef {'purged' | 'nothing' | 'stopped' | 'failed'} PurgeStatus
 */

/**
 * @typedef {object} PurgeOutcome
 * @property {PurgeStatus} status
 * @property {number} tombstones - the pending ones the sweep took
 * @property {number} rows - the rows it purged from the points
 * @property {{code: string, pointId: string | null} | null} failure - the first point it left,
 *   or what failed
 * @property {Array<{pointId: string, code: string, backedOff: boolean}>} stops - each point it
 *   left as it was, and whether it backed off one a sweep left before, reading none of it,
 *   since the point is as it was then
 * @property {boolean} backedOff - every point it left was one it backed off
 * @property {string[]} cleared - each point a recorded stop named, once this sweep purged it or
 *   found it gone
 */

/**
 * @param {Partial<PurgeOutcome> & {status: PurgeStatus}} fields
 * @returns {PurgeOutcome}
 */
const outcome = fields => ({
  tombstones: 0,
  rows: 0,
  failure: null,
  stops: [],
  backedOff: false,
  cleared: [],
  ...fields,
});

/** `meta`'s record of the points sweeps left, which later sweeps back off */
export const PURGE_STOP_KEY = 'purge-stop';

/**
 * A point a sweep left: its id, the code, when, and the point as it was then (stampOf)
 * @typedef {{pointId: string, code: string, at: number, point: string}} StopEntry
 */

/**
 * @typedef {{key: typeof PURGE_STOP_KEY, stops: StopEntry[]}} StopRecord
 */

/** @type {IDBTransactionOptions} */
const STRICT = Object.freeze({ durability: 'strict' });

/**
 * What changes when a point is made, verified, or dropped: each point's id and status. A purge
 * batch changes neither.
 * @param {readonly Point[]} points
 * @returns {string}
 */
export function stampOf(points) {
  return points
    .map(point => `${point.id}:${point.status}`)
    .sort()
    .join(',');
}

/**
 * The points sweeps left, as recorded
 * @param {IDBDatabase} db - CanvasTabDB
 * @returns {Promise<StopEntry[]>}
 */
async function readStops(db) {
  if (!db.objectStoreNames.contains(META_STORE)) return [];
  const tx = db.transaction(META_STORE, 'readonly');
  const stored = /** @type {StopRecord | undefined} */ (await result(tx.objectStore(META_STORE).get(PURGE_STOP_KEY)));
  if (!stored || !Array.isArray(stored.stops)) return [];
  return stored.stops.filter(
    entry =>
      entry && typeof entry.pointId === 'string' && typeof entry.code === 'string' && typeof entry.point === 'string',
  );
}

/** The points `stops` names, each with its code and as it was, in one order */
const keyOfStops = (/** @type {StopEntry[]} */ stops) =>
  JSON.stringify(stops.map(({ pointId, code, point }) => [pointId, code, point]).sort());

/**
 * Puts `stops` as the points sweeps left, or drops the record when there are none, in one
 * strict transaction
 * @param {IDBFactory} indexedDB
 * @param {StopEntry[]} stops
 */
async function recordStops(indexedDB, stops) {
  const db = await openWithoutUpgrade(indexedDB, DB_NAME);
  if (!db) return;
  try {
    if (!db.objectStoreNames.contains(META_STORE)) return;
    const tx = db.transaction(META_STORE, 'readwrite', STRICT);
    const done = new Promise((resolve, reject) => {
      tx.addEventListener('complete', () => resolve(undefined));
      tx.addEventListener('abort', () => reject(tx.error || new DOMException('The transaction aborted', 'AbortError')));
    });
    if (stops.length > 0) tx.objectStore(META_STORE).put(/** @type {StopRecord} */ ({ key: PURGE_STOP_KEY, stops }));
    else tx.objectStore(META_STORE).delete(PURGE_STOP_KEY);
    await done;
  } finally {
    db.close();
  }
}

/** Thrown inside a sweep when a point doesn't verify, so the sweep leaves that point where it is */
class Stop extends Error {
  /**
   * @param {string} code
   * @param {string} pointId
   */
  constructor(code, pointId) {
    super(code);
    this.code = code;
    this.pointId = pointId;
  }
}

/**
 * The ids each kind of entity has pending among `tombstones`
 * @param {readonly TombstoneRecord[]} tombstones
 * @returns {Record<TombstoneEntity, Set<string>>}
 */
function doomedOf(tombstones) {
  /** @type {Record<TombstoneEntity, Set<string>>} */
  const doomed = { note: new Set(), folder: new Set() };
  for (const { entityType, id } of tombstones) {
    if (Object.hasOwn(doomed, entityType) && typeof id === 'string') doomed[entityType].add(id);
  }
  return doomed;
}

/**
 * Whether `tombstone`'s delete came after `point` was made, so the point can hold what it took.
 * A point started at or after the delete copied the database without it: rows it holds under
 * that id belong to a note made again since. A copy started before the delete is still purged.
 * @param {TombstoneRecord} tombstone
 * @param {Point} point
 */
function deletedAfter(tombstone, point) {
  const deletedAt = typeof tombstone.deletedAt === 'number' ? tombstone.deletedAt : Infinity;
  const createdAt = typeof point.createdAt === 'number' ? point.createdAt : -Infinity;
  return createdAt < deletedAt;
}

/**
 * Whether `row`'s value names one of `ids` in one of `fields`
 * @param {PointRow} row
 * @param {readonly string[]} fields
 * @param {Set<string>} ids
 */
function owned(row, fields, ids) {
  const value = /** @type {Record<string, unknown> | null} */ (
    row.value && typeof row.value === 'object' ? row.value : null
  );
  return (
    Boolean(value) &&
    fields.some(field => typeof value?.[field] === 'string' && ids.has(/** @type {string} */ (value[field])))
  );
}

/**
 * The rows of `store` in `point` under `keys`, read in one readonly transaction
 * @param {IDBDatabase} recovery
 * @param {Point} point
 * @param {string} store
 * @param {readonly IDBValidKey[]} keys
 * @returns {Promise<PointRow[]>}
 */
async function rowsByKey(recovery, point, store, keys) {
  const tx = recovery.transaction(ROWS_STORE, 'readonly');
  const rows = tx.objectStore(ROWS_STORE);
  const found = await Promise.all(keys.map(key => result(rows.get([point.id, store, key]))));
  return /** @type {PointRow[]} */ (found.filter(Boolean));
}

/**
 * Which of `keys` `point` holds rows of `store` under, in one readonly transaction
 * @param {IDBDatabase} recovery
 * @param {Point} point
 * @param {string} store
 * @param {readonly string[]} keys
 * @returns {Promise<string[]>}
 */
async function heldKeys(recovery, point, store, keys) {
  const tx = recovery.transaction(ROWS_STORE, 'readonly');
  const rows = tx.objectStore(ROWS_STORE);
  const counts = await Promise.all(keys.map(key => result(rows.count([point.id, store, key]))));
  return keys.filter((_, index) => counts[index] > 0);
}

/**
 * The keys of the rows `point` holds of what `doomed` names, store by store, each with the
 * row's approximate size, so the purge reads them back in bounded batches. Rows owned by key
 * are counted, never read; rows owned by a field are read in bounded readonly batches and kept
 * only by key.
 * @param {{recovery: IDBDatabase, point: Point, doomed: Record<TombstoneEntity, Set<string>>, io: Io}} options
 * @returns {Promise<Array<{store: string, keys: Array<{key: IDBValidKey, bytes: number}>}>>}
 */
async function matchesIn({ recovery, point, doomed, io }) {
  /** @type {Array<{store: string, keys: Array<{key: IDBValidKey, bytes: number}>}>} */
  const matches = [];
  for (const store of point.stores) {
    if (!Object.hasOwn(OWNERS, store)) continue;
    const { entity, fields } = OWNERS[store];
    const ids = doomed[entity];
    if (ids.size === 0) continue;
    /** @type {Array<{key: IDBValidKey, bytes: number}>} */
    const keys = [];
    if (fields === null) {
      const all = [...ids];
      for (let from = 0; from < all.length; from += io.limits.records) {
        for (const key of await heldKeys(recovery, point, store, all.slice(from, from + io.limits.records))) {
          // Read back one batch of these at a time, which holds a record each
          keys.push({ key, bytes: 0 });
        }
      }
    } else {
      /** @type {IDBValidKey | null} */
      let after = null;
      const range = rowRange(io.keyRange, point.id, store);
      for (;;) {
        const read = await readBatch(recovery, ROWS_STORE, after, range, io);
        for (const { value } of read.entries) {
          const row = /** @type {PointRow} */ (value);
          if (owned(row, fields, ids))
            keys.push({ key: row.key, bytes: approximateBytes(row.value) + approximateBytes(row.key) });
        }
        if (read.entries.length > 0) after = read.entries[read.entries.length - 1].key;
        if (read.end || read.entries.length === 0) break;
      }
    }
    if (keys.length > 0) matches.push({ store, keys });
  }
  return matches;
}

/**
 * Purges one point of what the tombstones of deletes after it was made name, batch by batch.
 * It reads the point whole only when it holds some of that: verified before the first batch
 * and after each. Answers the number of rows it purged. Throws Stop when it doesn't verify.
 * @param {{recovery: IDBDatabase, point: Point, tombstones: readonly TombstoneRecord[], io: Io, between: (label: string) => Promise<void>}} options
 * @returns {Promise<number>}
 */
async function purgePoint({ recovery, point: found, tombstones, io, between }) {
  const doomed = doomedOf(tombstones.filter(tombstone => deletedAfter(tombstone, found)));
  if (doomed.note.size === 0 && doomed.folder.size === 0) return 0;
  const matches = await matchesIn({ recovery, point: found, doomed, io });
  await between('point-matched');
  if (matches.length === 0) return 0;

  const verdict = await verifyPoint({ recovery, point: found, io });
  if (!verdict.ok) throw new Stop(verdict.code, found.id);
  await between('point-verified');
  let point = found;
  let purged = 0;
  /** @type {PointRow[]} */
  let batch = [];
  let bytes = 0;

  const flush = async () => {
    if (batch.length === 0) return;
    const rows = batch;
    batch = [];
    bytes = 0;
    const before = point;
    point = await purgeRows({ recovery, point, rows, io });
    await between('batch-written');
    const after = await verifyPoint({ recovery, point, io });
    if (!after.ok) {
      // Put back as it was before this batch, which it verified as, and stop
      await restoreRows({ recovery, before, rows });
      point = before;
      throw new Stop(after.code, before.id);
    }
    purged += rows.length;
    await between('batch-verified');
  };

  /** @param {PointRow} row */
  const take = async row => {
    const size = approximateBytes(row.value) + approximateBytes(row.key);
    if (batch.length > 0 && (batch.length >= io.limits.records || bytes + size > io.limits.bytes)) await flush();
    batch.push(row);
    bytes += size;
  };

  for (const { store, keys } of matches) {
    // Read back in chunks a batch could hold, by count and by the sizes the scan saw
    let from = 0;
    while (from < keys.length) {
      let to = from;
      let size = 0;
      while (
        to < keys.length &&
        to - from < io.limits.records &&
        (to === from || size + keys[to].bytes <= io.limits.bytes)
      ) {
        size += keys[to].bytes;
        to += 1;
      }
      const chunk = keys.slice(from, to).map(({ key }) => key);
      for (const row of await rowsByKey(recovery, point, store, chunk)) await take(row);
      from = to;
    }
    // A store's rows go before the next store's are read, so a batch holds one store's
    await flush();
  }
  await flush();
  await between('point-purged');
  return purged;
}

/**
 * One sweep, under the lock
 * @param {PurgeOptions} options
 * @returns {Promise<PurgeOutcome>}
 */
async function sweep(options) {
  const { indexedDB, clock, hooks = {} } = options;
  /** @type {Io} */
  const io = { keyRange: options.keyRange, crypto: options.crypto, limits: options.limits || DEFAULT_LIMITS };
  const between = async (/** @type {string} */ label) => {
    if (hooks.between) await hooks.between(label);
  };

  const source = await openWithoutUpgrade(indexedDB, DB_NAME);
  if (!source) return outcome({ status: 'nothing' });
  /** @type {TombstoneRecord[]} */
  let tombstones;
  /** @type {StopEntry[]} */
  let standing = [];
  try {
    tombstones = await pendingTombstones(source);
    if (tombstones.length > 0) standing = await readStops(source);
  } finally {
    source.close();
  }
  if (tombstones.length === 0) return outcome({ status: 'nothing' });
  await between('pending-read');

  let rows = 0;
  /** The points this sweep purged */
  const finished = new Set();
  /** @type {StopEntry[]} the points it left, as the record will name them */
  const left = [];
  /** @type {PurgeOutcome['stops']} */
  const stops = [];
  /** @type {string[]} */
  let present = [];
  const recovery = await openRecovery(indexedDB, { create: false });
  if (recovery) {
    try {
      const points = await listPoints(recovery);
      present = points.map(point => point.id);
      for (const point of points) {
        // A point a sweep left that's as it was then would be left again: it's read no further
        const before = standing.find(entry => entry.pointId === point.id);
        if (before && before.point === stampOf([point])) {
          left.push(before);
          stops.push({ pointId: point.id, code: before.code, backedOff: true });
          continue;
        }
        try {
          rows += await purgePoint({ recovery, point, tombstones, io, between });
          finished.add(point.id);
        } catch (error) {
          if (!(error instanceof Stop)) throw error;
          // Left as it was, and the points after it are still purged
          left.push({ pointId: error.pointId, code: error.code, at: clock.now(), point: stampOf([point]) });
          stops.push({ pointId: error.pointId, code: error.code, backedOff: false });
        }
      }
    } finally {
      recovery.close();
    }
  }
  // A recorded stop ends once its point is purged, or gone
  const cleared = standing
    .filter(entry => finished.has(entry.pointId) || !present.includes(entry.pointId))
    .map(entry => entry.pointId);
  if (left.length > 0) {
    if (keyOfStops(left) !== keyOfStops(standing)) await recordStops(indexedDB, left);
    return outcome({
      status: 'stopped',
      tombstones: tombstones.length,
      rows,
      failure: { code: stops[0].code, pointId: stops[0].pointId },
      stops,
      backedOff: stops.every(entry => entry.backedOff),
      cleared,
    });
  }

  const db = await openWithoutUpgrade(indexedDB, DB_NAME);
  if (!db)
    return outcome({
      status: 'failed',
      tombstones: tombstones.length,
      rows,
      failure: { code: 'no-database', pointId: null },
    });
  try {
    await markPurged(db, tombstones, clock.now());
  } finally {
    db.close();
  }
  if (standing.length > 0) await recordStops(indexedDB, []);
  await between('tombstones-marked');
  return outcome({ status: 'purged', tombstones: tombstones.length, rows, cleared });
}

/**
 * Runs one sweep under the lock, and resolves with its outcome. It never rejects, and logs any
 * outcome but `purged` and `nothing`, with codes and ids only.
 * @param {PurgeOptions} options
 * @returns {Promise<PurgeOutcome>}
 */
export function purgeRecoveryPoints(options) {
  const { logger } = options;
  /** @type {Promise<PurgeOutcome>} */
  const run =
    options.locks && typeof options.locks.request === 'function'
      ? Promise.resolve().then(() => options.locks.request(POINTS_LOCK, { mode: 'exclusive' }, () => sweep(options)))
      : Promise.resolve(outcome({ status: 'failed', failure: { code: 'locks-unavailable', pointId: null } }));
  return run
    .catch(error => outcome({ status: 'failed', failure: { code: failureOf(error).code, pointId: null } }))
    .then(result => {
      if (result.status !== 'purged' && result.status !== 'nothing') {
        logger.warn('storage-purge', {
          status: result.status,
          code: result.failure ? result.failure.code : null,
          pointId: result.failure ? result.failure.pointId : null,
          tombstones: result.tombstones,
          rows: result.rows,
        });
      }
      return result;
    });
}
