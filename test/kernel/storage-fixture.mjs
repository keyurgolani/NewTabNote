// Test contexts for #17's IndexedDB adapter: fake-indexeddb behind the fault-injecting
// wrapper (storage-faults.mjs), with legacy-env's chrome.storage.local stub for settings.
// Adapters over one profile's factory and stub are contexts of one browser profile.

import { createRequire } from 'node:module';

import { IDB_STORES } from '../../js/kernel/adapters/indexeddb/schema.js';
import { createIndexedDbAdapter } from '../../js/kernel/adapters/indexeddb/adapter.js';
import { createKernel } from '../../js/kernel/core/application/kernel.js';
import { createBaselinePolicy } from '../../js/kernel/core/ports/policy.js';
import { faultyFactory } from './storage-faults.mjs';
import { CALLERS, isSettingsArea, testClock, testIds } from './support.mjs';

/** @typedef {import('../../js/kernel/adapters/indexeddb/adapter.js').IndexedDbAdapter} IndexedDbAdapter */
/** @typedef {import('../../js/kernel/adapters/indexeddb/adapter.js').IndexedDbOptions} IndexedDbOptions */
/** @typedef {import('../../js/kernel/core/ports/repository.js').StoreName} StoreName */
/** @typedef {import('../../js/kernel/core/ports/policy.js').Caller} Caller */
/** @typedef {import('../../js/kernel/core/application/kernel.js').Kernel} Kernel */
/** @typedef {import('./storage-faults.mjs').Faults} Faults */
/** @typedef {import('./support.mjs').ContractFixture} ContractFixture */

// The helper is CommonJS and outside the strict kernel program, so it comes in untyped
const requireCommonJs = createRequire(import.meta.url);
/** @type {any} */
export const legacyEnv = requireCommonJs('../helpers/legacy-env.js');
/** @type {{IDBFactory: new () => IDBFactory}} */
const { IDBFactory } = requireCommonJs('fake-indexeddb');

/**
 * @typedef {object} Profile
 * @property {IDBFactory} real - fake-indexeddb itself, for fixtures and dumps the adapter mustn't see
 * @property {Faults} faults
 * @property {any} chrome - legacy-env's chrome stub
 * @property {IndexedDbAdapter[]} adapters - every adapter made over this profile
 */

/** @returns {Profile} */
export function profile() {
  const real = new IDBFactory();
  return { real, faults: faultyFactory(real), chrome: legacyEnv.createChromeStub(), adapters: [] };
}

/**
 * An adapter over `of`, as a composition root makes one
 * @param {Profile} of
 * @param {Partial<IndexedDbOptions>} [options]
 * @returns {IndexedDbAdapter}
 */
export function adapterOn(of, options = {}) {
  const adapter = createIndexedDbAdapter({
    indexedDB: of.faults.factory,
    settings: of.chrome.api.storage.local,
    ...options,
  });
  of.adapters.push(adapter);
  return adapter;
}

/**
 * @param {IndexedDbAdapter} adapter
 * @param {{ids?: {next(): string}, clock?: {now(): number}}} [runtime]
 * @param {Caller} [caller]
 * @returns {Kernel}
 */
export function kernelOn(adapter, { ids = testIds(), clock = testClock() } = {}, caller = CALLERS.newtab) {
  return createKernel({ adapter, policy: createBaselinePolicy(), caller, ids, clock });
}

/** @param {Profile} of */
export function closeAll(of) {
  for (const adapter of of.adapters) adapter.close();
}

/**
 * A contract-suite context over a fresh profile, opened `versioned` as the service worker
 * opens it once its run has made the database, or over a version-8 database without
 * `missing`'s stores, opened as it is, as the worker does when its run left the database as
 * it was, and as Popup does (#17 PR 1b: a versioned open would give it the stores it lacks).
 * @param {StoreName[]} missing
 * @returns {ReturnType<ContractFixture['start']>}
 */
async function startIndexedDb(missing) {
  const first = profile();
  /** @type {Partial<IndexedDbOptions>} */
  const options = {};
  if (missing.length > 0) {
    await legacyEnv.createDatabase(first.real, { omit: missing.map(store => IDB_STORES[store]) });
    options.mode = 'existing';
  }
  const adapter = adapterOn(first, options);
  await adapter.open();
  const clock = testClock();
  const ids = testIds();
  return {
    adapter,
    clock,
    ids,
    kernel: (caller = CALLERS.newtab) => kernelOn(adapter, { ids, clock }, caller),
    async secondContext() {
      const second = adapterOn(first, options);
      await second.open();
      return {
        kernel: (caller = CALLERS.newtab) =>
          kernelOn(second, { ids, clock }, { ...caller, contextId: `${caller.contextId}-second` }),
      };
    },
    // A write the disk refuses: it goes through, then its transaction aborts as it commits
    failNextWrite: target => {
      if (isSettingsArea(target)) first.chrome.failNextSet();
      else first.faults.abortAfterNextWrite(IDB_STORES[target], 'QuotaExceededError');
    },
    close: async () => closeAll(first),
  };
}

/** @type {ContractFixture} */
export const indexedDbFixture = {
  name: 'indexeddb',
  flags: Object.freeze({ atomicMultiStore: true, revisions: false, idempotency: false, backups: false }),
  start: () => startIndexedDb([]),
  startWithout: startIndexedDb,
};
