/**
 * What the composition roots share (#12, "Where the kernel runs"): the legacy storage and
 * settings a page or the worker loaded, and the kernel each root builds on its adapter, with
 * the client it hands out.
 *
 * Loading this module touches no browser API, so a root can load before its page's or the
 * worker's globals exist, as js/background.js needs. Everything here reads them when it's
 * called.
 */

import { createKernel } from '../core/application/kernel.js';
import { createBaselinePolicy } from '../core/ports/policy.js';
import { systemClock } from '../core/ports/runtime.js';
import { randomIds } from './ids.js';

/** @typedef {import('../adapters/legacy/adapter.js').LegacyStorage} LegacyStorage */
/** @typedef {import('../adapters/legacy/adapter.js').SettingsStore} SettingsStore */
/** @typedef {import('../core/application/kernel.js').KernelClient} KernelClient */
/** @typedef {import('../core/contracts/surfaces.js').Surface} Surface */
/** @typedef {import('../core/ports/repository.js').KernelAdapter} KernelAdapter */
/** @typedef {import('../core/ports/runtime.js').Ids} Ids */
/** @typedef {import('../core/ports/runtime.js').Logger} Logger */

/**
 * What the legacy adapter runs on: js/storage.js's DatabaseManager, which the page or the
 * worker imports before it builds its kernel, and chrome.storage.local.
 * @typedef {object} LegacyHost
 * @property {LegacyStorage} storage
 * @property {SettingsStore} settings
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
 * The `Storage` global js/storage.js sets, and chrome.storage.local, both read when a call
 * reaches them
 * @returns {LegacyHost}
 */
export function legacyHost() {
  return {
    storage: /** @type {LegacyStorage} */ (/** @type {{Storage?: unknown}} */ (globalThis).Storage),
    settings: chromeSettings(),
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
 * Reports a commit-feed listener that threw. Its detail holds the aggregate, the ids, and the
 * error, never a payload.
 * @type {Logger}
 */
const consoleLogger = Object.freeze({
  warn: (event, detail) => console.warn(`NewTabNote kernel: ${event}`, detail),
});

/**
 * One context's kernel on `adapter`, which starts opening now, and its client. Its caller is
 * `surface` with an id of its own, which the policy checks on every command and query.
 * `maintainOnOpen` runs startup maintenance before anything else, as the new tab's and the
 * worker's Storage.init did. `ready` is what the kernel waits on before it runs anything, the
 * adapter's open unless the root has more to open (the new tab's). Every id it and its client
 * make is a UUID (ids.js).
 * @param {{adapter: KernelAdapter & {open(): Promise<void>}, surface: Surface, maintainOnOpen?: boolean, ready?: Promise<unknown>}} options
 * @returns {Client}
 */
export function kernelClient({ adapter, surface, maintainOnOpen = false, ready = adapter.open() }) {
  const kernel = createKernel({
    adapter,
    policy: createBaselinePolicy(),
    caller: Object.freeze({ surface, contextId: `${surface}-${randomIds.next()}` }),
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
