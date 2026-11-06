/**
 * #17's read half (#35 slice 4b-0b): the view a transaction is read through, which #17's adapter
 * puts its writes on top of (adapter.js, view), what a note's versions read as, and a tracker for
 * a read alone (createReadTracker). Nothing here writes, so a context that only reads CanvasTabDB
 * can read through it and reach no module the architecture list gives the role `writer`
 * (docs/architecture/committers.json).
 */

import { UnavailableError } from '../../core/contracts/outcomes.js';
import { TRANSFORM_DAILY_KEY, answerOf } from './daily-answer.js';
import { DAILY_INDEX_STORE, META_STORE } from './registry-names.js';
import { indexValue, result } from './requests.js';
import { IDB_STORES } from './schema.js';

/** @typedef {import('../../core/ports/repository.js').StoreName} StoreName */
/** @typedef {import('../../core/ports/repository.js').ReadTx} ReadTx */
/** @typedef {import('../../core/ports/repository.js').Versions} Versions */

/**
 * What a read tells its transaction's tracker, and asks it: the read half of versions.js's
 * VersionTracker, the tracker #17's adapter hands every view
 * @typedef {object} ReadTracker
 * @property {(key: IDBValidKey, record: Record<string, unknown> | undefined) => void} saw
 *   Notes what a read found for the note `key`, the first time the transaction reads it
 * @property {(key: IDBValidKey) => Versions | undefined} versions
 * @property {(key: IDBValidKey, record: Record<string, unknown> | undefined) => void} sawBlock
 *   Notes what a read found for the block `key`, the first time the transaction reads it
 * @property {(noteId: IDBValidKey, read: Promise<unknown>) => void} coverBlocks
 *   A read of note `noteId`'s blocks through the `canvasId` index, which `read` answers
 * @property {(key: IDBValidKey, record: Record<string, unknown> | undefined) => void} sawFolder
 *   Notes what a read found for the folder `key`, the first time the transaction reads it
 */

/**
 * @param {unknown} value
 * @returns {number}
 */
export const count = value =>
  Number.isSafeInteger(value) && /** @type {number} */ (value) >= 0 ? /** @type {number} */ (value) : 0;

/**
 * The versions a stored note has, each 0 when it has none
 * @param {Record<string, unknown>} record
 * @returns {Versions}
 */
export function versionsOf(record) {
  return {
    revision: count(record.revision),
    placementVersion: count(record.placementVersion),
    sourceRevision: count(record.sourceRevision),
  };
}

/**
 * A key as one string, so two copies of one array key, as #20's storage probe writes under,
 * are one record, and a string key never reads as another key's form
 * @param {IDBValidKey} key
 * @returns {string}
 */
export const idOf = key => (typeof key === 'string' ? `s${key}` : `k${JSON.stringify(key)}`);

/**
 * A tracker for a read alone, as a context that only reads CanvasTabDB hands each view: it keeps
 * each note's versions as the transaction's first read of it found them, and answers them, as
 * versions.js's tracker does. It keeps nothing of blocks or folders, which only a commit's ops
 * read.
 * @returns {ReadTracker}
 */
export function createReadTracker() {
  /**
   * Each note's versions as committed, or null for one the transaction found none of, by idOf
   * @type {Map<string, Versions | null>}
   */
  const known = new Map();
  return {
    saw: (key, record) => {
      const id = idOf(key);
      if (!known.has(id)) known.set(id, record ? versionsOf(record) : null);
    },
    versions: key => {
      const id = idOf(key);
      if (!known.has(id)) throw new UnavailableError('adapter', 'revision-before-get', false);
      return known.get(id) ?? undefined;
    },
    sawBlock: () => {},
    sawFolder: () => {},
    coverBlocks: () => {},
  };
}

/**
 * The IndexedDB stores among `stores` the database has, once each
 * @param {IDBDatabase} db
 * @param {readonly StoreName[]} stores
 * @returns {string[]}
 */
export function present(db, stores) {
  const names = new Set(stores.filter(store => Object.hasOwn(IDB_STORES, store)).map(store => IDB_STORES[store]));
  return [...names].filter(name => db.objectStoreNames.contains(name));
}

/**
 * `names` with `meta` when they hold the daily index and the database has `meta`, so a Daily
 * Note lookup reads logical 3's kept answer in its own transaction (daily-answer.js, F10)
 * @param {IDBDatabase} db
 * @param {string[]} names
 * @returns {string[]}
 */
