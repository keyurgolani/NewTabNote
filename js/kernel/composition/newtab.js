/**
 * The new tab's composition root (#12, docs/adr/0001-kernel-stack.md). It builds the tab's
 * kernel and, in place of the bootstrap at the end of js/app.js, constructs App with its
 * client, the document client its editors read and write through, and the AI port its
 * editors and note jobs call the provider through. js/main.js calls startNewTab() once it has
 * imported app.js.
 */

import { createAIPort } from '../../services/ai-port.mjs';
import { createLegacyAdapter } from '../adapters/legacy/adapter.js';
import { createNoteList } from '../core/application/note-list.js';
import { createDocumentClient } from './document.js';
import { createSettingsClient } from './settings.js';
import { kernelClient, legacyHost } from './host.js';
import { lazyFailureEvents } from './lazy-failure-events.js';
import { createNoteRemoval } from './removal.js';

/** @typedef {import('./host.js').Client} Client */
/** @typedef {import('./host.js').LegacyHost} LegacyHost */
/** @typedef {import('./document.js').DocumentClient} DocumentClient */
/** @typedef {import('./settings.js').SettingsClient} SettingsClient */
/** @typedef {import('../../services/ai-port.mjs').AIPort} AIPort */
/** @typedef {import('../core/application/note-list.js').NoteList} NoteList */
/** @typedef {ReturnType<typeof lazyFailureEvents>} PageFailureEvents */
/** @typedef {import('./removal.js').NoteRemoval} NoteRemoval */
/** @typedef {import('./removal.js').RemovalPorts} RemovalPorts */

/**
 * What the root needs of App: init, and the pane moves and message to the other new tabs that
 * removeNotes runs around its write
 * @typedef {{init(): Promise<void>, leaveNotes: RemovalPorts['leave'], notesLeft: RemovalPorts['announce']}} NewTabApp
 */

/**
 * What the page knows of its database outside the kernel (#12 slice 7): whether it's open,
 * and which stores it lacks, as js/storage.js keeps them, read when asked
 * @typedef {Readonly<{openState: string, missingStores: readonly string[]}>} StorageState
 */

/**
 * The storage guard's raw export, which reads every store but settings from a database the
 * kernel can't open, and changes nothing
 * @typedef {Readonly<{exportRawStores: () => Promise<Record<string, unknown>>}>} Recovery
 */

/**
 * An import's check of a parsed backup, which writes nothing (Storage.validateImport)
 * @typedef {(data: unknown) => unknown} ValidateBackup
 */

/**
 * Some of js/storage.js's calls, the ones one holder makes that Storage defines, which Storage
 * runs
 * @typedef {Readonly<Record<string, (...args: any[]) => any>>} LegacyStore
 */

/**
 * The calls what #22 and #19 own still make on js/storage.js, each holder's own, so App holds
 * no whole Storage (#12 slice 7c): the search index and vectors NotesManager keeps, the notes
 * and links GraphView draws, and sync's settings and data
 * @typedef {Readonly<{searchIndex: LegacyStore, graph: LegacyStore, sync: LegacyStore}>} LegacyStores
 */

/**
 * The legacy App class app.js puts on window. `searchIndexStore`, `graphStore` and
 * `syncStore` are the LegacyStores NotesManager, GraphView and SyncService go through until
 * #22 and #19 move them.
 * @typedef {object} NewTabPage
 * @property {new (options: {kernel: Client, documentClient: DocumentClient, settings: SettingsClient, ai: AIPort,
 *   noteList: NoteList, events: PageFailureEvents, removal: NoteRemoval, storageState: StorageState,
 *   recovery: Recovery, validateBackup: ValidateBackup, searchIndexStore: LegacyStore, graphStore: LegacyStore,
 *   syncStore: LegacyStore}) => NewTabApp} App
 */

/** Each LegacyStores handle's calls, as its holder makes them */
const LEGACY_STORE_CALLS = Object.freeze({
  searchIndex: ['hasStore', 'setSearchIndex', 'setSearchIndexEntry', 'removeSearchIndexEntry', 'getAllVectors', 'saveVector'],
  graph: ['getAllNotes', 'getStore'],
  sync: ['getSetting', 'setSetting', 'getStore', 'exportAll', 'importAll', 'importNote', 'saveElement'],
});

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
 * The tab's note-list projection on `kernel`: the one copy of the note lists App, its
 * controllers, the palette, and analytics read. It starts reading as soon as the kernel is
 * ready, so the lists are there when App first renders them.
 * @param {Client} kernel
 * @returns {NoteList}
 */
export function createNewTabNoteList(kernel) {
  return createNoteList({
    query: kernel.query,
    subscribe: kernel.subscribe,
    whenReady: kernel.whenReady,
    logger: { warn: (event, detail) => console.warn(`NewTabNote note list: ${event}`, detail) },
  });
}

/**
 * The tab's failure events (#20, "Diagnostic journal"): the embedding model's load,
 * auto-backup, and the indexer's start report through them. Trust code loads with import()
 * only when the first failure does, so the tab's module graph gains one small module and no
 * trust code.
 * @returns {PageFailureEvents}
 */
