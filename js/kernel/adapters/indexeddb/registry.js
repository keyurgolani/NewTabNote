/**
 * #17's sequential migration registry ("Data and migration", "Steps"): every schema change
 * CanvasTabDB gets, in order, each one an entry that never changes once it ships. A user on
 * any supported shape runs every pending structural step in one `versionchange` (migrate.js),
 * so going from 8 to the newest is one upgrade, one recovery point, and one reload.
 *
 * Structural steps (`kind: 'structural'`) run inside the `versionchange` transaction, where
 * anything awaited would commit it early (#17, step 2). So `apply(db, tx, context)` makes only
 * `createObjectStore`, `createIndex`, and `put` calls, synchronously, and returns nothing; it
 * reads what's there through `db.objectStoreNames` and `context`, never a request.
 * test/kernel/storage-migrate.test.mjs wraps the transaction and fails on any other call.
 *
 * Every step only adds (#17, "Compatibility"): the ten legacy stores, their indexes, and their
 * records stay, since 1.3.0 and 1.4.0 delete the whole database when one is missing. Transform
 * steps (`kind: 'transform'`, logical versions, #17 PR 3) run in batches outside the upgrade.
 *
 * This build defines step 9 only. #17 PR 2 adds 10 and PR 3 adds 11. Nothing opens CanvasTabDB
 * at 9 yet: schema.js's DB_VERSION stays 8 until #17 PR 1b wires the worker to migrate.js.
 */

import { STORE_SCHEMAS } from './schema.js';

/**
 * An index as IndexedDB reports it
 * @typedef {{name: string, keyPath: string | string[], unique: boolean, multiEntry: boolean}} IndexShape
 */

/**
 * A store as IndexedDB reports it, indexes sorted by name
 * @typedef {{keyPath: string | string[] | null, autoIncrement: boolean, indexes: IndexShape[]}} StoreShape
 */

/**
 * What a structural step knows about the database it upgrades, read before the upgrade began
 * @typedef {{logicalVersion: number | null}} StepContext
 */

/**
 * @typedef {object} StructuralStep
 * @property {string} id - the receipt's id, never reused
 * @property {'structural'} kind
 * @property {number} to - the structural version (and IndexedDB version) it leaves
 * @property {(db: IDBDatabase, tx: IDBTransaction, context: StepContext) => void} apply
 */

/** @typedef {StructuralStep} Step */

/** The store `meta` (#17, "Compatibility"): `{key: 'schema', structuralVersion, logicalVersion}` */
export const META_STORE = 'meta';
/** Its one record's key */
export const SCHEMA_KEY = 'schema';
/** The store of receipts, one per step and status (migrate.js) */
export const MIGRATIONS_STORE = 'migrations';
/** Receipts are keyed by step and status, so a step has at most one completion */
export const RECEIPT_KEY_PATH = Object.freeze(['id', 'status']);

/** The ten stores 1.3.0 to 1.4.1 make at version 8, every later shape keeps */
export const LEGACY_STORE_NAMES = Object.freeze(Object.keys(STORE_SCHEMAS).sort());

/**
 * A version-8 store's shape: its key path, and each index on the field it's named after,
 * neither unique nor multi-entry, as every release from 1.0.0 to 1.4.1 makes it
 * @param {string} name
 * @returns {StoreShape}
 */
function legacyShape(name) {
  const { keyPath, indexes } = STORE_SCHEMAS[name];
  return {
    keyPath,
    autoIncrement: false,
    indexes: [...indexes].sort().map(index => ({ name: index, keyPath: index, unique: false, multiEntry: false })),
  };
}

/** @type {Readonly<Record<string, StoreShape>>} */
const STORES_ADDED_AT_9 = Object.freeze({
  [META_STORE]: { keyPath: 'key', autoIncrement: false, indexes: [] },
  [MIGRATIONS_STORE]: { keyPath: [...RECEIPT_KEY_PATH], autoIncrement: false, indexes: [] },
});

/**
 * Creates a store as `shape` has it, with its indexes
 * @param {IDBDatabase} db
 * @param {string} name
 * @param {StoreShape} shape
 * @returns {IDBObjectStore}
 */
function createStore(db, name, shape) {
  const store = db.createObjectStore(name, { keyPath: shape.keyPath, autoIncrement: shape.autoIncrement });
  for (const index of shape.indexes) {
    store.createIndex(index.name, index.keyPath, { unique: index.unique, multiEntry: index.multiEntry });
  }
  return store;
}

/**
 * Step 9: every legacy store the database lacks, with its version-8 indexes (so no rollback
 * to 1.3.0 or 1.4.0 finds one missing and deletes the database), then `meta` and
 * `migrations`, and `meta.schema` at structural version 9. Records already there are left as
 * they are. Logical version 1 is the legacy record shape; PR 3's transforms raise it.
 * @type {StructuralStep}
 */
const STEP_9 = Object.freeze({
  id: 'structural-9',
  kind: /** @type {const} */ ('structural'),
  to: 9,
  apply(/** @type {IDBDatabase} */ db, /** @type {IDBTransaction} */ tx, /** @type {StepContext} */ context) {
    for (const name of LEGACY_STORE_NAMES) {
      if (!db.objectStoreNames.contains(name)) createStore(db, name, legacyShape(name));
    }
    const meta = db.objectStoreNames.contains(META_STORE)
      ? tx.objectStore(META_STORE)
      : createStore(db, META_STORE, STORES_ADDED_AT_9[META_STORE]);
    if (!db.objectStoreNames.contains(MIGRATIONS_STORE)) {
      createStore(db, MIGRATIONS_STORE, STORES_ADDED_AT_9[MIGRATIONS_STORE]);
    }
    meta.put({ key: SCHEMA_KEY, structuralVersion: 9, logicalVersion: context.logicalVersion ?? 1 });
  },
});

/** Every step, in order */
export const STEPS = Object.freeze([STEP_9]);

/** The newest structural version this registry reaches, which #17 PR 1b opens CanvasTabDB at */
export const LATEST_STRUCTURAL = STEPS.reduce((latest, step) => Math.max(latest, step.to), 8);

/** The logical version step 9 writes when nothing set one before it */
export const BASE_LOGICAL_VERSION = 1;

/**
 * Every store at structural version 8 (the legacy shape, before `meta` exists)
 * @returns {Record<string, StoreShape>}
 */
export function legacySchema() {
  return Object.fromEntries(LEGACY_STORE_NAMES.map(name => [name, legacyShape(name)]));
}

/**
 * Every store a database at structural `version` has, or null for one this registry doesn't
 * define
 * @param {number} version
 * @returns {Record<string, StoreShape> | null}
 */
export function schemaAt(version) {
  if (version === 8) return legacySchema();
  if (version === 9) return { ...legacySchema(), ...structuredClone(STORES_ADDED_AT_9) };
  return null;
}

/**
 * The structural steps a database at structural `from` still needs, in order, up to `target`
 * @param {number} from - 8 for any legacy shape, since step 9 creates every store it lacks
 * @param {number} [target]
 * @returns {StructuralStep[]}
 */
export function pendingStructural(from, target = LATEST_STRUCTURAL) {
  return STEPS.filter(step => step.kind === 'structural' && step.to > from && step.to <= target);
}
