/**
 * The new tab's composition root (#12, docs/adr/0001-kernel-stack.md). It builds the tab's
 * kernel, on #17's IndexedDB adapter since #17 PR 4a, and, in place of the bootstrap at the end
 * of js/app.js, constructs App with its client, the document client its editors read and write
 * through, and the AI port its editors and note jobs call the provider through. js/main.js's
 * boot() calls startNewTab() with the page's loader, once the boot root has loaded the
 * workspace chunk (#27 slice 3).
 */

import { createAIPort } from '../../services/ai-port.mjs';
import { createIndexedDbAdapter } from '../adapters/indexeddb/adapter.js';
import { validateBackup } from '../adapters/indexeddb/backups.js';
import { exportPoint, exportablePointRecord } from '../adapters/indexeddb/legacy-export.js';
import { exportRawStores } from '../adapters/indexeddb/raw-export.js';
import { createNoteList } from '../core/application/note-list.js';
import { UnavailableError } from '../core/contracts/outcomes.js';
import { systemClock } from '../core/ports/runtime.js';
import { createDocumentClient } from './document.js';
import { createSettingsClient } from './settings.js';
import { chromeSettingsChanges, kernelClient, pageHost, wakeWorkerToPurge } from './host.js';
import { lazyFailureEvents } from './lazy-failure-events.js';
import { createNoteRemoval } from './removal.js';
import { startIndexer } from './workers.js';

/** @typedef {import('./host.js').Client} Client */
/** @typedef {import('./host.js').LegacyStorage} LegacyStorage */
/** @typedef {import('./host.js').PageHost} PageHost */
/** @typedef {import('./settings.js').SettingsChanges} SettingsChanges */
/** @typedef {import('../adapters/indexeddb/adapter.js').IndexedDbAdapter} IndexedDbAdapter */
/** @typedef {import('../adapters/indexeddb/recovery-copies.js').CopyLocks} CopyLocks */
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
 * which stores it lacks, as js/storage.js keeps them, read when asked, and whether it's at
 * this build's version, which since #17 PR 1b only the worker's run brings it to
 * @typedef {Readonly<{openState: string, missingStores: readonly string[], upgraded: () => boolean}>} StorageState
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
 *   syncStore: LegacyStore, startIndexer: () => Worker, loader: unknown, preUpdateCopy: PreUpdateCopy}) => NewTabApp} App
 */

/** Each LegacyStores handle's calls, as its holder makes them */
const LEGACY_STORE_CALLS = Object.freeze({
  searchIndex: [
    'hasStore',
    'setSearchIndex',
    'setSearchIndexEntry',
    'removeSearchIndexEntry',
    'getAllVectors',
    'saveVector',
  ],
  graph: ['getAllNotes', 'getStore'],
  sync: ['getSetting', 'setSetting', 'getStore', 'exportAll', 'importAll', 'importNote', 'saveElement'],
});

/**
 * The pinned pre-migration copy, for Settings > Data & Backup's Export Pre-Update Copy (#17
 * PR 1b, Q8): `find` names the copy to export, with when it was made, and `export` hands it
 * over as 1.4.1's import file, once it reads back verified. Both only read, and make no
 * recovery database on a profile without one.
 * @typedef {object} PreUpdateCopy
 * @property {() => Promise<{id: string, createdAt: number} | null>} find
 * @property {(id: string) => Promise<object>} export
 */

/**
 * The new tab's pre-update copy, over the page's IndexedDB, read under the page's Web Locks
 * (exportPoint takes the points lock shared, so the worker's purge never cuts through it)
 * @param {{indexedDB?: IDBFactory, keyRange?: typeof IDBKeyRange, crypto?: import('../adapters/indexeddb/records.js').Digester, locks?: import('../adapters/indexeddb/legacy-export.js').SharedLocks | null}} [host]
 * @returns {PreUpdateCopy}
 */
