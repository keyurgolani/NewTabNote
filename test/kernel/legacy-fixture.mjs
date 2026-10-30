// The legacy adapter's test contexts: production js/utils.js and js/storage.js loaded into
// #33's test/helpers/legacy-env.js, on fake-indexeddb, with its chrome.storage.local stub.
// Contexts that share an IndexedDB factory and chrome.* are tabs of one browser profile.

import { createRequire } from 'node:module';

import { IDB_STORES } from '../../js/kernel/adapters/indexeddb/schema.js';
import { createLegacyAdapter } from '../../js/kernel/adapters/legacy/adapter.js';
import { createKernel } from '../../js/kernel/core/application/kernel.js';
import { createBaselinePolicy } from '../../js/kernel/core/ports/policy.js';
import { CALLERS, testClock, testIds } from './support.mjs';

/** @typedef {import('../../js/kernel/adapters/legacy/adapter.js').LegacyAdapter} LegacyAdapter */
/** @typedef {import('../../js/kernel/adapters/legacy/adapter.js').OpenMode} OpenMode */
/** @typedef {import('../../js/kernel/core/ports/repository.js').StoreName} StoreName */
/** @typedef {import('../../js/kernel/core/ports/policy.js').Caller} Caller */
/** @typedef {import('../../js/kernel/core/application/kernel.js').Kernel} Kernel */
/** @typedef {import('./support.mjs').ContractFixture} ContractFixture */
/** @typedef {import('./support.mjs').TestClock} TestClock */

// The helper is CommonJS and outside the strict kernel program, so it comes in untyped
const requireCommonJs = createRequire(import.meta.url);
/** @type {any} */
export const legacyEnv = requireCommonJs('../helpers/legacy-env.js');

/** The kernel store each IndexedDB store holds */
const KERNEL_STORES = /** @type {Record<string, StoreName>} */ (
  Object.fromEntries(Object.entries(IDB_STORES).map(([kernel, idb]) => [idb, kernel]))
);

/**
 * @typedef {object} LegacyContext
 * @property {any} env - the legacy-env environment
 * @property {any} storage - its DatabaseManager, the page's `Storage`
 * @property {StoreName[]} failing - kernel stores whose next write fails, one write per entry
 * @property {StoreName[]} abortingOnCommit
 *   Kernel stores whose next write goes through and then has its transaction abort, as a
 *   write the disk refuses at commit does
 */

/**
 * A page context running the production storage scripts, the way a new tab, Popup, or Side
 * Panel loads them. Pass another context's `env` to share its IndexedDB and chrome.*.
 * @param {any} [sharedWith]
 * @returns {LegacyContext}
 */
export function legacyContext(sharedWith) {
  const env = legacyEnv.createLegacyEnv(
    sharedWith ? { context: 'page', indexedDB: sharedWith.indexedDB, chrome: sharedWith.chrome } : { context: 'page' },
  );
  env.load('js/utils.js', 'js/storage.js');
  const storage = env.get('Storage');
  /** @type {StoreName[]} */
  const failing = [];
  /** @type {StoreName[]} */
  const abortingOnCommit = [];
  failWrites(storage, failing, abortingOnCommit);
  return { env, storage, failing, abortingOnCommit };
}

/**
 * Make a put or delete on a kernel store listed in `failing` throw, as a failing IndexedDB
 * write would, and one on a store in `abortingOnCommit` go through and then abort its
 * transaction. Once per entry.
 * @param {any} storage
 * @param {StoreName[]} failing
 * @param {StoreName[]} abortingOnCommit
 */
function failWrites(storage, failing, abortingOnCommit) {
  const transaction = storage.transaction.bind(storage);
  storage.transaction = (/** @type {string | string[]} */ names, /** @type {IDBTransactionMode} */ mode) => {
    const tx = transaction(names, mode);
    const objectStore = tx.objectStore.bind(tx);
    tx.objectStore = (/** @type {string} */ name) => {
      const store = objectStore(name);
      const target = KERNEL_STORES[name];
      return new Proxy(store, {
        get(object, property) {
          const value = Reflect.get(object, property, object);
          if (typeof value !== 'function') return value;
          if (property !== 'put' && property !== 'delete') return value.bind(object);
          return (/** @type {unknown[]} */ ...args) => {
            const index = failing.indexOf(target);
            if (index !== -1) {
              failing.splice(index, 1);
              throw new DOMException('A write the test made fail', 'UnknownError');
            }
            const request = value.apply(object, args);
            const late = abortingOnCommit.indexOf(target);
            if (late !== -1) {
              abortingOnCommit.splice(late, 1);
              request.addEventListener('success', () => tx.abort());
            }
            return request;
          };
        },
      });
    };
    return tx;
  };
}

/**
 * @param {LegacyContext} context
 * @param {OpenMode} [mode]
 * @param {{reopen?: boolean}} [options] - `reopen`, as the worker's root sets it
 * @returns {LegacyAdapter}
 */
export function adapterFor(context, mode = 'versioned', { reopen = false } = {}) {
  return createLegacyAdapter({
    storage: context.storage,
    settings: context.env.chrome.api.storage.local,
    mode,
    reopen,
  });
}

/**
 * @param {LegacyAdapter} adapter
 * @param {{ids: {next(): string}, clock: {now(): number}}} runtime
 * @param {Caller} [caller]
 * @returns {Kernel}
 */
export function kernelFor(adapter, { ids, clock }, caller = CALLERS.newtab) {
  return createKernel({ adapter, policy: createBaselinePolicy(), caller, ids, clock });
}

/** @param {LegacyContext[]} contexts */
export function closeAll(contexts) {
  for (const { storage } of contexts) if (storage.db) storage.db.close();
}

/**
 * A contract-suite context over a fresh profile, or over a version-8 database without
 * `missing`'s stores.
 * @param {StoreName[]} missing
 * @returns {ReturnType<ContractFixture['start']>}
 */
async function startLegacy(missing) {
  const first = legacyContext();
  if (missing.length > 0) {
    await legacyEnv.createDatabase(first.env.indexedDB, { omit: missing.map(store => IDB_STORES[store]) });
  }
  const adapter = adapterFor(first);
  await adapter.open();
  /** @type {LegacyContext[]} */
  const contexts = [first];
  const clock = testClock();
  const ids = testIds();
  return {
    adapter,
    clock,
    ids,
    kernel: (caller = CALLERS.newtab) => kernelFor(adapter, { ids, clock }, caller),
    async secondContext() {
      const second = legacyContext(first.env);
      const secondAdapter = adapterFor(second);
      await secondAdapter.open();
      contexts.push(second);
      return {
        kernel: (caller = CALLERS.newtab) =>
          kernelFor(secondAdapter, { ids, clock }, { ...caller, contextId: `${caller.contextId}-second` }),
      };
    },
    failNextWrite: target => {
      if (target === 'preferences' || target === 'session' || target === 'jobs') first.env.chrome.failNextSet();
      else first.failing.push(target);
    },
    close: async () => closeAll(contexts),
  };
}

/** @type {ContractFixture} */
export const legacyFixture = {
  name: 'legacy',
  flags: Object.freeze({ atomicMultiStore: false, revisions: false, idempotency: false }),
  start: () => startLegacy([]),
  startWithout: startLegacy,
};
