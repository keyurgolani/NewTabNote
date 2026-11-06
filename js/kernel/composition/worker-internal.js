/**
 * The worker's own client and router (#35 slice 4a, "One committer"): the worker's capture goes
 * through #13's client on the in-process transport, as `worker-internal`, to a router of its own,
 * which hands it to the coordinator's one queue (./coordinator.js), as a page's command will
 * through the port router once its slice moves it. js/background.js builds both after the
 * coordinator.
 *
 * The router is on the worker's catalog, which grants `worker-internal` its capture, and serves
 * that alone. It's reached only in-process, never on a port: the port router
 * (./background.js, installWorkerRouter) stays on the shared catalog, so no port sender reaches
 * the worker's operations even if a grant were wrong (the lead's Q1, 3a's pin). Every sender here
 * is the worker's own code, so no message limit applies: 1.5.0 saves a capture over 1 MiB (the
 * lead's ruling for 4a), while the port router keeps #13's.
 *
 * Building them opens nothing and touches no browser API but the manifest's version: the client
 * says hello on its first capture.
 */

import { WORKER_CATALOG } from '../core/contracts/worker-catalog.js';
import { createClient } from '../core/messaging/client.js';
import { JOURNALED_OPERATIONS } from '../core/messaging/journaled-operations.js';
import { createLookup } from '../core/messaging/operations.js';
import { createRouter } from '../core/messaging/router.js';
import { createBaselinePolicy } from '../core/ports/policy.js';
import { systemClock } from '../core/ports/runtime.js';
import { hostTimers, randomIds, workerTransport } from './messaging.js';

/** @typedef {import('../core/messaging/router.js').Router} Router */
/** @typedef {import('../core/messaging/router.js').CoordinatorStatus} CoordinatorStatus */
/** @typedef {import('../core/messaging/router.js').Dispatch} Dispatch */
/** @typedef {import('../core/messaging/client.js').Client} MessagingClient */
/** @typedef {import('../core/messaging/link.js').Connection} Connection */
/** @typedef {import('../core/ports/runtime.js').Clock} Clock */
/** @typedef {import('../core/ports/runtime.js').Timers} Timers */
/** @typedef {import('../core/ports/runtime.js').Ids} Ids */

/**
 * The one operation the worker's own router serves: its capture, with the schemas its drain
 * upcasts an entry against
 */
const WORKER_INTERNAL_LOOKUP = createLookup({ captureToDailyNote: JOURNALED_OPERATIONS.captureToDailyNote });

/**
 * What the router and the client warn of, with an operation's name and an error at most, never a
 * payload, as the port router's does
 */
const messagingLogger = Object.freeze({
  /** @param {string} event @param {unknown} [detail] */
  warn: (event, detail) => console.warn(`NewTabNote messaging: ${event}`, detail),
});

/**
 * The version the client and the router say in their handshake: the manifest's, the same on both
 * sides even where there's no chrome.runtime
 * @returns {string}
 */
function ownVersion() {
  try {
    return globalThis.chrome.runtime.getManifest().version;
  } catch {
    return '';
  }
}

/**
 * The worker's own router, which serves the capture alone on the worker's catalog, handing it to
 * the coordinator's queue (`enqueue`) with the request's `begin`, so one whose deadline came while
 * it waited never runs
 * @param {{
 *   coordinatorId: string,
 *   extensionVersion?: string,
 *   status: () => CoordinatorStatus,
 *   settled?: () => unknown,
 *   enqueue: (command: any, dispatch: Dispatch) => unknown,
 *   clock?: Clock,
 *   timers?: Timers,
 * }} options - `extensionVersion` is the manifest's, and `clock` and `timers` the worker's,
 *   unless a test passes others
 * @returns {Router}
 */
export function createWorkerInternalRouter({
  coordinatorId,
  extensionVersion = ownVersion(),
  status,
  settled,
  enqueue,
  clock = systemClock,
  timers = hostTimers,
}) {
  return createRouter({
    lookup: WORKER_INTERNAL_LOOKUP,
    handlers: Object.freeze({ captureToDailyNote: (payload, dispatch) => enqueue(payload, dispatch) }),
    policy: createBaselinePolicy(WORKER_CATALOG),
    clock,
    timers,
    coordinatorId,
    extensionVersion,
    status,
    settled,
    logger: messagingLogger,
    capped: false,
  });
}

/**
 * The worker's own client, on the in-process transport to `router`, the worker's own
 * (createWorkerInternalRouter), as `worker-internal`, so the worker's capture passes the same
 * checks as a page's command but the message limit. It answers with #12's outcome union: a
 * capture the coordinator didn't start by its deadline as `unavailable`, retryable, and one it
 * started whose answer didn't come in time as `unknown`, both `deadline-exceeded`.
 * @param {{
 *   router: {accept(connection: Connection): void},
 *   extensionVersion?: string,
 *   clock?: Clock,
 *   timers?: Timers,
 *   ids?: Ids,
 * }} options - `extensionVersion` is the manifest's, and `clock`, `timers` and `ids` the
 *   worker's, unless a test passes others
 * @returns {MessagingClient}
 */
export function createWorkerInternalClient({
  router,
  extensionVersion = ownVersion(),
  clock = systemClock,
  timers = hostTimers,
  ids = randomIds,
}) {
  return createClient({
    transport: workerTransport(router),
    surface: 'worker-internal',
    extensionVersion,
    lookup: WORKER_INTERNAL_LOOKUP,
    ids,
    clock,
    timers,
    logger: messagingLogger,
    capped: false,
  });
}
