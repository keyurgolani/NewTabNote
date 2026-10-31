/**
 * Verified recovery points (#17, "Steps" 1 and 4, "Recovery points"), in their own database,
 * `NewTabNoteRecovery` at version 1, so nothing a migration does to CanvasTabDB can reach them:
 * - `points` (keyPath `id`): `{id, kind, pinned, status, sourceShape, sourceVersion,
 *   structuralVersion, logicalVersion, target, stores, createdAt, verifiedAt, manifest}`, where
 *   `status` is `copying`, `verified`, or `failed`, and `manifest` gives each copied store's
 *   `{count, idSetHash, contentHash, keyPath, purged}`. Ids, versions, counts, key paths, and
 *   hashes only, never content.
 * - `rows` (keyPath `['pointId', 'store', 'key']`): `{pointId, store, key, value, sha256}`, each
 *   copied record as it was read, with the SHA-256 records.js took of it then.
 * - `progress` (keyPath `pointId`): where a copy got to, so a cut-off one resumes.
 *
 * A point copies every CanvasTabDB store but `settings` (Q10), which releases up to 1.1.2 used
 * for every setting, the AI key in plaintext included, and nothing from chrome.storage.local.
 * It copies in batches of at most 100 records or 2 MB, one readonly transaction on CanvasTabDB
 * and then one strict readwrite transaction here per batch, so a capture or a save waits at
 * most one batch. A point copied across transactions is not one snapshot (Q14): it's verified
 * against what it read.
 *
 * Verified means read back and matched (#17): each store's count, its ID set (records.js's
 * order-free sum of key hashes), each row's SHA-256 recomputed from the row against the one
 * taken when it was read, the key each value holds at its store's key path against the row's
 * key, and the store's content hash: the sum, taken as the copy read, of one hash per record
 * over its store, its key's hash, and its value's hash (records.js's contentEntry). The
 * content hash is what ties a value to its key and its store, so a value under another key or
 * store, or a changed value whose row hash was recomputed, fails it (review R61). Only a
 * failed verification discards a point, along with a
 * partial point the disk ran out of room for (Q7), which never verified. The first verified
 * `pre-migration` point is pinned while the legacy stores exist, which is as long as #17 runs;
 * otherwise the newest verified point of each kind is kept.
 *
 * Permanent deletion purges a deleted note's or folder's rows from every point, the pinned one
 * included (#17 PR 2b, Q16; purge.js): each batch, in one transaction, deletes its rows, adds
 * their keys to their store's `purged` list, and takes their contentEntry out of `contentHash`
 * (records.js's subtractHashes), with the point's record (purgeRows). Verification counts them:
 * a store's rows plus its purged keys must give the count and the ID set the copy recorded,
 * its rows alone the content hash, and a purged key mustn't still be there. A purged key is
 * an id, never content.
 *
 * Before a run reuses a verified point, matchesSource reads the live stores the same way and
 * compares them with the manifest, so a point older than the data it stands for is remade.
 *
 * Only migrate.js, #20's repair-points.js and the purge (purge.js) write points, all under Web
 * Lock `storage.migrate` held exclusive, so each point is changed by one writer at a time and
 * its record is kept in memory between batches. A reader across transactions (the pre-update
 * export) takes the lock shared, so it never reads a point between two batches.
 */

import { UnavailableError } from '../../core/contracts/outcomes.js';
import { failureOf } from './failures.js';
import {
  EMPTY_SET_HASH,
  addHashes,
  approximateBytes,
  contentEntry,
  keyAt,
  recordSha256,
  subtractHashes,
} from './records.js';
import { result } from './requests.js';
import { openWithoutUpgrade } from './shapes.js';

/** @typedef {import('./records.js').Digester} Digester */
/** @typedef {import('../../core/ports/runtime.js').Clock} Clock */

export const RECOVERY_DB_NAME = 'NewTabNoteRecovery';

/**
 * The Web Lock every writer of points holds exclusive, the migration runner (migrate.js's
 * MIGRATE_LOCK) and the purge (purge.js), and a reader across transactions holds shared
 * (legacy-export.js)
 */
export const POINTS_LOCK = 'storage.migrate';
export const RECOVERY_DB_VERSION = 1;
export const POINTS_STORE = 'points';
export const ROWS_STORE = 'rows';
export const PROGRESS_STORE = 'progress';

