/**
 * Popup's composition root (#12, docs/adr/0001-kernel-stack.md). js/popup.js lists notes,
 * reads whether to show the day's summary, and saves its quick note through this client.
 */

import { createIndexedDbAdapter } from '../adapters/indexeddb/adapter.js';
import { POPUP_HANDLERS } from '../core/application/handlers-popup.js';
import { applyingCloseDrafts, pageDrafts } from './close-drafts.js';
import { kernelClient, pageHost } from './host.js';

/** @typedef {import('./host.js').PageHost} PageHost */
/** @typedef {import('./close-drafts.js').Applier} Applier */

/**
 * Popup's kernel and its client, on #17's IndexedDB adapter (#17 PR 1b, Q3). It opens the
 * database as it is, with no repair, upgrade, or maintenance, and makes none on a profile
 * without one. When it finds no database, or one below this build's version, it first wakes
 * the worker and waits up to 5 seconds for its migration run (Q12). A database a newer build
 * upgraded is refused as `newer-schema`, and once the worker upgrades the database under it,
 * every call answers `reload-required`. When the page holds a closing tab's edit, its whenReady
 * resolves once the edit is applied, with the applier `load` hands over, the `close-drafts-chunk`
 * chunk Popup imports then (close-drafts.js, #33), so Popup lists its notes with the edit in. It
 * runs only what js/popup.js and that apply send (POPUP_HANDLERS).
 * @param {PageHost} [host]
 * @param {ReturnType<typeof pageDrafts>} [drafts]
 * @param {() => Promise<Applier>} [load]
 * @returns {ReturnType<typeof applyingCloseDrafts>}
 */
export function createPopupClient(
  host = pageHost(),
  drafts = pageDrafts(),
  load = () => import('../core/application/close-drafts-chunk.js'),
) {
  const adapter = createIndexedDbAdapter({ ...host, mode: 'existing' });
  return applyingCloseDrafts(kernelClient({ adapter, surface: 'popup', handlers: POPUP_HANDLERS }), drafts, { load });
}
