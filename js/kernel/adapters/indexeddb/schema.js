/**
 * CanvasTabDB as 1.4.x has stored it since version 8 (#17, "Data and migration"). #17 slice 1
 * changes nothing in it: the adapter opens the same database at the same version, with the
 * same ten stores and indexes, and writes the same records. A database an older version left
 * gets each store it lacks, with the indexes js/storage.js gives it, as Storage.open always
 * has. #17 slice 2's migration registry replaces that upgrade.
 */

/** @typedef {import('../../core/ports/repository.js').StoreName} StoreName */

export const DB_NAME = 'CanvasTabDB';

/** The version this build reads and writes, js/storage.js's dbVersion */
export const DB_VERSION = 8;

/**
 * Each store of version 8, with its key path and its indexes. Every index is named after the
 * field it indexes, and none is unique.
 * @type {Readonly<Record<string, Readonly<{keyPath: string, indexes: readonly string[]}>>>}
 */
export const STORE_SCHEMAS = Object.freeze({
  canvases: Object.freeze({ keyPath: 'id', indexes: Object.freeze(['name', 'updatedAt']) }),
  elements: Object.freeze({ keyPath: 'id', indexes: Object.freeze(['canvasId', 'type']) }),
  settings: Object.freeze({ keyPath: 'key', indexes: Object.freeze([]) }),
  media: Object.freeze({ keyPath: 'id', indexes: Object.freeze(['canvasId']) }),
  search_index: Object.freeze({ keyPath: 'noteId', indexes: Object.freeze([]) }),
  folders: Object.freeze({ keyPath: 'id', indexes: Object.freeze(['parentId', 'name']) }),
  links: Object.freeze({ keyPath: 'id', indexes: Object.freeze(['fromNoteId', 'toNoteId']) }),
  themes: Object.freeze({ keyPath: 'id', indexes: Object.freeze(['name', 'updatedAt']) }),
  vectors: Object.freeze({ keyPath: 'id', indexes: Object.freeze([]) }),
  snapshots: Object.freeze({ keyPath: 'id', indexes: Object.freeze(['noteId', 'timestamp']) }),
});

/** Each kernel store's IndexedDB store, under the names 1.4.x has always used */
export const IDB_STORES = Object.freeze({
  notes: 'canvases',
  blocks: 'elements',
  folders: 'folders',
  searchIndex: 'search_index',
  media: 'media',
  vectors: 'vectors',
  snapshots: 'snapshots',
  links: 'links',
  themes: 'themes',
});

/** Without these the notes can't be read, so a versioned open refuses the database, as Storage.open does */
export const CORE_STORES = Object.freeze(['canvases', 'elements']);

/**
 * Derived from the notes, so a database without one skips its writes: the search index, as
 * Storage.createNote and Storage.updateNote skip it, and the wiki links, as
 * Storage.updateNoteLinks does. A write to any other missing store fails the command.
 * @type {readonly StoreName[]}
 */
export const DERIVED_STORES = Object.freeze(['searchIndex', 'links']);

/**
 * Creates each version-8 store `db` lacks, with its indexes. Runs only inside the upgrade, and
 * makes only synchronous calls, since anything awaited would commit the upgrade (#17, step 2).
 * @param {IDBDatabase} db
 */
export function createMissingStores(db) {
  for (const [name, { keyPath, indexes }] of Object.entries(STORE_SCHEMAS)) {
    if (db.objectStoreNames.contains(name)) continue;
    const store = db.createObjectStore(name, { keyPath });
    for (const index of indexes) store.createIndex(index, index, { unique: false });
  }
}
