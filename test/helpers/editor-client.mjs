// The document client a test page's editors read and write through: a new tab's kernel on #17's
// adapter, opened as js/kernel/composition/newtab.js's root opens it since #17 PR 4a, once the
// worker's run has had its turn, as the root waits on it (legacy-env answers it). The narrow
// handles NotesManager, GraphView and SyncService take are the root's, on the same kernel (#17 PR
// 4b). test/helpers/legacy-env.js loads it into the page with test/helpers/page-module.js, so
// the kernel runs in the page as it does in Chrome.

import { createDocumentClient } from '../../js/kernel/composition/document.js';
import { chromeSettingsChanges, waitForWorkerUpgrade } from '../../js/kernel/composition/host.js';
import {
  connectNewTabStorage,
  createNewTabAdapter,
  createNewTabBackupCheck,
  createNewTabLegacyStores,
  createNewTabNoteList,
  createNewTabRecovery,
  createNewTabStorageState,
} from '../../js/kernel/composition/newtab.js';
import { createNoteRemoval } from '../../js/kernel/composition/removal.js';
import { createSettingsClient } from '../../js/kernel/composition/settings.js';
import { createKernel } from '../kernel/test-kernel.mjs';
import { createBaselinePolicy } from '../../js/kernel/core/ports/policy.js';
import { legacyIds, systemClock } from '../../js/kernel/core/ports/runtime.js';

/**
 * The page's kernel client, the document client over it, and its note list
 * (js/kernel/core/application/note-list.js), all on one kernel, as the new tab's root builds
 * them, so a commit an editor or a job makes reaches the list's feed. The database's state, the
 * storage guard's raw export, and an import's backup check are the root's, as the root gives
 * them to App.
 * @param {{settings: any, onListQuery?: (query: any) => void, kernelNow?: () => number,
 *   pageNow?: () => number, zone?: string}} host - the page's chrome.storage.local,
 *   what to tell of each query the note list makes, the kernel's and the document client's
 *   clocks, the system's unless given, and the zone both take today's Daily Note in, the host's
 *   unless given (#17 PR 3b)
 * @returns {{
 *   kernel: import('../../js/kernel/composition/host.js').Client,
 *   documentClient: import('../../js/kernel/composition/document.js').DocumentClient,
 *   noteList: import('../../js/kernel/core/application/note-list.js').NoteList,
 *   removalFor: (ports: Omit<import('../../js/kernel/composition/removal.js').RemovalPorts, 'settled'>) =>
 *     import('../../js/kernel/composition/removal.js').NoteRemoval,
 *   settingsClient: import('../../js/kernel/composition/settings.js').SettingsClient,
 *   storageState: import('../../js/kernel/composition/newtab.js').StorageState,
 *   recovery: import('../../js/kernel/composition/newtab.js').Recovery,
 *   validateBackup: import('../../js/kernel/composition/newtab.js').ValidateBackup,
 *   stores: import('../../js/kernel/composition/newtab.js').LegacyStores,
 * }}
 *   `removalFor` makes the page's removeNotes, with the pane moves and announce the test's
 *   page has, settled by its note list
 */
export function pageClientsFor({ settings, onListQuery = () => {}, kernelNow, pageNow, zone }) {
  // The page waits on the worker's run first, as the new tab's root does
  const adapter = createNewTabAdapter({
    indexedDB: globalThis.indexedDB,
    settings,
    awaitUpgrade: () => waitForWorkerUpgrade({ runtime: /** @type {any} */ (globalThis).chrome?.runtime }),
    locks: /** @type {any} */ (globalThis.navigator?.locks || null),
  });
  const zoneNow = zone ? () => zone : systemClock.zone;
  const kernel = createKernel({
    adapter,
    policy: createBaselinePolicy(),
    caller: Object.freeze({ surface: 'newtab', contextId: 'newtab-test' }),
    ids: legacyIds,
    clock: { now: kernelNow || systemClock.now, zone: zoneNow },
    ready: adapter.open(),
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
  // js/storage.js's shell, on a page that loads it, connected as the root connects it (#17 PR 4b)
  const shell = /** @type {any} */ (globalThis).Storage;
  if (shell && typeof shell.connect === 'function') {
    connectNewTabStorage(client, { settings, storage: shell }, createNewTabStorageState(adapter));
  }
  return {
    kernel: client,
    documentClient: createDocumentClient(client, { ...(pageNow ? { now: pageNow } : {}), zone: zoneNow }),
    noteList,
    removalFor: ports => createNoteRemoval(client, { ...ports, settled: () => noteList.settled() }),
    // It hears of settings changes as the new tab's does, from chrome.storage.onChanged (#17 PR 4a)
    settingsClient: createSettingsClient(client, { onSettingsChange: chromeSettingsChanges() }),
    // The adapter's state, as the root gives it to App
    storageState: createNewTabStorageState(adapter),
    // The raw export over the page's IndexedDB, as the root's (raw-export.js)
    recovery: createNewTabRecovery({ indexedDB: globalThis.indexedDB }),
    validateBackup: createNewTabBackupCheck(),
    // The narrow handles the root gives NotesManager, GraphView and SyncService (#17 PR 4b)
    stores: createNewTabLegacyStores(client, { settings }, createNewTabStorageState(adapter)),
  };
}

/**
 * The page's kernel client, and the document client over it
 * @param {{settings: any}} host - the page's chrome.storage.local
 * @returns {{kernel: import('../../js/kernel/composition/host.js').Client,
 *   documentClient: import('../../js/kernel/composition/document.js').DocumentClient}}
 */
export function editorKernelFor(host) {
  const { kernel, documentClient } = pageClientsFor(host);
  return { kernel, documentClient };
}

/**
 * @param {{settings: any}} host - the page's chrome.storage.local
 * @returns {import('../../js/kernel/composition/document.js').DocumentClient}
 */
export function editorClientFor(host) {
  return pageClientsFor(host).documentClient;
}
