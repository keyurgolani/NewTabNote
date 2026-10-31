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
 * The stores step 10 adds (#17 PR 2a), which hold ids, codes, digests, and versions, never note
 * text, but for `conflicts`, which keeps a save that lost to a newer revision so its text
 * survives:
 * - `operations`: the idempotency ledger, `{opId, digest, outcome, at}` per committed or
 *   conflicted command (ledger.js)
 * - `changes`: the change log, `{seq, entityType, entityId, revision, opId, ops, position}`, one
 *   entry per entity per commit, `ops` empty until #17 PR 4 (changes.js)
 * - `conflicts`: `{id, noteId, scope, expected, current, at, command}`, keyed by the commandId
 *   that lost (conflicts.js)
 * - `tombstones`: `{entityType, id, deletedAt, lastRevision, seq, reason, purge}`, content-free.
 *   Core's deletion puts one for each note deleted for good and each folder deleted, in the
 *   delete's own transaction (#17 PR 2b, deletion.js). Only a tombstone whose recovery-point
 *   purge is pending holds `purge`, so its index lists just those (purge.js).
 */
export const OPERATIONS_STORE = 'operations';
export const CHANGES_STORE = 'changes';
export const CONFLICTS_STORE = 'conflicts';
export const TOMBSTONES_STORE = 'tombstones';
/**
 * The store step 11 adds (#17 PR 3b): `{dailyKey, noteId}` for each local date, naming the Daily
 * Note that holds it (domain/daily.js). It's derived from the notes, which the kernel's lookups
 * repair it from (application/notes.js), and holds ids and dates, never note text.
 */
export const DAILY_INDEX_STORE = 'daily_index';
/** `meta`'s record of the change log's `head` (the last seq) and `floor` (the last one pruned) */
export const CHANGES_KEY = 'changes';

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
 * One index as step 10 makes it, neither unique nor multi-entry
 * @param {string} name
 * @param {string | string[]} keyPath
 * @returns {IndexShape}
 */
const plainIndex = (name, keyPath) => ({ name, keyPath, unique: false, multiEntry: false });

/** @type {Readonly<Record<string, StoreShape>>} */
const STORES_ADDED_AT_10 = Object.freeze({
  [OPERATIONS_STORE]: { keyPath: 'opId', autoIncrement: false, indexes: [plainIndex('at', 'at')] },
  [CHANGES_STORE]: {
    keyPath: ['seq', 'entityType', 'entityId'],
    autoIncrement: false,
    indexes: [plainIndex('entity', ['entityType', 'entityId'])],
  },
  [CONFLICTS_STORE]: { keyPath: 'id', autoIncrement: false, indexes: [plainIndex('noteId', 'noteId')] },
  [TOMBSTONES_STORE]: { keyPath: ['entityType', 'id'], autoIncrement: false, indexes: [plainIndex('purge', 'purge')] },
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

/** @type {Readonly<Record<string, StoreShape>>} */
const STORES_ADDED_AT_11 = Object.freeze({
  [DAILY_INDEX_STORE]: { keyPath: 'dailyKey', autoIncrement: false, indexes: [] },
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
 * A transform step (#17 PR 3a): a logical version that fills fields in place, in resumable
 * batches, outside any upgrade, which the worker runs once its run is in (transforms.js)
 * @typedef {{id: string, kind: 'transform', to: number}} TransformStep
 */

/**
 * Logical 2: each note's placement, kind, and lifecycle from its flags, and an `updatedAt` for
 * a note an index can't list (transforms.js)
 * @type {TransformStep}
 */
const LOGICAL_2 = Object.freeze({ id: 'logical-2', kind: /** @type {const} */ ('transform'), to: 2 });

/**
 * Logical 3 (#17 PR 3b): each Daily Note's local key, its zone, and the note that holds the key
 * when another does, by #17's rules (domain/daily.js), and the daily index's entries
 * (transforms.js)
 * @type {TransformStep}
 */
const LOGICAL_3 = Object.freeze({ id: 'logical-3', kind: /** @type {const} */ ('transform'), to: 3 });

/** Every transform step, in order */
export const TRANSFORM_STEPS = Object.freeze([LOGICAL_2, LOGICAL_3]);

/** The newest logical version this build's transforms reach */
export const LATEST_LOGICAL = TRANSFORM_STEPS.reduce((latest, step) => Math.max(latest, step.to), 1);

/**
 * The transform steps a database at logical version `from` still needs, in order
 * @param {number} from
 * @returns {TransformStep[]}
 */
export function pendingTransforms(from) {
  return TRANSFORM_STEPS.filter(step => step.to > from);
}

/** The newest structural version this registry reaches, which this build opens CanvasTabDB at */
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
  if (version === 10) {
    return { ...legacySchema(), ...structuredClone(STORES_ADDED_AT_9), ...structuredClone(STORES_ADDED_AT_10) };
  }
  if (version === 11) {
    return {
      ...legacySchema(),
      ...structuredClone(STORES_ADDED_AT_9),
      ...structuredClone(STORES_ADDED_AT_10),
      ...structuredClone(STORES_ADDED_AT_11),
    };
  }
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
