/**
 * The legacy secret reader (#20, "Providers", Credentials): whether 1.4.x left a plaintext
 * secret where it kept one, answered as the places that hold a non-empty one, never the
 * secret. The three places (#20's verified code facts):
 *
 * - `setting_llmApiKey` in chrome.storage.local, the AI provider's key;
 * - `setting_syncWebdavConfig.password` in chrome.storage.local, the WebDAV password;
 * - `llmApiKey` in CanvasTabDB's `settings` store, where releases up to 1.1.2 kept every
 *   setting, which the adapters never serve (IDB_SETTINGS_KEYS) and recovery points never copy.
 *
 * What it guarantees, which test/kernel/trust-secrets.test.mjs holds it to with canaries:
 * - It answers only source names. A value is read only to test whether it's a non-empty
 *   string, inside the function that reads it, and nothing keeps, returns, logs, or throws it.
 * - A failure rejects with an UnavailableError made here, with a cause and a code and no
 *   `cause` option, so what chrome.storage or IndexedDB threw, whatever its message, stays here.
 * - It opens CanvasTabDB without upgrading it, makes no database where there's none, reads
 *   the one key in one readonly transaction, and closes the connection.
 * - It writes nothing anywhere. Removing a key is slice 3's `remove-saved-key`.
 */

import { UnavailableError } from '../../core/contracts/outcomes.js';
import { result } from './requests.js';
import { DB_NAME } from './schema.js';
import { openWithoutUpgrade } from './shapes.js';

/** @typedef {import('./adapter.js').SettingsStore} SettingsStore */
/** @typedef {'setting_llmApiKey' | 'setting_syncWebdavConfig' | 'settings'} SecretSource */

/** The chrome.storage.local keys it reads, and the IndexedDB `settings` key */
export const SECRET_SETTING_KEYS = Object.freeze(['setting_llmApiKey', 'setting_syncWebdavConfig']);
export const IDB_SECRET_KEY = 'llmApiKey';

/**
 * @param {unknown} value
 * @returns {boolean}
 */
const nonEmpty = value => typeof value === 'string' && value.trim() !== '';

/**
 * Whether chrome.storage.local holds each secret, read in one get
 * @param {SettingsStore} settings
 * @returns {Promise<SecretSource[]>}
 */
async function inSettings(settings) {
  /** @type {SecretSource[]} */
  const found = [];
  try {
    const stored = await settings.get([...SECRET_SETTING_KEYS]);
    // An answer that isn't an object is a read that didn't work, never "nothing stored"
    if (stored === null || typeof stored !== 'object') throw new TypeError('not a settings answer');
    if (nonEmpty(stored.setting_llmApiKey)) found.push('setting_llmApiKey');
    const webdav = stored.setting_syncWebdavConfig;
    if (webdav !== null && typeof webdav === 'object' && nonEmpty(/** @type {{password?: unknown}} */ (webdav).password)) {
      found.push('setting_syncWebdavConfig');
    }
  } catch {
    // What chrome.storage threw stays here: it's no one's business past the code
    throw new UnavailableError('storage', 'settings-read-failed', true);
  }
  return found;
}

/**
 * Whether CanvasTabDB's legacy `settings` store holds a non-empty AI key
 * @param {IDBFactory} indexedDB
 * @returns {Promise<boolean>}
 */
async function inIndexedDb(indexedDB) {
  /** @type {IDBDatabase | null} */
  let db = null;
  try {
    db = await openWithoutUpgrade(indexedDB, DB_NAME);
    if (!db || !db.objectStoreNames.contains('settings')) return false;
    const store = db.transaction('settings', 'readonly').objectStore('settings');
    const record = /** @type {{value?: unknown} | undefined} */ (await result(store.get(IDB_SECRET_KEY)));
    return record !== undefined && record !== null && nonEmpty(record.value);
  } catch {
    // Neither IndexedDB's error nor its message leaves: a code says it couldn't be read
    throw new UnavailableError('storage', 'unreadable', true);
  } finally {
    if (db) db.close();
  }
}

/**
 * @param {{indexedDB: IDBFactory, settings: SettingsStore}} options
 * @returns {{present(): Promise<readonly SecretSource[]>}}
 */
export function createLegacySecretReader({ indexedDB, settings }) {
  return Object.freeze({
    async present() {
      const found = await inSettings(settings);
      if (await inIndexedDb(indexedDB)) found.push('settings');
      return Object.freeze(found);
    },
  });
}
