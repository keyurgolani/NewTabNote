/**
 * The service worker's composition root (#12, docs/adr/0001-kernel-stack.md).
 *
 * js/background.js imports this module statically, so it evaluates before the worker
 * registers any listener. A throw while it loads, or a top-level await anywhere in what it
 * imports, leaves the extension without its context menus and commands, so loading it
 * touches no browser API. js/background.js installs #13's router with installWorkerRouter(),
 * and hands createWorkerClient() to #35's coordinator (./coordinator.js), which builds the
 * worker's kernel on its first start, once utils.js and storage.js have put Utils and Storage
 * on self.
 */

import { createLegacyAdapter } from '../adapters/legacy/adapter.js';
import { installRuntimePort } from '../adapters/messaging/runtime-port.js';
import { createRouter } from '../core/messaging/router.js';
import { createBaselinePolicy } from '../core/ports/policy.js';
import { systemClock } from '../core/ports/runtime.js';
import { kernelClient, legacyHost } from './host.js';
import { hostTimers, randomIds } from './messaging.js';

/** @typedef {import('./host.js').Client} Client */
/** @typedef {import('./host.js').LegacyHost} LegacyHost */
/** @typedef {import('../core/messaging/router.js').Router} Router */
/** @typedef {import('../core/ports/runtime.js').Logger} Logger */

/**
 * What the router installs on: chrome.runtime's port listener, and the manifest's version
 * @typedef {import('../adapters/messaging/runtime-port.js').Runtime & Pick<typeof chrome.runtime, 'getManifest'>} WorkerRuntime
 */

/**
 * The worker's kernel and its client. It opens the database versioned, as Storage.init did,
 * and runs startup maintenance before any command: first-run settings only, since the
 * read-only integrity check runs after an install or an update, as runIntegrityCheck (#35
 * slice 1), so no start reads every store. Its caller, `worker-internal`, may capture,
 * maintain and check, and nothing else. Its connection closes when another context upgrades
 * or deletes the database, so it never blocks one, and the next capture opens it again: a
 * newer build's database is refused as `newer-schema`. The coordinator (./coordinator.js)
 * builds it on its first start, so the worker opens nothing until an event needs storage.
 * @param {LegacyHost} [host]
 * @returns {Client}
 */
export function createWorkerClient(host = legacyHost()) {
  const adapter = createLegacyAdapter({ ...host, mode: 'versioned', reopen: true, integrityCheck: false });
  return kernelClient({ adapter, surface: 'worker-internal', maintainOnOpen: true });
}

/**
 * What the router warns of, with an operation's name and an error at most, never a payload
 * @type {Logger}
 */
const messagingLogger = Object.freeze({
  warn: (event, detail) => console.warn(`NewTabNote messaging: ${event}`, detail),
});

/** @param {unknown} error */
const warnOf = error => messagingLogger.warn('worker-router-failed', { error });

/**
 * #13's router, on `runtime`'s port listener, so each port one of this extension's pages
 * opens by PORT_NAME reaches it (adapters/messaging/runtime-port.js). It serves the handshake
 * and system.messagingHealth, and no page opens a port yet, since no client moves to it before
 * #35's later slices. js/background.js calls this at its top level, synchronously, so the
 * listener is there before Chrome hands over the port that woke the worker. It never throws,
 * since a throw there would stop every listener the worker registers: `report` hears why a
 * router couldn't be installed, and what a port's listener threw.
 *
 * #35's coordinator gives it this instance's id, which each welcome sends, `status`, which
 * each welcome says, and the session hooks, whose `opened` starts the coordinator.
 * @param {{
 *   runtime?: unknown,
 *   report?: (error: unknown) => void,
 *   coordinatorId?: string,
 *   status?: () => import('../core/messaging/router.js').CoordinatorStatus,
 *   sessions?: import('../core/messaging/router.js').SessionHooks,
 * }} [options] - `runtime` is chrome.runtime unless a test passes another
 * @returns {Router | null} the router, or null when it couldn't be installed
 */
export function installWorkerRouter({
  runtime = globalThis.chrome?.runtime,
  report = warnOf,
  coordinatorId,
  status,
  sessions,
} = {}) {
  try {
    const worker = /** @type {WorkerRuntime} */ (runtime);
    const router = createRouter({
      policy: createBaselinePolicy(),
      clock: systemClock,
      timers: hostTimers,
      coordinatorId: coordinatorId ?? randomIds.next(),
      extensionVersion: worker.getManifest().version,
      status,
      sessions,
      logger: messagingLogger,
    });
    installRuntimePort({ runtime: worker, router, report });
    return router;
  } catch (error) {
    report(error);
    return null;
  }
}
