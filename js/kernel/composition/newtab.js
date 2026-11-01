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
import { NEWTAB_HANDLERS } from '../core/application/handlers-all.js';
import { createNoteList } from '../core/application/note-list.js';
import {
  DRAFTS_LOCK,
  DRAFT_PREFIX,
  SAVED_UNTOLD_KEY,
  UNTOLD_KEY,
  recoveredIdOf,
} from '../core/domain/close-draft-keys.js';
import { systemClock } from '../core/ports/runtime.js';
import { applyingCloseDrafts, holdsKeys, pageDrafts } from './close-drafts.js';
import { createDocumentClient } from './document.js';
import { createSettingsClient } from './settings.js';
import { PROVIDER_SETTING_KEYS, SYNC_SETTING_KEYS, createHolderSettings } from './holder-settings.js';
import { chromeBackupSettings, chromeSettingsChanges, kernelClient, pageHost, wakeWorkerToPurge } from './host.js';
import { lazyFailureEvents } from './lazy-failure-events.js';
import { createNoteRemoval } from './removal.js';
import { createStorageFacade } from './storage-facade.js';
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
/** @typedef {import('./storage-facade.js').StorageFacade} StorageFacade */
/** @typedef {import('./close-drafts.js').Applier} Applier */
/** @typedef {import('../core/application/close-drafts.js').DraftStorage} DraftStorage */
/** @typedef {import('../core/application/close-drafts.js').DraftLocks} DraftLocks */
/** @typedef {import('../core/application/close-drafts.js').DraftStore} DraftStore */

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
 * Some of js/storage.js's calls, the ones one holder makes, under the names it has always
 * called, each a command or a query on the tab's kernel since #17 PR 4b (storage-facade.js)
 * @typedef {Readonly<Record<string, (...args: any[]) => any>>} LegacyStore
 */

/**
 * The calls what #22 and #19 own still make on js/storage.js, each holder's own, so App holds
 * no whole Storage (#12 slice 7c): the search index and vectors NotesManager keeps, the notes
 * and links GraphView draws, and sync's settings and what it uploads
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

/**
 * Each LegacyStores handle's calls on the facade (storage-facade.js), as its holder makes them.
 * Sync's handle also has its own settings (holder-settings.js), and no importAll, importNote,
 * or saveElement: sync has never applied a remote note, and those paths stay as they are
 * until #19 (sync-service.js).
 */
