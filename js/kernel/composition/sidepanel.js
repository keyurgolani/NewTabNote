/**
 * Side Panel's composition root (#12, docs/adr/0001-kernel-stack.md). js/sidepanel.js reads
 * the notes it summarizes through this client.
 */

import { createIndexedDbAdapter } from '../adapters/indexeddb/adapter.js';
import { SIDEPANEL_HANDLERS } from '../core/application/handlers-sidepanel.js';
import { kernelClient, pageHost } from './host.js';

/** @typedef {import('./host.js').Client} Client */
/** @typedef {import('./host.js').PageHost} PageHost */

/**
 * Side Panel's kernel and its client, on #17's IndexedDB adapter (#17 PR 1b, Q3), opened as
 * Popup's is: as it is, with no repair, upgrade, or maintenance, after waiting up to 5
 * seconds on the worker's migration run when there's no database or an older one (Q12). A
 * database a newer build upgraded is refused as `newer-schema`. It runs only what
 * js/sidepanel.js sends (SIDEPANEL_HANDLERS).
 * @param {PageHost} [host]
 * @returns {Client}
 */
export function createSidePanelClient(host = pageHost()) {
  const adapter = createIndexedDbAdapter({ ...host, mode: 'existing' });
  return kernelClient({ adapter, surface: 'sidepanel', handlers: SIDEPANEL_HANDLERS });
}