export function createPreUpdateCopy({
  indexedDB = globalThis.indexedDB,
  keyRange = globalThis.IDBKeyRange,
  crypto = /** @type {any} */ (globalThis.crypto),
  locks = /** @type {any} */ (globalThis.navigator && globalThis.navigator.locks) || null,
} = {}) {
  return Object.freeze({
    async find() {
      const point = await exportablePointRecord({ indexedDB });
      return point ? { id: point.id, createdAt: point.createdAt } : null;
    },
    export: (/** @type {string} */ pointId) =>
      exportPoint({ indexedDB, keyRange, crypto, clock: systemClock, pointId, locks }),
  });
}

/**
 * What the new tab's root runs on (#17 PR 4a): Popup's host, which is the page's IndexedDB,
 * chrome.storage.local, and its wait on the worker's run (Q12), with the page's Web Locks for
 * #33's copy, where it hears of settings changes, and js/storage.js's DatabaseManager, which the
 * narrow LegacyStores still call until #17 PR 4b makes it a facade over the tab's kernel
 * @typedef {PageHost & {locks: CopyLocks | null, changes: SettingsChanges, storage: LegacyStorage}} NewTabHost
 */

/**
 * The new tab's host, from the page's globals, each read when a call reaches it
 * @returns {NewTabHost}
 */
export function newTabHost() {
  return {
    ...pageHost(),
    locks: /** @type {CopyLocks | null} */ (/** @type {unknown} */ (globalThis.navigator?.locks || null)),
    changes: chromeSettingsChanges(),
    storage: /** @type {LegacyStorage} */ (/** @type {{Storage?: unknown}} */ (globalThis).Storage),
  };
}

/**
 * The new tab's adapter, #17's (#17 PR 4a), opened as the database is on disk, as Popup's is
 * (Q3): since #17 PR 1b only the service worker upgrades it, so a page that finds none, or one
 * below this build's version, waits up to 5 seconds on the worker's run first. A database a newer
 * build upgraded is `newer-schema`, and one without its notes or blocks `missing-core-stores`, as
 * Storage refused them. Before it opens a version-8 database that lacks a store, it saves #33's
 * copy of what's there, under the page's Web Lock, as js/storage.js's open did. It runs the
 * tab's startup maintenance, the first-run settings only (Q9), and the backup tasks (Q1).
 * @param {Pick<NewTabHost, 'indexedDB' | 'settings' | 'awaitUpgrade' | 'locks'>} host
 * @returns {IndexedDbAdapter}
 */
export function createNewTabAdapter(host) {
  return createIndexedDbAdapter({
    indexedDB: host.indexedDB,
    settings: host.settings,
    awaitUpgrade: host.awaitUpgrade,
    locks: host.locks,
    mode: 'existing',
    requireCore: true,
    maintains: true,
    copiesMissingStores: true,
    backups: true,
  });
}

/**
 * Why the tab can't start when the holders' Storage didn't open after the adapter did, in the
 * words the legacy adapter gave Storage's refusals, so App shows the same guard or error state
 * @param {unknown} error - what Storage.open threw
 * @returns {UnavailableError}
 */
function holdersFailure(error) {
  const { code, name, message } = /** @type {{code?: unknown, name?: unknown, message?: unknown}} */ (error || {});
  const thrown = { cause: error };
  if (code === 'NEWER_SCHEMA') return new UnavailableError('newer-schema', 'version-too-new', false, thrown);
  if (code === 'MISSING_CORE_STORES') return new UnavailableError('storage', 'missing-core-stores', false, thrown);
  if (code === 'NO_DATABASE') return new UnavailableError('storage', 'no-database', true, thrown);
  if (name === 'QuotaExceededError' || /quota/i.test(String(message))) {
    return new UnavailableError('quota', 'quota', false, thrown);
  }
  return new UnavailableError('storage', 'open-failed', true, thrown);
}

