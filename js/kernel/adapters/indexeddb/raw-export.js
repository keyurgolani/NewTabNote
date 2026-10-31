/**
 * The storage guard's raw export (#17 PR 4a), moved from js/storage.js's exportRawStores next to
 * #20's salvage reader, so the new tab no longer needs Storage for it. App offers it on the
 * screens it shows when the kernel can't open the database: one a newer build upgraded, and one
 * without its notes or blocks. It reads every store of CanvasTabDB but the secret-class
 * `settings`, which versions up to 1.1.2 kept the AI key in, through an open that never upgrades
 * the database or makes one, and changes nothing. Each store's values come with every Blob as a
 * data URL, and a store without a key path as `{key, value}` pairs, as Storage read them
 * (recovery-copies.js's readStoreForCopy).
 */

import { readStoreForCopy } from './recovery-copies.js';
import { DB_NAME } from './schema.js';
import { openWithoutUpgrade } from './shapes.js';

/** @typedef {import('../../core/ports/runtime.js').Clock} Clock */

/**
 * What the export file holds, as Storage's did: the version on disk, which names the file, when
 * it was made, and each store's values by its name
 * @typedef {{rawExport: true, onDiskVersion: number, exportedAt: number, stores: Record<string, unknown[]>}} RawExport
 */

/**
 * Every store of the database on disk but `settings`, read as it is. Rejects, in Storage's
 * words, when there's no database, and with what IndexedDB threw when a read fails.
 * @param {{indexedDB: IDBFactory, clock: Clock}} options
 * @returns {Promise<RawExport>}
 */
export async function exportRawStores({ indexedDB, clock }) {
  const db = await openWithoutUpgrade(indexedDB, DB_NAME);
  if (!db) throw new Error("couldn't open the notes database");
  try {
    /** @type {Record<string, unknown[]>} */
    const stores = {};
    for (const name of Array.from(db.objectStoreNames)) {
      if (name === 'settings') continue;
      stores[name] = await readStoreForCopy(db, name);
    }
    return { rawExport: true, onDiskVersion: db.version, exportedAt: clock.now(), stores };
  } finally {
    db.close();
  }
}
