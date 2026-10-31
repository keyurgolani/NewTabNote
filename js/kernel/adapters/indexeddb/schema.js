/**
 * CanvasTabDB's ten legacy stores, as 1.4.x has stored them since version 8 (#17, "Data and
 * migration"), and the version this build opens it at: structural version 11 since #17 PR 3b
 * (registry.js's step 9: every legacy store, then `meta` and `migrations`; step 10: the
 * `operations`, `changes`, `conflicts`, and `tombstones` stores; step 11: `daily_index`), which
 * only the service worker upgrades to, through the migration runner (migrate.js) after a
 * verified recovery point.
 * Every legacy store, index, and record stays as it was, since 1.3.0 and 1.4.0 delete the
 * whole database when one is missing.
 */

/** @typedef {import('../../core/ports/repository.js').StoreName} StoreName */

export const DB_NAME = 'CanvasTabDB';

/**
 * The newest IndexedDB version this build opens CanvasTabDB at, registry.js's
 * LATEST_STRUCTURAL and js/storage.js's dbVersion (test/kernel/storage-open.test.mjs keeps the
 * three equal). A database at a later one was upgraded by a newer build and is refused.
 */
export const DB_VERSION = 11;

/** The last version before `meta`, which every release from 1.3.0 to 1.4.1 opens at */
export const LEGACY_VERSION = 8;

/**
 * Each legacy store, as version 8 has it, with its key path and its indexes. Every index is named after the
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

/**
 * Each kernel store's IndexedDB store, under the names 1.4.x has always used, the two of step
 * 10's a deletion writes (#17 PR 2b), which only a database at version 10 or later has, and step
 * 11's daily index (#17 PR 3b), which only one at 11 has
 */
export const IDB_STORES = Object.freeze({
  notes: 'canvases',
  blocks: 'elements',
  folders: 'folders',
  searchIndex: 'search_index',
  media: 'media',
  vectors: 'vectors',
  snapshots: 'snapshots',
  links: 'links',
  conflicts: 'conflicts',
  tombstones: 'tombstones',
  dailyIndex: 'daily_index',
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
