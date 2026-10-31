/**
 * The background coordinator's host in the service worker (#35 slice 1,
 * docs/adr/0001-kernel-stack.md, "Where the kernel runs"). js/background.js registers every
 * listener first and builds this last, so a throw while building it leaves the menus, the
 * commands and #13's port listener in place. Building it opens nothing: it starts once per
 * worker instance, on the first event that needs storage (an install or update, a browser
 * start, a page's port session, a capture), and builds the worker's kernel then.
 *
 * Each welcome says what it can do (#13, "Handshake and compatibility"): `starting` until the
 * database is open, then `ready`, or degraded and why: the open's code (`newer-schema`,
 * `missing-core-stores`), else `storage-unavailable`, and `coordinator-unavailable` when the
 * kernel couldn't be built at all, which every command then answers too, and the worker's
 * console shows why. A start writes first-run settings only; the read-only integrity check
 * runs after an install or an update (`installed`). Loading this module touches no browser API.
 *
 * What it journals is best effort (#20, "Diagnostic journal"): a journal that throws changes
 * nothing it answers.
 */

import { failed, unavailable } from '../core/contracts/outcomes.js';
import { systemClock } from '../core/ports/runtime.js';
import { randomIds } from './messaging.js';

/** @typedef {import('./host.js').Client} Client */
/** @typedef {import('../core/contracts/outcomes.js').Unavailable} Unavailable */
/** @typedef {import('../core/messaging/router.js').CoordinatorStatus} CoordinatorStatus */

/**
 * What the coordinator journals through: the worker's failure events (./trust.js's
 * createFailureEvents), which never throw, though a stand-in might
 * @typedef {{event(code: string, fields?: Record<string, unknown>, error?: unknown): void}} Events
 */

/**
 * The worker's background coordinator
 * @typedef {object} Coordinator
 * @property {string} instanceId - this worker instance's, the router's coordinatorId
 * @property {() => Promise<void>} start - once per instance; later calls share the first
 * @property {() => CoordinatorStatus} status - what a welcome says now
 * @property {() => Client} client - the kernel the worker's own handlers run commands on
 * @property {(reason: unknown) => Promise<void>} installed
 *   Starts it for an onInstalled event, and after an install or an update runs the read-only
 *   integrity check once
 */

/** The reason a welcome gives, and the code every command answers, when the kernel can't be built */
const UNAVAILABLE = 'coordinator-unavailable';

/** The onInstalled reasons the integrity check runs after: this extension's own install or update */
const CHECKED_ON = Object.freeze(['install', 'update']);

/**
 * This worker instance's id, which #13's router sends in each welcome, so a client sees it
 * change when the worker restarted. It never throws: without crypto it's made from the clock.
 * @returns {string}
 */
export function coordinatorInstanceId() {
  try {
    return randomIds.next();
  } catch {
    return `coordinator-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  }
}

/**
 * @param {Events | null | undefined} events
 * @param {string} code
 * @param {Record<string, unknown>} fields
 * @param {unknown} [error]
 */
function journal(events, code, fields, error) {
  try {
    if (events) events.event(code, fields, error);
  } catch {
    // Best effort: a journal that can't be written changes nothing the worker does
  }
}

/**
 * A kernel client that answers every command and query as `outcome`, for a coordinator whose
 * kernel couldn't be built
 * @param {Unavailable} outcome
 * @returns {Client}
 */
function unavailableClient(outcome) {
  return /** @type {Client} */ (
    /** @type {unknown} */ (
      Object.freeze({
        execute: async () => ({ ...outcome }),
        query: async () => failed('coordinator', outcome.code),
        subscribe: () => () => {},
        whenReady: async () => ({ ...outcome }),
        ids: Object.freeze({ next: () => coordinatorInstanceId() }),
      })
    )
  );
}

/**
 * The welcome's reason for a kernel whose open failed
 * @param {{cause?: unknown, code?: unknown}} failure
 * @returns {string}
 */
function reasonOf({ cause, code }) {
  if (cause === 'newer-schema') return 'newer-schema';
  if (code === 'missing-core-stores') return 'missing-core-stores';
  return 'storage-unavailable';
}

/** @param {unknown} error */
const reportUnbuilt = error => console.error("NewTabNote: the background coordinator couldn't build its kernel", error);

/**
 * A coordinator that can't serve: what js/background.js keeps when building the real one
 * threw, and what it answers with until that's done
 * @param {string} instanceId
 * @returns {Coordinator}
 */
export function unavailableCoordinator(instanceId) {
  const client = unavailableClient(unavailable('coordinator', UNAVAILABLE, false));
  const start = () => Promise.resolve();
  return Object.freeze({
    instanceId,
    start,
    status: () => ({ status: /** @type {const} */ ('degraded'), reason: UNAVAILABLE }),
    client: () => client,
    installed: start,
  });
}

/**
 * The worker's coordinator. `makeKernel` builds the worker's kernel, which opens the database
 * as it's built, so it's called on the first start, never before; a throw from it leaves the
 * coordinator unavailable for this instance, and goes to `report`.
 * @param {{
 *   instanceId: string,
 *   makeKernel: () => Client,
 *   events?: Events | null,
 *   clock?: {now(): number},
 *   report?: (error: unknown) => void,
 * }} options
 * @returns {Coordinator}
 */
export function createCoordinator({
  instanceId,
  makeKernel,
  events = null,
  clock = systemClock,
  report = reportUnbuilt,
}) {
  /** @type {'idle' | 'starting' | 'ready' | 'degraded' | 'unavailable'} */
  let state = 'idle';
  /** @type {string} */
  let reason = '';
  /** @type {Client | null} */
  let kernel = null;
  /** What the worker's handlers run on until the kernel is built, and for good if it can't be */
  const unbuilt = unavailableClient(unavailable('coordinator', UNAVAILABLE, false));
  /** @type {Promise<void> | null} */
  let started = null;

  const run = async () => {
    state = 'starting';
    const openStartedAt = clock.now();
    try {
      kernel = makeKernel();
    } catch (error) {
      state = 'unavailable';
      reason = UNAVAILABLE;
      try {
        report(error);
      } catch {
        // Nothing a report throws changes what the worker answers
      }
      return;
    }
    /** @type {unknown} */
    let failure;
    try {
      failure = await kernel.whenReady();
    } catch (error) {
      failure = error;
    }
    if (failure) {
      state = 'degraded';
      reason = reasonOf(/** @type {{cause?: unknown, code?: unknown}} */ (failure));
      // The worker's storage init: an open that failed is a storage incident now, not only
      // when a capture finds it
      journal(
        events,
        'storage.open-failed',
        { subjectId: 'CanvasTabDB', durationMs: Math.max(0, clock.now() - openStartedAt) },
        failure,
      );
      return;
    }
    state = 'ready';
  };

  const start = () => {
    if (!started) started = run();
    return started;
  };

  return Object.freeze({
    instanceId,
    start,
    status() {
      if (state === 'ready') return { status: /** @type {const} */ ('ready') };
      const now = state === 'idle' || state === 'starting' ? 'starting' : reason;
      return { status: /** @type {const} */ ('degraded'), reason: now };
    },
    client: () => kernel || unbuilt,
    async installed(installReason) {
      await start();
      if (state !== 'ready' || !kernel || !CHECKED_ON.includes(/** @type {string} */ (installReason))) return;
      const checking = kernel;
      try {
        await checking.execute({ type: 'runIntegrityCheck', commandId: checking.ids.next() });
      } catch {
        // The check only reports what it finds, so one that couldn't run changes nothing
      }
    },
  });
}
