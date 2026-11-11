/**
 * The new tab's composition root (#12, docs/adr/0001-kernel-stack.md). It builds the tab's
 * kernel, on #17's read-only reader since #35 slice 4d, which sends its writes to the worker over
 * #13's port, and, in place of the bootstrap at the end of js/app.js, constructs App with its
 * client, the document client its editors read and write through, and the AI port its editors and
 * note jobs call the provider through. js/main.js's boot() calls startNewTab() with the page's
 * loader, once the boot root has loaded the workspace chunk (#27 slice 3).
 */

import { createAIPort } from '../../services/ai-port.mjs';
import { exportFile, exportObject, readExport, validateBackup } from '../adapters/indexeddb/backup-file.js';
import { settingsFailureOf } from '../adapters/indexeddb/failures.js';
import { exportPoint, exportablePointRecord } from '../adapters/indexeddb/legacy-export.js';
import { exportRawStores } from '../adapters/indexeddb/raw-export.js';
import { createIndexedDbReader } from '../adapters/indexeddb/reader.js';
import { settingKey } from '../adapters/indexeddb/settings.js';
import { createCommitFeed } from '../core/application/feed.js';
import { NEWTAB_HANDLERS } from '../core/application/handlers-newtab.js';
import { createNoteList } from '../core/application/note-list.js';
import { BULK_ACTIONS, COMMANDS } from '../core/contracts/commands.js';
import { UnavailableError, unavailable, unavailableFrom } from '../core/contracts/outcomes.js';
import {
  DRAFTS_LOCK,
  DRAFT_PREFIX,
  SAVED_UNTOLD_KEY,
  UNTOLD_KEY,
  recoveredIdOf,
} from '../core/domain/close-draft-keys.js';
import { systemClock } from '../core/ports/runtime.js';
import { closeDraftWriter } from './close-draft-writer.js';
import { applyingCloseDrafts, holdsKeys, pageDrafts } from './close-drafts.js';
import { createDocumentClient } from './document.js';
import { createSettingsClient } from './settings.js';
import { PROVIDER_SETTING_KEYS, SYNC_SETTING_KEYS, createHolderSettings } from './holder-settings.js';
import { chromeSettingsChanges, kernelClient, pageHost, wakeWorkerToPurge } from './host.js';
import { lazyFailureEvents } from './lazy-failure-events.js';
import { failingFast } from './page-reads.js';
import { createNoteRemoval } from './removal.js';
import { createStorageFacade } from './storage-facade.js';
import { startIndexer } from './workers.js';

/** @typedef {import('./host.js').Client} Client */
/** @typedef {import('./host.js').LegacyStorage} LegacyStorage */
/** @typedef {import('./host.js').PageHost} PageHost */
/** @typedef {import('./settings.js').SettingsChanges} SettingsChanges */
/** @typedef {import('../adapters/indexeddb/adapter.js').SettingsStore} SettingsStore */
/** @typedef {import('../adapters/indexeddb/reader.js').IndexedDbReader} IndexedDbReader */
/** @typedef {import('../core/ports/repository.js').KernelAdapter} KernelAdapter */
/** @typedef {import('../core/application/journaling.js').JournalingLocks} JournalingLocks */
/** @typedef {import('../core/application/journaling.js').JournalingOptions} JournalingOptions */
/** @typedef {import('../core/contracts/commands.js').Command} Command */
/** @typedef {import('../core/contracts/outcomes.js').Outcome} Outcome */
/** @typedef {import('../core/contracts/outcomes.js').BulkOutcome} BulkOutcome */
/** @typedef {typeof import('./newtab-send-chunk.js')} SendChunk */
/** @typedef {import('./newtab-send-chunk.js').NewTabRuntime} NewTabRuntime */
/** @typedef {import('./document.js').DocumentClient} DocumentClient */
/** @typedef {import('./settings.js').SettingsClient} SettingsClient */
/** @typedef {import('../../services/ai-port.mjs').AIPort} AIPort */
/** @typedef {import('../core/application/note-list.js').NoteList} NoteList */
/** @typedef {ReturnType<typeof lazyFailureEvents>} PageFailureEvents */
/** @typedef {import('./removal.js').NoteRemoval} NoteRemoval */
/** @typedef {import('./removal.js').RemovalPorts} RemovalPorts */
/** @typedef {import('./storage-facade.js').StorageFacade} StorageFacade */
/** @typedef {import('./close-drafts.js').Applier} Applier */
/**
 * The new tab's applier: the one every page has, and the toasts' reads, which a test's applier
 * may leave out, and then the new tab tells nothing
 * @typedef {Applier & Partial<Pick<typeof import('../core/application/close-drafts.js'), 'untoldToasts'>>} NewTabApplier
 */