export function createNewTabFailureEvents() {
  return lazyFailureEvents({ surface: 'newtab' });
}

/**
 * The tab's removeNotes on `kernel`. `page` is the App that moves its panes and tells the other
 * new tabs, asked for when a removal runs, since App makes its controllers after it's built.
 * @param {Client} kernel
 * @param {NoteList} noteList
 * @param {() => NewTabApp | null} page
 * @returns {NoteRemoval}
 */
export function createNewTabRemoval(kernel, noteList, page) {
  return createNoteRemoval(kernel, {
    leave: ids => {
      const app = page();
      return app ? app.leaveNotes(ids) : null;
    },
    announce: ids => {
      const app = page();
      if (app) app.notesLeft(ids);
    },
    settled: () => noteList.settled(),
    logger: { warn: (event, detail) => console.warn(`NewTabNote removeNotes: ${event}`, detail) },
  });
}

/**
 * The tab's settings port on `kernel` (#12 slices 6 and 7): its controllers' preferences,
 * workspace session, AI chat history, themes, onboarding, backups, and the export file go
 * through it, and it hears of each settings change through js/storage.js's onSettingsChange,
 * as the controllers did.
 * @param {Client} kernel
 * @param {LegacyHost} host - the one the kernel was built on
 * @returns {SettingsClient}
 */
export function createNewTabSettingsClient(kernel, host) {
  return createSettingsClient(kernel, { onSettingsChange: listener => host.storage.onSettingsChange(listener) });
}

/**
 * Whether the tab's database is open, and which stores it lacks, read from `host`'s storage
 * when asked, as App, the sidebar, and the export notice read them
 * @param {LegacyHost} host
 * @returns {StorageState}
 */
export function createNewTabStorageState(host) {
  return Object.freeze({
    get openState() {
      return host.storage.openState;
    },
    get missingStores() {
      return host.storage.missingStores;
    },
  });
}

/**
 * The storage guard's raw export, on `host`'s storage
 * @param {LegacyHost} host
 * @returns {Recovery}
 */
export function createNewTabRecovery(host) {
  return Object.freeze({ exportRawStores: () => host.storage.exportRawStores() });
}

/**
 * An import's check of a backup, on `host`'s storage
 * @param {LegacyHost} host
 * @returns {ValidateBackup}
 */
export function createNewTabBackupCheck(host) {
  return data => host.storage.validateImport(data);
}

/**
 * The narrow handles on `host`'s storage that App hands NotesManager, GraphView and SyncService.
 * A call its holder makes that Storage doesn't define is left out, so a holder that checks for
 * one finds none, as it found none on Storage.
 * @param {LegacyHost} host
 * @returns {LegacyStores}
 */
export function createNewTabLegacyStores(host) {
  const storage = /** @type {Record<string, unknown>} */ (/** @type {unknown} */ (host.storage));
  /**
   * @param {readonly string[]} calls
   * @returns {LegacyStore}
   */
  const only = calls => {
    /** @type {Record<string, (...args: any[]) => any>} */
    const handle = {};
    for (const call of calls) {
      if (typeof storage[call] !== 'function') continue;
      // Storage's method as it is when called, on Storage
      handle[call] = (...args) => /** @type {(...args: any[]) => any} */ (storage[call]).apply(storage, args);
    }
    return Object.freeze(handle);
  };
  return Object.freeze({
    searchIndex: only(LEGACY_STORE_CALLS.searchIndex),
    graph: only(LEGACY_STORE_CALLS.graph),
    sync: only(LEGACY_STORE_CALLS.sync),
  });
}

/**
 * Start the new tab when its DOM is ready, as app.js's bootstrap did: App gets the tab's
 * client, its document client, its settings client, its AI port, its note list, its failure
 * events, its removeNotes, its database's state and recovery, its import's backup check, and
 * the narrow legacy stores the search index, the graph view, and sync still go through. Nothing
 * puts it on the page: no code reads a global App instance (#12 slice 7c). The listener answers
 * with init's promise, which a page ignores and a test can wait for.
 * @returns {void}
 */
export function startNewTab() {
  document.addEventListener('DOMContentLoaded', () => {
    const page = /** @type {NewTabPage} */ (/** @type {unknown} */ (globalThis));
    const host = legacyHost();
    const kernel = createNewTabClient(host);
    const noteList = createNewTabNoteList(kernel);
    /** @type {NewTabApp | null} */
    let built = null;
    const stores = createNewTabLegacyStores(host);
    const app = new page.App({
      kernel,
      documentClient: createNewTabDocumentClient(kernel, host),
      settings: createNewTabSettingsClient(kernel, host),
      ai: createAIPort(),
      noteList,
      events: createNewTabFailureEvents(),
      removal: createNewTabRemoval(kernel, noteList, () => built),
      storageState: createNewTabStorageState(host),
      recovery: createNewTabRecovery(host),
      validateBackup: createNewTabBackupCheck(host),
      searchIndexStore: stores.searchIndex,
      graphStore: stores.graph,
      syncStore: stores.sync,
    });
    built = app;
    return app.init().catch(error => {
      console.error('App initialization failed:', error);
    });
  });
}
