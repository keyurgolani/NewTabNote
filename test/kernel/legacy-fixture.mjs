// Page contexts running Storage: production js/utils.js and js/storage.js, which the new tab
// still opens beside #17's adapter for the holders #22 and #19 own until #17 PR 4b, or the
// frozen v1.4.1's (test/fixtures/storage/releases/), loaded into #33's test/helpers/legacy-env.js,
// on fake-indexeddb, with its chrome.storage.local stub. Contexts that share an IndexedDB
// factory and chrome.* are tabs of one browser profile. #12's legacy adapter, which ran the
// kernel over these, went with #17 PR 4a.

import { createRequire } from 'node:module';

// The helper is CommonJS and outside the strict kernel program, so it comes in untyped
const requireCommonJs = createRequire(import.meta.url);
/** @type {any} */
export const legacyEnv = requireCommonJs('../helpers/legacy-env.js');

/**
 * A page context: its legacy-env environment and the Storage it loaded
 * @typedef {{env: any, storage: any}} PageContext
 */

/** @typedef {PageContext} LegacyContext */

/**
 * A page context running the production storage scripts, the way the new tab loads them. Pass
 * another context's `env` to share its IndexedDB and chrome.*. `worker: false` leaves its wake
 * of the worker unanswered (legacy-env's workerRun), as with no worker.
 * @param {any} [sharedWith]
 * @param {{worker?: boolean}} [options]
 * @returns {LegacyContext}
 */
export function legacyContext(sharedWith, { worker = true } = {}) {
  const env = legacyEnv.createLegacyEnv(
    sharedWith
      ? { context: 'page', indexedDB: sharedWith.indexedDB, chrome: sharedWith.chrome, worker }
      : { context: 'page', worker },
  );
  env.load('js/utils.js', 'js/storage.js');
  return { env, storage: env.get('Storage') };
}

/** Where the frozen 1.4.1 files are (test/fixtures/storage/releases/) */
const RELEASE_141 = 'test/fixtures/storage/releases/v1.4.1/js';

/**
 * A page context running the frozen v1.4.1 Storage, with this build's Utils, whose helpers the
 * Storage calls are unchanged since 1.4.1 and which the editor's files need. legacy-parity holds
 * the kernel's copies of 1.4.x's rules to it since #17 PR 4a took js/storage.js's own copies
 * out, which matched 1.4.1's line for line. Its `storage.open()` opens the database at 1.4.1's
 * version with none of init()'s first-run settings or integrity check, as js/storage.js's
 * open() did. Pass another context's `env` to share its IndexedDB and chrome.*.
 * @param {any} [sharedWith]
 * @returns {PageContext}
 */
export function releaseContext(sharedWith) {
  const env = legacyEnv.createLegacyEnv(
    sharedWith
      ? { context: 'page', indexedDB: sharedWith.indexedDB, chrome: sharedWith.chrome, worker: false }
      : { context: 'page', worker: false },
  );
  env.load('js/utils.js', `${RELEASE_141}/storage.js`);
  const storage = env.get('Storage');
  storage.open = async () => {
    const db = await storage._openAtCurrentVersion();
    storage.db = db;
    storage.missingStores = storage.requiredStores.filter((/** @type {string} */ name) => !db.objectStoreNames.contains(name));
    storage.openState = 'open';
  };
  return { env, storage };
}

/** @param {PageContext[]} contexts */
export function closeAll(contexts) {
  for (const { storage } of contexts) if (storage.db) storage.db.close();
}
