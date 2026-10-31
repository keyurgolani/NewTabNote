/**
 * The settings #11's and #19's holders keep outside the kernel (#17 PR 4b): each under
 * `setting_<key>` in chrome.storage.local, read or written in one call, with nothing kept
 * here between calls, as js/storage.js's getSetting and setSetting kept them. js/llm.js keeps
 * the AI provider, its model, endpoint, Ollama's URL, and the key. SyncService and App's
 * reconnect keep the sync provider, its WebDAV config, and when sync last ran. #11 and #19
 * move them into the kernel's settings as `saveProviderSettings` and `saveSyncSettings`
 * (docs/architecture/write-paths.md).
 *
 * Two of them hold a secret, the two chrome.storage.local places #20's secret reader names
 * (adapters/indexeddb/legacy-secrets.js): `llmApiKey`, the provider's key, and
 * `syncWebdavConfig`, whose `password` is the WebDAV password. They stay where 1.4.x keeps
 * them until #21's vault (#17, "Security and privacy"). The key is read and written only by
 * LLMService, which keeps each key to the provider it was saved for (#21 slice 1a), and this
 * is the one way under it to where the key is kept: no copy here, and no other path.
 * Neither secret goes into a kernel command or query, so no operations ledger row hashes it,
 * and no change row, recovery point, or diagnostic holds it. Nothing here logs a value or
 * puts one in an error: a failure names the key and the error's name only.
 */

/** @typedef {import('../adapters/indexeddb/adapter.js').SettingsStore} SettingsStore */

/**
 * #11's settings, which js/llm.js keeps: the AI provider, its key and the provider the key was
 * saved for, the model, the endpoint, and Ollama's URL
 */
export const PROVIDER_SETTING_KEYS = Object.freeze([
  'llmEndpoint',
  'llmProvider',
  'llmApiKey',
  'llmApiKeyProvider',
  'llmModel',
  'ollamaUrl',
]);

/** #19's settings, which SyncService and App's reconnect keep: the provider, its WebDAV config, and when sync last ran */
export const SYNC_SETTING_KEYS = Object.freeze(['syncProvider', 'syncWebdavConfig', 'syncLastSyncAt']);

/**
 * A holder's getSetting and setSetting, as js/storage.js's
 * @typedef {object} HolderSettings
 * @property {(key: string, defaultValue?: unknown) => Promise<unknown>} getSetting
 *   The stored value, or `defaultValue` (null unless given) when there's none or the read
 *   fails, which it warns of
 * @property {(key: string, value: unknown) => Promise<void>} setSetting
 *   Stores `value`, null included, and rejects when chrome.storage fails, which it logs
 */

/**
 * The getSetting and setSetting of a holder whose settings are `keys`, over `store`, which is
 * chrome.storage.local in the new tab. A key that isn't one of them is refused, so a holder
 * reaches no other holder's settings, and nothing reaches a preference or the session around
 * the kernel.
 * @param {SettingsStore} store
 * @param {readonly string[]} keys
 * @returns {Readonly<HolderSettings>}
 */
export function createHolderSettings(store, keys) {
  const known = new Set(keys);
  /** @param {unknown} key */
  const storageKey = key => {
    if (typeof key !== 'string' || !known.has(key)) {
      throw new TypeError(`${String(key)} isn't one of this holder's settings`);
    }
    return `setting_${key}`;
  };
  return Object.freeze({
    async getSetting(/** @type {string} */ key, /** @type {unknown} */ defaultValue = null) {
      const name = storageKey(key);
      try {
        const stored = await store.get([name]);
        const value = stored === null || typeof stored !== 'object' ? undefined : stored[name];
        return value !== undefined ? value : defaultValue;
      } catch (error) {
        // As Storage.getSetting answered: the default, with a warning that names no value
        console.warn(`NewTabNote couldn't read the ${key} setting:`, errorName(error));
        return defaultValue;
      }
    },
    async setSetting(/** @type {string} */ key, /** @type {unknown} */ value) {
      const name = storageKey(key);
      try {
        await store.set({ [name]: value });
      } catch (error) {
        // As Storage.setSetting rejected, with what chrome.storage threw, logged by its name only
        console.error(`NewTabNote couldn't save the ${key} setting:`, errorName(error));
        throw error;
      }
    },
  });
}

/**
 * What a failure is called, for a log line: never its message, which could quote what was saved
 * @param {unknown} error
 * @returns {string}
 */
function errorName(error) {
  const name = error && typeof error === 'object' ? /** @type {{name?: unknown}} */ (error).name : undefined;
  return typeof name === 'string' && name !== '' ? name : 'Error';
}
