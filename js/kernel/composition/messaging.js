/**
 * How each context reaches #13's router (#13, "Topology"). Transport selection lives here,
 * never in core. A page's client takes the runtime port when the page runs as an extension
 * page, where chrome.runtime has an id and connect(), and otherwise an in-process transport
 * to a router of the page's own, as under the storage.js mock, whose sendMessage never
 * answers, or once the extension context is gone. The worker's own code always takes the
 * in-process transport, as worker-internal.
 *
 * Loading this module touches no browser API: each function reads the globals when it's
 * called.
 */

import { createRuntimePortTransport } from '../adapters/messaging/runtime-port.js';
import { createInProcessTransport } from '../core/messaging/in-process.js';

/** @typedef {import('../core/contracts/surfaces.js').Surface} Surface */
/** @typedef {import('../core/messaging/link.js').Connection} Connection */
/** @typedef {import('../core/messaging/link.js').Transport} Transport */
/** @typedef {import('../core/ports/runtime.js').Timers} Timers */
/** @typedef {import('../adapters/messaging/runtime-port.js').Runtime} Runtime */

/** @typedef {{accept(connection: Connection): void}} RouterLike */

/**
 * The host's timers, for the router's and the client's deadlines and waits
 * @type {Timers}
 */
export const hostTimers = Object.freeze({
  set: (callback, ms) => setTimeout(callback, ms),
  clear: handle => clearTimeout(/** @type {ReturnType<typeof setTimeout>} */ (handle)),
});

// Ids from crypto.randomUUID(), for a client's session and requests and the coordinator's
// instance, as every root's kernel has them since #17 PR 2a (ids.js)
export { randomIds } from './ids.js';

/**
 * Whether `runtime` is an extension page's chrome.runtime, which can open a port
 * @param {unknown} runtime
 * @returns {runtime is Runtime}
 */
export function canConnect(runtime) {
  if (runtime === null || typeof runtime !== 'object') return false;
  const { id, connect } = /** @type {{id?: unknown, connect?: unknown}} */ (runtime);
  return typeof id === 'string' && id !== '' && typeof connect === 'function';
}

/**
 * A page's transport: the runtime port where the page can open one, and otherwise an
 * in-process one to the router `localRouter` builds then
 * @param {{surface: Surface, localRouter: () => RouterLike, runtime?: unknown}} options -
 *   `runtime` is chrome.runtime unless a test passes another
 * @returns {Transport}
 */
export function pageTransport({ surface, localRouter, runtime = globalThis.chrome?.runtime }) {
  if (canConnect(runtime)) return createRuntimePortTransport({ runtime });
  return createInProcessTransport({ router: localRouter(), surface });
}

/**
 * The worker's own transport to its router, as worker-internal, so its requests pass the
 * same checks as a page's
 * @param {RouterLike} router
 * @returns {Transport}
 */
export function workerTransport(router) {
  return createInProcessTransport({ router, surface: 'worker-internal' });
}