/** CanvasTabDB stores a point never copies (Q10) */
export const EXCLUDED_STORES = Object.freeze(['settings']);

/** The batch bounds (#17, "Accessibility and performance") */
export const BATCH_RECORDS = 100;
export const BATCH_BYTES = 2 * 1024 * 1024;

/** @type {IDBTransactionOptions} */
const STRICT = Object.freeze({ durability: 'strict' });

/**
 * `pre-migration` before a structural step (migrate.js), and `pre-repair` before a reversible
 * #20 remediation changes anything (repair-points.js), each under Web Lock `storage.migrate`
 * @typedef {'pre-migration' | 'pre-repair'} PointKind
 */

/**
 * @typedef {object} StoreManifest
 * @property {number} count - records copied
 * @property {string} idSetHash - the sum of their keys' hashes (records.js)
 * @property {string} contentHash - the sum of their contentEntry hashes (records.js)
 * @property {string | string[] | null} keyPath - the store's key path, null before the first batch
 * @property {IDBValidKey[]} purged - keys permanent deletion took out since (#17 PR 2)
 */

/**
 * @typedef {object} Point
 * @property {string} id
 * @property {PointKind} kind
 * @property {boolean} pinned
 * @property {'copying' | 'verified' | 'failed'} status
 * @property {string} sourceShape - shapes.js's kind for the database it copied
 * @property {number} sourceVersion - that database's IndexedDB version
 * @property {number | null} structuralVersion - its `meta.schema`, null before 9
 * @property {number | null} logicalVersion
 * @property {number | null} target - the structural version the point comes before, null when none follows it
 * @property {string[]} stores - the stores it copies, sorted
 * @property {number} createdAt
 * @property {number | null} verifiedAt
 * @property {Record<string, StoreManifest>} manifest
 */

/**
 * @typedef {object} Progress
 * @property {string} pointId
 * @property {string[]} done - stores copied in full
 * @property {string | null} store - the store being copied
 * @property {IDBValidKey | null} after - the last key copied from it
 */

/**
 * Where to wait between steps, so a test can stop the worker there (migrate.js)
 * @typedef {{between?: (label: string) => void | Promise<void>}} Hooks
 */

/**
 * @typedef {object} Limits
 * @property {number} records
 * @property {number} bytes
 */

/** @type {Limits} */
export const DEFAULT_LIMITS = Object.freeze({ records: BATCH_RECORDS, bytes: BATCH_BYTES });

/**
 * What the copy and the checks take from their host: IDBKeyRange (from the same IndexedDB as
 * the factory), Web Crypto for the hashes, and the batch bounds
 * @typedef {{keyRange: typeof IDBKeyRange, crypto: Digester, limits: Limits}} Io
 */

/**
 * Resolves when `tx` commits, rejects with its error when it aborts
 * @param {IDBTransaction} tx
 * @returns {Promise<void>}
 */
export function committed(tx) {
  return new Promise((resolve, reject) => {
    tx.addEventListener('complete', () => resolve());
    tx.addEventListener('abort', () => reject(tx.error || new DOMException('The transaction aborted', 'AbortError')));
  });
}

/**
 * Creates the recovery database's stores. Runs inside its upgrade, synchronously.
 * @param {IDBDatabase} db
 */
function createRecoveryStores(db) {
  if (!db.objectStoreNames.contains(POINTS_STORE)) db.createObjectStore(POINTS_STORE, { keyPath: 'id' });
  if (!db.objectStoreNames.contains(ROWS_STORE)) {
    db.createObjectStore(ROWS_STORE, { keyPath: ['pointId', 'store', 'key'] });
  }
  if (!db.objectStoreNames.contains(PROGRESS_STORE)) db.createObjectStore(PROGRESS_STORE, { keyPath: 'pointId' });
}

/**
 * Opens NewTabNoteRecovery, making it when `create` and it doesn't exist. Resolves null when
 * it doesn't exist and `create` is false. One without its three stores, or at a version this
 * build doesn't know, is refused, `recovery-unavailable`, and left as it is.
 * @param {IDBFactory} indexedDB
 * @param {{create: boolean}} options
 * @returns {Promise<IDBDatabase | null>}
 */
