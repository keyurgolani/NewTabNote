/**
 * Popup's composition root (#12, docs/adr/0001-kernel-stack.md). js/popup.js lists notes,
 * reads whether to show the day's summary, and saves its quick note through this client.
 */

import { createIndexedDbReader } from '../adapters/indexeddb/reader.js';
import { POPUP_HANDLERS } from '../core/application/handlers-popup.js';
import { UnavailableError, unavailable } from '../core/contracts/outcomes.js';
import { applyingCloseDrafts, pageDrafts } from './close-drafts.js';
import { kernelClient, pageHost } from './host.js';

/** @typedef {import('./host.js').PageHost} PageHost */
/** @typedef {import('./host.js').Client} Client */
/** @typedef {import('./close-drafts.js').Applier} Applier */
/** @typedef {import('../adapters/indexeddb/reader.js').IndexedDbReader} IndexedDbReader */
/** @typedef {import('../core/ports/repository.js').KernelAdapter} KernelAdapter */
/** @typedef {import('../core/ports/runtime.js').Timers} Timers */
/** @typedef {import('../core/application/journaling.js').JournalingLocks} JournalingLocks */
/** @typedef {import('../core/application/journaling.js').JournalingOptions} JournalingOptions */
/** @typedef {import('../core/contracts/commands.js').Command} Command */
/** @typedef {import('../core/contracts/outcomes.js').Outcome} Outcome */
/** @typedef {import('../core/contracts/outcomes.js').BulkOutcome} BulkOutcome */
/** @typedef {typeof import('./popup-send-chunk.js')} SendChunk */
/** @typedef {import('./popup-send-chunk.js').PopupRuntime} PopupRuntime */

/** How long Popup's start waits for its apply of closing tabs' edits before it reads what's stored (Q11) */
export const POPUP_APPLY_WAIT_MS = 2000;

/**
 * What Popup's root runs on: a page's host, with what its writes need, the page's chrome.runtime,
 * the manifest's version and the Web Locks its journal holds its owner lock in, and the timers its
 * start's wait runs on, the page's own unless a test passes others. With no runtime, a write
 * answers as one that can't reach the coordinator does.
 * @typedef {PageHost & {
 *   runtime?: PopupRuntime,
 *   extensionVersion?: string,
 *   locks?: JournalingLocks | null,
 *   timers?: Timers,
 * }} PopupHost
 */

/** @type {Timers} the page's own */
const PAGE_TIMERS = Object.freeze({
  set: (callback, ms) => setTimeout(callback, ms),
  clear: handle => clearTimeout(/** @type {ReturnType<typeof setTimeout>} */ (handle)),
});

/**
 * The page's own host
 * @returns {PopupHost}
 */
export function popupHost() {
  let extensionVersion = '';
  try {
    extensionVersion = globalThis.chrome.runtime.getManifest().version;
  } catch {
    // No manifest, no version to say: the router refuses the hello
  }
  return {
    ...pageHost(),
    runtime: /** @type {PopupRuntime | undefined} */ (globalThis.chrome?.runtime),
    extensionVersion,
    locks: /** @type {JournalingLocks | null} */ (/** @type {unknown} */ (globalThis.navigator?.locks || null)),
  };
}

/**
 * #17's reader as the kernel's adapter, for Popup's table of queries alone. Nothing that writes is
 * there: the kernel refuses a command its table doesn't hold before it recalls or commits anything
 * (kernel.js), so nothing reaches the stand-ins, and each answers as an adapter without it does.
 * @param {IndexedDbReader} reader
 * @returns {KernelAdapter & {open(): Promise<void>}}
 */
function readsOnly(reader) {
  const noExport = () => Promise.reject(new UnavailableError('adapter', 'backups-need-legacy-storage', false));
  return Object.freeze({
    name: reader.name,
    flags: reader.flags,
    open: reader.open,
    read: reader.read,
    readSettings: reader.readSettings,
    ledger: reader.ledger,
    recall: () => undefined,
    commit: () => Promise.resolve({ outcome: unavailable('adapter', 'adapter-failed', false), replayed: false }),
    exportBackup: noExport,
    exportData: noExport,
  });
}

