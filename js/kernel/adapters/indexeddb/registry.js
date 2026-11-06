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
 * This build defines structural steps 9, 10, and 11 (#17 PR 3b) and transform steps logical 2
 * (#17 PR 3a) and 3 (#17 PR 3b). Since #17 PR 1b the service worker runs the structural steps
 * at start, through migrate.js, and schema.js's DB_VERSION is the newest one's: 11 since #17 PR
 * 3b. A profile at 8 runs all three in its one `versionchange`. The worker runs the transform
 * steps after that, through transforms.js.
 */

// The names, shapes and plans, which nothing here writes, are registry-names.js's (#35 slice
// 4b-0), so a context that only reads CanvasTabDB imports them without these steps. This module
// still exports each one it did before them, so its importers read the same names. The four
// shapes its steps import from there (legacyShape and STORES_ADDED_AT_9 to 11) stay its own.
export {
  BASE_LOGICAL_VERSION,
  CHANGES_KEY,
  CHANGES_STORE,
  CONFLICTS_STORE,
  DAILY_INDEX_STORE,
  LATEST_LOGICAL,
  LATEST_STRUCTURAL,
  LEGACY_STORE_NAMES,
  META_STORE,
  MIGRATIONS_STORE,
  OPERATIONS_STORE,
  RECEIPT_KEY_PATH,
  SCHEMA_KEY,
  TOMBSTONES_STORE,
  TRANSFORM_STEPS,
  legacySchema,
  pendingTransforms,
  schemaAt,
} from './registry-names.js';
import {
  BASE_LOGICAL_VERSION,
  CHANGES_KEY,
  LATEST_STRUCTURAL,
  LEGACY_STORE_NAMES,
  META_STORE,
  MIGRATIONS_STORE,
  SCHEMA_KEY,
  STORES_ADDED_AT_10,
  STORES_ADDED_AT_11,
  STORES_ADDED_AT_9,
  legacyShape,
} from './registry-names.js';

/** @typedef {import('./registry-names.js').IndexShape} IndexShape */
/** @typedef {import('./registry-names.js').StoreShape} StoreShape */
/** @typedef {import('./registry-names.js').TransformStep} TransformStep */

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

/**
 * Step 10 (#17 PR 2a): the commit model's four stores (STORES_ADDED_AT_10), `meta.schema` at
 * structural version 10 with the logical version it had, and the change log's empty head. No
 * legacy store, index, or record changes. The versions a note carries (`revision`,
 * `placementVersion`, `sourceRevision`) are fields on `canvases`, read as 0 where a record
 * lacks them, so no record is rewritten for them.
 * @type {StructuralStep}
 */
const STEP_10 = Object.freeze({
  id: 'structural-10',
  kind: /** @type {const} */ ('structural'),
  to: 10,
  apply(/** @type {IDBDatabase} */ db, /** @type {IDBTransaction} */ tx, /** @type {StepContext} */ context) {
    for (const [name, shape] of Object.entries(STORES_ADDED_AT_10)) {
      if (!db.objectStoreNames.contains(name)) createStore(db, name, shape);
    }
    const meta = tx.objectStore(META_STORE);
    meta.put({
      key: SCHEMA_KEY,
      structuralVersion: 10,
      logicalVersion: context.logicalVersion ?? BASE_LOGICAL_VERSION,
    });
    meta.put({ key: CHANGES_KEY, head: 0, floor: 0 });
  },
});

/**
 * Step 11 (#17 PR 3b): the daily index (STORES_ADDED_AT_11), empty, and `meta.schema` at
 * structural version 11 with the logical version it had. Nothing else changes: logical 3 fills
 * the index, and each Daily Note's key, after the upgrade (transforms.js).
 * @type {StructuralStep}
 */
const STEP_11 = Object.freeze({
  id: 'structural-11',
  kind: /** @type {const} */ ('structural'),
  to: 11,
  apply(/** @type {IDBDatabase} */ db, /** @type {IDBTransaction} */ tx, /** @type {StepContext} */ context) {
    for (const [name, shape] of Object.entries(STORES_ADDED_AT_11)) {
      if (!db.objectStoreNames.contains(name)) createStore(db, name, shape);
    }
    tx.objectStore(META_STORE).put({
      key: SCHEMA_KEY,
      structuralVersion: 11,
      logicalVersion: context.logicalVersion ?? BASE_LOGICAL_VERSION,
    });
  },
});

/** Every step, in order */
export const STEPS = Object.freeze([STEP_9, STEP_10, STEP_11]);

/**
 * The structural steps a database at structural `from` still needs, in order, up to `target`
 * @param {number} from - 8 for any legacy shape, since step 9 creates every store it lacks
 * @param {number} [target]
 * @returns {StructuralStep[]}
 */
export function pendingStructural(from, target = LATEST_STRUCTURAL) {
  return STEPS.filter(step => step.kind === 'structural' && step.to > from && step.to <= target);
}
