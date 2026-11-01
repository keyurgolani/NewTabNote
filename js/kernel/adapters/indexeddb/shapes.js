/**
 * Which shape a CanvasTabDB is in (#17, "Data and migration"), read from its stores, their key
 * paths and indexes, and `meta`, never from `oldVersion` or the version number alone. The
 * support matrix (test/fixtures/storage/shapes.json has each row with its tag and line):
 * - `none`: no database, or one with no stores below the newest version this build reaches.
 *   One with no stores at or above it is `unknown` (`empty-at-target`): opening it there runs
 *   no upgrade, and making it again would mean deleting it, which nothing here does (#33's
 *   AC6, test/startup.test.js), so it's left as it is.
 * - `legacy`: a subset of the ten version-8 stores, each as every release made it, holding
 *   `canvases` and `elements`, at IndexedDB version 2 to 8 (1.0.0 to 1.4.1), with the stores
 *   it lacks. Step 9 adds them.
 * - `missing-core`: the same, without `canvases` or `elements`, which no step can supply
 * - `current`: `meta.schema` names a structural version this registry defines, and the
 *   database is at that IndexedDB version with exactly that version's stores
 * - `newer`: `meta.schema` names a later structural version, or the database is at an
 *   IndexedDB version later than this build can open, so a newer build wrote it
 * - `unknown`: anything else, such as a store no release made, a legacy store with other
 *   indexes, or `meta` without a readable schema
 * Only `none` and `legacy` migrate. The rest stay as they are, copied to a recovery point for
 * #18 (Q13), and #33's refusal stays the answer for them.
 */

import { failureOf } from './failures.js';
import { abort, endOf } from './requests.js';
import { DB_NAME } from './schema.js';
import {
  LATEST_STRUCTURAL,
  LEGACY_STORE_NAMES,
  META_STORE,
  MIGRATIONS_STORE,
  SCHEMA_KEY,
  legacySchema,
  schemaAt,
} from './registry.js';

/** @typedef {import('./registry.js').StoreShape} StoreShape */
/** @typedef {import('./registry.js').IndexShape} IndexShape */

/**
 * A receipt (migrate.js), as `migrations` holds it: ids, versions, times, and a failure code,
 * never content. A transform step's (transforms.js) adds how many records it read and filled.
 * @typedef {{id: string, from: number | null, to: number, status: 'completed' | 'failed' | 'space-blocked', startedAt: number, completedAt: number, recoveryPointId: string | null, failure: {code: string} | null, counts?: Record<string, number>}} Receipt
 */

/**
 * What a non-upgrading open read
 * @typedef {object} Inspection
 * @property {boolean} exists
 * @property {number} version - 0 when there's no database
 * @property {Record<string, StoreShape>} stores
 * @property {{structuralVersion: unknown, logicalVersion: unknown} | null | 'unreadable'} meta
 *   `meta.schema`, null without a `meta` store, `unreadable` when the store holds none
 * @property {Receipt[]} receipts - `migrations`, when the database has it
 */

/**
 * @typedef {{kind: 'none'}
 *   | {kind: 'legacy', missing: string[]}
 *   | {kind: 'missing-core', missing: string[]}
 *   | {kind: 'current', structuralVersion: number, logicalVersion: number}
 *   | {kind: 'newer', structuralVersion: number | null}
 *   | {kind: 'unknown', reason: string}} Shape
 */

/** Stores without which nothing can read the notes (schema.js's CORE_STORES) */
const CORE = Object.freeze(['canvases', 'elements']);

/** The oldest IndexedDB version a release wrote (1.0.0) and the newest before `meta` (1.3.0 to 1.4.1) */
const FIRST_LEGACY_VERSION = 2;
const LAST_LEGACY_VERSION = 8;

/**
 * A key path in a form two can be compared in
 * @param {unknown} keyPath
 * @returns {string}
 */
const keyPathText = keyPath => JSON.stringify(keyPath === undefined ? null : keyPath);

/**
 * Whether two store shapes match: key path, key generator, and every index
 * @param {StoreShape} actual
 * @param {StoreShape} expected
 */
export function sameStore(actual, expected) {
  if (keyPathText(actual.keyPath) !== keyPathText(expected.keyPath)) return false;
  if (actual.autoIncrement !== expected.autoIncrement) return false;
  if (actual.indexes.length !== expected.indexes.length) return false;
  return actual.indexes.every((index, i) => {
    const other = expected.indexes[i];
    return (
      index.name === other.name &&
      keyPathText(index.keyPath) === keyPathText(other.keyPath) &&
      index.unique === other.unique &&
      index.multiEntry === other.multiEntry
    );
  });
}

/**
 * Whether `value` is a version number a schema record can hold
 * @param {unknown} value
 * @returns {value is number}
 */
const isVersion = value => typeof value === 'number' && Number.isInteger(value) && value > 0;

/**
 * The shape an inspection shows (see the top of this file)
 * @param {Inspection} inspection
 * @param {{latest?: number}} [build] - the newest structural version this build reaches
 * @returns {Shape}
 */
