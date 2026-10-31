// The document client a test page's editors read and write through: a new tab's kernel over
// the page's own Storage, as js/kernel/composition/newtab.js builds it, but already open,
// since the test started Storage itself. test/helpers/legacy-env.js loads it into the page
// with test/helpers/page-module.js, so the kernel runs in the page as it does in Chrome.

import { createLegacyAdapter } from '../../js/kernel/adapters/legacy/adapter.js';
import { createDocumentClient } from '../../js/kernel/composition/document.js';
import { createNewTabNoteList } from '../../js/kernel/composition/newtab.js';
import { createNoteRemoval } from '../../js/kernel/composition/removal.js';
import { createKernel } from '../../js/kernel/core/application/kernel.js';
import { createBaselinePolicy } from '../../js/kernel/core/ports/policy.js';
import { legacyIds, systemClock } from '../../js/kernel/core/ports/runtime.js';

/**
 * The page's kernel client, the document client over it, and its note list
 * (js/kernel/core/application/note-list.js), all on one kernel, as the new tab's root builds
 * them, so a commit an editor or a job makes reaches the list's feed
 * @param {{storage: any, settings: any, onListQuery?: (query: any) => void, kernelNow?: () => number,
 *   pageNow?: () => number}} host - the page's Storage and chrome.storage.local, what to tell of
 *   each query the note list makes, and the kernel's and the document client's clocks, the
 *   system's unless given
 * @returns {{
 *   kernel: import('../../js/kernel/composition/host.js').Client,
 *   documentClient: import('../../js/kernel/composition/document.js').DocumentClient,
 *   noteList: import('../../js/kernel/core/application/note-list.js').NoteList,
 *   removalFor: (ports: Omit<import('../../js/kernel/composition/removal.js').RemovalPorts, 'settled'>) =>
 *     import('../../js/kernel/composition/removal.js').NoteRemoval,
 * }}
 *   `removalFor` makes the page's removeNotes, with the pane moves and announce the test's
 *   page has, settled by its note list
 */
export function pageClientsFor({ storage, settings, onListQuery = () => {}, kernelNow, pageNow }) {
  const adapter = createLegacyAdapter({ storage, settings, mode: 'versioned' });
  const kernel = createKernel({
    adapter,
    policy: createBaselinePolicy(),
    caller: Object.freeze({ surface: 'newtab', contextId: 'newtab-test' }),
    ids: legacyIds,
    clock: kernelNow ? { now: kernelNow } : systemClock,
  });
  const client = Object.freeze({
    execute: kernel.execute,
    query: kernel.query,
    subscribe: kernel.subscribe,
    whenReady: kernel.whenReady,
    ids: legacyIds,
  });
  /** @type {typeof kernel.query} */
  const listQuery = query => {
    onListQuery(query);
    return kernel.query(query);
  };
  const noteList = createNewTabNoteList({ ...client, query: listQuery });
  return {
    kernel: client,
    documentClient: createDocumentClient(client, pageNow ? { now: pageNow } : {}),
    noteList,
    removalFor: ports => createNoteRemoval(client, { ...ports, settled: () => noteList.settled() }),
  };
}

/**
 * The page's kernel client, and the document client over it
 * @param {{storage: any, settings: any}} host - the page's Storage and chrome.storage.local
 * @returns {{kernel: import('../../js/kernel/composition/host.js').Client,
 *   documentClient: import('../../js/kernel/composition/document.js').DocumentClient}}
 */
export function editorKernelFor(host) {
  const { kernel, documentClient } = pageClientsFor(host);
  return { kernel, documentClient };
}

/**
 * @param {{storage: any, settings: any}} host - the page's Storage and chrome.storage.local
 * @returns {import('../../js/kernel/composition/document.js').DocumentClient}
 */
export function editorClientFor(host) {
  return pageClientsFor(host).documentClient;
}
