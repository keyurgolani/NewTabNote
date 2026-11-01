/**
 * Popup's composition root (#12, docs/adr/0001-kernel-stack.md). js/popup.js lists notes,
 * reads whether to show the day's summary, and saves its quick note through this client.
 */

import { createIndexedDbAdapter } from '../adapters/indexeddb/adapter.js';
import { POPUP_HANDLERS } from '../core/application/handlers-popup.js';
import { kernelClient, pageHost } from './host.js';

/** @typedef {import('./host.js').Client} Client */
/** @typedef {import('./host.js').PageHost} PageHost */

/**
 * Popup's kernel and its client, on #17's IndexedDB adapter (#17 PR 1b, Q3). It opens the
 * database as it is, with no repair, upgrade, or maintenance, and makes none on a profile
 * without one. When it finds no database, or one below this build's version, it first wakes
 * the worker and waits up to 5 seconds for its migration run (Q12). A database a newer build
 * upgraded is refused as `newer-schema`, and once the worker upgrades the database under it,
 * every call answers `reload-required`. It runs only what js/popup.js sends (POPUP_HANDLERS).
 * @param {PageHost} [host]
 * @returns {Client}
 */
export function createPopupClient(host = pageHost()) {
  const adapter = createIndexedDbAdapter({ ...host, mode: 'existing' });
  return kernelClient({ adapter, surface: 'popup', handlers: POPUP_HANDLERS });
}
