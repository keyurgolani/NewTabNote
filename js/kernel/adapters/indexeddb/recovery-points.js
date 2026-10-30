/**
 * Verified recovery points (#17, "Steps" 1 and 4, "Recovery points"), in their own database,
 * `NewTabNoteRecovery` at version 1, so nothing a migration does to CanvasTabDB can reach them:
 * - `points` (keyPath `id`): `{id, kind, pinned, status, sourceShape, sourceVersion,
 *   structuralVersion, logicalVersion, target, stores, createdAt, verifiedAt, manifest}`, where
 *   `status` is `copying`, `verified`, or `failed`, and `manifest` gives each copied store's
 *   `{count, idSetHash, purged}`. Ids, versions, counts, and hashes only, never content.
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
 * order-free sum of key hashes), and each row's SHA-256 recomputed from the row against the
 * one taken when it was read. Only a failed verification discards a point, along with a
 * partial point the disk ran out of room for (Q7), which never verified. The first verified
 * `pre-migration` point is pinned while the legacy stores exist, which is as long as #17 runs;
 * otherwise the newest verified point of each kind is kept.
 *
 * Permanent deletion (#17 PR 2, Q16) will purge a note's rows from every point, the pinned one
 * included, and add their keys to that store's `purged` list. Verification counts them: a
 * store's rows plus its purged keys must give the count and the ID set the copy recorded, and
 * a purged key mustn't still be there.
 *
 * Only migrate.js writes points, under Web Lock `storage.migrate`, so each point is changed by
 * one writer at a time and its record is kept in memory between batches.
 */

import { UnavailableError } from '../../core/contracts/outcomes.js';
import { failureOf } from './failures.js';
import { EMPTY_SET_HASH, addHashes, approximateBytes, recordSha256 } from './records.js';
import { result } from './requests.js';
import { openWithoutUpgrade } from './shapes.js';

/** @typedef {import('./records.js').Digester} Digester */
/** @typedef {import('../../core/ports/runtime.js').Clock} Clock */

export const RECOVERY_DB_NAME = 'NewTabNoteRecovery';
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

/** @typedef {'pre-migration'} PointKind */

/**
 * @typedef {object} StoreManifest
 * @property {number} count - records copied
 * @property {string} idSetHash - the sum of their keys' hashes (records.js)
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
function rowRange(keyRange, pointId, store) {
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
 * @returns {Promise<{entries: Array<{key: IDBValidKey, value: any}>, end: boolean}>}
 */
export function readBatch(db, store, after, range, { keyRange, limits }) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, 'readonly');
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
      if (answered) resolve({ entries, end });
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
  for (const store of fields.stores) manifest[store] = { count: 0, idSetHash: EMPTY_SET_HASH, purged: [] };
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
      let idSetHash = point.manifest[store].idSetHash;
      for (const { key, value } of batch.entries) {
        rows.push({ pointId: point.id, store, key, value, sha256: await recordSha256(value, crypto) });
        idSetHash = addHashes(idSetHash, await recordSha256(key, crypto));
      }
      if (hooks.between) await hooks.between('copy-read');

      const last = batch.entries.length > 0 ? batch.entries[batch.entries.length - 1].key : after;
      const finished = batch.end || batch.entries.length === 0;
      /** @type {Point} */
      const next = {
        ...point,
        manifest: {
          ...point.manifest,
          [store]: { ...point.manifest[store], count: point.manifest[store].count + rows.length, idSetHash },
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
    const purged = new Set();
    let idSetHash = EMPTY_SET_HASH;
    for (const key of expected.purged || []) {
      const hash = await recordSha256(key, crypto);
      purged.add(hash);
      idSetHash = addHashes(idSetHash, hash);
    }
    let count = 0;
    /** @type {IDBValidKey | null} */
    let after = null;
    const range = rowRange(io.keyRange, point.id, store);
    for (;;) {
      const batch = await readBatch(recovery, ROWS_STORE, after, range, io);
      for (const { value: row } of batch.entries) {
        if (!row || row.pointId !== point.id || row.store !== store) return { ok: false, code: 'row-mismatch' };
        if ((await recordSha256(row.value, crypto)) !== row.sha256) return { ok: false, code: 'record-mismatch' };
        const keyHash = await recordSha256(row.key, crypto);
        if (purged.has(keyHash)) return { ok: false, code: 'purged-row-present' };
        idSetHash = addHashes(idSetHash, keyHash);
        count += 1;
      }
      if (batch.entries.length > 0) after = batch.entries[batch.entries.length - 1].key;
      if (batch.end || batch.entries.length === 0) break;
    }
    if (count + purged.size !== expected.count) return { ok: false, code: 'count-mismatch' };
    if (idSetHash !== expected.idSetHash) return { ok: false, code: 'id-set-mismatch' };
    total += count;
  }
  // No row outside the stores the point copied
  const tx = recovery.transaction(ROWS_STORE, 'readonly');
  const rows = await result(tx.objectStore(ROWS_STORE).count(rowRange(io.keyRange, point.id)));
  if (rows !== total) return { ok: false, code: 'count-mismatch' };
  return { ok: true };
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
 * Marks `point` verified, pins it when it's the first verified pre-migration point, and
 * deletes older verified points of its kind that aren't pinned, so the pinned one and the
 * newest stay
 * @param {{recovery: IDBDatabase, point: Point, clock: Clock, io: Pick<Io, 'keyRange' | 'limits'>}} options
 * @returns {Promise<Point>}
 */
export async function keepVerified({ recovery, point, clock, io }) {
  const others = (await listPoints(recovery)).filter(other => other.id !== point.id);
  const pinned =
    point.kind === 'pre-migration' &&
    !others.some(other => other.kind === 'pre-migration' && other.pinned && other.status === 'verified');
  /** @type {Point} */
  const verified = { ...point, status: 'verified', verifiedAt: clock.now(), pinned };
  await savePoint(recovery, verified, null);
  for (const other of others) {
    if (other.kind === point.kind && other.status === 'verified' && !other.pinned) {
      await discardPoint(recovery, other.id, io);
    }
  }
  return verified;
}

/**
 * Whether `error` is the disk refusing a write
 * @param {unknown} error
 */
export const isQuota = error => failureOf(error).code === 'quota';
