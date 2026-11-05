/**
 * What the composition roots share (#12, "Where the kernel runs"): the settings and the
 * storage host a page or the worker reads from its globals, the kernel each root builds on
 * its adapter, with the client it hands out, and the journal's shim on a page's client (#35
 * slice 3b, journalingClient).
 *
 * Loading this module touches no browser API, so a root can load before its page's or the
 * worker's globals exist, as js/background.js needs. Everything here reads them when it's
 * called.
 */

import { createKernel } from '../core/application/kernel.js';
import { COMMANDS } from '../core/contracts/commands.js';
import { createBaselinePolicy } from '../core/ports/policy.js';
import { systemClock } from '../core/ports/runtime.js';
import { randomIds } from './ids.js';

/** @typedef {import('../adapters/indexeddb/adapter.js').SettingsStore} SettingsStore */
/** @typedef {import('../core/application/kernel.js').KernelClient} KernelClient */
/** @typedef {import('../core/application/handlers.js').HandlerTable} HandlerTable */
/** @typedef {import('../core/contracts/surfaces.js').Surface} Surface */
/** @typedef {import('../core/ports/repository.js').KernelAdapter} KernelAdapter */
/** @typedef {import('../core/ports/runtime.js').Ids} Ids */
/** @typedef {import('../core/ports/runtime.js').Logger} Logger */
/** @typedef {import('../core/contracts/commands.js').Command} Command */
/** @typedef {import('../core/contracts/outcomes.js').Outcome} Outcome */
/** @typedef {import('../core/contracts/outcomes.js').BulkOutcome} BulkOutcome */
/** @typedef {import('../core/application/journaling.js').JournalingOptions} JournalingOptions */

/**
 * js/storage.js's shell, the `Storage` global llm.js and App's reconnect still call, which the
 * new tab's root connects to the tab's kernel (#17 PR 4b, newtab.js). TypeScript reads the
 * legacy `Storage` global as the DOM's Storage, so the root reads it through this.
 * @typedef {object} LegacyStorage
 * @property {(calls: Readonly<Record<string, (...args: any[]) => any>>) => void} connect
 */

/**
 * What a root hands its page or the worker: the kernel's calls, and `ids` for the ids a
 * command carries, made when the intent happens. #35 can point the calls at the background
 * coordinator without changing a caller.
 * @typedef {KernelClient & {ids: Ids}} Client
 */

/**
 * chrome.storage.local, read when a call reaches it
 * @returns {SettingsStore}
 */
export function chromeSettings() {
  return {
    get: keys => chrome.storage.local.get(keys),
    set: items => chrome.storage.local.set(items),
  };
}

/**
 * chrome.storage.local as the new tab's backup tasks use it (#17 PR 4a, backups.js): its get,
 * of every key too, its set, and its remove, which the automatic backup prunes its oldest with,
 * read when a call reaches it. Popup's and Side Panel's run no backup task, so they get
 * chromeSettings() alone.
 * @returns {import('../adapters/indexeddb/backups.js').BackupStore}
 */
export function chromeBackupSettings() {
  return {
    get: keys => chrome.storage.local.get(keys),
    set: items => chrome.storage.local.set(items),
    remove: keys => chrome.storage.local.remove(keys),
  };
}

/**
 * #13's settings.changed notice from chrome.storage.onChanged, as js/storage.js's
 * onSettingsChange gave it to the new tab until #17 PR 4a: the keys of each change to
 * chrome.storage.local's `setting_` keys, by name only, so no listener is handed a value, not
 * llmApiKey's either, and reads what it needs again. chrome.storage is read when a listener is
 * added, and the answer stops it.
 * @returns {import('./settings.js').SettingsChanges}
 */
export function chromeSettingsChanges() {
  return listener => {
    /**
     * @param {Record<string, unknown>} changes - chrome.storage's, whose values go no further
     * @param {string} areaName
     */
    const heard = (changes, areaName) => {
      if (areaName !== 'local') return;
      const keys = Object.keys(changes)
        .filter(key => key.startsWith('setting_'))
        .map(key => key.slice('setting_'.length));
      if (keys.length > 0) listener(Object.freeze({ type: 'settings.changed', keys: Object.freeze(keys) }));
    };
    const { onChanged } = chrome.storage;
    onChanged.addListener(heard);
    return () => onChanged.removeListener(heard);
  };
}

