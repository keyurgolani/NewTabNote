/**
 * Side Panel's composition root (#12, docs/adr/0001-kernel-stack.md). js/sidepanel.js reads
 * the notes it summarizes through this client.
 */

import { createIndexedDbAdapter } from '../adapters/indexeddb/adapter.js';
import { SIDEPANEL_HANDLERS } from '../core/application/handlers-sidepanel.js';
import { applyingCloseDrafts, pageDrafts } from './close-drafts.js';
import { kernelClient, pageHost } from './host.js';

/** @typedef {import('./host.js').PageHost} PageHost */
/** @typedef {import('./close-drafts.js').Applier} Applier */

/**
 * Side Panel's kernel and its client, on #17's IndexedDB adapter (#17 PR 1b, Q3), opened as
 * Popup's is: as it is, with no repair, upgrade, or maintenance, after waiting up to 5
 * seconds on the worker's migration run when there's no database or an older one (Q12). A
 * database a newer build upgraded is refused as `newer-schema`. When the page holds a closing
 * tab's edit, its whenReady resolves once the edit is applied, with the applier `load` hands
 * over, the `close-drafts-chunk` chunk Side Panel imports then (close-drafts.js, #33), so Side Panel
 * reads its notes with the edit in. It runs only what js/sidepanel.js and that apply send
 * (SIDEPANEL_HANDLERS).
 * @param {PageHost} [host]
 * @param {ReturnType<typeof pageDrafts>} [drafts]
 * @param {() => Promise<Applier>} [load]
 * @returns {ReturnType<typeof applyingCloseDrafts>}
 */
export function createSidePanelClient(
  host = pageHost(),
  drafts = pageDrafts(),
  load = () => import('../core/application/close-drafts-chunk.js'),
) {
  const adapter = createIndexedDbAdapter({ ...host, mode: 'existing' });
  return applyingCloseDrafts(kernelClient({ adapter, surface: 'sidepanel', handlers: SIDEPANEL_HANDLERS }), drafts, { load });
}
