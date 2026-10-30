// The document client a test page's editors read and write through: a new tab's kernel over
// the page's own Storage, as js/kernel/composition/newtab.js builds it, but already open,
// since the test started Storage itself. test/helpers/legacy-env.js loads it into the page
// with test/helpers/page-module.js, so the kernel runs in the page as it does in Chrome.

import { createLegacyAdapter } from '../../js/kernel/adapters/legacy/adapter.js';
import { createDocumentClient } from '../../js/kernel/composition/document.js';
import { createKernel } from '../../js/kernel/core/application/kernel.js';
import { createBaselinePolicy } from '../../js/kernel/core/ports/policy.js';
import { legacyIds, systemClock } from '../../js/kernel/core/ports/runtime.js';

/**
 * The page's kernel client, and the document client over it
 * @param {{storage: any, settings: any}} host - the page's Storage and chrome.storage.local
 * @returns {{kernel: import('../../js/kernel/composition/host.js').Client,
 *   documentClient: import('../../js/kernel/composition/document.js').DocumentClient}}
 */
export function editorKernelFor({ storage, settings }) {
  const adapter = createLegacyAdapter({ storage, settings, mode: 'versioned' });
  const kernel = createKernel({
    adapter,
    policy: createBaselinePolicy(),
    caller: Object.freeze({ surface: 'newtab', contextId: 'newtab-test' }),
    ids: legacyIds,
    clock: systemClock,
  });
  const client = Object.freeze({
    execute: kernel.execute,
    query: kernel.query,
    subscribe: kernel.subscribe,
    whenReady: kernel.whenReady,
    ids: legacyIds,
  });
  return { kernel: client, documentClient: createDocumentClient(client) };
}

/**
 * @param {{storage: any, settings: any}} host - the page's Storage and chrome.storage.local
 * @returns {import('../../js/kernel/composition/document.js').DocumentClient}
 */
export function editorClientFor(host) {
  return editorKernelFor(host).documentClient;
}
