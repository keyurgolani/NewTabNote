/**
 * Side Panel's composition root (#12, docs/adr/0001-kernel-stack.md). js/sidepanel.js reads
 * the notes it summarizes through this client.
 */

import { createIndexedDbReader } from '../adapters/indexeddb/reader.js';
import { SIDEPANEL_HANDLERS } from '../core/application/handlers-sidepanel.js';
import { UnavailableError, unavailable } from '../core/contracts/outcomes.js';
import { applyingCloseDrafts, pageDrafts } from './close-drafts.js';
import { journalingClient, kernelClient, pageHost } from './host.js';

/** @typedef {import('./host.js').PageHost} PageHost */
/** @typedef {import('./host.js').Client} Client */
/** @typedef {import('./close-drafts.js').Applier} Applier */
/** @typedef {import('../adapters/indexeddb/reader.js').IndexedDbReader} IndexedDbReader */
/** @typedef {import('../adapters/messaging/runtime-port.js').Runtime} Runtime */
/** @typedef {import('../core/ports/repository.js').KernelAdapter} KernelAdapter */
/** @typedef {import('../core/ports/runtime.js').Timers} Timers */
/** @typedef {import('../core/contracts/commands.js').Command} Command */
/** @typedef {import('../core/contracts/outcomes.js').Outcome} Outcome */
/** @typedef {import('../core/messaging/client.js').Client} MessagingClient */
/** @typedef {typeof import('./sidepanel-send-chunk.js')} SendChunk */

/** How long Side Panel's start waits for its apply of closing tabs' edits before it reads what's stored (Q11) */
export const SIDEPANEL_APPLY_WAIT_MS = 2000;

/**
 * What Side Panel's root runs on: a page's host, with what its writes need, the page's
 * chrome.runtime and the manifest's version, the timers its start's wait runs on, and the idle that
 * starts its journal, the page's own unless a test passes others. With no runtime, a write answers
 * as one that can't reach the coordinator does.
 * @typedef {PageHost & {
 *   runtime?: Runtime,
 *   extensionVersion?: string,
 *   timers?: Timers,
 *   requestIdle?: (callback: () => void, options: {timeout: number}) => void,
 * }} SidePanelHost
 */

/** @type {Timers} the page's own */
const PAGE_TIMERS = Object.freeze({
  set: (callback, ms) => setTimeout(callback, ms),
  clear: handle => clearTimeout(/** @type {ReturnType<typeof setTimeout>} */ (handle)),
});

/**
 * The page's own host
 * @returns {SidePanelHost}
 */
export function sidePanelHost() {
  let extensionVersion = '';
  try {
    extensionVersion = globalThis.chrome.runtime.getManifest().version;
  } catch {
    // No manifest, no version to say: the router refuses the hello
  }
  return { ...pageHost(), runtime: /** @type {Runtime | undefined} */ (globalThis.chrome?.runtime), extensionVersion };
}

/**
 * #17's reader as the kernel's adapter, for Side Panel's table of queries alone, as Popup's root
 * has it. Nothing that writes is there: the kernel refuses a command its table doesn't hold before
 * it recalls or commits anything (kernel.js), so nothing reaches the stand-ins, and each answers
 * as an adapter without it does.
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
 * Side Panel's writes (rule 2). The send chunk loads at the first command, not at the start, so a
 * start with nothing to apply loads none of it (Q1). Each command waits for it, then goes, first
 * to last, so no later command passes an earlier one. A chunk that can't load or start answers
 * each unavailable, as one that can't reach the coordinator is, `reload-required`: nothing went,
 * and only a reload can load it (rule 7).
 * @param {() => Promise<SendChunk>} load
 * @param {Parameters<SendChunk['sidePanelSender']>[0]} options
 * @returns {(command: Command) => Promise<Outcome>}
 */
function heldSends(load, options) {
  /** @type {Promise<MessagingClient> | undefined} */
  let sender;
  return command => {
    sender ||= load().then(chunk => chunk.sidePanelSender(options));
    return sender.then(
      client => /** @type {Promise<Outcome>} */ (client.execute(command)),
      () => unavailable('coordinator', 'reload-required', false),
    );
  };
}

