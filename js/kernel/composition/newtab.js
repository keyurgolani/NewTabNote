/**
 * The new tab's composition root (#12, docs/adr/0001-kernel-stack.md). It builds the tab's
 * kernel and, in place of the bootstrap at the end of js/app.js, constructs App with its
 * client and the document client its editors read and write through. js/main.js calls
 * startNewTab() once it has imported app.js.
 */

import { createLegacyAdapter } from '../adapters/legacy/adapter.js';
import { createDocumentClient } from './document.js';
import { kernelClient, legacyHost } from './host.js';

/** @typedef {import('./host.js').Client} Client */
/** @typedef {import('./host.js').LegacyHost} LegacyHost */
/** @typedef {import('./document.js').DocumentClient} DocumentClient */

/**
 * The legacy App class app.js puts on window, and the instance the controllers still read as
 * window.app until #12 slice 7 removes it
 * @typedef {object} NewTabPage
 * @property {new (options: {kernel: Client, documentClient: DocumentClient}) => {init(): Promise<void>}} App
 * @property {unknown} [app]
 */

/**
 * The new tab's kernel and its client. It opens the database versioned, as Storage.init did,
 * and runs startup maintenance before any command. Its connection waits out another
 * context's upgrade, as in 1.4.x, until #12 slice 4b moves the editor to the kernel, where a
 * save can keep its text while the tab asks for a reload.
 * @param {LegacyHost} [host]
 * @returns {Client}
 */
export function createNewTabClient(host = legacyHost()) {
  const adapter = createLegacyAdapter({ ...host, mode: 'versioned' });
  return kernelClient({ adapter, surface: 'newtab', maintainOnOpen: true });
}

/**
 * Start the new tab when its DOM is ready, as app.js's bootstrap did: App gets the tab's
 * client and becomes window.app before init runs. The listener answers with init's promise,
 * which a page ignores and a test can wait for.
 * @returns {void}
 */
export function startNewTab() {
  document.addEventListener('DOMContentLoaded', () => {
    const page = /** @type {NewTabPage} */ (/** @type {unknown} */ (globalThis));
    const kernel = createNewTabClient();
    const app = new page.App({ kernel, documentClient: createDocumentClient(kernel) });
    page.app = app;
    return app.init().catch(error => {
      console.error('App initialization failed:', error);
    });
  });
}
