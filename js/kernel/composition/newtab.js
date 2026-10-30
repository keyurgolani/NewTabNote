/**
 * The new tab's composition root (#12, docs/adr/0001-kernel-stack.md). It builds the tab's
 * kernel and, in place of the bootstrap at the end of js/app.js, constructs App with its
 * client, the document client its editors read and write through, and the AI port its
 * editors and note jobs call the provider through. js/main.js calls startNewTab() once it has
 * imported app.js.
 */

import { createAIPort } from '../../services/ai-port.mjs';
import { createLegacyAdapter } from '../adapters/legacy/adapter.js';
import { createDocumentClient } from './document.js';
import { kernelClient, legacyHost } from './host.js';

/** @typedef {import('./host.js').Client} Client */
/** @typedef {import('./host.js').LegacyHost} LegacyHost */
/** @typedef {import('./document.js').DocumentClient} DocumentClient */
/** @typedef {import('../../services/ai-port.mjs').AIPort} AIPort */

/**
 * The legacy App class app.js puts on window, and the instance the controllers still read as
 * window.app until #12 slice 7 removes it
 * @typedef {object} NewTabPage
 * @property {new (options: {kernel: Client, documentClient: DocumentClient, ai: AIPort}) => {init(): Promise<void>}} App
 * @property {unknown} [app]
 */

/**
 * The new tab's kernel and its client. It opens the database versioned, as Storage.init did,
 * and runs startup maintenance before any command. Its connection closes when another
 * context upgrades the database, so that upgrade never waits on this tab, and from then on
 * every command answers `reload-required`: the editor keeps its text and asks for a reload.
 * @param {LegacyHost} [host]
 * @returns {Client}
 */
export function createNewTabClient(host = legacyHost()) {
  const adapter = createLegacyAdapter({ ...host, mode: 'versioned' });
  return kernelClient({ adapter, surface: 'newtab', maintainOnOpen: true });
}

/**
 * The document client the new tab's editors read and write through, on `kernel`. Before the
 * tab's connection closes for another context's upgrade, it has them write what they have
 * pending, so typing from the last half second isn't lost.
 * @param {Client} kernel
 * @param {LegacyHost} host - the one the kernel was built on
 * @returns {DocumentClient}
 */
export function createNewTabDocumentClient(kernel, host) {
  return createDocumentClient(kernel, {
    beforeConnectionCloses: flush => host.storage.beforeConnectionCloses(flush),
    connectionOpen: () => host.storage.openState === 'open',
  });
}

/**
 * Start the new tab when its DOM is ready, as app.js's bootstrap did: App gets the tab's
 * client, its document client, and its AI port, and becomes window.app before init runs. The
 * listener answers with init's promise, which a page ignores and a test can wait for.
 * @returns {void}
 */
export function startNewTab() {
  document.addEventListener('DOMContentLoaded', () => {
    const page = /** @type {NewTabPage} */ (/** @type {unknown} */ (globalThis));
    const host = legacyHost();
    const kernel = createNewTabClient(host);
    const app = new page.App({
      kernel,
      documentClient: createNewTabDocumentClient(kernel, host),
      ai: createAIPort(),
    });
    page.app = app;
    return app.init().catch(error => {
      console.error('App initialization failed:', error);
    });
  });
}