/**
 * Popup's writes (rule 3). The send chunk starts loading at the root's start (Q9). Each command
 * waits for it, then for its journal's owner lock, since the journal sends a command unjournaled
 * until it holds it, and then goes, first to last, so no later command passes an earlier one. A
 * chunk that can't load or start answers each unavailable, as one that can't reach the coordinator
 * is, `reload-required`: nothing went, and only a reload can load it.
 * @param {() => Promise<SendChunk>} load
 * @param {Parameters<SendChunk['popupWrites']>[0]} options
 * @returns {(command: Command, options?: JournalingOptions) => Promise<Outcome | BulkOutcome>}
 */
function heldWrites(load, options) {
  const writes = (async () => {
    const started = (await load()).popupWrites(options);
    await started.ready;
    return started;
  })();
  // Each command's own wait answers for a chunk that couldn't load
  writes.catch(() => {});
  return (command, journaling) =>
    writes.then(
      started => started.execute(command, journaling),
      () => unavailable('coordinator', 'reload-required', false),
    );
}

/**
 * Resolves once `done` does, which never rejects, or `ms` from now on `timers`, whichever is first
 * @param {Promise<unknown>} done
 * @param {Timers} timers
 * @param {number} ms
 * @returns {Promise<void>}
 */
const within = (done, timers, ms) =>
  new Promise(resolve => {
    const handle = timers.set(resolve, ms);
    done.then(() => {
      timers.clear(handle);
      resolve();
    });
  });

/**
 * Popup's client (#35 slice 4b-2). Its reads stay in the page, on #17's read-only reader (Q15),
 * which opens the database as it is and makes none. With no database, or one below this build's
 * version, it waits up to 5 seconds for the worker's migration run first (Q12). It answers
 * `newer-schema` for a database a newer build upgraded, and `reload-required` once the worker
 * upgrades it under the page. Its kernel runs only the two queries js/popup.js sends.
 *
 * Its writes, the quick note and the apply of a closing tab's edit (close-drafts.js, #33), go to
 * the worker over #13's port, through the send chunk `send` loads (heldWrites). When the page holds
 * an edit, whenReady waits for its apply, with the applier `load` hands over, at most
 * POPUP_APPLY_WAIT_MS once the reader is open (Q11), since a cold worker that migrates can take
 * its 5 seconds. Popup reads what's stored then, and `applied` answers once the apply is done.
 * @param {PopupHost} [host]
 * @param {ReturnType<typeof pageDrafts>} [drafts]
 * @param {() => Promise<Applier>} [load]
 * @param {() => Promise<SendChunk>} [send]
 */
export function createPopupClient(
  host = popupHost(),
  drafts = pageDrafts(),
  load = () => import('./close-drafts-applier.js'),
  send = () => import('./popup-send-chunk.js'),
) {
  const { indexedDB, settings, awaitUpgrade } = host;
  const reader = createIndexedDbReader({ indexedDB, settings, awaitUpgrade });
  const reads = kernelClient({ adapter: readsOnly(reader), surface: 'popup', handlers: POPUP_HANDLERS });
  const execute = heldWrites(send, {
    reads,
    runtime: /** @type {PopupRuntime} */ (host.runtime),
    extensionVersion: host.extensionVersion ?? '',
    indexedDB,
    ledger: reader.ledger,
    locks: host.locks ?? null,
    storage: drafts.storage,
  });
  const client = applyingCloseDrafts(
    /** @type {Client} */ (/** @type {unknown} */ (Object.freeze({ ...reads, execute }))),
    drafts,
    { load },
  );
  const timers = host.timers || PAGE_TIMERS;
  /** @type {ReturnType<Client['whenReady']> | undefined} */
  let ready;
  const whenReady = () =>
    (ready ||= reads.whenReady().then(failure => {
      if (failure) return failure;
      return within(client.applied(), timers, POPUP_APPLY_WAIT_MS).then(() => reads.whenReady());
    }));
  return Object.freeze({ ...client, whenReady });
}
