/**
 * Popup's composition root (#12, docs/adr/0001-kernel-stack.md). js/popup.js lists notes,
 * reads whether to show the day's summary, and saves its quick note through this client.
 */

import { createIndexedDbAdapter } from '../adapters/indexeddb/adapter.js';
import { chromeSettings, kernelClient, waitForWorkerUpgrade } from './host.js';

/** @typedef {import('./host.js').Client} Client */
/** @typedef {import('../adapters/indexeddb/adapter.js').SettingsStore} SettingsStore */

/**
 * What Popup's and Side Panel's storage runs on, read from the page's globals unless a test
 * passes it
 * @typedef {object} PageHost
 * @property {IDBFactory} indexedDB
 * @property {SettingsStore} settings
 * @property {() => Promise<unknown>} awaitUpgrade - the wait on the worker's migration run (#17, Q12)
 */

/**
 * The page's own storage host
 * @returns {PageHost}
 */
export function pageHost() {
  return { indexedDB: globalThis.indexedDB, settings: chromeSettings(), awaitUpgrade: () => waitForWorkerUpgrade() };
}

/**
 * Popup's kernel and its client, on #17's IndexedDB adapter (#17 PR 1b, Q3). It opens the
 * database as it is, with no repair, upgrade, or maintenance, and makes none on a profile
 * without one. When it finds no database, or one below this build's version, it first wakes
 * the worker and waits up to 5 seconds for its migration run (Q12). A database a newer build
 * upgraded is refused as `newer-schema`, and once the worker upgrades the database under it,
 * every call answers `reload-required`.
 * @param {PageHost} [host]
 * @returns {Client}
 */
export function createPopupClient(host = pageHost()) {
  const adapter = createIndexedDbAdapter({ ...host, mode: 'existing' });
  return kernelClient({ adapter, surface: 'popup' });
}