/**
 * The new tab's kernel and its client, on `adapter` (createNewTabAdapter). It runs startup
 * maintenance before any command. Its connection closes when the worker upgrades the database,
 * so that upgrade never waits on this tab, and from then on every command answers
 * `reload-required`: the editor keeps its text and asks for a reload.
 *
 * js/storage.js's DatabaseManager opens beside it, watching its connection, for the holders
 * #22 and #19 own (createNewTabLegacyStores), until #17 PR 4b makes it a facade. Both open at
 * once, so their waits on the worker's run overlap, and the kernel is ready once both are: no
 * holder calls a Storage that isn't open, as when Storage was the kernel's own. When the
 * adapter's open fails, its failure is the one the tab answers.
 * @param {IndexedDbAdapter} adapter
 * @param {Pick<NewTabHost, 'storage'>} host
 * @returns {Client}
 */
export function createNewTabClient(adapter, host) {
  /** @type {Promise<unknown>} */
  const holders = Promise.resolve()
    .then(() => host.storage.open({ watchConnection: true }))
    .then(
      () => null,
      error => holdersFailure(error),
    );
  const ready = adapter.open().then(async () => {
    const failure = await holders;
    if (failure) throw failure;
  });
  return kernelClient({ adapter, surface: 'newtab', maintainOnOpen: true, ready });
}

/** The codes of a committed command that deleted notes or folders for good, leaving tombstones */
const DELETED_CODES = Object.freeze(['note-deleted', 'trash-emptied', 'trash-cleaned', 'folder-deleted']);

/**
 * Whether `outcome` deleted something for good: a note (a permanent delete, or a trash of an
 * empty untitled note), Empty trash or trash retention that deleted any, a folder, or a bulk
 * delete any item of which did
 * @param {import('../core/contracts/outcomes.js').Outcome | import('../core/contracts/outcomes.js').BulkOutcome} outcome
 * @returns {boolean}
 */
function deletedSomething(outcome) {
  if (outcome.kind === 'bulk') return outcome.items.some(item => deletedSomething(item.outcome));
  return outcome.kind === 'committed' && DELETED_CODES.includes(outcome.code) && outcome.changedIds.length > 0;
}

/**
 * `client`, which wakes the worker to purge (#17 PR 2b) after each command that deleted
 * something for good, whatever path ran it: removeNotes, a folder's delete, or any other.
 * The wake is best effort, and never changes the outcome.
 * @param {Client} client
 * @param {() => void} wake
 * @returns {Client}
 */
export function withPurgeWake(client, wake) {
  return Object.freeze({
    ...client,
    execute: /** @type {Client['execute']} */ (
      /** @type {unknown} */ (
        async (/** @type {import('../core/contracts/commands.js').Command} */ command) => {
          const outcome = await client.execute(command);
          if (deletedSomething(/** @type {any} */ (outcome))) {
            try {
              wake();
            } catch {
              // The worker sweeps at its next start
            }
          }
          return outcome;
        }
      )
    ),
  });
}

/**
 * The document client the new tab's editors read and write through, on `kernel`. Before the
 * adapter's connection closes for another context's upgrade, it has them write what they have
 * pending, so typing from the last half second isn't lost.
 * @param {Client} kernel
 * @param {Pick<IndexedDbAdapter, 'beforeClose' | 'openState'>} adapter - the one the kernel was built on
 * @returns {DocumentClient}
 */
