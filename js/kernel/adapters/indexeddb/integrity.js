/**
 * The read-only integrity check on #17's adapter (#35 slice 1, #17 PR 1b): what 1.4.x's
 * Storage.runIntegrityCheck reports (js/storage.js, validateDatabase), counted the same way
 * over the same stores, so the worker's check after an install or an update says what it said
 * when the worker ran on Storage. It counts orphaned records, whose note isn't in `canvases`,
 * and deletes nothing (#33). Each store is read in a readonly transaction of its own, as
 * Storage reads them, so none is held for the whole scan; a store the database lacks is
 * skipped, and index key cursors keep blocks and media from being loaded.
 * test/kernel/storage-integrity.test.mjs holds it to Storage's report.
 */

import { result } from './requests.js';

/**
 * Where the check reports: the context's console, as Storage.runIntegrityCheck reports, unless
 * a test passes another
 * @typedef {{info(message: string, detail: unknown): void, warn(message: string, error: unknown): void}} IntegrityLog
 */

/**
 * What the check counts, by Storage.validateDatabase's names
 * @typedef {object} IntegrityReport
 * @property {number} orphanedElements - blocks whose `canvasId` names no note
 * @property {number} orphanedSearchIndex - search entries keyed by no note's id
 * @property {number} orphanedLinks - links from or to a note that isn't there
 * @property {number} orphanedVectors - vectors keyed by no note's id
 * @property {number} orphanedSnapshots - snapshots whose `noteId` names no note
 * @property {number} orphanedMedia - media whose `canvasId` names no note
 */

/**
 * Every key of `store`, read in a transaction of its own
 * @param {IDBDatabase} db
 * @param {string} store
 * @returns {Promise<IDBValidKey[]>}
 */
function keysOf(db, store) {
  return result(db.transaction(store, 'readonly').objectStore(store).getAllKeys());
}

/**
 * How many records of `store` have an `index` key that names no note, read in a transaction
 * of its own. A record without the index's field isn't in the index, so it isn't counted.
 * @param {IDBDatabase} db
 * @param {string} store
 * @param {string} index
 * @param {Set<unknown>} noteIds
 * @returns {Promise<number>}
 */
function orphanIndexKeys(db, store, index, noteIds) {
  return new Promise((resolve, reject) => {
    let orphans = 0;
    const request = db.transaction(store, 'readonly').objectStore(store).index(index).openKeyCursor();
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor) {
        resolve(orphans);
        return;
      }
      if (cursor.key && !noteIds.has(cursor.key)) orphans += 1;
      cursor.continue();
    };
    request.onerror = () => reject(request.error);
  });
}

/**
 * Counts `db`'s orphaned records, store by store, as Storage.validateDatabase does
 * @param {IDBDatabase} db
 * @returns {Promise<IntegrityReport>}
 */
export async function scanOrphans(db) {
  /** @param {string} store */
  const has = store => db.objectStoreNames.contains(store);
  /** @type {IntegrityReport} */
  const report = {
    orphanedElements: 0,
    orphanedSearchIndex: 0,
    orphanedLinks: 0,
    orphanedVectors: 0,
    orphanedSnapshots: 0,
    orphanedMedia: 0,
  };
  /** @type {Set<unknown>} */
  const noteIds = new Set(await keysOf(db, 'canvases'));
  /** @param {IDBValidKey[]} keys */
  const unknown = keys => keys.filter(key => !noteIds.has(key)).length;

  if (has('elements')) report.orphanedElements = await orphanIndexKeys(db, 'elements', 'canvasId', noteIds);
  // Keyed by the note's id
  if (has('search_index')) report.orphanedSearchIndex = unknown(await keysOf(db, 'search_index'));
  if (has('links')) {
    const links = /** @type {Array<{fromNoteId?: unknown, toNoteId?: unknown}>} */ (
      await result(db.transaction('links', 'readonly').objectStore('links').getAll())
    );
    report.orphanedLinks = links.filter(
      link => (link.fromNoteId && !noteIds.has(link.fromNoteId)) || (link.toNoteId && !noteIds.has(link.toNoteId)),
    ).length;
  }
  // saveVector keys each vector by its note's id
  if (has('vectors')) report.orphanedVectors = unknown(await keysOf(db, 'vectors'));
  if (has('snapshots')) report.orphanedSnapshots = await orphanIndexKeys(db, 'snapshots', 'noteId', noteIds);
  if (has('media')) report.orphanedMedia = await orphanIndexKeys(db, 'media', 'canvasId', noteIds);
  return report;
}

/**
 * Runs the check on `db`, and reports as Storage.runIntegrityCheck does: the counts above zero
 * when there are any, and nothing otherwise, or the error that stopped it. It never throws.
 * @param {IDBDatabase} db
 * @param {IntegrityLog} log
 * @returns {Promise<void>}
 */
export async function runIntegrityCheck(db, log) {
  try {
    const report = await scanOrphans(db);
    const orphans = Object.entries(report).filter(([, value]) => value > 0);
    if (orphans.length > 0) log.info('Integrity check (read-only) found orphaned records:', Object.fromEntries(orphans));
  } catch (error) {
    log.warn('Integrity check encountered an error:', error);
  }
}
