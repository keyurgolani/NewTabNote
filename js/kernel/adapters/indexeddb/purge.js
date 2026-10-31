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
 * 2. For each point, oldest first, verify it. One that doesn't verify stops the purge, and is
 *    left as it was, with every tombstone still pending: the purge never purges a point it
 *    can't check, and never discards one.
 * 3. Find the rows the tombstones' entities own (OWNERS), by key or by a field of the row, read
 *    in bounded readonly batches and hashed outside any transaction.
 * 4. Purge them in strict batches of at most 100 rows or 2 MB (recovery-points.js's
 *    purgeRows), each of which leaves the point verifying, and verify the point again after
 *    each. A point that doesn't verify after a batch gets that batch back, rows and record, so
 *    it's as it was before the batch, which it verified as, and the purge stops.
 * 5. Once every point is purged, the tombstones lose their `purge` field (deletion.js).
 * Cut off anywhere, the next sweep finishes the rest: a batch commits whole or not at all, and a
 * tombstone stays pending until every point is purged of it.
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
 * - `stopped`: a point didn't verify, before a batch or after one, and was left as it was; the
 *   tombstones stay pending
 * - `failed`: IndexedDB or the lock failed; the tombstones stay pending
 * @typedef {'purged' | 'nothing' | 'stopped' | 'failed'} PurgeStatus
 */

/**
 * @typedef {object} PurgeOutcome
 * @property {PurgeStatus} status
 * @property {number} tombstones - the pending ones the sweep took
 * @property {number} rows - the rows it purged from the points
 * @property {{code: string, pointId: string | null} | null} failure
 */

/**
 * @param {Partial<PurgeOutcome> & {status: PurgeStatus}} fields
 * @returns {PurgeOutcome}
 */
const outcome = fields => ({ tombstones: 0, rows: 0, failure: null, ...fields });

/** Thrown inside a sweep when a point doesn't verify, so the sweep stops where it is */
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
 * The ids each kind of entity has pending
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
 * The rows of `store` in `point` whose keys are among `ids`, read in one readonly transaction
 * @param {IDBDatabase} recovery
 * @param {Point} point
 * @param {string} store
 * @param {readonly string[]} ids
 * @returns {Promise<PointRow[]>}
 */
async function rowsByKey(recovery, point, store, ids) {
  const tx = recovery.transaction(ROWS_STORE, 'readonly');
  const rows = tx.objectStore(ROWS_STORE);
  const found = await Promise.all(ids.map(id => result(rows.get([point.id, store, id]))));
  return /** @type {PointRow[]} */ (found.filter(Boolean));
}

/**
 * Purges one point of what `doomed` names, batch by batch, verifying it before the first and
 * after each. Answers the number of rows it purged. Throws Stop when it doesn't verify.
 * @param {{recovery: IDBDatabase, point: Point, doomed: Record<TombstoneEntity, Set<string>>, io: Io, between: (label: string) => Promise<void>}} options
 * @returns {Promise<number>}
 */
async function purgePoint({ recovery, point: found, doomed, io, between }) {
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

  for (const store of point.stores) {
    if (!Object.hasOwn(OWNERS, store)) continue;
    const { entity, fields } = OWNERS[store];
    const ids = doomed[entity];
    if (ids.size === 0) continue;
    if (fields === null) {
      const all = [...ids];
      for (let from = 0; from < all.length; from += io.limits.records) {
        for (const row of await rowsByKey(recovery, point, store, all.slice(from, from + io.limits.records))) {
          await take(row);
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
          if (owned(row, fields, ids)) await take(row);
        }
        if (read.entries.length > 0) after = read.entries[read.entries.length - 1].key;
        if (read.end || read.entries.length === 0) break;
      }
    }
    // A store's rows go before the next store is read, so a batch holds one store's
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
  try {
    tombstones = await pendingTombstones(source);
  } finally {
    source.close();
  }
  if (tombstones.length === 0) return outcome({ status: 'nothing' });
  await between('pending-read');

  const doomed = doomedOf(tombstones);
  let rows = 0;
  const recovery = await openRecovery(indexedDB, { create: false });
  if (recovery) {
    try {
      for (const point of await listPoints(recovery)) {
        rows += await purgePoint({ recovery, point, doomed, io, between });
      }
    } catch (error) {
      if (!(error instanceof Stop)) throw error;
      return outcome({
        status: 'stopped',
        tombstones: tombstones.length,
        rows,
        failure: { code: error.code, pointId: error.pointId },
      });
    } finally {
      recovery.close();
    }
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
  await between('tombstones-marked');
  return outcome({ status: 'purged', tombstones: tombstones.length, rows });
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