/**
 * What Popup's and Side Panel's storage runs on (#17 PR 1b: #17's IndexedDB adapter), read
 * from the page's globals unless a test passes it
 * @typedef {object} PageHost
 * @property {IDBFactory} indexedDB
 * @property {SettingsStore} settings
 * @property {() => Promise<unknown>} awaitUpgrade - the wait on the worker's migration run (#17, Q12)
 */

/**
 * The page's own storage host
 * @returns {PageHost}
 */
export function pageHost() {
  return { indexedDB: globalThis.indexedDB, settings: chromeSettings(), awaitUpgrade: () => waitForWorkerUpgrade() };
}

/** What a page sends to wake the service worker and hear its migration run's status (#17, Q12) */
export const MIGRATE_MESSAGE = 'storage.migrate';

/** How long a page waits on the worker's run before it opens what's there (#17, Q12) */
export const MIGRATE_WAIT_MS = 5000;

/**
 * What a page sends once it has deleted something for good, to have the service worker purge
 * it from the recovery points (#17 PR 2b). It carries no ids: the worker goes by the
 * tombstones the delete left, so the message only says when.
 */
export const PURGE_MESSAGE = 'storage.purge';

/**
 * Wakes the worker to purge, best effort: a worker that can't be reached purges at its next
 * start, since the tombstones stay pending until it does
 * @param {{runtime?: {sendMessage?: (message: unknown) => Promise<unknown>} | undefined}} [options]
 * @returns {void}
 */
export function wakeWorkerToPurge({ runtime = globalThis.chrome?.runtime } = {}) {
  try {
    if (!runtime || typeof runtime.sendMessage !== 'function') return;
    Promise.resolve(runtime.sendMessage({ type: PURGE_MESSAGE })).catch(() => {});
  } catch {
    // Nothing to do: the next worker start sweeps
  }
}

/**
 * A page that finds no database, or one below this build's version, before the worker's run
 * (#17, Q12): wake the worker with MIGRATE_MESSAGE, which it answers once its run has finished,
 * and wait for that answer, at most `waitMs`. Never rejects: a worker that can't be reached, or
 * doesn't answer in time, leaves the page to run on what's there.
 * @param {{runtime?: {sendMessage?: (message: unknown) => Promise<unknown>} | undefined, waitMs?: number}} [options]
 * @returns {Promise<void>}
 */
export function waitForWorkerUpgrade({ runtime = globalThis.chrome?.runtime, waitMs = MIGRATE_WAIT_MS } = {}) {
  return new Promise(resolve => {
    const timer = setTimeout(resolve, waitMs);
    const finish = () => {
      clearTimeout(timer);
      resolve();
    };
    try {
      if (!runtime || typeof runtime.sendMessage !== 'function') {
        finish();
        return;
      }
      Promise.resolve(runtime.sendMessage({ type: MIGRATE_MESSAGE })).then(finish, finish);
    } catch {
      finish();
    }
  });
}

/**
 * Reports a commit-feed listener that threw, and as an error a command or query the page sent
 * that its table doesn't hold. Its detail holds the aggregate, the ids, the surface, the type
 * and the error, never a payload.
 * @type {Logger}
 */
const consoleLogger = Object.freeze({
  warn: (event, detail) => console.warn(`NewTabNote kernel: ${event}`, detail),
  error: (event, detail) => console.error(`NewTabNote kernel: ${event}`, detail),
});

/**
 * One context's kernel on `adapter`, which starts opening now, and its client. Its caller is
 * `surface` with an id of its own, which the policy checks on every command and query, and it
 * runs the commands and queries `handlers` holds, the root's table of what its page sends
 * (core/application/handlers.js). `maintainOnOpen` runs startup maintenance before anything
 * else, as the new tab's and the worker's Storage.init did. `ready` is what the kernel waits
 * on before it runs anything, the adapter's open unless the root has more to open (the new
 * tab's). Every id it and its client make is a UUID (ids.js).
 * @param {{adapter: KernelAdapter & {open(): Promise<void>}, surface: Surface, handlers: HandlerTable, maintainOnOpen?: boolean, ready?: Promise<unknown>}} options
 * @returns {Client}
 */