export async function openRecovery(indexedDB, { create }) {
  /** @type {IDBDatabase | null} */
  let db = await openWithoutUpgrade(indexedDB, RECOVERY_DB_NAME);
  if (!db && create) {
    db = await new Promise((resolve, reject) => {
      const request = indexedDB.open(RECOVERY_DB_NAME, RECOVERY_DB_VERSION);
      request.onupgradeneeded = () => createRecoveryStores(request.result);
      request.onsuccess = () => {
        const opened = request.result;
        opened.onversionchange = () => opened.close();
        resolve(opened);
      };
      request.onerror = () => reject(request.error);
    });
  }
  if (!db) return null;
  const usable =
    db.version === RECOVERY_DB_VERSION &&
    [POINTS_STORE, ROWS_STORE, PROGRESS_STORE].every(name =>
      /** @type {IDBDatabase} */ (db).objectStoreNames.contains(name),
    );
  if (!usable) {
    db.close();
    throw new UnavailableError('storage', 'recovery-unavailable', false);
  }
  return db;
}

/**
 * Every point, oldest first
 * @param {IDBDatabase} recovery
 * @returns {Promise<Point[]>}
 */
export async function listPoints(recovery) {
  const tx = recovery.transaction(POINTS_STORE, 'readonly');
  const points = /** @type {Point[]} */ (await result(tx.objectStore(POINTS_STORE).getAll()));
  return points.sort((a, b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/**
 * The key range of every row of `pointId`, or of one store's rows. A row key starts with the
 * point id and the store name, so every key after them sorts below the next string up.
 * @param {typeof IDBKeyRange} keyRange
 * @param {string} pointId
 * @param {string} [store]
 * @returns {IDBKeyRange}
 */
export function rowRange(keyRange, pointId, store) {
  const lower = store === undefined ? [pointId] : [pointId, store];
  const upper = store === undefined ? [`${pointId}\u0000`] : [pointId, `${store}\u0000`];
  return keyRange.bound(lower, upper, false, true);
}

/**
 * One batch of records from `store`: up to `limits.records` of them, and no more than
 * `limits.bytes` unless a single record is bigger, after `after`, in key order. One readonly
 * transaction.
 * @param {IDBDatabase} db
 * @param {string} store
 * @param {IDBValidKey | null} after
 * @param {IDBKeyRange | null} range - the range to stay inside, when not the whole store
 * @param {Pick<Io, 'keyRange' | 'limits'>} io
 * @returns {Promise<{entries: Array<{key: IDBValidKey, value: any}>, end: boolean, keyPath: string | string[] | null}>}
 */
export function readBatch(db, store, after, range, { keyRange, limits }) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, 'readonly');
    const { keyPath } = tx.objectStore(store);
    /** @type {IDBKeyRange | undefined} */
    let bounds = range || undefined;
    if (after !== null) {
      bounds = range ? keyRange.bound(after, range.upper, true, range.upperOpen) : keyRange.lowerBound(after, true);
    }
    const request = tx.objectStore(store).openCursor(bounds);
    /** @type {Array<{key: IDBValidKey, value: any}>} */
    const entries = [];
    let bytes = 0;
    let end = false;
    // Whether the cursor answered at all: a transaction that ends before it did read nothing,
    // which must never pass for the end of the store
    let answered = false;
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      answered = true;
      const cursor = request.result;
      if (!cursor) {
        end = true;
        return;
      }
      const size = approximateBytes(cursor.value) + approximateBytes(cursor.primaryKey);
      if (entries.length > 0 && bytes + size > limits.bytes) return;
      entries.push({ key: cursor.primaryKey, value: cursor.value });
      bytes += size;
      if (entries.length >= limits.records) return;
      cursor.continue();
    };
    tx.oncomplete = () => {
      if (answered) resolve({ entries, end, keyPath });
      else reject(new DOMException('The read ended before its cursor answered', 'UnknownError'));
    };
    tx.onabort = () => reject(tx.error);
  });
}

/**
 * About how many bytes copying `stores` of `db` takes, read in bounded batches
 * @param {IDBDatabase} db
 * @param {readonly string[]} stores
 * @param {Pick<Io, 'keyRange' | 'limits'>} io
 * @returns {Promise<number>}
 */
export async function measureStores(db, stores, io) {
  let bytes = 0;
  for (const store of stores) {
    /** @type {IDBValidKey | null} */
    let after = null;
    for (;;) {
      const batch = await readBatch(db, store, after, null, io);
      for (const { key, value } of batch.entries) bytes += approximateBytes(value) + approximateBytes(key);
      if (batch.entries.length > 0) after = batch.entries[batch.entries.length - 1].key;
      if (batch.end || batch.entries.length === 0) break;
    }
  }
  return bytes;
}

