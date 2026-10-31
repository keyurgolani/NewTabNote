/**
 * What #20's salvage file and Save as file read (#20, "Salvage file"; js/trust/core/
 * remediation/salvage-file.js shapes it): everything readable a user could lose, read without
 * changing anything, and never the secret-class legacy IndexedDB `settings` store.
 *
 * - CanvasTabDB, opened at whatever version is on disk without upgrading it (no database is
 *   "missing", never one made), each store its schema knows (version 8's, #17's `meta` and
 *   `migrations`, and step 10's four) but `settings`, one at a time in #17's bounded readonly batches
 *   (recovery-points.js's readBatch). A store that won't read answers its error code and no
 *   values, and the next store is still read. A store the schema doesn't know is never read:
 *   it's named with no values, so the file can say it was left out.
 * - The legacy copies in chrome.storage.local, `auto_backup_<time>` and
 *   `recovery_backup_<time>`, by key. Only those keys' values are kept; nothing else the area
 *   holds is returned.
 * - #17's recovery points in NewTabNoteRecovery, each read back and verified again now, with
 *   its rows per store.
 * Every Blob becomes a data URL (data-urls.js), so what this answers is plain JSON.
 *
 * Nothing shipped calls it: the remediation pipeline does, in-process, once slice 4's views
 * start a run.
 */

import { failureOf } from './failures.js';
import { withDataUrls } from './data-urls.js';
import {
  DEFAULT_LIMITS,
  EXCLUDED_STORES,
  listPoints,
  openRecovery,
  readBatch,
  readPointStore,
  verifyPoint,
} from './recovery-points.js';
import {
  CHANGES_STORE,
  CONFLICTS_STORE,
  DAILY_INDEX_STORE,
  META_STORE,
  MIGRATIONS_STORE,
  OPERATIONS_STORE,
  TOMBSTONES_STORE,
} from './registry.js';
import { DB_NAME, STORE_SCHEMAS } from './schema.js';
import { openWithoutUpgrade } from './shapes.js';

/** @typedef {import('./records.js').Digester} Digester */
/** @typedef {import('./recovery-points.js').Point} Point */

/**
 * The stores it reads: every one CanvasTabDB's schema knows, but the secret-class `settings`.
 * That's step 10's four too (#17 PR 2a): the ledger, the change log, the conflict records,
 * which hold the text a conflict kept, and the tombstones; and step 11's daily index (#17 PR 3b).
 */
export const READ_STORES = Object.freeze(
  [
    ...Object.keys(STORE_SCHEMAS),
    META_STORE,
    MIGRATIONS_STORE,
    OPERATIONS_STORE,
    CHANGES_STORE,
    CONFLICTS_STORE,
    TOMBSTONES_STORE,
    DAILY_INDEX_STORE,
  ]
    .filter(name => !EXCLUDED_STORES.includes(name))
    .sort(),
);

/** A legacy copy's key: what 1.4.x's auto-backup and recovery copies are stored under */
export const LEGACY_COPY_KEY = /^(?:auto|recovery)_backup_[0-9]{10,16}$/;

/** A #17 recovery point's id */
const POINT_ID = /^pre-(?:migration|repair)-[0-9]{10,16}(?:-[0-9]{1,3})?$/;

/**
 * chrome.storage.local, or anything with its promise-returning get, which takes null for
 * every key
 * @typedef {{get: (keys: string[] | null) => Promise<Record<string, unknown>>}} SettingsReader
 */

/** @typedef {{store: string, values: unknown[], errorCode?: string}} StoreRead */

/**
 * @typedef {object} PointRead
 * @property {string} id
 * @property {string} kind
 * @property {string} status - as stored: `copying`, `verified`, or `failed`
 * @property {boolean} verified - whether it read back verified now
 * @property {number} createdAt
 * @property {number | null} verifiedAt
 * @property {StoreRead[]} stores
 */

/**
 * @typedef {object} SalvageRead
 * @property {{status: 'open' | 'missing' | 'failed', errorCode?: string, stores: StoreRead[]}} database
 * @property {{status: 'read' | 'failed', errorCode?: string, copies: Array<{key: string, value: unknown}>}} legacyCopies
 * @property {{status: 'read' | 'missing' | 'failed', errorCode?: string, points: PointRead[]}} recoveryPoints
 */

/**
 * @typedef {{kind: 'legacy-copy', key: string, value: unknown}
 *   | {kind: 'recovery-point', point: PointRead}} RestorePointRead
 */

/**
 * The error code `error` answers with, never its message
 * @param {unknown} error
 */
const codeOf = error => failureOf(error).code;

/**
 * Every value of `store`, read in bounded batches, Blobs as data URLs
 * @param {IDBDatabase} db
 * @param {string} store
 * @param {typeof IDBKeyRange} keyRange
 * @returns {Promise<StoreRead>}
 */
async function readStore(db, store, keyRange) {
  /** @type {unknown[]} */
  const values = [];
  try {
    /** @type {IDBValidKey | null} */
    let after = null;
    for (;;) {
      const batch = await readBatch(db, store, after, null, { keyRange, limits: DEFAULT_LIMITS });
      for (const { value } of batch.entries) values.push(await withDataUrls(value));
      if (batch.entries.length > 0) after = batch.entries[batch.entries.length - 1].key;
      if (batch.end || batch.entries.length === 0) break;
    }
    return { store, values };
  } catch (error) {
    return { store, values: [], errorCode: codeOf(error) };
  }
}

