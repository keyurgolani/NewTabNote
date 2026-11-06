/**
 * #17's registry's names, shapes and plans (#35 slice 4b-0): every store's name and key, each
 * structural version's store shapes, the newest version, and the transform plan, which a
 * context that only reads CanvasTabDB may import, since nothing here writes. The steps that make
 * those shapes, and write `meta`, are registry.js's, which only the worker's adapter and its
 * migration runner run. registry.js re-exports what it exported before them, and
 * test/kernel/registry-names.test.mjs holds the newest version here to its steps. legacyShape
 * and the STORES_ADDED_AT shapes, which were registry.js's own, are exported for its steps
 * alone.
 */

import { DB_VERSION, STORE_SCHEMAS } from './schema.js';

/**
 * An index as IndexedDB reports it
 * @typedef {{name: string, keyPath: string | string[], unique: boolean, multiEntry: boolean}} IndexShape
 */

/**
 * A store as IndexedDB reports it, indexes sorted by name
 * @typedef {{keyPath: string | string[] | null, autoIncrement: boolean, indexes: IndexShape[]}} StoreShape
 */

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
export function legacyShape(name) {
  const { keyPath, indexes } = STORE_SCHEMAS[name];
  return {
    keyPath,
    autoIncrement: false,
    indexes: [...indexes].sort().map(index => ({ name: index, keyPath: index, unique: false, multiEntry: false })),
  };
}

/** @type {Readonly<Record<string, StoreShape>>} */
export const STORES_ADDED_AT_9 = Object.freeze({
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
export const STORES_ADDED_AT_10 = Object.freeze({
  [OPERATIONS_STORE]: { keyPath: 'opId', autoIncrement: false, indexes: [plainIndex('at', 'at')] },
  [CHANGES_STORE]: {
    keyPath: ['seq', 'entityType', 'entityId'],
    autoIncrement: false,
    indexes: [plainIndex('entity', ['entityType', 'entityId'])],
  },
  [CONFLICTS_STORE]: { keyPath: 'id', autoIncrement: false, indexes: [plainIndex('noteId', 'noteId')] },
  [TOMBSTONES_STORE]: { keyPath: ['entityType', 'id'], autoIncrement: false, indexes: [plainIndex('purge', 'purge')] },
});

/** @type {Readonly<Record<string, StoreShape>>} */
export const STORES_ADDED_AT_11 = Object.freeze({
  [DAILY_INDEX_STORE]: { keyPath: 'dailyKey', autoIncrement: false, indexes: [] },
});

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

/**
 * The newest structural version this registry reaches, which this build opens CanvasTabDB at:
 * schema.js's DB_VERSION, which test/kernel/registry-names.test.mjs holds to the newest step's
 */
export const LATEST_STRUCTURAL = DB_VERSION;

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