/**
 * The stores a point of `db` copies: all of them but EXCLUDED_STORES, sorted
 * @param {IDBDatabase} db
 * @returns {string[]}
 */
export function storesToCopy(db) {
  return Array.from(db.objectStoreNames)
    .filter(name => !EXCLUDED_STORES.includes(name))
    .sort();
}

/**
 * A new point's record, before its first batch
 * @param {{id: string, kind: PointKind, sourceShape: string, sourceVersion: number, structuralVersion: number | null, logicalVersion: number | null, target: number | null, stores: string[], createdAt: number}} fields
 * @returns {Point}
 */
function newPoint(fields) {
  /** @type {Record<string, StoreManifest>} */
  const manifest = {};
  for (const store of fields.stores) {
    manifest[store] = { count: 0, idSetHash: EMPTY_SET_HASH, contentHash: EMPTY_SET_HASH, keyPath: null, purged: [] };
  }
  return { ...fields, pinned: false, status: 'copying', verifiedAt: null, manifest };
}

/**
 * Writes a point's record and its progress, in one strict transaction
 * @param {IDBDatabase} recovery
 * @param {Point} point
 * @param {Progress | null} progress - null deletes it
 */
async function savePoint(recovery, point, progress) {
  const tx = recovery.transaction([POINTS_STORE, PROGRESS_STORE], 'readwrite', STRICT);
  const done = committed(tx);
  tx.objectStore(POINTS_STORE).put(point);
  if (progress) tx.objectStore(PROGRESS_STORE).put(progress);
  else tx.objectStore(PROGRESS_STORE).delete(point.id);
  await done;
}

/**
 * Starts a point: its record and its progress
 * @param {IDBDatabase} recovery
 * @param {Parameters<typeof newPoint>[0]} fields
 * @returns {Promise<{point: Point, progress: Progress}>}
 */
export async function startPoint(recovery, fields) {
  const point = newPoint(fields);
  /** @type {Progress} */
  const progress = { pointId: point.id, done: [], store: null, after: null };
  await savePoint(recovery, point, progress);
  return { point, progress };
}

/**
 * A point's progress record, or a fresh one
 * @param {IDBDatabase} recovery
 * @param {string} pointId
 * @returns {Promise<Progress>}
 */
export async function readProgress(recovery, pointId) {
  const tx = recovery.transaction(PROGRESS_STORE, 'readonly');
  const stored = await result(tx.objectStore(PROGRESS_STORE).get(pointId));
  return stored || { pointId, done: [], store: null, after: null };
}

/**
 * Copies what's left of `point` from `source`, batch by batch, each batch committing its rows,
 * the manifest so far, and the progress together. Resolves when every store is copied.
 * Rejects with what failed: a QuotaExceededError the caller answers by dropping the point.
 * @param {{source: IDBDatabase, recovery: IDBDatabase, point: Point, progress: Progress, io: Io, hooks?: Hooks}} options
 * @returns {Promise<void>}
 */
export async function copyPoint({ source, recovery, point, progress, io, hooks = {} }) {
  const { crypto } = io;
  for (const store of point.stores) {
    if (progress.done.includes(store)) continue;
    if (!source.objectStoreNames.contains(store)) throw new UnavailableError('storage', 'store-unavailable', false);
    /** @type {IDBValidKey | null} */
    let after = progress.store === store ? progress.after : null;
    for (;;) {
      const batch = await readBatch(source, store, after, null, io);
      /** @type {Array<{pointId: string, store: string, key: IDBValidKey, value: unknown, sha256: string}>} */
      const rows = [];
      let { idSetHash, contentHash } = point.manifest[store];
      for (const { key, value } of batch.entries) {
        const sha256 = await recordSha256(value, crypto);
        const keyHash = await recordSha256(key, crypto);
        rows.push({ pointId: point.id, store, key, value, sha256 });
        idSetHash = addHashes(idSetHash, keyHash);
        contentHash = addHashes(contentHash, await contentEntry(store, keyHash, sha256, crypto));
      }
      if (hooks.between) await hooks.between('copy-read');

      const last = batch.entries.length > 0 ? batch.entries[batch.entries.length - 1].key : after;
      const finished = batch.end || batch.entries.length === 0;
      /** @type {Point} */
      const next = {
        ...point,
        manifest: {
          ...point.manifest,
          [store]: {
            ...point.manifest[store],
            count: point.manifest[store].count + rows.length,
            idSetHash,
            contentHash,
            keyPath: batch.keyPath,
          },
        },
      };
      /** @type {Progress} */
      const nextProgress = finished
        ? { pointId: point.id, done: [...progress.done, store], store: null, after: null }
        : { pointId: point.id, done: progress.done, store, after: last };
      const tx = recovery.transaction([POINTS_STORE, ROWS_STORE, PROGRESS_STORE], 'readwrite', STRICT);
      const done = committed(tx);
      const rowStore = tx.objectStore(ROWS_STORE);
      for (const row of rows) rowStore.put(row);
      tx.objectStore(POINTS_STORE).put(next);
      tx.objectStore(PROGRESS_STORE).put(nextProgress);
      await done;
      point.manifest = next.manifest;
      progress.done = nextProgress.done;
      progress.store = nextProgress.store;
      progress.after = nextProgress.after;
      if (hooks.between) await hooks.between('copy-written');
      if (finished) break;
      after = last;
    }
  }
}

