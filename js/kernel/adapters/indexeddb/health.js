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
 * - the migration reader: CanvasTabDB's version against the one this build upgrades to, and
 *   what the worker recorded of its last run (`setting_storageUpgrade`), for storage's check
 *   below that version (9 at #17 PR 1b, 10 since PR 2a).
 *
 * A composition root makes them with the context's IndexedDB, and Web Crypto and IDBKeyRange
 * for verification. No shipped root does yet.
 */

import { UnavailableError } from '../../core/contracts/outcomes.js';
import { DEFAULT_LIMITS, listPoints, openRecovery, verifyPoint } from './recovery-points.js';
import { LATEST_STRUCTURAL } from './registry.js';
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
          // Discarded since it was listed, by #17's migration run or keepVerified replacing an
          // older pre-repair point
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

/** chrome.storage.local key of the worker's last migration run (composition/background.js) */
const UPGRADE_RECORD_KEY = 'setting_storageUpgrade';

/**
 * chrome.storage.local key of the marker the worker's run sets while its upgrade waits on
 * another connection (composition/background.js). It's outside `setting_*`, so no page's
 * settings listener hears of it, and no copy of the settings takes it.
 */
export const UPGRADE_BLOCKED_KEY = 'storageUpgradeBlocked';

/**
 * Where CanvasTabDB is against the version this build upgrades to, and whether a run's upgrade
 * is waiting on another connection now
 * @typedef {{version: number, latest: number, status: string | null, code: string | null, blocked: boolean}} MigrationState
 */

/**
 * @param {{indexedDB: IDBFactory, settings: import('./adapter.js').SettingsStore}} options
 */
export function createMigrationReader({ indexedDB, settings }) {
  return Object.freeze({
    /**
     * CanvasTabDB's version (0 when there's none), the latest, the recorded run's status and
     * code, null when there's no record, and whether the worker's blocked marker stands. It
     * reads the version from indexedDB.databases(), which opens no connection, so it never
     * waits behind an upgrade; a factory without databases() leaves it unknown, and it throws.
     * It writes nothing.
     * @returns {Promise<MigrationState>}
     */
    async current() {
      if (typeof indexedDB.databases !== 'function') throw new UnavailableError('storage', 'unreadable', true);
      let version = 0;
      try {
        const listed = await indexedDB.databases();
        const found = listed.find(database => database && database.name === DB_NAME);
        if (found && Number.isSafeInteger(found.version)) version = /** @type {number} */ (found.version);
      } catch {
        throw new UnavailableError('storage', 'unreadable', true);
      }
      /** @type {unknown} */
      let stored;
      try {
        stored = await settings.get([UPGRADE_RECORD_KEY, UPGRADE_BLOCKED_KEY]);
      } catch {
        throw new UnavailableError('storage', 'settings-read-failed', true);
      }
      if (stored === null || typeof stored !== 'object') throw new UnavailableError('storage', 'settings-read-failed', true);
      const record = /** @type {Record<string, unknown>} */ (stored)[UPGRADE_RECORD_KEY];
      const fields = record !== null && typeof record === 'object' ? /** @type {Record<string, unknown>} */ (record) : {};
      return {
        version,
        latest: LATEST_STRUCTURAL,
        status: typeof fields.status === 'string' ? fields.status : null,
        code: typeof fields.code === 'string' ? fields.code : null,
        blocked: Boolean(/** @type {Record<string, unknown>} */ (stored)[UPGRADE_BLOCKED_KEY]),
      };
    },
  });
}