/**
 * The new tab's client: the one applyingCloseDrafts answers, whose commands take what they tell the
 * journal, and the toasts for what its apply took from the untold lists, none when there was
 * nothing to tell
 * @typedef {ReturnType<typeof applyingCloseDrafts> & {
 *   execute: (command: Command, options?: JournalingOptions) => Promise<Outcome | BulkOutcome>,
 *   closeDraftToasts: () => Promise<string[]>,
 * }} NewTabPageClient
 */
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
 * chrome.storage.local, and its wait on the worker's run (Q12), with where it hears of settings
 * changes and js/storage.js's shell, the `Storage` global, which the root connects to the tab's
 * kernel (connectNewTabStorage, #17 PR 4b). Its writes take the page's chrome.runtime, the
 * manifest's version and the Web Locks its journal holds its owner lock in (#35 slice 4d), and the
 * idle its send chunk loads at, the page's own unless a test passes another. With no runtime, a
 * write answers as one that can't reach the coordinator does.
 * @typedef {PageHost & {
 *   locks: JournalingLocks | null,
 *   changes: SettingsChanges,
 *   storage: LegacyStorage,
 *   runtime?: NewTabRuntime,
 *   extensionVersion?: string,
 *   requestIdle?: (callback: () => void, options: {timeout: number}) => void,
 * }} NewTabHost
 */

/**
 * The new tab's host, from the page's globals, each read when a call reaches it
 * @returns {NewTabHost}
 */
export function newTabHost() {
  let extensionVersion = '';
  try {
    extensionVersion = globalThis.chrome.runtime.getManifest().version;
  } catch {
    // No manifest, no version to say: the router refuses the hello
  }
  return {
    ...pageHost(),
    locks: /** @type {JournalingLocks | null} */ (/** @type {unknown} */ (globalThis.navigator?.locks || null)),
    changes: chromeSettingsChanges(),
    storage: /** @type {LegacyStorage} */ (/** @type {{Storage?: unknown}} */ (globalThis).Storage),
    runtime: /** @type {NewTabRuntime | undefined} */ (globalThis.chrome?.runtime),
    extensionVersion,
  };
}

/** The export reads the new tab's reader runs (backup-file.js), which write nothing */
const EXPORT_READS = Object.freeze({ readExport, exportFile, exportObject });

/**
 * The new tab's reader, #17's read-only one (#35 slice 4d, rule 1), opened as the database is on
 * disk, as Popup's is (Q3): since #17 PR 1b only the service worker upgrades it, so a page that
 * finds none, or one below this build's version, waits up to 5 seconds on the worker's run first.
 * A database a newer build upgraded is `newer-schema`, and one without its notes or blocks
 * `missing-core-stores`, as Storage refused them. It runs the export reads on its connection. It
 * makes no copy of a database that lacks a store and runs no startup maintenance: the worker's
 * open does both (rules 8 and 9).
 * @param {Pick<NewTabHost, 'indexedDB' | 'settings' | 'awaitUpgrade'>} host
 * @returns {IndexedDbReader}
 */
export function createNewTabReader(host) {
  return createIndexedDbReader({
    indexedDB: host.indexedDB,
    settings: host.settings,
    awaitUpgrade: host.awaitUpgrade,
    requireCore: true,
    exports: EXPORT_READS,
  });
}

/**
 * The new tab's reader as the kernel's adapter, for its table of queries and its session's write
 * (handlers-newtab.js, rule 1). Its commit takes a settings effect of area `session` alone, through
 * the page's settings handle (rule 2), and anything else answers `adapter-failed`, as Popup's reads
 * adapter does (page-reads.js). It isn't exported, so nothing takes it for a whole adapter: every
 * exported one runs the kernel-adapter suite (test/kernel/conformance-inventory.mjs).
 * @param {IndexedDbReader} reader
 * @param {Pick<SettingsStore, 'set'>} settings
 * @returns {KernelAdapter & {open(): Promise<void>}}
 */
function newTabReads(reader, settings) {
  const noExport = () => Promise.reject(new UnavailableError('adapter', 'backups-need-legacy-storage', false));
  return Object.freeze({
    name: reader.name,
    // The export queries run where the reader exports
    flags: Object.freeze({ ...reader.flags, backups: Boolean(reader.exportBackup) }),
    open: reader.open,
    read: reader.read,
    readSettings: reader.readSettings,
    ledger: reader.ledger,
    recall: () => undefined,
    commit: work => {
      const { effect } = work;
      if (effect.kind !== 'settings' || effect.area !== 'session') {
        return Promise.resolve({ outcome: unavailable('adapter', 'adapter-failed', false), replayed: false });
      }
      const items = Object.fromEntries(
        Object.entries(effect.values).map(([key, value]) => [settingKey('session', key), value]),
      );
      return Promise.resolve()
        .then(() => settings.set(items))
        .then(
          () => ({ outcome: work.done(), replayed: false }),
          error => ({ outcome: unavailableFrom(settingsFailureOf(error, 'write')), replayed: false }),
        );
    },
    exportBackup: reader.exportBackup || noExport,
    exportData: /** @type {KernelAdapter['exportData']} */ (reader.exportData || noExport),
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
 * The wake is best effort, and never changes the outcome. What a command tells the journal goes
 * with it.
 * @param {Client} client
 * @param {() => void} wake
 * @returns {Client}
 */
export function withPurgeWake(client, wake) {
  return Object.freeze({
    ...client,
    execute: /** @type {Client['execute']} */ (
      /** @type {unknown} */ (
        async (/** @type {Command} */ command, /** @type {any} */ options) => {
          const outcome = await client.execute(command, options);
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
 * waits for it. An applier that can't load can't clear, so the delete doesn't run: it answers
 * `reload-required`, as a page whose storage went does, and the UI tells it so. Run anyway, it
 * would leave an untold entry naming its note, which no later start drops (the review's D1). What
 * a command tells the journal goes with it.
 * @param {Client} client
 * @param {{storage: DraftStorage | undefined, locks: DraftLocks | null, load: () => Promise<Applier>, logger?: {warn: (event: string, detail: Record<string, unknown>) => void}}} drafts
 * @returns {Client}
 */
export function withCloseDraftClears(client, { storage, locks, load, logger = clearLogger }) {
  /** @param {import('../core/contracts/commands.js').Command} command */
  const run = async command => {
    /** @type {DraftStore} */
    let store;
    try {
      store = (await load()).closeDraftStore(storage);
    } catch (error) {
      logger.warn('close-drafts-not-cleared', { error });
      return unavailable('storage', 'reload-required', false);
    }
    const outcome = /** @type {import('../core/contracts/outcomes.js').Outcome | import('../core/contracts/outcomes.js').BulkOutcome} */ (
      await client.execute(command)
    );
    const ids = notesDeletedBy(outcome);
    if (ids.length > 0) store.clearNotes(ids);
    return outcome;
  };
  return Object.freeze({
    ...client,
    execute: /** @type {Client['execute']} */ (
      /** @type {unknown} */ (
        (/** @type {Command} */ command, /** @type {any} */ options) => {
          if (!DELETING_COMMANDS.includes(command.type)) return client.execute(command, options);
          const named = notesNamedBy(command);
          if (!(named ? holdsKeysFor(storage, named) : holdsNoteKeys(storage))) return client.execute(command, options);
          return locks ? locks.request(DRAFTS_LOCK, { mode: 'exclusive' }, () => run(command)) : run(command);
        }
      )
    ),
  });
}

/**
 * The close-time drafts' applier, close-drafts-applier.js with the `close-drafts-chunk` chunk
 * under it, which the new tab imports only when its localStorage gives it work, as Popup and Side
 * Panel do (close-drafts.js), with the reads its toasts make
 * @returns {Promise<NewTabApplier>}
 */
const loadCloseDrafts = () => import('./close-drafts-applier.js');

/** How long after the page's first read its send chunk may wait for the page to go idle (Q6 a) */
const SEND_IDLE_CAP_MS = 2000;

/**
 * What the reader's openState says once its connection is gone: closed for another context's
 * upgrade, or by Chrome. A reader still opening, or one whose open failed, says neither.
 */
const GONE = Object.freeze(['version-changed', 'closed-by-browser']);

/** Tells of a commit-feed listener that threw, with the aggregate and ids, never a payload */
const feedLogger = Object.freeze({
  warn: (/** @type {string} */ event, /** @type {Record<string, unknown>} */ detail) =>
    console.warn(`NewTabNote kernel: ${event}`, detail),
});

/**
 * The new tab's writes (rule 3). The send chunk loads at the page's first command, or at its idle
 * once its first read is in, 2 seconds at most, whichever comes first (Q6 a). Each command waits
 * for it, then for the journal's owner lock, since the journal sends a command unjournaled until it
 * holds it, and then goes, first to last, so no later command passes an earlier one. A chunk that
 * can't load or start answers each unavailable, as one that can't reach the coordinator is,
 * `reload-required`: nothing went, and only a reload can load it.
 * @param {() => Promise<SendChunk>} load
 * @param {Parameters<SendChunk['newTabWrites']>[0]} options
 * @param {((callback: () => void, options: {timeout: number}) => void) | undefined} requestIdle
 *   the page's idle callback. A page without one, as in Node, loads the chunk at its first command.
 */
function heldWrites(load, options, requestIdle) {
  /** @type {Promise<ReturnType<SendChunk['newTabWrites']>> | undefined} */
  let writes;
  const start = () => {
    if (!writes) {
      writes = (async () => {
        const started = (await load()).newTabWrites(options);
        await started.ready;
        return started;
      })();
      // Each command's own wait answers for a chunk that couldn't load
      writes.catch(() => {});
    }
    return writes;
  };
  /** @type {(() => void) | undefined} the ask for the page's idle, made once, when its first read is in */
  let idle = () => {
    try {
      requestIdle?.(start, { timeout: SEND_IDLE_CAP_MS });
    } catch {
      // The first command loads it
    }
  };
  return {
    /** @type {(command: Command, journaling?: JournalingOptions) => Promise<Outcome | BulkOutcome>} */
    execute: (command, journaling) =>
      start().then(
        started => started.execute(command, journaling),
        () => unavailable('coordinator', 'reload-required', false),
      ),
    /** @type {(request: {type: string}) => Promise<unknown>} #280's probe: a query over the writes' client */
    query: request =>
      start().then(
        started => started.client.query(request),
        () => ({ kind: 'failed', cause: 'unavailable', code: 'reload-required' }),
      ),
    /** @param {Promise<unknown>} answer - the page's first read */
    read: answer => {
      if (idle) answer.then(idle, idle);
      idle = undefined;
    },
  };
}

/**
 * The client the new tab's root hands out (#35 slice 4d). Its queries run in the page, on #17's
 * read-only reader `reader` (createNewTabReader), and so does its session's write, which commits
 * through the page's settings handle (rules 1 and 2). Every other command goes to the worker over
 * #13's port as `newtab`, through the send chunk `send` loads (heldWrites), journaled as the
 * catalog says, in the order the page sends them (rule 3). Each committed reply feeds the page's
 * commit feed, so the note list follows the tab's own changes: a command's ids under its
 * aggregate, and each committed item of a bulk reply under its item's (rule 5). Once the reader's
 * connection is gone, for another context's upgrade or by Chrome, a command answers
 * `reload-required`, unsent, while what the close's flush sent first still goes (rule 12).
 *
 * As before the move, it wakes the worker to purge after each delete for good (withPurgeWake),
 * holds the close-time drafts' lock around each command that can delete for good and clears what
 * the deleted notes left of them (withCloseDraftClears), and its whenReady resolves once the
 * closing tabs' edits are applied, so the note list's first read and App's start come after them
 * (#33), however long their sends take (Q7). Like Popup and Side Panel, the new tab loads the
 * applier only when its localStorage holds a draft, 1.4.3's catch-up key or an untold list, which
 * it reads for its toasts (holdsNewTabWork), so its start loads none of it (#147's heap, the
 * lead's call). Its apply also takes both untold lists, under the drafts' lock, so of two new tabs
 * starting together one tells each entry (Q-B7), and `closeDraftToasts` answers the toasts for
 * what they held once the apply is done (V3).
 *
 * Two runs send that apply: the start's, and the journal's apply of the editor saves closed pages
 * left, which the send chunk starts. Each stops sending once the worker didn't take one of its
 * commands (failingFast, #246), so a worker that doesn't answer holds the drafts' lock one wait
 * per run. The page's own commands never stop. An entry its journal couldn't take is
 * `journal.append-failed` on the tab's failure events (#35 slice 4a).
 * @param {IndexedDbReader} reader
 * @param {Pick<NewTabHost, 'settings' | 'indexedDB' | 'locks' | 'runtime' | 'extensionVersion' | 'requestIdle'>} host
 * @param {{drafts?: ReturnType<typeof pageDrafts>, wake?: () => void, load?: () => Promise<NewTabApplier>, send?: () => Promise<SendChunk>, events?: import('./host.js').PageEvents}} [page]
 *   the page's drafts and its wake, from its globals, the applier's load, the send chunk's, and
 *   the tab's failure events (createNewTabFailureEvents)
 * @returns {NewTabPageClient}
 */
export function createNewTabPageClient(
  reader,
  host,
  {
    drafts = pageDrafts(),
    wake = () => wakeWorkerToPurge(),
    load = loadCloseDrafts,
    send = () => import('./newtab-send-chunk.js'),
    events,
  } = {},
) {
  const reads = kernelClient({
    adapter: newTabReads(reader, host.settings),
    surface: 'newtab',
    handlers: NEWTAB_HANDLERS,
  });
  const feed = createCommitFeed(feedLogger);
  /** @type {(command: Command, outcome: Outcome | BulkOutcome) => void} */
  const published = (command, outcome) => {
    try {
      if (outcome.kind === 'bulk') {
        const type =
          BULK_ACTIONS[/** @type {keyof typeof BULK_ACTIONS} */ (/** @type {{action?: unknown}} */ (command).action)];
        for (const { outcome: item } of outcome.items) {
          if (item.kind === 'committed' && item.changedIds.length > 0) {
            feed.publish({ aggregate: COMMANDS[type].aggregate, ids: item.changedIds });
          }
        }
      } else if (outcome.kind === 'committed' && outcome.changedIds.length > 0) {
        feed.publish({
          aggregate: COMMANDS[/** @type {keyof typeof COMMANDS} */ (command.type)].aggregate,
          ids: outcome.changedIds,
        });
      }
    } catch {
      // The commit landed, so its outcome stands
    }
  };
  const writes = heldWrites(
    send,
    {
      reads,
      runtime: /** @type {NewTabRuntime} */ (host.runtime),
      extensionVersion: host.extensionVersion ?? '',
      indexedDB: host.indexedDB,
      ledger: reader.ledger,
      locks: host.locks ?? null,
      storage: drafts.storage,
      events,
      failingFast,
      published,
    },
    host.requestIdle || globalThis.requestIdleCallback,
  );
  /** @type {(command: Command, options?: JournalingOptions) => Promise<Outcome | BulkOutcome>} */
  const execute = (command, options) => {
    if (GONE.includes(reader.openState())) return Promise.resolve(unavailable('storage', 'reload-required', false));
    if (Object.hasOwn(NEWTAB_HANDLERS.commands, command.type)) return reads.execute(command);
    return writes.execute(command, options);
  };
  /** @type {Client['query']} */
  const query = request => {
    // #280's probe: the status lines' trust.status goes to the worker over #13's port
    if (/** @type {string} */ (request.type) === 'trust.status') return /** @type {any} */ (writes.query(request));
    const answer = reads.query(request);
    writes.read(answer);
    return answer;
  };
  /** @type {Client['subscribe']} */
  const subscribe = listener => {
    const stops = [reads.subscribe(listener), feed.subscribe(listener)];
    return () => stops.forEach(stop => stop());
  };
  const base = /** @type {Client} */ (/** @type {unknown} */ (Object.freeze({ ...reads, execute, query, subscribe })));
  const client = withCloseDraftClears(withPurgeWake(base, wake), {
    storage: drafts.storage,
    locks: drafts.locks,
    load,
  });
  /** @type {NewTabApplier | null} The applier the apply loaded, which the toasts' reads come from */
  let loaded = null;
  /** @returns {Promise<Applier>} the applier, its apply taking the untold lists too */
  const telling = async () => {
    const applier = await load();
    loaded = applier;
    return {
      ...applier,
      applyCloseDrafts: options => applier.applyCloseDrafts({ ...options, tell: true }),
    };
  };
  // The start's run sends applyCloseDraft alone, which answers an Outcome
  const run = failingFast(/** @type {(command: Command) => Promise<Outcome>} */ (execute));
  const started = applyingCloseDrafts(
    /** @type {Client} */ (/** @type {unknown} */ (Object.freeze({ ...client, execute: run }))),
    drafts,
    { load: telling, holds: holdsNewTabWork },
  );
  // The page's own commands never fail fast: only a run does
  const page = /** @type {NewTabPageClient} */ (
    /** @type {unknown} */ (Object.freeze({ ...started, execute: client.execute }))
  );
  return Object.freeze({
    ...page,
    async closeDraftToasts() {
      const result = await page.applied();
      const untoldToasts = loaded && loaded.untoldToasts;
      if (!result || !result.told || !untoldToasts) return [];
      /** @param {string} noteId */
      const noteOf = async noteId => {
        const state = await client.query({ type: 'getNote', noteId });
        return state.kind === 'ready' ? state.data.note : null;
      };
      try {
        return await untoldToasts({ noteOf, told: result.told });
      } catch (error) {
        clearLogger.warn('close-draft-toasts-not-read', { error });
        return [];
      }
    },
  });
}

/**
 * The document client the new tab's editors read and write through, on `kernel`. Before the
 * reader's connection closes for another context's upgrade, it has them write what they have
 * pending, so typing from the last half second isn't lost. At the page's own close, they write
 * each edit they haven't seen commit as a close-time draft, through the writer on the page's
 * localStorage (close-draft-writer.js, #33), which the next start applies.
 * @param {Client} kernel
 * @param {Pick<IndexedDbReader, 'beforeClose' | 'openState'>} adapter - the reader the kernel reads on
 * @param {{storage?: DraftStorage | undefined}} [page] - the page's localStorage, from its globals
 * @returns {DocumentClient}
 */
export function createNewTabDocumentClient(kernel, adapter, { storage = pageDrafts().storage } = {}) {
  return createDocumentClient(kernel, {
    beforeConnectionCloses: flush => adapter.beforeClose(flush),
    connectionOpen: () => adapter.openState() === 'open',
    closeDrafts: closeDraftWriter({ storage, newId: () => kernel.ids.next() }),
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
 * @param {Pick<IndexedDbReader, 'openState' | 'missingStores' | 'upgraded'>} adapter - the reader the kernel reads on
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
    const reader = createNewTabReader(host);
    // Before the client, whose journal tells them of an entry it couldn't take (#35 slice 4a)
    const events = createNewTabFailureEvents();
    const kernel = createNewTabPageClient(reader, host, { events });
    const noteList = createNewTabNoteList(kernel);
    /** @type {NewTabApp | null} */
    let built = null;
    const storageState = createNewTabStorageState(reader);
    const stores = createNewTabLegacyStores(kernel, host, storageState);
    connectNewTabStorage(kernel, host, storageState);
    const app = new page.App({
      kernel,
      documentClient: createNewTabDocumentClient(kernel, reader),
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
