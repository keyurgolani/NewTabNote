/**
 * #33's missing-stores recovery copy, carried over from Storage.open (js/storage.js,
 * checkAndRepairDatabase), so the new tab keeps it when #12 slice 4 moves it onto this adapter.
 * When a page opens a version-8 database missing stores, it saves one copy of every readable
 * store but `settings`, which versions up to 1.1.2 used for the AI key in plaintext, with each
 * Blob as a data URL. The copy goes to chrome.storage.local under a new
 * `recovery_backup_<timestamp>` key, and `recovery_copy_missing_stores` names it in the same
 * write, so a later open reads that one small value and skips a copy for the same missing
 * stores. Pages that open together check and write under the Web Lock Storage takes, so a page
 * on either one finds the other's copy. The service worker leaves it to the next page.
 * Nothing prunes these copies; #18 and #20 read them.
 */

/** @typedef {import('./adapter.js').SettingsStore} SettingsStore */

/** The key that names the copy, so each open reads one small value instead of every backup */
export const MARKER_KEY = 'recovery_copy_missing_stores';

/** The Web Lock Storage takes for the same check and write */
export const LOCK_NAME = 'ntn-recovery-copy';

/**
 * Web Locks, or anything with its request(name, callback)
 * @typedef {{request: (name: string, callback: () => Promise<void>) => Promise<unknown>}} Locks
 */

/** How deep a value is searched for a Blob, as Storage searches it */
const MAX_DEPTH = 32;

/**
 * Whether `value` holds a Blob anywhere within MAX_DEPTH levels
 * @param {unknown} value
 * @param {number} depth
 * @returns {boolean}
 */
function hasBlob(value, depth) {
  if (value instanceof Blob) return true;
  if (!value || typeof value !== 'object' || depth > MAX_DEPTH || ArrayBuffer.isView(value)) return false;
  const items = Array.isArray(value) ? value : Object.values(value);
  return items.some(item => hasBlob(item, depth + 1));
}

/**
 * A Blob as the data URL FileReader.readAsDataURL gives for it
 * @param {Blob} blob
 * @returns {Promise<string>}
 */
async function dataUrl(blob) {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = '';
  // In pieces, so a large image can't overflow the call stack
  for (let start = 0; start < bytes.length; start += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(start, start + 0x8000));
  }
  return `data:${blob.type || 'application/octet-stream'};base64,${btoa(binary)}`;
}

/**
 * A copy of a stored value with each Blob in it as a data URL. legacy-export.js uses it too.
 * @param {unknown} value
 * @returns {Promise<unknown>}
 */
export async function withDataUrls(value) {
  if (value instanceof Blob) return dataUrl(value);
  if (!hasBlob(value, 0)) return value;
  if (Array.isArray(value)) {
    const out = [];
    for (const item of value) out.push(await withDataUrls(item));
    return out;
  }
  /** @type {Record<string, unknown>} */
  const out = {};
  for (const [key, item] of Object.entries(/** @type {Record<string, unknown>} */ (value))) {
    out[key] = await withDataUrls(item);
  }
  return out;
}

/**
 * Every record of a store, with Blobs as data URLs. A store without a key path, which version
 * 8 has none of, comes back as `{key, value}` pairs.
 * @param {IDBDatabase} db
 * @param {string} name
 * @returns {Promise<unknown[]>}
 */
async function readStore(db, name) {
  const { values, keys } = await new Promise((resolve, reject) => {
    const tx = db.transaction(name, 'readonly');
    const store = tx.objectStore(name);
    const valuesRequest = store.getAll();
    const keysRequest = store.keyPath === null ? store.getAllKeys() : null;
    tx.oncomplete = () =>
      resolve({ values: valuesRequest.result || [], keys: keysRequest ? keysRequest.result : null });
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
  /** @type {unknown[]} */
  const converted = [];
  for (const value of values) converted.push(await withDataUrls(value));
  return keys ? converted.map((value, index) => ({ key: keys[index], value })) : converted;
}

/**
 * One chrome.storage.local value, reading only its key. Undefined when it isn't set or can't
 * be read, as Storage reads it.
 * @param {SettingsStore} settings
 * @param {string} key
 * @returns {Promise<any>}
 */
async function storedValue(settings, key) {
  try {
    const stored = await settings.get([key]);
    return stored ? stored[key] : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The check and the write, under the lock when there is one
 * @param {{db: IDBDatabase, missing: readonly string[], settings: SettingsStore}} options
 */
async function writeIfNone({ db, missing, settings }) {
  const written = await storedValue(settings, MARKER_KEY);
  const same =
    written &&
    Array.isArray(written.missingStores) &&
    written.missingStores.length === missing.length &&
    missing.every(store => written.missingStores.includes(store));
  if (same) return;

  /** @type {Record<string, unknown>} */
  const copy = { recoveryBackup: true, reason: 'missing-stores', timestamp: Date.now(), missingStores: [...missing] };
  for (const name of Array.from(db.objectStoreNames)) {
    if (name === 'settings') continue;
    try {
      copy[name] = await readStore(db, name);
    } catch {
      // A store that can't be read is left out, as Storage leaves it out
    }
  }
  // A new key, checking only the one about to be used rather than reading every backup
  let stamp = Date.now();
  while ((await storedValue(settings, `recovery_backup_${stamp}`)) !== undefined) stamp += 1;
  const key = `recovery_backup_${stamp}`;
  await settings.set({
    [key]: copy,
    [MARKER_KEY]: { key, missingStores: copy.missingStores, timestamp: copy.timestamp },
  });
}

/**
 * Saves the missing-stores copy of `db` unless one for the same missing stores exists. Rejects
 * when it can't, and the caller opens anyway, as Storage does.
 * @param {{db: IDBDatabase, missing: readonly string[], settings: SettingsStore, locks?: Locks}} options
 * @returns {Promise<void>}
 */
export async function writeMissingStoresCopy({ db, missing, settings, locks }) {
  if (!locks || typeof locks.request !== 'function') {
    await writeIfNone({ db, missing, settings });
    return;
  }
  await locks.request(LOCK_NAME, () => writeIfNone({ db, missing, settings }));
}
