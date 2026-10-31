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
 * A page and the service worker also reach the stored WebDAV server's origin with fetch
 * (storedWebdavOrigin), read when no other row takes a call.
 *
 * It wires the journal itself, so no later code can take the guard's reports: a page and the
 * offscreen document send each one to the service worker (network-refusals.js); the worker's
 * own go through the handle it answers, which only network-guard-first.js's importers see.
 *
 * It never throws, so a context it can't guard still runs the scripts after it, the new tab's
 * boot guard among them.
 */

import { storedLoopbackOrigin, storedWebdavOrigin } from './destination-match.js';
import { ANY_LOOPBACK, installGuard } from './network-guard.js';
import { REFUSAL_MESSAGE } from './network-refusals.js';

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
 * @returns {import('./network-guard.js').OriginSource}
 */
export function loopbackOf(scope, surface) {
  if (surface === 'offscreen') return () => ANY_LOOPBACK;
  const local = settingsOf(scope);
  return local ? () => storedLoopbackOrigin(local) : () => null;
}

/**
 * Where the context `scope` may reach the stored WebDAV server (see above)
 * @param {any} scope
 * @returns {import('./network-guard.js').OriginSource}
 */
export function storedOf(scope) {
  const local = settingsOf(scope);
  return local ? () => storedWebdavOrigin(local) : () => null;
}

/**
 * The context's chrome.storage.local, as the stored-URL reads take it, or null without one
 * @param {any} scope
 * @returns {{get(keys: string[]): Promise<Record<string, unknown>>} | null}
 */
function settingsOf(scope) {
  try {
    const local = scope.chrome.storage.local;
    return typeof local.get === 'function' ? { get: keys => local.get(keys) } : null;
  } catch {
    return null;
  }
}

/**
 * A page's sink for the guard's reports: each sent to the service worker, which journals it
 * @param {any} scope
 * @returns {((report: import('./network-guard.js').RefusalReport) => void) | null}
 */
function pageSink(scope) {
  try {
    const runtime = scope.chrome.runtime;
    if (typeof runtime.sendMessage !== 'function') return null;
    return report => {
      try {
        const sent = runtime.sendMessage({ type: REFUSAL_MESSAGE, report });
        if (sent && typeof sent.catch === 'function') sent.catch(() => {});
      } catch {
        // The journal is best effort
      }
    };
  } catch {
    return null;
  }
}

/**
 * Install the guard on `scope` for the context it is. Never throws.
 * @param {any} scope
 * @returns {import('./network-guard.js').GuardHandle | null}
 */
export function installContextGuard(scope) {
  try {
    const surface = surfaceOf(scope);
    const handle = installGuard(scope, { surface, loopback: loopbackOf(scope, surface), stored: storedOf(scope) });
    const sink = surface === 'worker-internal' ? null : pageSink(scope);
    if (handle && sink) handle.onRefused(sink);
    return handle;
  } catch {
    return null;
  }
}