/**
 * One run of `send`'s commands, the start's apply or the journal's (Q5's b). Once one of them
 * answers that the worker didn't take it, unavailable from the coordinator, or unknown since its
 * answer didn't come in time, each later one answers at once, unsent: as the first did when it
 * was unavailable, and after an unknown one, unavailable with its code, since nothing went. What
 * each carried stays for the next start, and the run holds the drafts' lock one wait at most.
 * @param {(command: Command) => Promise<Outcome>} send
 * @returns {(command: Command) => Promise<Outcome>}
 */
function failingFast(send) {
  /** @type {Outcome | null} */
  let stopped = null;
  return async command => {
    if (stopped) return stopped;
    const outcome = await send(command);
    if (outcome.kind === 'unknown') stopped = unavailable('coordinator', outcome.code, true);
    else if (outcome.kind === 'unavailable' && outcome.cause === 'coordinator') stopped = outcome;
    return outcome;
  };
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
 * Side Panel's client (#35 slice 4c). Its reads stay in the page, on #17's read-only reader (Q15),
 * which opens the database as it is and makes none. With no database, or one below this build's
 * version, it waits up to 5 seconds for the worker's migration run first (Q12). It answers
 * `newer-schema` for a database a newer build upgraded, and `reload-required` once the worker
 * upgrades it under the page. Its kernel runs only the one query js/sidepanel.js sends.
 *
 * Its one write, the apply of a closing tab's edit (close-drafts.js, #33), goes to the worker over
 * #13's port, through the send chunk `send` loads at the first command (heldSends). Two runs send
 * it: the start's apply, and the journal's apply of the editor saves closed pages left, which
 * the journal's chunk `journal` loads at idle once the first read is in (host.js
 * journalingClient). Each stops sending once the worker didn't take one of its commands
 * (failingFast). The journal journals nothing here, since Side Panel sends no journaled command
 * (rule 4). When the page holds an edit, whenReady waits for its apply, with the applier `load`
 * hands over, at most SIDEPANEL_APPLY_WAIT_MS once the reader is open (rule 5), since a cold
 * worker that migrates can take its 5 seconds. Side Panel reads what's stored then, and `applied`
 * answers once the apply is done.
 * @param {SidePanelHost} [host]
 * @param {ReturnType<typeof pageDrafts>} [drafts]
 * @param {() => Promise<Applier>} [load]
 * @param {() => Promise<SendChunk>} [send]
 * @param {() => Promise<typeof import('./journal-chunk.js')>} [journal]
 */
export function createSidePanelClient(
  host = sidePanelHost(),
  drafts = pageDrafts(),
  load = () => import('./close-drafts-applier.js'),
  send = () => import('./sidepanel-send-chunk.js'),
  journal = () => import('./journal-chunk.js'),
) {
  const { indexedDB, settings, awaitUpgrade } = host;
  const reader = createIndexedDbReader({ indexedDB, settings, awaitUpgrade });
  const reads = kernelClient({ adapter: readsOnly(reader), surface: 'sidepanel', handlers: SIDEPANEL_HANDLERS });
  const sends = heldSends(send, {
    runtime: /** @type {Runtime} */ (host.runtime),
    extensionVersion: host.extensionVersion ?? '',
    ledger: reader.ledger,
  });
  const started = applyingCloseDrafts(
    /** @type {Client} */ (/** @type {unknown} */ (Object.freeze({ ...reads, execute: failingFast(sends) }))),
    drafts,
    { load },
  );
  const timers = host.timers || PAGE_TIMERS;
  /** @type {ReturnType<Client['whenReady']> | undefined} */
  let ready;
  const whenReady = () =>
    (ready ||= reads.whenReady().then(failure => {
      if (failure) return failure;
      return within(started.applied(), timers, SIDEPANEL_APPLY_WAIT_MS).then(() => reads.whenReady());
    }));
  const client = /** @type {typeof started} */ (
    /** @type {unknown} */ (Object.freeze({ ...started, whenReady, execute: failingFast(sends) }))
  );
  const chunk = /** @type {() => Promise<import('./host.js').JournalChunk<typeof client>>} */ (journal);
  return journalingClient(client, 'sidepanel', chunk, host.requestIdle || globalThis.requestIdleCallback);
}
