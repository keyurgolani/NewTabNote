/**
 * The new tab's composition root (#12, docs/adr/0001-kernel-stack.md). It builds the tab's
 * kernel and, in place of the bootstrap at the end of js/app.js, constructs App with its
 * client, the document client its editors read and write through, and the AI port its
 * editors and note jobs call the provider through. js/main.js calls startNewTab() once it has
 * imported app.js.
 */

import { createAIPort } from '../../services/ai-port.mjs';
import { exportPoint, exportablePointRecord } from '../adapters/indexeddb/legacy-export.js';
import { createLegacyAdapter } from '../adapters/legacy/adapter.js';
import { createNoteList } from '../core/application/note-list.js';
import { systemClock } from '../core/ports/runtime.js';
import { createDocumentClient } from './document.js';
import { kernelClient, legacyHost, wakeWorkerToPurge } from './host.js';
import { lazyFailureEvents } from './lazy-failure-events.js';
import { createNoteRemoval } from './removal.js';

/** @typedef {import('./host.js').Client} Client */
/** @typedef {import('./host.js').LegacyHost} LegacyHost */
/** @typedef {import('./document.js').DocumentClient} DocumentClient */
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
 * The legacy App class app.js puts on window, and the instance the controllers still read as
 * window.app until #12 slice 7 removes it
 * @typedef {object} NewTabPage
 * @property {new (options: {kernel: Client, documentClient: DocumentClient, ai: AIPort, noteList: NoteList, events: PageFailureEvents, removal: NoteRemoval, preUpdateCopy: PreUpdateCopy}) => NewTabApp} App
 * @property {unknown} [app]
 */

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
 * The new tab's kernel and its client. It opens the database as it is on disk (since #17 PR
 * 1b only the service worker upgrades it), waiting first on the worker's migration run when it
 * finds none or an older one, and runs startup maintenance before any command. Its connection
 * closes when the worker upgrades the database, so that upgrade never waits on this tab, and
 * from then on every command answers `reload-required`: the editor keeps its text and asks for
 * a reload.
 * @param {LegacyHost} [host]
 * @returns {Client}
 */
export function createNewTabClient(host = legacyHost()) {
  const adapter = createLegacyAdapter({ ...host, mode: 'versioned' });
  return kernelClient({ adapter, surface: 'newtab', maintainOnOpen: true });
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
 * Start the new tab when its DOM is ready, as app.js's bootstrap did: App gets the tab's
 * client, its document client, its AI port, its note list, its failure events, and its
 * removeNotes, and becomes window.app before init runs. The listener answers with init's
 * promise, which a page ignores and a test can wait for.
 * @returns {void}
 */
export function startNewTab() {
  document.addEventListener('DOMContentLoaded', () => {
    const page = /** @type {NewTabPage} */ (/** @type {unknown} */ (globalThis));
    const host = legacyHost();
    const kernel = withPurgeWake(createNewTabClient(host), () => wakeWorkerToPurge());
    const noteList = createNewTabNoteList(kernel);
    /** @type {NewTabApp | null} */
    let built = null;
    const app = new page.App({
      kernel,
      documentClient: createNewTabDocumentClient(kernel, host),
      ai: createAIPort(),
      noteList,
      events: createNewTabFailureEvents(),
      removal: createNewTabRemoval(kernel, noteList, () => built),
      preUpdateCopy: createPreUpdateCopy(),
    });
    built = app;
    page.app = app;
    return app.init().catch(error => {
      console.error('App initialization failed:', error);
    });
  });
}