export function detectShape(inspection, { latest = LATEST_STRUCTURAL } = {}) {
  const names = Object.keys(inspection.stores).sort();
  const { meta } = inspection;

  if (meta !== null) {
    if (meta === 'unreadable' || !isVersion(meta.structuralVersion))
      return { kind: 'unknown', reason: 'meta-unreadable' };
    const structuralVersion = meta.structuralVersion;
    if (structuralVersion > latest) return { kind: 'newer', structuralVersion };
    const schema = schemaAt(structuralVersion);
    if (!schema || structuralVersion <= LAST_LEGACY_VERSION) return { kind: 'unknown', reason: 'meta-unreadable' };
    if (inspection.version > latest) return { kind: 'newer', structuralVersion };
    if (inspection.version !== structuralVersion) return { kind: 'unknown', reason: 'version-mismatch' };
    const expected = Object.keys(schema).sort();
    const same =
      names.length === expected.length &&
      names.every((name, i) => name === expected[i] && sameStore(inspection.stores[name], schema[name]));
    if (!same) return { kind: 'unknown', reason: 'schema-mismatch' };
    if (!isVersion(meta.logicalVersion)) return { kind: 'unknown', reason: 'meta-unreadable' };
    return { kind: 'current', structuralVersion, logicalVersion: meta.logicalVersion };
  }

  // No store: nothing to keep, and below the target an upgrade makes every store
  if (names.length === 0) {
    return inspection.version < latest ? { kind: 'none' } : { kind: 'unknown', reason: 'empty-at-target' };
  }
  // A version this build can't open was written by a newer one
  if (inspection.version > latest) return { kind: 'newer', structuralVersion: null };

  const legacy = legacySchema();
  if (names.some(name => !Object.hasOwn(legacy, name))) return { kind: 'unknown', reason: 'extra-store' };
  if (names.some(name => !sameStore(inspection.stores[name], legacy[name]))) {
    return { kind: 'unknown', reason: 'store-mismatch' };
  }
  if (inspection.version < FIRST_LEGACY_VERSION || inspection.version > LAST_LEGACY_VERSION) {
    return { kind: 'unknown', reason: 'version-mismatch' };
  }
  const missing = LEGACY_STORE_NAMES.filter(name => !names.includes(name));
  if (CORE.some(name => missing.includes(name))) return { kind: 'missing-core', missing };
  return { kind: 'legacy', missing };
}

/**
 * Every store's shape, `meta.schema`, and the receipts, read in one readonly transaction
 * @param {IDBDatabase} db
 * @returns {Promise<Omit<Inspection, 'exists'>>}
 */
export function readSchema(db) {
  const names = Array.from(db.objectStoreNames).sort();
  if (names.length === 0) return Promise.resolve({ version: db.version, stores: {}, meta: null, receipts: [] });
  return new Promise((resolve, reject) => {
    const tx = db.transaction(names, 'readonly');
    /** @type {Record<string, StoreShape>} */
    const stores = {};
    for (const name of names) {
      const store = tx.objectStore(name);
      const indexes = Array.from(store.indexNames)
        .sort()
        .map(indexName => {
          const index = store.index(indexName);
          return { name: indexName, keyPath: index.keyPath, unique: index.unique, multiEntry: index.multiEntry };
        });
      stores[name] = { keyPath: store.keyPath, autoIncrement: store.autoIncrement, indexes };
    }
    /** @type {IDBRequest | null} */
    const metaRequest = names.includes(META_STORE) ? tx.objectStore(META_STORE).get(SCHEMA_KEY) : null;
    /** @type {IDBRequest | null} */
    const receiptsRequest = names.includes(MIGRATIONS_STORE) ? tx.objectStore(MIGRATIONS_STORE).getAll() : null;
    endOf(tx).then(end => {
      if (!end.committed) {
        reject(end.error);
        return;
      }
      const record = metaRequest ? metaRequest.result : undefined;
      /** @type {Inspection['meta']} */
      let meta = null;
      if (metaRequest) {
        meta =
          record && typeof record === 'object'
            ? { structuralVersion: record.structuralVersion, logicalVersion: record.logicalVersion }
            : 'unreadable';
      }
      resolve({ version: db.version, stores, meta, receipts: receiptsRequest ? receiptsRequest.result || [] : [] });
    });
  });
}

/**
 * Opens `name` without upgrading it: at whatever version is on disk, making no database when
 * there's none. Resolves null for none. It closes on versionchange, so it never blocks one.
 * @param {IDBFactory} indexedDB
 * @param {string} name
 * @returns {Promise<IDBDatabase | null>}
 */
export function openWithoutUpgrade(indexedDB, name) {
  return new Promise((resolve, reject) => {
    /** @type {IDBOpenDBRequest} */
    let request;
    try {
      request = indexedDB.open(name);
    } catch (error) {
      reject(failureOf(error));
      return;
    }
    let creating = false;
    request.onupgradeneeded = () => {
      // There was no database: abort, so this open makes none
      creating = true;
      abort(request.transaction);
    };
    request.onsuccess = () => {
      const db = request.result;
      db.onversionchange = () => db.close();
      resolve(db);
    };
    request.onerror = () => {
      if (creating) resolve(null);
      else reject(request.error);
    };
  });
}

/**
 * Reads CanvasTabDB's shape without upgrading or writing it
 * @param {IDBFactory} indexedDB
 * @param {string} [name]
 * @returns {Promise<Inspection>}
 */
export async function inspect(indexedDB, name = DB_NAME) {
  const db = await openWithoutUpgrade(indexedDB, name);
  if (!db) return { exists: false, version: 0, stores: {}, meta: null, receipts: [] };
  try {
    return { exists: true, ...(await readSchema(db)) };
  } finally {
    db.close();
  }
}
