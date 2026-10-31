/**
 * What #20's health providers read of IndexedDB (#20 slice 2, "Providers"), here since only
 * #17's adapter opens object stores. Each reads, writes nothing, makes no database where
 * there's none, and closes what it opened:
 *
 * - the recovery reader: NewTabNoteRecovery's points, as kind, status, and times only, and a
 *   point read back and matched by #17's verifyPoint, for recovery readiness;
 * - the vectors reader: whether CanvasTabDB's `vectors` store holds a record, which is how
 *   local inference tells the embedding model has loaded once (nothing journals a load that
 *   worked).
 *
 * A composition root makes them with the context's IndexedDB, and Web Crypto and IDBKeyRange
 * for verification. No shipped root does yet.
 */

import { UnavailableError } from '../../core/contracts/outcomes.js';
import { DEFAULT_LIMITS, listPoints, openRecovery, verifyPoint } from './recovery-points.js';
import { result } from './requests.js';
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
        /** @type {{ok: true} | {ok: false, code: string}} */ ({ ok: false, code: 'recovery-unavailable' }),
        async db => {
          const point = (await listPoints(db)).find(candidate => candidate.id === pointId);
          if (!point) return { ok: false, code: 'recovery-unavailable' };
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
    /** @returns {Promise<boolean>} whether `vectors` holds a record */
    async stored() {
      /** @type {IDBDatabase | null} */
      let db = null;
      try {
        db = await openWithoutUpgrade(indexedDB, DB_NAME);
        if (!db || !db.objectStoreNames.contains('vectors')) return false;
        const count = await result(db.transaction('vectors', 'readonly').objectStore('vectors').count());
        return count > 0;
      } catch {
        throw new UnavailableError('storage', 'unreadable', true);
      } finally {
        if (db) db.close();
      }
    },
  });
}
