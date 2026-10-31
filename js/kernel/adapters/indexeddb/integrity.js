/**
 * The read-only integrity check (#17 PR 4a, Q9): what js/storage.js's validateDatabase counted
 * at each new tab's start, which moves to the service worker's start, at most once a day, since
 * the new tab now opens #17's adapter, whose page maintenance writes the first-run settings only.
 * It counts the records that name a note the database doesn't hold, in each store that keeps
 * such a name, and lists the legacy stores the database lacks. It deletes nothing and changes no
 * record: the worker logs what it found, as the page did. #35's job host takes it over later.
 *
 * Only when it last ran goes in `meta` (INTEGRITY_KEY), so a database below version 9, which has
 * no `meta`, isn't checked: the worker's run never got it in, and it stays as 1.4.x left it.
 */

import { failureOf } from './failures.js';
import { META_STORE } from './registry.js';
import { result } from './requests.js';
import { STORE_SCHEMAS } from './schema.js';

/** `meta`'s record of the last check: `{key: 'integrity', checkedAt}` */
export const INTEGRITY_KEY = 'integrity';

/** The worker checks at its start, and no more often than this */
export const INTEGRITY_CHECK_EVERY_MS = 24 * 60 * 60 * 1000;

/** @type {IDBTransactionOptions} */
const STRICT = Object.freeze({ durability: 'strict' });

/**
 * What the check counted, in validateDatabase's words
 * @typedef {object} IntegrityReport
 * @property {number} orphanedElements - blocks whose note is gone
 * @property {number} orphanedSearchIndex - search entries, by their note's id
 * @property {number} orphanedLinks - links from or to a note that's gone
 * @property {number} orphanedVectors - vectors, by their note's id
 * @property {number} orphanedSnapshots - snapshots whose note is gone
 * @property {number} orphanedMedia - media whose note is gone
 * @property {string[]} missingStores - the legacy stores the database lacks
 */

/**
 * How many of an index's keys name no note, read by a key cursor, so no block or media payload
 * is loaded
 * @param {IDBIndex} index
 * @param {Set<unknown>} noteIds
 * @returns {Promise<number>}
 */
function orphanKeys(index, noteIds) {
  return new Promise((resolve, reject) => {
    let orphans = 0;
    const request = index.openKeyCursor();
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
 * The check on `db`, in one readonly transaction over the stores it has, as validateDatabase
 * counts them: a store the database lacks counts none
 * @param {IDBDatabase} db
 * @returns {Promise<IntegrityReport>}
 */
export async function readIntegrity(db) {
  /** @param {string} name */
  const has = name => db.objectStoreNames.contains(name);
  /** @type {IntegrityReport} */
  const report = {
    orphanedElements: 0,
    orphanedSearchIndex: 0,
    orphanedLinks: 0,
    orphanedVectors: 0,
    orphanedSnapshots: 0,
    orphanedMedia: 0,
    missingStores: Object.keys(STORE_SCHEMAS).filter(name => !has(name)),
  };
  const read = ['canvases', 'elements', 'search_index', 'links', 'vectors', 'snapshots', 'media'].filter(has);
  if (!read.includes('canvases')) return report;
  const tx = db.transaction(read, 'readonly');
  /** @type {Set<unknown>} */
  const noteIds = new Set(await result(tx.objectStore('canvases').getAllKeys()));
  /** @param {string} name */
  const orphanedKeys = async name =>
    (await result(tx.objectStore(name).getAllKeys())).filter(key => !noteIds.has(key)).length;
  if (has('elements'))
    report.orphanedElements = await orphanKeys(tx.objectStore('elements').index('canvasId'), noteIds);
  // Its key path is noteId
  if (has('search_index')) report.orphanedSearchIndex = await orphanedKeys('search_index');
  if (has('links')) {
    const links = /** @type {Array<{fromNoteId?: unknown, toNoteId?: unknown}>} */ (
      await result(tx.objectStore('links').getAll())
    );
    report.orphanedLinks = links.filter(
      link => (link.fromNoteId && !noteIds.has(link.fromNoteId)) || (link.toNoteId && !noteIds.has(link.toNoteId)),
    ).length;
  }
  // saveVector keys each vector by its note's id
  if (has('vectors')) report.orphanedVectors = await orphanedKeys('vectors');
  if (has('snapshots'))
    report.orphanedSnapshots = await orphanKeys(tx.objectStore('snapshots').index('noteId'), noteIds);
  if (has('media')) report.orphanedMedia = await orphanKeys(tx.objectStore('media').index('canvasId'), noteIds);
  return report;
}

/**
 * The check at the worker's start: nothing within `everyMs` of the last one, or on a database
 * without `meta`; otherwise the report, once `meta` records when it ran. Rejects with an
 * UnavailableError when storage fails it.
 * @param {{database: () => IDBDatabase, now: number, everyMs?: number}} options
 * @returns {Promise<{checked: false} | {checked: true, report: IntegrityReport}>}
 */
export async function checkIntegrity({ database, now, everyMs = INTEGRITY_CHECK_EVERY_MS }) {
  try {
    const db = database();
    if (!db.objectStoreNames.contains(META_STORE)) return { checked: false };
    const meta = db.transaction(META_STORE, 'readonly').objectStore(META_STORE);
    const last = /** @type {{checkedAt?: unknown} | undefined} */ (await result(meta.get(INTEGRITY_KEY)));
    const checkedAt = last && typeof last.checkedAt === 'number' ? last.checkedAt : null;
    if (checkedAt !== null && now - checkedAt >= 0 && now - checkedAt < everyMs) return { checked: false };
    const report = await readIntegrity(db);
    const done = db.transaction(META_STORE, 'readwrite', STRICT);
    done.objectStore(META_STORE).put({ key: INTEGRITY_KEY, checkedAt: now });
    await new Promise((resolve, reject) => {
      done.oncomplete = () => resolve(undefined);
      done.onabort = () => reject(done.error);
    });
    return { checked: true, report };
  } catch (error) {
    throw failureOf(error);
  }
}

/**
 * The counts in `report` that found something, as the page logged them
 * @param {IntegrityReport} report
 * @returns {Record<string, number>}
 */
export function orphansIn(report) {
  /** @type {Record<string, number>} */
  const found = {};
  for (const [key, value] of Object.entries(report)) {
    if (key.startsWith('orphaned') && typeof value === 'number' && value > 0) found[key] = value;
  }
  return found;
}