/**
 * The keys a store's purge list holds, as hashes, and their sum
 * @param {StoreManifest} expected
 * @param {Digester} crypto
 */
async function purgedOf(expected, crypto) {
  /** @type {Set<string>} */
  const hashes = new Set();
  let sum = EMPTY_SET_HASH;
  for (const key of expected.purged || []) {
    const hash = await recordSha256(key, crypto);
    hashes.add(hash);
    sum = addHashes(sum, hash);
  }
  return { hashes, sum };
}

/**
 * Reads `point` back and matches it (see the top of this file). Writes nothing.
 * @param {{recovery: IDBDatabase, point: Point, io: Io}} options
 * @returns {Promise<{ok: true} | {ok: false, code: string}>}
 */
export async function verifyPoint({ recovery, point, io }) {
  const { crypto } = io;
  const manifestStores = Object.keys(point.manifest).sort();
  if (manifestStores.length !== point.stores.length || manifestStores.some((name, i) => name !== point.stores[i])) {
    return { ok: false, code: 'manifest-mismatch' };
  }
  let total = 0;
  for (const store of point.stores) {
    const expected = point.manifest[store];
    const purged = await purgedOf(expected, crypto);
    let idSetHash = purged.sum;
    let contentHash = EMPTY_SET_HASH;
    let count = 0;
    /** @type {IDBValidKey | null} */
    let after = null;
    const range = rowRange(io.keyRange, point.id, store);
    for (;;) {
      const batch = await readBatch(recovery, ROWS_STORE, after, range, io);
      for (const { value: row } of batch.entries) {
        if (!row || row.pointId !== point.id || row.store !== store) return { ok: false, code: 'row-mismatch' };
        const valueHash = await recordSha256(row.value, crypto);
        if (valueHash !== row.sha256) return { ok: false, code: 'record-mismatch' };
        const keyHash = await recordSha256(row.key, crypto);
        // Every legacy store keys its records inline: the value must hold the row's key
        if (expected.keyPath !== null && expected.keyPath !== undefined) {
          const held = keyAt(row.value, expected.keyPath);
          if (held === undefined || (await recordSha256(held, crypto)) !== keyHash) {
            return { ok: false, code: 'key-mismatch' };
          }
        }
        if (purged.hashes.has(keyHash)) return { ok: false, code: 'purged-row-present' };
        idSetHash = addHashes(idSetHash, keyHash);
        contentHash = addHashes(contentHash, await contentEntry(store, keyHash, valueHash, crypto));
        count += 1;
      }
      if (batch.entries.length > 0) after = batch.entries[batch.entries.length - 1].key;
      if (batch.end || batch.entries.length === 0) break;
    }
    if (count + purged.hashes.size !== expected.count) return { ok: false, code: 'count-mismatch' };
    if (idSetHash !== expected.idSetHash) return { ok: false, code: 'id-set-mismatch' };
    if (contentHash !== expected.contentHash) return { ok: false, code: 'content-mismatch' };
    total += count;
  }
  // No row outside the stores the point copied
  const tx = recovery.transaction(ROWS_STORE, 'readonly');
  const rows = await result(tx.objectStore(ROWS_STORE).count(rowRange(io.keyRange, point.id)));
  if (rows !== total) return { ok: false, code: 'count-mismatch' };
  return { ok: true };
}