const LEGACY_STORE_CALLS = Object.freeze({
  searchIndex: /** @type {const} */ ([
    'hasStore',
    'setSearchIndex',
    'setSearchIndexEntry',
    'removeSearchIndexEntry',
    'getAllVectors',
    'saveVector',
  ]),
  graph: /** @type {const} */ (['getAllNotes', 'listLinks']),
  sync: /** @type {const} */ (['exportAll']),
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
 * #33's copy, where it hears of settings changes, and js/storage.js's shell, the `Storage`
 * global, which the root connects to the tab's kernel (connectNewTabStorage, #17 PR 4b). Its
 * chrome.storage.local has the remove the backup tasks prune with too (chromeBackupSettings).
 * @typedef {PageHost & {locks: CopyLocks | null, changes: SettingsChanges, storage: LegacyStorage}} NewTabHost
 */

/**
 * The new tab's host, from the page's globals, each read when a call reaches it
 * @returns {NewTabHost}
 */
export function newTabHost() {
  return {
    ...pageHost(),
    // With remove, which the automatic backup prunes the oldest with
    settings: chromeBackupSettings(),
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
 * The new tab's kernel and its client, on `adapter` (createNewTabAdapter), with every handler
 * the catalog allows on the new tab (NEWTAB_HANDLERS). It runs startup maintenance before any
 * command. Its connection closes when the worker upgrades the database, so that upgrade never
 * waits on this tab, and from then on every command answers `reload-required`: the editor
 * keeps its text and asks for a reload. It's the tab's one connection to the database since
 * #17 PR 4b, when js/storage.js stopped opening its own.
 * @param {IndexedDbAdapter} adapter
 * @returns {Client}
 */
export function createNewTabClient(adapter) {
  return kernelClient({
    adapter,
    surface: 'newtab',
    handlers: NEWTAB_HANDLERS,
    maintainOnOpen: true,
    ready: adapter.open(),
  });
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

/** The commands that can delete a note for good, a bulk action's items included (#33) */
const DELETING_COMMANDS = Object.freeze(['deleteNotePermanently', 'emptyTrash', 'runTrashCleanup', 'trashNote', 'runBulkAction']);

/** The codes of a committed command that deleted notes for good, whose changedIds are those notes */
const NOTES_DELETED = Object.freeze(['note-deleted', 'trash-emptied', 'trash-cleaned']);

/**
 * The notes `command` can delete for good, as it names them before the kernel runs it: a
 * permanent delete's note, and the note the Trash deletes for good when it's empty and untitled.
 * Empty Trash, trash retention and a bulk action name theirs only in their outcome, so null.
 * @param {import('../core/contracts/commands.js').Command} command
 * @returns {string[] | null}
 */
const notesNamedBy = command => {
  if (command.type === 'deleteNotePermanently' || command.type === 'trashNote') return [command.noteId];
  return null;
};

/**
 * The notes `outcome` deleted for good
 * @param {import('../core/contracts/outcomes.js').Outcome | import('../core/contracts/outcomes.js').BulkOutcome} outcome
 * @returns {string[]}
 */
const notesDeletedBy = outcome => {
  if (outcome.kind === 'bulk') return outcome.items.flatMap(item => notesDeletedBy(item.outcome));
  return outcome.kind === 'committed' && NOTES_DELETED.includes(outcome.code) ? outcome.changedIds : [];
};

/**
 * Whether `storage` gives the new tab's start work: a draft, 1.4.3's catch-up key, or an untold
 * list, which the new tab reads for its toasts. Popup and Side Panel read no untold list, so
 * theirs is holdsDrafts (close-drafts.js). This one and the two below are the new tab's alone, so
 * they're here, out of the chunk its start shares with Popup's and Side Panel's.
 * @param {DraftStorage | undefined} storage
 * @returns {boolean}
 */
const holdsNewTabWork = storage => holdsKeys(storage, { catchUp: true, untold: true });

/**
 * Whether `storage` holds a key a note deleted for good could have left: a draft, or an untold
 * list, which the store's clearNotes clears. With neither, no note has one here.
 * @param {DraftStorage | undefined} storage
 * @returns {boolean}
 */
const holdsNoteKeys = storage => holdsKeys(storage, { untold: true });

/**
 * Whether `storage` holds a key the notes `noteIds` left, which a delete of them for good clears
 * (the store's clearNotes): a draft for one of them, a draft whose recovered note one of them is
 * (recoveredIdOf), or an entry naming one in either untold list. Synchronous, and never throws: a
 * page without localStorage, or without access to it, holds none, and a value that doesn't parse
 * names no note.
 * @param {DraftStorage | undefined} storage
 * @param {readonly string[]} noteIds
 * @returns {boolean}
 */
function holdsKeysFor(storage, noteIds) {
  /**
   * @param {string | null} text
   * @returns {unknown}
   */
  const parsed = text => {
    try {
      return JSON.parse(text || 'null');
    } catch {
      return null;
    }
  };
  /**
   * @param {unknown} value
   * @returns {value is Record<string, unknown>}
   */
  const isObject = value => typeof value === 'object' && value !== null;
  try {
    if (!storage) return false;
    const ids = new Set(noteIds);
    /** @param {unknown} id */
    const named = id => typeof id === 'string' && ids.has(id);
    for (let index = 0; index < storage.length; index += 1) {
      const key = String(storage.key(index));
      if (!key.startsWith(DRAFT_PREFIX)) continue;
      const draft = parsed(storage.getItem(key));
      if (!isObject(draft)) continue;
      if (named(draft.noteId) || (typeof draft.id === 'string' && named(recoveredIdOf({ id: draft.id })))) return true;
    }
    /**
     * @param {string} key
     * @param {string[]} fields
     */
    const names = (key, fields) => {
      const list = parsed(storage.getItem(key));
      return Array.isArray(list) && list.some(entry => isObject(entry) && fields.some(field => named(entry[field])));
    };
    return names(UNTOLD_KEY, ['id', 'of']) || names(SAVED_UNTOLD_KEY, ['id']);
  } catch {
    return false;
  }
}

/** Tells of a delete whose clear couldn't load, never a draft's text */
const clearLogger = Object.freeze({
  warn: (/** @type {string} */ event, /** @type {Record<string, unknown>} */ detail) =>
    console.warn(`NewTabNote close-time drafts: ${event}`, detail),
});

/**
 * `client`, whose every command that can delete a note for good holds the close-time drafts'
 * lock around the command and the clear of what the notes it deleted left in the page's
 * localStorage, whatever path sends it: a permanent delete, Empty Trash, trash retention, a bulk
 * action, and the Trash, which deletes an empty untitled note for good (#33, the lead's Q7).
 * Only the outcome says what was deleted, so the lock is taken first. So a delete never lands
 * between an apply's read of a draft and its command, and clearing after the commit needs nothing
 * put back. The clear is the store's, from the applier `load` hands over, inside the lock.
 *
 * A delete skips the lock and the load when the page holds no key its notes could have left: for
 * one that names its note, no draft for it, no draft whose recovered note it is, and no entry
 * naming it in either untold list (holdsKeysFor); for Empty Trash, trash retention and a bulk
 * action, which name their notes only in their outcome, no draft and no untold list at all
 * (holdsNoteKeys). That's safe on two counts: a draft a closing tab writes after the look can't
 * bring a note deleted for good back, since the next start's apply drops a draft whose note is
 * gone (rule 1); and an apply removes a draft's key only once its command has committed, so while
 * one is under way its key is there, and a delete of its note that looks then takes the lock and
 * waits for it. An applier that can't load clears nothing, and the delete runs: the next start's
 * apply drops what its notes left, as rule 1 does.
 * @param {Client} client
 * @param {{storage: DraftStorage | undefined, locks: DraftLocks | null, load: () => Promise<Applier>, logger?: {warn: (event: string, detail: Record<string, unknown>) => void}}} drafts
 * @returns {Client}
 */
export function withCloseDraftClears(client, { storage, locks, load, logger = clearLogger }) {
  /** @param {import('../core/contracts/commands.js').Command} command */
  const run = async command => {
    /** @type {DraftStore | null} */
    let store = null;
    try {
      store = (await load()).closeDraftStore(storage);
    } catch (error) {
      logger.warn('close-drafts-not-cleared', { error });
    }
    const outcome = /** @type {import('../core/contracts/outcomes.js').Outcome | import('../core/contracts/outcomes.js').BulkOutcome} */ (
      await client.execute(command)
    );
    const ids = notesDeletedBy(outcome);
    if (store && ids.length > 0) store.clearNotes(ids);
    return outcome;
  };
  return Object.freeze({
    ...client,
    execute: /** @type {Client['execute']} */ (
      /** @type {unknown} */ (
        (/** @type {import('../core/contracts/commands.js').Command} */ command) => {
          if (!DELETING_COMMANDS.includes(command.type)) return client.execute(command);
          const named = notesNamedBy(command);
          if (!(named ? holdsKeysFor(storage, named) : holdsNoteKeys(storage))) return client.execute(command);
          return locks ? locks.request(DRAFTS_LOCK, { mode: 'exclusive' }, () => run(command)) : run(command);
        }
      )
    ),
  });
}

/**
 * The close-time drafts' applier, the `close-drafts-chunk` chunk, which the new tab imports only
 * when its localStorage gives it work, as Popup and Side Panel do (close-drafts.js)
 * @returns {Promise<Applier>}
 */
const loadCloseDrafts = () => import('../core/application/close-drafts-chunk.js');

/**
 * The client the new tab's root hands out, on `adapter` (createNewTabClient): it wakes the worker
 * to purge after each delete for good (withPurgeWake), holds the close-time drafts' lock around
 * each command that can delete for good and clears what the deleted notes left of them
 * (withCloseDraftClears), and its whenReady resolves once the closing tabs' edits are applied,
 * so the note list's first read and App's start come after them (#33). Like Popup and Side Panel,
 * the new tab loads the applier only when its localStorage holds a draft, 1.4.3's catch-up key
 * or an untold list, which it reads for its toasts (holdsNewTabWork), so its start loads none of
 * it (#147's heap, the lead's call).
 * @param {IndexedDbAdapter} adapter
 * @param {{drafts?: ReturnType<typeof pageDrafts>, wake?: () => void, load?: () => Promise<Applier>}} [page]
 *   the page's drafts and its wake, from its globals, and the applier's load
 * @returns {ReturnType<typeof applyingCloseDrafts>}
 */
export function createNewTabPageClient(
  adapter,
  { drafts = pageDrafts(), wake = () => wakeWorkerToPurge(), load = loadCloseDrafts } = {},
) {
  const client = withCloseDraftClears(withPurgeWake(createNewTabClient(adapter), wake), {
    storage: drafts.storage,
    locks: drafts.locks,
    load,
  });
  return applyingCloseDrafts(client, drafts, { load, holds: holdsNewTabWork });
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
 * The narrow handles App hands NotesManager, GraphView and SyncService, each with only its
 * holder's calls, under the names it has always called on js/storage.js. Since #17 PR 4b each
 * is a command or a query on `kernel`, the tab's client (storage-facade.js), and sync's
 * settings are its own, in chrome.storage.local as before (holder-settings.js).
 * @param {Client} kernel
 * @param {Pick<NewTabHost, 'settings'>} host
 * @param {Pick<StorageState, 'openState' | 'missingStores'>} storageState - the tab's database, as its adapter opened it
 * @returns {LegacyStores}
 */
export function createNewTabLegacyStores(kernel, host, storageState) {
  const facade = createStorageFacade(kernel, { openDatabase: storageState });
  /**
   * @param {readonly (keyof StorageFacade)[]} calls
   * @returns {Record<string, (...args: any[]) => any>}
   */
  const only = calls => Object.fromEntries(calls.map(call => [call, facade[call]]));
  return Object.freeze({
    searchIndex: Object.freeze(only(LEGACY_STORE_CALLS.searchIndex)),
    graph: Object.freeze(only(LEGACY_STORE_CALLS.graph)),
    sync: Object.freeze({
      ...only(LEGACY_STORE_CALLS.sync),
      ...createHolderSettings(host.settings, SYNC_SETTING_KEYS),
    }),
  });
}

/**
 * The settings the `Storage` global's shell reads and writes (js/storage.js): llm.js's
 * provider settings, and the WebDAV config App's reconnect reads
 */
export const STORAGE_SHELL_SETTING_KEYS = Object.freeze([...PROVIDER_SETTING_KEYS, 'syncWebdavConfig']);

/**
 * Connects js/storage.js's shell, the `Storage` global llm.js and App's reconnect still call,
 * to the tab's kernel (#17 PR 4b): the facade's calls, as the handles make them, and the
 * settings of the holders that call the global, through their accessor (holder-settings.js).
 * The root connects it before App starts, so no call reaches it unconnected.
 * @param {Client} kernel
 * @param {Pick<NewTabHost, 'settings' | 'storage'>} host
 * @param {Pick<StorageState, 'openState' | 'missingStores'>} storageState - the tab's database, as its adapter opened it
 */
export function connectNewTabStorage(kernel, host, storageState) {
  const facade = createStorageFacade(kernel, { openDatabase: storageState });
  host.storage.connect(
    Object.freeze({ ...facade, ...createHolderSettings(host.settings, STORAGE_SHELL_SETTING_KEYS) }),
  );
}

/**
 * Start the new tab, as app.js's bootstrap did: App gets the tab's client, its document
 * client, its settings client, its AI port, its note list, its failure events, its
 * removeNotes, its database's state and recovery, its import's backup check, the narrow
 * handles the search index, the graph view, and sync go through, on the same client, the
 * indexer's starter (./workers.js), and the page's loader (js/runtime/lazy.js). Nothing puts it on the
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
    const kernel = createNewTabPageClient(adapter);
    const noteList = createNewTabNoteList(kernel);
    /** @type {NewTabApp | null} */
    let built = null;
    const storageState = createNewTabStorageState(adapter);
    const stores = createNewTabLegacyStores(kernel, host, storageState);
    connectNewTabStorage(kernel, host, storageState);
    const events = createNewTabFailureEvents();
    const app = new page.App({
      kernel,
      documentClient: createNewTabDocumentClient(kernel, adapter),
      settings: createNewTabSettingsClient(kernel, host),
      ai: createAIPort(),
      noteList,
      events,
      removal: createNewTabRemoval(kernel, noteList, () => built),
      storageState,
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
