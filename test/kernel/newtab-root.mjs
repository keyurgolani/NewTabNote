// The new tab's root on a legacy-env profile, as startNewTab builds it (composition/newtab.js), for
// the kernel tests of the new tab's page side once its writes go to the worker over #13's port (#35
// slice 4d): #17's read-only reader, as the root makes it, and the root's client on it, whose writes
// go to a stand-in for the worker (popup-worker.mjs) on a newtab.html page. The root is read as a
// namespace, so a case on a tree without it fails in its own body.

import * as root from '../../js/kernel/composition/newtab.js';
import { popupWorker } from './popup-worker.mjs';

/** @typedef {import('./popup-worker.mjs').Handed} Handed */
/** @typedef {import('../../js/kernel/core/contracts/outcomes.js').Outcome} Outcome */
/** @typedef {import('../../js/kernel/core/messaging/router.js').CoordinatorStatus} CoordinatorStatus */

/**
 * The new tab on `env`'s profile, its writes to a stand-in for the worker there, which `close`
 * closes with the reader
 * @param {any} env - a legacy-env environment: its IndexedDB, chrome.storage.local, Web Locks and localStorage
 * @param {{
 *   status?: () => CoordinatorStatus,
 *   before?: (handed: Handed) => unknown,
 *   answer?: (handed: Handed) => Outcome | undefined,
 *   runtime?: (runtime: any) => any,
 *   requestIdle?: (callback: () => void, options: {timeout: number}) => void,
 *   awaitUpgrade?: () => Promise<unknown>,
 *   locks?: any,
 *   send?: () => Promise<any>,
 *   load?: () => Promise<any>,
 *   wake?: () => void,
 *   events?: any,
 *   drafts?: any,
 * }} [options] - the stand-in's `status`, `before` and `answer` (popup-worker.mjs); `runtime`: what
 *   the page's chrome.runtime goes through, as it is unless a case wraps it; the page's idle; its
 *   wait on the worker's run, none unless given; its Web Locks, the profile's unless given; and the
 *   root's own loads, wake and failure events
 */
export function newTabOn(env, options = {}) {
  const { status, before, answer, requestIdle, locks, ...rest } = options;
  const { runtime = (/** @type {any} */ through) => through, awaitUpgrade = async () => {}, ...page } = rest;
  const settings = env.chrome.api.storage.local;
  const stand = popupWorker({ indexedDB: env.indexedDB, settings, status, before, answer, page: 'newtab' });
  const host = {
    indexedDB: env.indexedDB,
    settings,
    awaitUpgrade,
    locks: locks || env.global.navigator.locks || null,
    runtime: runtime(stand.runtime),
    extensionVersion: stand.extensionVersion,
    ...(requestIdle ? { requestIdle } : {}),
  };
  const reader = /** @type {any} */ (root).createNewTabReader(host);
  const client = /** @type {any} */ (root).createNewTabPageClient(reader, host, {
    drafts: { storage: env.global.localStorage, locks: env.global.navigator.locks || null },
    wake: () => {},
    ...page,
  });
  return {
    stand,
    reader,
    host,
    /** @type {ReturnType<typeof root.createNewTabPageClient>} */
    client,
    /** Closes the stand-in, the page's ports, and the reader's connection */
    close() {
      stand.close();
      reader.close();
    },
  };
}
