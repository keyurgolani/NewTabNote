/**
 * What #20's health providers read of IndexedDB (#20 slice 2, "Providers"), here since only
 * #17's adapter opens object stores. Each reads, writes nothing, makes no database where
 * there's none, and closes what it opened:
 *
 * - the recovery reader: NewTabNoteRecovery's points, as kind, status, and times only, and a
 *   point read back and matched by #17's verifyPoint, for recovery readiness;
 * - the vectors reader: whether CanvasTabDB's `vectors` store holds a record, and when the
 *   newest was written, which is how local inference tells the embedding model has loaded
 *   since a failure (nothing journals a load that worked).
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
 * @param {{indexedDB: IDBFactory}} options
 */
export function createVectorsReader({ indexedDB }) {
  return Object.freeze({
    /**
     * Whether `vectors` holds a record, and the newest `updatedAt` any holds (Storage.saveVector
     * writes one with each), null when none says. It reads each record once, in one readonly
     * cursor, keeping only that time.
     * @returns {Promise<{stored: boolean, at: number | null}>}
     */
    async latest() {
      /** @type {IDBDatabase | null} */
      let db = null;
      try {
        db = await openWithoutUpgrade(indexedDB, DB_NAME);
        if (!db || !db.objectStoreNames.contains('vectors')) return { stored: false, at: null };
        const request = db.transaction('vectors', 'readonly').objectStore('vectors').openCursor();
        return await new Promise((resolve, reject) => {
          let stored = false;
          /** @type {number | null} */
          let at = null;
          request.onsuccess = () => {
            const cursor = request.result;
            if (!cursor) {
              resolve({ stored, at });
              return;
            }
            stored = true;
            const updatedAt = /** @type {{updatedAt?: unknown}} */ (cursor.value || {}).updatedAt;
            if (typeof updatedAt === 'number' && Number.isSafeInteger(updatedAt) && updatedAt >= 0) {
              at = at === null ? updatedAt : Math.max(at, updatedAt);
            }
            cursor.continue();
          };
          request.onerror = () => reject(request.error);
        });
      } catch {
        throw new UnavailableError('storage', 'unreadable', true);
      } finally {
        if (db) db.close();
      }
    },
  });
}
