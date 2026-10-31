/**
 * The network guard as each context installs it (#21 slice 1b, "Guard"): js/network-guard.js
 * in every page, before any other script, and the first import of the service worker and the
 * indexer. installContextGuard names the context by its location and gives the guard the
 * loopback origin it may reach:
 *
 * - a page and the service worker: the stored Ollama URL's origin (destination-match.js's
 *   storedLoopbackOrigin), read when a call to a loopback host is made, so a URL changed in
 *   Settings applies to the next call;
 * - the offscreen document, which has no chrome.storage and takes only the worker's requests,
 *   each to the origin the worker checked: any loopback port;
 * - anything else, the indexer among them: none.
 *
 * It never throws, so a context it can't guard still runs the scripts after it, the new tab's
 * boot guard among them.
 */

import { storedLoopbackOrigin } from './destination-match.js';
import { ANY_LOOPBACK, installGuard } from './network-guard.js';

/**
 * The context `scope` is, by its location: a page's surface, or worker-internal
 * @param {any} scope
 * @returns {string}
 */
export function surfaceOf(scope) {
  try {
    // The pages, by file, as the journal names them (surfaces.js)
    const page = /\/(newtab|popup|sidepanel|offscreen)\.html$/.exec(scope.location.pathname);
    return page ? page[1] : 'worker-internal';
  } catch {
    return 'worker-internal';
  }
}

/**
 * Where the context `scope` may reach loopback (see above)
 * @param {any} scope
 * @param {string} surface
 * @returns {import('./network-guard.js').LoopbackSource}
 */
export function loopbackOf(scope, surface) {
  if (surface === 'offscreen') return () => ANY_LOOPBACK;
  const local = scope && scope.chrome && scope.chrome.storage ? scope.chrome.storage.local : null;
  if (!local || typeof local.get !== 'function') return () => null;
  return () => storedLoopbackOrigin({ get: keys => local.get(keys) });
}

/**
 * Install the guard on `scope` for the context it is. Never throws.
 * @param {any} scope
 * @returns {import('./network-guard.js').GuardHandle | null}
 */
export function installContextGuard(scope) {
  try {
    const surface = surfaceOf(scope);
    return installGuard(scope, { surface, loopback: loopbackOf(scope, surface) });
  } catch {
    return null;
  }
}
