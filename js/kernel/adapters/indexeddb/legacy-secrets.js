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
 * - The reader writes nothing anywhere. Removing a key is `remove-saved-key`'s, through the
 *   remover below (#20 slice 4a), which takes out exactly the entries it's named and nothing
 *   beside them:
 *   - `setting_llmApiKey`: the key, and with it its owner, `setting_llmApiKeyProvider` (#94),
 *     in one call, as LLMService.setApiKey('') clears both;
 *   - `setting_syncWebdavConfig`: the `password` field (its server and user name stay, so Sync
 *     asks for the password again). It reads the config to write the rest back, and keeps,
 *     returns, and logs none of it;
 *   - `settings`: the `llmApiKey` row of CanvasTabDB's `settings` store, never another row, a
 *     note, or anything the user made.
 *   It tries every place it's named, each on its own, so one that fails doesn't keep the rest,
 *   then fails the same way the reader does, with the first failure's code and no message
 *   from what it called. The remediation reads the places again to say which went.
 */

import { UnavailableError } from '../../core/contracts/outcomes.js';
import { abort, result } from './requests.js';
import { DB_NAME } from './schema.js';
import { openWithoutUpgrade } from './shapes.js';

/** @typedef {import('./adapter.js').SettingsStore} SettingsStore */
/** @typedef {SettingsStore & {remove(keys: string[]): Promise<void>}} RemovableSettings */
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

/** The places the remover takes a secret out of */
const PLACES = Object.freeze(['setting_llmApiKey', 'setting_syncWebdavConfig', 'settings']);

/**
 * Takes the WebDAV password out of its config, keeping every other field, when it holds one
 * @param {RemovableSettings} settings
 */
async function removeWebdavPassword(settings) {
  const stored = await settings.get(['setting_syncWebdavConfig']);
  if (stored === null || typeof stored !== 'object') throw new TypeError('not a settings answer');
  const config = stored.setting_syncWebdavConfig;
  if (config === null || typeof config !== 'object' || Array.isArray(config)) return;
  if (!Object.prototype.hasOwnProperty.call(config, 'password')) return;
  const kept = { .../** @type {Record<string, unknown>} */ (config) };
  delete kept.password;
  await settings.set({ setting_syncWebdavConfig: kept });
}

/**
 * Deletes the `llmApiKey` row of CanvasTabDB's legacy `settings` store, and no other, without
 * upgrading the database or making one
 * @param {IDBFactory} indexedDB
 */
async function removeIdbKey(indexedDB) {
  /** @type {IDBDatabase | null} */
  let db = null;
  try {
    db = await openWithoutUpgrade(indexedDB, DB_NAME);
    if (!db || !db.objectStoreNames.contains('settings')) return;
    const tx = db.transaction('settings', 'readwrite');
    const done = new Promise((resolve, reject) => {
      tx.oncomplete = () => resolve(undefined);
      tx.onabort = () => reject(tx.error);
      tx.onerror = () => reject(tx.error);
    });
    try {
      tx.objectStore('settings').delete(IDB_SECRET_KEY);
    } catch (error) {
      abort(tx);
      throw error;
    }
    await done;
  } finally {
    if (db) db.close();
  }
}

/**
 * The legacy secret remover: the reader's `present()`, and `remove(places)`, which takes the
 * secret out of each place named and nothing else (see the top of this file). A place it
 * doesn't know is refused before anything is removed.
 * @param {{indexedDB: IDBFactory, settings: RemovableSettings}} options
 * @returns {{present(): Promise<readonly SecretSource[]>, remove(places: readonly string[]): Promise<void>}}
 */
export function createLegacySecretRemover({ indexedDB, settings }) {
  const reader = createLegacySecretReader({ indexedDB, settings });
  return Object.freeze({
    present: () => reader.present(),
    /** @param {readonly string[]} places */
    async remove(places) {
      if (!Array.isArray(places) || !places.every(place => PLACES.includes(place))) {
        throw new UnavailableError('adapter', 'not-applicable', false);
      }
      /** @type {string | null} */
      let failed = null;
      // Each place on its own; what chrome.storage or IndexedDB threw stays here
      /** @type {Array<[string, () => Promise<void>, string]>} */
      const steps = [
        [
          'setting_llmApiKey',
          () => settings.remove(['setting_llmApiKey', 'setting_llmApiKeyProvider']),
          'settings-write-failed',
        ],
        ['setting_syncWebdavConfig', () => removeWebdavPassword(settings), 'settings-write-failed'],
        ['settings', () => removeIdbKey(indexedDB), 'transaction-failed'],
      ];
      for (const [place, step, code] of steps) {
        if (!places.includes(place)) continue;
        try {
          await step();
        } catch {
          if (failed === null) failed = code;
        }
      }
      if (failed !== null) throw new UnavailableError('storage', failed, true);
    },
  });
}