/**
 * @param {{indexedDB: IDBFactory, keyRange: typeof IDBKeyRange, crypto: Digester, settings: SettingsReader}} options
 */
export function createSalvageReader({ indexedDB, keyRange, crypto, settings }) {
  const io = { keyRange, crypto, limits: DEFAULT_LIMITS };

  /**
   * One point, verified again now, with its rows per store
   * @param {IDBDatabase} recovery
   * @param {Point} point
   * @returns {Promise<PointRead>}
   */
  const readPoint = async (recovery, point) => {
    let verified = false;
    try {
      verified = point.status === 'verified' && (await verifyPoint({ recovery, point, io })).ok;
    } catch {
      verified = false;
    }
    /** @type {StoreRead[]} */
    const stores = [];
    for (const store of point.stores) {
      if (EXCLUDED_STORES.includes(store)) continue;
      if (!READ_STORES.includes(store)) {
        stores.push({ store, values: [] });
        continue;
      }
      try {
        const rows = await readPointStore(recovery, point, store, io);
        const values = [];
        for (const { value } of rows) values.push(await withDataUrls(value));
        stores.push({ store, values });
      } catch (error) {
        stores.push({ store, values: [], errorCode: codeOf(error) });
      }
    }
    return {
      id: point.id,
      kind: point.kind,
      status: point.status,
      verified,
      createdAt: point.createdAt,
      verifiedAt: point.verifiedAt,
      stores,
    };
  };

  /** @returns {Promise<SalvageRead['database']>} */
  const readDatabase = async () => {
    /** @type {IDBDatabase | null} */
    let db;
    try {
      db = await openWithoutUpgrade(indexedDB, DB_NAME);
    } catch (error) {
      return { status: 'failed', errorCode: codeOf(error), stores: [] };
    }
    if (!db) return { status: 'missing', stores: [] };
    try {
      const names = Array.from(db.objectStoreNames)
        .filter(name => !EXCLUDED_STORES.includes(name))
        .sort();
      /** @type {StoreRead[]} */
      const stores = [];
      for (const name of names) {
        stores.push(READ_STORES.includes(name) ? await readStore(db, name, keyRange) : { store: name, values: [] });
      }
      return { status: 'open', stores };
    } finally {
      db.close();
    }
  };

  /** @returns {Promise<SalvageRead['legacyCopies']>} */
  const readCopies = async () => {
    try {
      const all = await settings.get(null);
      const copies = Object.keys(all || {})
        .filter(key => LEGACY_COPY_KEY.test(key))
        .sort()
        .map(key => ({ key, value: all[key] }));
      return { status: 'read', copies };
    } catch (error) {
      return { status: 'failed', errorCode: codeOf(error), copies: [] };
    }
  };

  /** @returns {Promise<SalvageRead['recoveryPoints']>} */
  const readPoints = async () => {
    /** @type {IDBDatabase | null} */
    let recovery;
    try {
      recovery = await openRecovery(indexedDB, { create: false });
    } catch (error) {
      return { status: 'failed', errorCode: codeOf(error), points: [] };
    }
    if (!recovery) return { status: 'missing', points: [] };
    try {
      const points = [];
      for (const point of await listPoints(recovery)) points.push(await readPoint(recovery, point));
      return { status: 'read', points };
    } catch (error) {
      return { status: 'failed', errorCode: codeOf(error), points: [] };
    } finally {
      recovery.close();
    }
  };

  return Object.freeze({
    /**
     * Everything the salvage file holds, read now. Never rejects: what won't read answers its
     * error code.
     * @returns {Promise<SalvageRead>}
     */
    async collect() {
      return { database: await readDatabase(), legacyCopies: await readCopies(), recoveryPoints: await readPoints() };
    },

    /**
     * Whether restore point `subjectId` is there, read without its rows: before Save as file
     * opens the picker
     * @param {string} subjectId
     * @returns {Promise<boolean>}
     */
    async has(subjectId) {
      if (LEGACY_COPY_KEY.test(subjectId)) {
        const found = await settings.get([subjectId]);
        return Boolean(found) && Object.hasOwn(found, subjectId) && found[subjectId] !== undefined;
      }
      if (!POINT_ID.test(subjectId)) return false;
      const recovery = await openRecovery(indexedDB, { create: false });
      if (!recovery) return false;
      try {
        return (await listPoints(recovery)).some(point => point.id === subjectId);
      } finally {
        recovery.close();
      }
    },

    /**
     * One restore point to save as a file: a legacy copy by its key, or a verified #17 point
     * by its id. Resolves null when there's no such point; rejects with an UnavailableError
     * when it can't be read.
     * @param {string} subjectId
     * @returns {Promise<RestorePointRead | null>}
     */
    async restorePoint(subjectId) {
      if (LEGACY_COPY_KEY.test(subjectId)) {
        const found = await settings.get([subjectId]);
        if (!found || !Object.hasOwn(found, subjectId) || found[subjectId] === undefined) return null;
        return { kind: 'legacy-copy', key: subjectId, value: found[subjectId] };
      }
      if (!POINT_ID.test(subjectId)) return null;
      const recovery = await openRecovery(indexedDB, { create: false });
      if (!recovery) return null;
      try {
        const point = (await listPoints(recovery)).find(candidate => candidate.id === subjectId);
        if (!point) return null;
        return { kind: 'recovery-point', point: await readPoint(recovery, point) };
      } finally {
        recovery.close();
      }
    },
  });
}

/** @typedef {ReturnType<typeof createSalvageReader>} SalvageReader */
