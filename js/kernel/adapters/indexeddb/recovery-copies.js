/**
 * The recovery copies 1.4.x's Storage keeps in chrome.storage.local, moved to #17's adapter
 * with the new tab (#17 PR 4a). Each goes under a new `recovery_backup_<time>` key, which
 * nothing prunes: #18's backup engine and #20's Recovery Center read them.
 * - Replace all's copy of every exported note before an import moves the active notes to
 *   trash (backups.js).
 * - #33's copy of a database at version 8 that lacks some of its stores, which the new tab
 *   writes before it opens one, as 1.4.1's guard does (copyMissingStores).
 */

import { withDataUrls } from './data-urls.js';
import { DB_NAME, LEGACY_VERSION, STORE_SCHEMAS } from './schema.js';
import { openWithoutUpgrade } from './shapes.js';

/** @typedef {import('../../core/ports/runtime.js').Clock} Clock */

/** Each recovery copy's key starts with this, the rest its time, as Storage names them */
export const RECOVERY_COPY_PREFIX = 'recovery_backup_';

/**
 * The key naming #33's copy, so each start reads one small value instead of every stored
 * copy. Whatever removes that copy removes this key with it.
 */
export const MISSING_STORES_COPY_KEY = 'recovery_copy_missing_stores';

/** The Web Lock #33's check and write hold, so tabs that open together write one copy */
export const RECOVERY_COPY_LOCK = 'ntn-recovery-copy';

/** The legacy stores, in the order Storage's requiredStores lists them */
const LEGACY_STORES = Object.freeze(Object.keys(STORE_SCHEMAS));

/**
 * chrome.storage.local, or anything with its promise-returning get and set
 * @typedef {object} CopyStore
 * @property {(keys: string[]) => Promise<Record<string, unknown>>} get
 * @property {(items: Record<string, unknown>) => Promise<void>} set
 */

/**
 * Web Locks, or anything with its request(name, callback)
 * @typedef {{request: (name: string, callback: () => Promise<any>) => Promise<any>}} CopyLocks
 */

/**
 * One stored value, read by its key alone, or undefined when it isn't there or can't be read,
 * as Storage._getStorageValue reads one
 * @param {CopyStore} settings
 * @param {string} key
 * @returns {Promise<unknown>}
 */
async function storedValue(settings, key) {
  try {
    const found = await settings.get([key]);
    return found ? found[key] : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Saves `copy` under a `recovery_backup_<time>` key no copy holds yet, the time now, or the
 * first later millisecond that's free, with `withItems(key)`'s items in the same write, as
 * Storage._writeRecoveryBackup does. Resolves the key, and rejects when the write fails.
 * @param {CopyStore} settings
 * @param {Record<string, unknown>} copy
 * @param {Clock} clock
 * @param {(key: string) => Record<string, unknown>} [withItems]
 * @returns {Promise<string>}
 */
export async function writeRecoveryCopy(settings, copy, clock, withItems) {
  let stamp = clock.now();
  while ((await storedValue(settings, `${RECOVERY_COPY_PREFIX}${stamp}`)) !== undefined) stamp += 1;
  const key = `${RECOVERY_COPY_PREFIX}${stamp}`;
  await settings.set({ [key]: copy, ...(withItems ? withItems(key) : {}) });
  return key;
}

/**
 * Every value of store `name`, each Blob in it as a data URL, read in a transaction of its own.
 * A store without a key path, which version 8 has none of, comes as `{key, value}` pairs.
 * @param {IDBDatabase} db
 * @param {string} name
 * @returns {Promise<unknown[]>}
 */
function readStoreForCopy(db, name) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(name, 'readonly');
    const store = tx.objectStore(name);
    const values = store.getAll();
    const keys = store.keyPath === null ? store.getAllKeys() : null;
    tx.oncomplete = () => resolve({ values: values.result || [], keys: keys ? keys.result : null });
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  }).then(async read => {
    const { values, keys } = /** @type {{values: unknown[], keys: IDBValidKey[] | null}} */ (read);
    const converted = [];
    for (const value of values) converted.push(await withDataUrls(value));
    return keys ? converted.map((value, i) => ({ key: keys[i], value })) : converted;
  });
}

/**
 * #33's copy, unless one names the same missing stores: every store but `settings`, which
 * versions up to 1.1.2 kept the AI key in, in plaintext, each under its own name
 * @param {IDBDatabase} db
 * @param {string[]} missing
 * @param {CopyStore} settings
 * @param {Clock} clock
 * @returns {Promise<'written' | 'kept'>}
 */
async function copyUnlessKept(db, missing, settings, clock) {
  const written = /** @type {{missingStores?: unknown} | undefined} */ (
    await storedValue(settings, MISSING_STORES_COPY_KEY)
  );
  const names = written && Array.isArray(written.missingStores) ? written.missingStores : null;
  if (names && names.length === missing.length && missing.every(store => names.includes(store))) return 'kept';

  /** @type {Record<string, unknown>} */
  const copy = {
    recoveryBackup: true,
    reason: 'missing-stores',
    timestamp: clock.now(),
    missingStores: missing.slice(),
  };
  for (const name of Array.from(db.objectStoreNames)) {
    if (name === 'settings') continue;
    try {
      copy[name] = await readStoreForCopy(db, name);
    } catch {
      // A store it can't read is left out, as Storage leaves it out
    }
  }
  await writeRecoveryCopy(settings, copy, clock, key => ({
    [MISSING_STORES_COPY_KEY]: { key, missingStores: copy.missingStores, timestamp: copy.timestamp },
  }));
  return 'written';
}

/**
 * #33's copy before the new tab opens a database at version 8 that lacks some legacy store:
 * one recovery copy of every store it can read, and the stores it lacks, with a marker that
 * names them, so a later start skips it for the same missing stores. The check and the write
 * hold Web Lock `ntn-recovery-copy` when there are locks, so of two tabs that open together,
 * the later one finds the earlier one's copy. It reads through an open of its own that upgrades
 * nothing and makes no database. A database at any other version gets none: 1.4.1 only ever
 * wrote one at 8, and the worker's run gives a database every store it lacks after its own
 * recovery point. It never changes the database, and never rejects, so a copy that can't be
 * written leaves the open to go on, as Storage's did.
 * @param {{indexedDB: IDBFactory, settings: CopyStore, clock: Clock, locks?: CopyLocks | null}} options
 * @returns {Promise<'written' | 'kept' | 'not-needed' | 'failed'>}
 */
export async function copyMissingStores({ indexedDB, settings, clock, locks = null }) {
  /** @type {IDBDatabase | null} */
  let db;
  try {
    db = await openWithoutUpgrade(indexedDB, DB_NAME);
  } catch {
    return 'failed';
  }
  if (!db) return 'not-needed';
  const open = db;
  try {
    if (open.version !== LEGACY_VERSION) return 'not-needed';
    const missing = LEGACY_STORES.filter(name => !open.objectStoreNames.contains(name));
    if (missing.length === 0) return 'not-needed';
    const copy = () => copyUnlessKept(open, missing, settings, clock);
    return await (locks && typeof locks.request === 'function' ? locks.request(RECOVERY_COPY_LOCK, copy) : copy());
  } catch {
    return 'failed';
  } finally {
    open.close();
  }
}
