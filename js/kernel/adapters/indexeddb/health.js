/**
 * What #20's health providers read of IndexedDB (#20 slice 2, "Providers"), here since only
 * #17's adapter opens object stores. Each reads, writes nothing, makes no database where
 * there's none, and closes what it opened:
 *
 * - the recovery reader: NewTabNoteRecovery's points, as kind, status, and times only, and a
 *   point read back and matched by #17's verifyPoint, for recovery readiness;
 * - the vectors reader: whether CanvasTabDB's `vectors` store holds a record, and whether one
 *   was written after a time, which is how local inference tells the embedding model has
 *   loaded since a failure (nothing journals a load that worked).
 *
 * A composition root makes them with the context's IndexedDB, and Web Crypto and IDBKeyRange
 * for verification. No shipped root does yet.
 */

import { UnavailableError } from '../../core/contracts/outcomes.js';
import { DEFAULT_LIMITS, listPoints, openRecovery, verifyPoint } from './recovery-points.js';
import { DB_NAME } from './schema.js';
import { openWithoutUpgrade } from './shapes.js';

/** @typedef {import('./records.js').Digester} Digester */
/** @typedef {{id: string, kind: string, status: string, createdAt: number, verifiedAt: number | null}} PointSummary */

/**
 * Runs `body` on NewTabNoteRecovery when it exists, and closes it after
 * @template T
 * @param {IDBFactory} indexedDB
 * @param {T} none - what to answer when there's no recovery database
 * @param {(db: IDBDatabase) => Promise<T>} body
 * @returns {Promise<T>}
 */
async function withRecovery(indexedDB, none, body) {
  const db = await openRecovery(indexedDB, { create: false });
  if (!db) return none;
  try {
    return await body(db);
  } finally {
    db.close();
  }
}

/**
 * @param {{indexedDB: IDBFactory, keyRange: typeof IDBKeyRange, crypto: Digester}} options
 */
export function createRecoveryReader({ indexedDB, keyRange, crypto }) {
  const io = { keyRange, crypto, limits: DEFAULT_LIMITS };
  return Object.freeze({
    /** @returns {Promise<PointSummary[]>} every point, as kind, status, and times */
    points: () =>
      withRecovery(indexedDB, /** @type {PointSummary[]} */ ([]), async db =>
        (await listPoints(db)).map(point => ({
          id: point.id,
          kind: point.kind,
          status: point.status,
          createdAt: point.createdAt,
          verifiedAt: point.verifiedAt,
        })),
      ),

    /**
     * @param {string} pointId
     * @returns {Promise<{ok: true} | {ok: false, code: string}>}
     */
    verify: pointId =>
      withRecovery(
        indexedDB,
        /** @type {{ok: true} | {ok: false, code: string}} */ ({ ok: false, code: 'point-discarded' }),
        async db => {
          const point = (await listPoints(db)).find(candidate => candidate.id === pointId);
          // Discarded since it was listed: only #17's run discards one, after its own verification
          if (!point) return { ok: false, code: 'point-discarded' };
          return verifyPoint({ recovery: db, point, io });
        },
      ),
  });
}

/**
 * Runs `body` on CanvasTabDB's `vectors` store when there is one, and closes the database
 * after; `none` when there's no database or no store
 * @template T
 * @param {IDBFactory} indexedDB
 * @param {T} none
 * @param {(store: IDBObjectStore) => Promise<T>} body
 * @returns {Promise<T>}
 */
async function withVectors(indexedDB, none, body) {
  /** @type {IDBDatabase | null} */
  let db = null;
  try {
    db = await openWithoutUpgrade(indexedDB, DB_NAME);
    if (!db || !db.objectStoreNames.contains('vectors')) return none;
    return await body(db.transaction('vectors', 'readonly').objectStore('vectors'));
  } catch {
    throw new UnavailableError('storage', 'unreadable', true);
  } finally {
    if (db) db.close();
  }
}

/**
 * @param {{indexedDB: IDBFactory}} options
 */
export function createVectorsReader({ indexedDB }) {
  return Object.freeze({
    /** @returns {Promise<boolean>} whether `vectors` holds a record, counted without reading one */
    stored: () =>
      withVectors(indexedDB, false, store =>
        new Promise((resolve, reject) => {
          const request = store.count();
          request.onsuccess = () => resolve(request.result > 0);
          request.onerror = () => reject(request.error);
        }),
      ),

    /**
     * Whether a vector was written after `at`, by the `updatedAt` Storage.saveVector writes with
     * each. It reads in key order and stops at the first one newer, so it reads every vector
     * only when none is.
     * @param {number} at
     * @returns {Promise<boolean>}
     */
    newerThan: at =>
      withVectors(indexedDB, false, store =>
        new Promise((resolve, reject) => {
          const request = store.openCursor();
          request.onsuccess = () => {
            const cursor = request.result;
            if (!cursor) {
              resolve(false);
              return;
            }
            const updatedAt = /** @type {{updatedAt?: unknown}} */ (cursor.value || {}).updatedAt;
            if (typeof updatedAt === 'number' && Number.isSafeInteger(updatedAt) && updatedAt > at) {
              resolve(true);
              return;
            }
            cursor.continue();
          };
          request.onerror = () => reject(request.error);
        }),
      ),
  });
}