export function createNewTabDocumentClient(kernel, adapter) {
  return createDocumentClient(kernel, {
    beforeConnectionCloses: flush => adapter.beforeClose(flush),
    connectionOpen: () => adapter.openState() === 'open',
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
 * through it, and it hears of each settings change from `host` (chrome.storage.onChanged, as
 * js/storage.js's onSettingsChange heard them until #17 PR 4a).
 * @param {Client} kernel
 * @param {Pick<NewTabHost, 'changes'>} host
 * @returns {SettingsClient}
 */
export function createNewTabSettingsClient(kernel, host) {
  return createSettingsClient(kernel, { onSettingsChange: host.changes });
}

/**
 * Whether the tab's database is open, which stores it lacks, and whether it's at this build's
 * version, read from `adapter`'s connection when asked, as App, the sidebar, the export notice,
 * the space notice, and the pre-update copy's section read them
 * @param {Pick<IndexedDbAdapter, 'openState' | 'missingStores' | 'upgraded'>} adapter - the one the kernel was built on
 * @returns {StorageState}
 */
export function createNewTabStorageState(adapter) {
  return Object.freeze({
    get openState() {
      return adapter.openState();
    },
    get missingStores() {
      return adapter.missingStores();
    },
    upgraded: () => adapter.upgraded(),
  });
}

/**
 * The storage guard's raw export over the page's IndexedDB (adapters/indexeddb/raw-export.js),
 * Storage's own until #17 PR 4a: every store but settings, read as it is, changing nothing
 * @param {Pick<NewTabHost, 'indexedDB'>} host
 * @returns {Recovery}
 */
export function createNewTabRecovery(host) {
  return Object.freeze({
    exportRawStores: () => exportRawStores({ indexedDB: host.indexedDB, clock: systemClock }),
  });
}

/**
 * An import's check of a parsed backup, which writes nothing: the one the import runs again
 * before it writes (adapters/indexeddb/backups.js), Storage.validateImport's
 * @returns {ValidateBackup}
 */
export function createNewTabBackupCheck() {
  return data => validateBackup(data);
}

/**
 * The narrow handles on `host`'s storage that App hands NotesManager, GraphView and SyncService.
 * A call its holder makes that Storage doesn't define is left out, so a holder that checks for
 * one finds none, as it found none on Storage.
 * @param {Pick<NewTabHost, 'storage'>} host
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
 * Start the new tab, as app.js's bootstrap did: App gets the tab's client, its document
 * client, its settings client, its AI port, its note list, its failure events, its
 * removeNotes, its database's state and recovery, its import's backup check, the narrow
 * legacy stores the search index, the graph view, and sync still go through, the indexer's
 * starter (./workers.js), and the page's loader (js/runtime/lazy.js). Nothing puts it on the
 * page: no code reads a global App instance (#12 slice 7c). A chunk the boot root loads runs
 * once the document is parsed, after a listener for DOMContentLoaded could hear it, so it
 * starts now; while the document still loads, as a test's may, it waits for
 * DOMContentLoaded. It answers init's promise, which a page ignores and a test can wait for,
 * or null when it waits, and then the listener answers it.
 * @param {{loader?: unknown}} [options]
 * @returns {Promise<void> | null}
 */
export function startNewTab({ loader = null } = {}) {
  const start = () => {
    const page = /** @type {NewTabPage} */ (/** @type {unknown} */ (globalThis));
    const host = newTabHost();
    const adapter = createNewTabAdapter(host);
    const kernel = withPurgeWake(createNewTabClient(adapter, host), () => wakeWorkerToPurge());
    const noteList = createNewTabNoteList(kernel);
    /** @type {NewTabApp | null} */
    let built = null;
    const stores = createNewTabLegacyStores(host);
    const app = new page.App({
      kernel,
      documentClient: createNewTabDocumentClient(kernel, adapter),
      settings: createNewTabSettingsClient(kernel, host),
      ai: createAIPort(),
      noteList,
      events: createNewTabFailureEvents(),
      removal: createNewTabRemoval(kernel, noteList, () => built),
      storageState: createNewTabStorageState(adapter),
      recovery: createNewTabRecovery(host),
      validateBackup: createNewTabBackupCheck(),
      searchIndexStore: stores.searchIndex,
      graphStore: stores.graph,
      syncStore: stores.sync,
      startIndexer,
      loader,
      preUpdateCopy: createPreUpdateCopy(),
    });
    built = app;
    return app.init().catch(error => {
      console.error('App initialization failed:', error);
    });
  };
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start);
    return null;
  }
  return start();
}