/**
 * Whether `source` still holds what `point` copied: each store's count, ID set, and content
 * hash, read now in the same bounded readonly batches, against the manifest (purged keys
 * accounted for). Writes nothing. A point that doesn't match is older than the data it stands
 * for, and a run makes a new one instead of reusing it (review R61, Q3).
 * @param {{source: IDBDatabase, point: Point, io: Io}} options
 * @returns {Promise<boolean>}
 */
export async function matchesSource({ source, point, io }) {
  const { crypto } = io;
  for (const store of point.stores) {
    if (!source.objectStoreNames.contains(store)) return false;
    const expected = point.manifest[store];
    const purged = await purgedOf(expected, crypto);
    let idSetHash = purged.sum;
    let contentHash = EMPTY_SET_HASH;
    let count = 0;
    /** @type {IDBValidKey | null} */
    let after = null;
    for (;;) {
      const batch = await readBatch(source, store, after, null, io);
      for (const { key, value } of batch.entries) {
        const keyHash = await recordSha256(key, crypto);
        const valueHash = await recordSha256(value, crypto);
        idSetHash = addHashes(idSetHash, keyHash);
        contentHash = addHashes(contentHash, await contentEntry(store, keyHash, valueHash, crypto));
        count += 1;
      }
      if (batch.entries.length > 0) after = batch.entries[batch.entries.length - 1].key;
      if (batch.end || batch.entries.length === 0) break;
    }
    if (count + purged.hashes.size !== expected.count) return false;
    if (idSetHash !== expected.idSetHash || contentHash !== expected.contentHash) return false;
  }
  return true;
}

/**
 * Every row a point holds for `store`, as copied, read back in bounded batches
 * @param {IDBDatabase} recovery
 * @param {Point} point
 * @param {string} store
 * @param {Pick<Io, 'keyRange' | 'limits'>} io
 * @returns {Promise<Array<{key: IDBValidKey, value: any}>>}
 */
export async function readPointStore(recovery, point, store, io) {
  /** @type {Array<{key: IDBValidKey, value: any}>} */
  const rows = [];
  /** @type {IDBValidKey | null} */
  let after = null;
  const range = rowRange(io.keyRange, point.id, store);
  for (;;) {
    const batch = await readBatch(recovery, ROWS_STORE, after, range, io);
    for (const { value: row } of batch.entries) rows.push({ key: row.key, value: row.value });
    if (batch.entries.length > 0) after = batch.entries[batch.entries.length - 1].key;
    if (batch.end || batch.entries.length === 0) break;
  }
  return rows;
}

/**
 * Deletes a point: its rows in bounded batches, then its record and progress
 * @param {IDBDatabase} recovery
 * @param {string} pointId
 * @param {Pick<Io, 'keyRange' | 'limits'>} io
 */
export async function discardPoint(recovery, pointId, { keyRange, limits }) {
  const range = rowRange(keyRange, pointId);
  for (;;) {
    const tx = recovery.transaction(ROWS_STORE, 'readwrite', STRICT);
    const done = committed(tx);
    const store = tx.objectStore(ROWS_STORE);
    let deleted = 0;
    const request = store.getAllKeys(range, limits.records);
    request.onsuccess = () => {
      for (const key of request.result) store.delete(key);
      deleted = request.result.length;
    };
    await done;
    if (deleted === 0) break;
  }
  const tx = recovery.transaction([POINTS_STORE, PROGRESS_STORE], 'readwrite', STRICT);
  const done = committed(tx);
  tx.objectStore(POINTS_STORE).delete(pointId);
  tx.objectStore(PROGRESS_STORE).delete(pointId);
  await done;
}

/**
 * Marks `point` verified and settles which points stay:
 * - Verified points of its kind made before the same target are older copies of what it now
 *   holds (a reuse found them stale, review R61): they go, and when one of them was pinned the
 *   pin moves to `point`.
 * - Otherwise the first verified pre-migration point is pinned, and older verified points of
 *   the kind that aren't pinned go, so the pinned one and the newest stay.
 * The new point is saved first, so a run cut off in between never leaves fewer points.
 * @param {{recovery: IDBDatabase, point: Point, clock: Clock, io: Pick<Io, 'keyRange' | 'limits'>}} options
 * @returns {Promise<Point>}
 */