export function withAnswer(db, names) {
  if (!names.includes(DAILY_INDEX_STORE) || names.includes(META_STORE)) return names;
  return db.objectStoreNames.contains(META_STORE) ? [...names, META_STORE] : names;
}

/**
 * A view's handle on each store it names: the store, or null when the transaction has none or
 * the database lacks it. A store #17 doesn't know, or one outside the transaction, throws.
 * @param {IDBDatabase} db
 * @param {IDBTransaction | null} tx
 * @param {readonly StoreName[]} scope
 * @returns {(store: StoreName) => IDBObjectStore | null}
 */
export function storeHandle(db, tx, scope) {
  return store => {
    if (!Object.hasOwn(IDB_STORES, store)) throw new UnavailableError('adapter', 'unknown-store', false);
    if (!scope.includes(store)) throw new UnavailableError('adapter', 'store-outside-transaction', false);
    const name = IDB_STORES[store];
    return tx && db.objectStoreNames.contains(name) ? tx.objectStore(name) : null;
  };
}

/**
 * A unit's reads of its command's transaction: only the stores it named, where a store the
 * database lacks reads as empty, as DatabaseManager's reads of auxiliary stores do. Notes come
 * back as stored, versions included, and what each read finds goes to the transaction's
 * tracker (versions.js). #17's adapter puts its writes on top (adapter.js, view).
 * @param {IDBDatabase} db
 * @param {IDBTransaction | null} tx - null when the database has none of the stores
 * @param {readonly StoreName[]} scope
 * @param {ReadTracker} tracker
 * @returns {ReadTx}
 */
export function readView(db, tx, scope, tracker) {
  const handle = storeHandle(db, tx, scope);
  /**
   * Tells the tracker what a read found of a note, a block, or a folder, for its versions and
   * the change log's ops (versions.js)
   * @param {StoreName} store
   * @param {IDBValidKey} key
   * @param {Record<string, unknown> | undefined} record
   */
  const saw = (store, key, record) => {
    if (store === 'notes') tracker.saw(key, record);
    else if (store === 'blocks') tracker.sawBlock(key, record);
    else if (store === 'folders') tracker.sawFolder(key, record);
  };
  /**
   * @param {StoreName} store
   * @param {Array<Record<string, unknown>>} records
   */
  const sawAll = (store, records) => {
    for (const record of records) saw(store, /** @type {string} */ (record.id), record);
    return records;
  };
  return /** @type {ReadTx} */ ({
    get: async (store, key) => {
      const objectStore = handle(store);
      const record = objectStore ? await result(objectStore.get(key)) : undefined;
      saw(store, key, record);
      return record;
    },
    getAll: async store => {
      const objectStore = handle(store);
      return sawAll(store, objectStore ? await result(objectStore.getAll()) : []);
    },
    getAllKeys: async store => {
      const objectStore = handle(store);
      return objectStore ? /** @type {string[]} */ (await result(objectStore.getAllKeys())) : [];
    },
    getKey: async (store, key) => {
      const objectStore = handle(store);
      const stored = objectStore
        ? /** @type {string | undefined} */ (await result(objectStore.getKey(key)))
        : undefined;
      // A key with no record tells the tracker what a read that finds none does, so a write of
      // it looks nothing up (R131). A write of it earlier in the transaction looked it up first,
      // and IndexedDB answers in order, so that answer is the one kept.
      if (stored === undefined) saw(store, key, undefined);
      return stored;
    },
    getAllByIndex: async (store, index, value) => {
      const objectStore = handle(store);
      const key = indexValue(value);
      if (!objectStore) return [];
      const read = result(objectStore.index(index).getAll(key));
      // Every block of the note, as it was before any write after this read
      if (store === 'blocks' && index === 'canvasId') tracker.coverBlocks(key, read);
      return sawAll(store, await read);
    },
    getKeysByIndex: async (store, index, value) => {
      const objectStore = handle(store);
      const key = indexValue(value);
      return objectStore ? result(objectStore.index(index).getAllKeys(key)) : [];
    },
    revision: (store, key) => {
      handle(store);
      return store === 'notes' ? tracker.versions(key)?.revision : undefined;
    },
    versions: (store, key) => {
      handle(store);
      return store === 'notes' ? tracker.versions(key) : undefined;
    },
    has: store => handle(store) !== null,
    // Logical 3's kept answer, from `meta`, which a transaction over the daily index spans
    dailyAnswer: async () =>
      tx && tx.objectStoreNames.contains(META_STORE)
        ? answerOf(await result(tx.objectStore(META_STORE).get(TRANSFORM_DAILY_KEY)))
        : null,
  });
}