export function kernelClient({ adapter, surface, handlers, maintainOnOpen = false, ready = adapter.open() }) {
  const kernel = createKernel({
    adapter,
    // On the catalog its table runs on: the shared one on every page, the worker's on the worker
    policy: createBaselinePolicy(handlers.catalog),
    caller: Object.freeze({ surface, contextId: `${surface}-${randomIds.next()}` }),
    handlers,
    ids: randomIds,
    clock: systemClock,
    logger: consoleLogger,
    ready,
    maintainOnOpen,
  });
  return Object.freeze({
    execute: kernel.execute,
    query: kernel.query,
    subscribe: kernel.subscribe,
    whenReady: kernel.whenReady,
    ids: randomIds,
  });
}

/**
 * A page's journal, once its chunk is in (composition/journal-chunk.js): its journaling, which
 * writes a journaled command's entry and then sends it
 * @typedef {{execute: (command: Command, send: Client['execute'], options?: JournalingOptions) => Promise<Outcome | BulkOutcome>}} PageJournal
 */

/**
 * A page's failure events (#20), as its root hands them to its journal
 * @typedef {{event(code: string, fields?: Record<string, unknown>, failure?: unknown): void}} PageEvents
 */

/**
 * The journal's chunk, as a root loads it
 * @template {Client} C
 * @typedef {{startPageJournal: (client: C, sessionId: string, surface: Surface, ports?: {events?: PageEvents}) => PageJournal}} JournalChunk
 */

/** How long after a page's first read its journal may wait for the page to go idle (the lead's bound) */
const JOURNAL_IDLE_CAP_MS = 2000;

/**
 * `client` with its journal (#35 slice 3b): the shim every page's root hands out. The journal's
 * chunk loads on the page's first journaled command, or at idle once its first read is in, with a
 * 2 s cap, whichever comes first, so no page's start holds it. No command waits for it: until it's
 * in, a command goes as it did before slice 3, unjournaled, which the close-time draft covers for
 * an editor's save, since a command held for it could go out after one sent later and write older
 * text over it (the lead's addition to 3b's plan). Once it's in, each command goes through the
 * journal, with what its caller tells of it (`options`). A chunk that can't load leaves the page
 * as it was. Its arguments come in order, and nothing of its own state is a property, so the
 * pages' start carries none of its names (the lead's byte cut).
 * @template {Client} C
 * @param {C} client
 * @param {Surface} surface
 * @param {() => Promise<JournalChunk<C>>} load the journal's chunk
 * @param {(callback: () => void, options: {timeout: number}) => void} [requestIdle] the page's idle
 *   callback, `globalThis.requestIdleCallback` from its root. A page without one, as in Node,
 *   loads its journal on its first journaled command alone.
 * @param {string} [sessionId] the page's, which its owner lock and entries name, new for each page
 *   load
 * @param {PageEvents} [events] the page's failure events, which hear of an entry its journal
 *   couldn't take (#35 slice 4a), on a page that has them
 * @returns {C & {execute: (command: Command, options?: JournalingOptions) => Promise<Outcome | BulkOutcome>}}
 */
export function journalingClient(client, surface, load, requestIdle, sessionId = randomIds.next(), events) {
  /** @type {PageJournal | undefined} */
  let journal;
  /** @type {Promise<void> | undefined} */
  let loading;
  // The chunk's load, once. One that can't load, or can't start, leaves the page unjournaled.
  const start = () => {
    loading ||= (async () => {
      try {
        journal = (await load()).startPageJournal(client, sessionId, surface, { events });
      } catch {
        // The page goes on as before slice 3
      }
    })();
  };
  /** @type {(() => void) | undefined} the ask for the page's idle, made once, when its first read is in */
  let idle = () => requestIdle?.(start, { timeout: JOURNAL_IDLE_CAP_MS });
  /** @type {(command: Command, options?: JournalingOptions) => Promise<Outcome | BulkOutcome>} */
  const execute = (command, options) => {
    if (journal) return journal.execute(command, client.execute, options);
    if (COMMANDS[/** @type {keyof typeof COMMANDS} */ (command.type)]?.journaled) start();
    return client.execute(command);
  };
  /** @type {C['query']} */
  const query = request => {
    const answer = client.query(request);
    if (idle) answer.then(idle, idle);
    idle = undefined;
    return answer;
  };
  return /** @type {C & {execute: typeof execute}} */ (
    /** @type {unknown} */ (Object.freeze({ ...client, execute, query }))
  );
}