export async function keepVerified({ recovery, point, clock, io }) {
  const others = (await listPoints(recovery)).filter(other => other.id !== point.id);
  const sameKind = others.filter(other => other.kind === point.kind && other.status === 'verified');
  const replaced = sameKind.filter(other => other.target === point.target);
  const pinnedElsewhere = sameKind.some(other => other.pinned && other.target !== point.target);
  const pinned = point.kind === 'pre-migration' && (replaced.some(other => other.pinned) || !pinnedElsewhere);
  /** @type {Point} */
  const verified = { ...point, status: 'verified', verifiedAt: clock.now(), pinned };
  await savePoint(recovery, verified, null);
  for (const other of sameKind) {
    if (other.target === point.target || !other.pinned) await discardPoint(recovery, other.id, io);
  }
  return verified;
}

/**
 * A run reuses verified `point`: any other verified point of its kind made before the same
 * target is an older copy of what it holds, left by a run cut off after keepVerified saved the
 * newer one and before it dropped the older (review B6 carry-over 1). Those go, as keepVerified
 * would have dropped them, and when one of them was pinned the pin moves to `point` first, so a
 * run cut off in between never leaves fewer pinned points.
 * @param {{recovery: IDBDatabase, point: Point, io: Pick<Io, 'keyRange' | 'limits'>}} options
 * @returns {Promise<Point>} `point`, pinned when it took a pin over
 */
export async function dropOlderCopies({ recovery, point, io }) {
  const older = (await listPoints(recovery)).filter(
    other =>
      other.id !== point.id &&
      other.kind === point.kind &&
      other.status === 'verified' &&
      other.target === point.target,
  );
  if (older.length === 0) return point;
  let kept = point;
  if (!point.pinned && older.some(other => other.pinned)) {
    kept = { ...point, pinned: true };
    await savePoint(recovery, kept, null);
  }
  for (const other of older) await discardPoint(recovery, other.id, io);
  return kept;
}

/**
 * A row as `rows` holds it
 * @typedef {{pointId: string, store: string, key: IDBValidKey, value: unknown, sha256: string}} PointRow
 */

/**
 * Purges `rows`, which `point` holds, from it (#17 PR 2b, purge.js), in one strict transaction
 * over its rows and its record: each row goes, its key joins its store's `purged` list, and its
 * contentEntry leaves the store's content hash, so the point verifies after as it did before.
 * The hashes are taken before the transaction opens. Answers the point's record as written.
 * @param {{recovery: IDBDatabase, point: Point, rows: readonly PointRow[], io: Pick<Io, 'crypto'>}} options
 * @returns {Promise<Point>}
 */
export async function purgeRows({ recovery, point, rows, io }) {
  /** @type {Record<string, StoreManifest>} */
  const manifest = { ...point.manifest };
  for (const row of rows) {
    const store = manifest[row.store];
    if (!store || row.pointId !== point.id) throw new UnavailableError('storage', 'row-mismatch', false);
    const keyHash = await recordSha256(row.key, io.crypto);
    const entry = await contentEntry(row.store, keyHash, row.sha256, io.crypto);
    manifest[row.store] = {
      ...store,
      purged: [...(store.purged || []), row.key],
      contentHash: subtractHashes(store.contentHash, entry),
    };
  }
  /** @type {Point} */
  const next = { ...point, manifest };
  const tx = recovery.transaction([POINTS_STORE, ROWS_STORE], 'readwrite', STRICT);
  const done = committed(tx);
  const rowStore = tx.objectStore(ROWS_STORE);
  for (const row of rows) rowStore.delete([point.id, row.store, row.key]);
  tx.objectStore(POINTS_STORE).put(next);
  await done;
  return next;
}

/**
 * Puts `rows` back, and the point's record back as `before`, in one strict transaction: a purge
 * batch undone, since the point didn't verify after it (purge.js)
 * @param {{recovery: IDBDatabase, before: Point, rows: readonly PointRow[]}} options
 * @returns {Promise<void>}
 */
export async function restoreRows({ recovery, before, rows }) {
  const tx = recovery.transaction([POINTS_STORE, ROWS_STORE], 'readwrite', STRICT);
  const done = committed(tx);
  const rowStore = tx.objectStore(ROWS_STORE);
  for (const row of rows) rowStore.put(row);
  tx.objectStore(POINTS_STORE).put(before);
  await done;
}

/**
 * Whether `error` is the disk refusing a write
 * @param {unknown} error
 */
export const isQuota = error => failureOf(error).code === 'quota';
