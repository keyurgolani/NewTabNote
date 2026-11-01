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
 * kernel couldn't be built at all, which every command then answers too. A start writes
 * first-run settings only; the read-only integrity check runs after an install or an update
 * (`installed`). system.coordinatorHealth says the same, with this instance's start and the
 * commands it ran by outcome. Loading this module touches no browser API.
 *
 * The worker's kernel runs #17's migration run before it opens (PR 1b, ./background.js). While
 * an open page of an older build blocks the run's upgrade, the kernel answers
 * `blocked-upgrade` at once, and the coordinator is degraded `migrating`: no failed open. Its
 * start resolves on that answer, so a capture made meanwhile answers right away, and beside
 * it the coordinator waits on the run's own end, never on a timer. Once the page closes or
 * reloads, the upgrade goes on, the run ends, and the coordinator asks once more: `ready`,
 * with the integrity check an install or an update asked for meanwhile.
 *
 * start() builds the kernel before it returns, with nothing awaited first, so whatever calls
 * it reads client() as the built kernel at once: js/background.js's answers to a page's
 * `storage.migrate` and #34's `storageUpgrade` start it, then read the kernel's run, with no
 * point where they'd find the stand-in (test/kernel/coordinator.test.mjs pins it).
 *
 * A kernel that can't be built is `coordinator.start-failed` (#20, "Diagnostic journal"),
 * which raises the `coordinator` provider's incident, and a start that opens is
 * `coordinator.started`, which resolves it. What it journals is best effort: a journal that
 * throws changes nothing it answers, and no start, and no wait on a run, ever rejects.
 */

import { failed, ready, unavailable } from '../core/contracts/outcomes.js';
import { systemClock } from '../core/ports/runtime.js';
import { randomIds } from './messaging.js';

/** @typedef {import('./host.js').Client} Client */
/** @typedef {import('../core/contracts/outcomes.js').Unavailable} Unavailable */
/** @typedef {import('../core/contracts/operations/system-coordinator-health.js').CoordinatorHealth} CoordinatorHealth */
/** @typedef {import('../core/messaging/router.js').CoordinatorStatus} CoordinatorStatus */
/** @typedef {import('../core/messaging/router.js').Handler} Handler */

/**
 * What the coordinator journals through: the worker's failure events (./trust.js's
 * createFailureEvents), which never throw, though a stand-in might
 * @typedef {{event(code: string, fields?: Record<string, unknown>, error?: unknown): void}} Events
 */

/**
 * What a kernel with #17's migration run behind it adds (./background.js's worker client): the
 * latest attempt's end, which the coordinator waits on while the run's upgrade is blocked
 * @typedef {{migration?: {readonly done: Promise<unknown>}}} WithMigration
 */

/**
 * The worker's background coordinator
 * @typedef {object} Coordinator
 * @property {string} instanceId - this worker instance's, the router's coordinatorId
 * @property {() => Promise<void>} start
 *   Once per instance; later calls share the first. It builds the kernel before it returns,
 *   and resolves once the kernel has answered whether it opened, at once while its upgrade is
 *   blocked. It never rejects.
 * @property {() => CoordinatorStatus} status - what a welcome says now
 * @property {() => CoordinatorHealth} health - what system.coordinatorHealth answers with
 * @property {() => Client} client
 *   The kernel the worker's own handlers run commands on, which counts each outcome by kind
 * @property {(reason: unknown) => Promise<void>} installed
 *   Starts it for an onInstalled event, and after an install or an update runs the read-only
 *   integrity check once: when the start opens, or while the upgrade is blocked, once the
 *   run's end lets it open
 */

/** The reason a welcome gives, and the code every command answers, when the kernel can't be built */
const UNAVAILABLE = 'coordinator-unavailable';

/**
 * The reason a welcome gives while an older build's open page blocks the run's upgrade (#17 PR
 * 1b), a migration and not a failure, which #20's `coordinator` provider shows as unverified
 */
const MIGRATING = 'migrating';

/** What the worker's kernel answers while that page blocks the upgrade */
const BLOCKED_UPGRADE = 'blocked-upgrade';

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
 * Journals `code` through `events`, and never throws, whatever `events` does: js/background.js
 * journals through it too, in top-level code, where a throw would stop the worker's start
 * @param {Events | null | undefined} events
 * @param {string} code
 * @param {Record<string, unknown>} fields
 * @param {unknown} [error]
 */
export function journal(events, code, fields, error) {
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

/**
 * The end of the migration attempt `built` answered `failure` from, when it says an older
 * build's open page blocks the run's upgrade (#17 PR 1b), and null for any other answer or a
 * kernel with no run behind it
 * @param {Client} built
 * @param {unknown} failure
 * @returns {Promise<unknown> | null}
 */
function blockedRun(built, failure) {
  const { code } = /** @type {{code?: unknown}} */ (failure && typeof failure === 'object' ? failure : {});
  if (code !== BLOCKED_UPGRADE) return null;
  const { migration } = /** @type {WithMigration} */ (/** @type {unknown} */ (built));
  return migration && migration.done ? migration.done : null;
}

/** @param {unknown} error */
const reportUnbuilt = error => console.error("NewTabNote: the background coordinator couldn't build its kernel", error);

/**
 * The router's handler for system.coordinatorHealth, which asks whichever coordinator
 * `current` gives at the time, since js/background.js installs the router before it builds one
 * @param {() => Coordinator} current
 * @param {{now(): number}} [clock]
 * @returns {Readonly<Record<string, Handler>>}
 */
export function coordinatorHandlers(current, clock = systemClock) {
  return Object.freeze({ 'system.coordinatorHealth': () => ready(clock.now(), current().health()) });
}

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
    health: () => ({
      status: /** @type {const} */ ('degraded'),
      reason: UNAVAILABLE,
      coordinatorId: instanceId,
      startedAt: null,
      commands: [],
      oldestOrphanedEntryAt: null,
    }),
    client: () => client,
    installed: start,
  });
}

/**
 * The worker's coordinator. `makeKernel` builds the worker's kernel, which opens the database
 * as it's built, so it's called on the first start, never before, and synchronously: start()
 * awaits nothing before it. A throw from it leaves the coordinator unavailable for this
 * instance, is `coordinator.start-failed`, and goes to `report`.
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
  /** @type {number | null} */
  let startedAt = null;
  /** @type {Map<string, number>} each command outcome's kind, and how many there were */
  const outcomes = new Map();
  /** Whether an install or an update asked for the integrity check while the upgrade was blocked */
  let checkWhenReady = false;

  /**
   * `built`, counting each command's outcome by kind for system.coordinatorHealth
   * @param {Client} built
   * @returns {Client}
   */
  const counted = built => {
    /** @param {import('../core/contracts/commands.js').Command} command */
    const execute = async command => {
      const outcome = await built.execute(command);
      outcomes.set(outcome.kind, (outcomes.get(outcome.kind) ?? 0) + 1);
      return outcome;
    };
    // The same overloads as the kernel's own execute, which this calls
    return Object.freeze({ ...built, execute: /** @type {Client['execute']} */ (/** @type {unknown} */ (execute)) });
  };

  /**
   * The read-only integrity check, on `checking`
   * @param {Client} checking
   * @returns {Promise<void>}
   */
  const check = async checking => {
    try {
      await checking.execute({ type: 'runIntegrityCheck', commandId: checking.ids.next() });
    } catch {
      // The check only reports what it finds, so one that couldn't run changes nothing
    }
  };

  /**
   * Asks `built` whether it opened, and moves `state` on its answer. While an older build's
   * open page blocks the run's upgrade, that's degraded `migrating`, not a failed open: this
   * resolves on the answer, so the start and what awaits it go on, and beside it waits on the
   * attempt's own end, never on a timer, then asks once more. `waited` is the attempt it last
   * waited on, so an answer that waiting can't change is a failed open, not a loop. It never
   * rejects.
   * @param {Client} built
   * @param {number} began - when the start began, for how long a failed open took
   * @param {Promise<unknown> | null} [waited]
   * @returns {Promise<void>}
   */
  const settle = async (built, began, waited = null) => {
    /** @type {unknown} */
    let failure;
    try {
      failure = await built.whenReady();
    } catch (error) {
      failure = error;
    }
    if (!failure) {
      state = 'ready';
      reason = '';
      // A start that opened resolves a coordinator.start-failed an earlier instance raised
      journal(events, 'coordinator.started', {});
      if (checkWhenReady) {
        checkWhenReady = false;
        await check(built);
      }
      return;
    }
    const ending = blockedRun(built, failure);
    if (ending && ending !== waited) {
      state = 'degraded';
      reason = MIGRATING;
      Promise.resolve(ending)
        .catch(() => {})
        .then(() => settle(built, began, ending))
        .catch(() => {});
      return;
    }
    state = 'degraded';
    reason = reasonOf(/** @type {{cause?: unknown, code?: unknown}} */ (failure));
    // The worker's storage init: an open that failed is a storage incident now, not only when
    // a capture finds it
    journal(
      events,
      'storage.open-failed',
      { subjectId: 'CanvasTabDB', durationMs: Math.max(0, clock.now() - began) },
      failure,
    );
  };

  const run = async () => {
    state = 'starting';
    const began = clock.now();
    startedAt = began;
    try {
      kernel = counted(makeKernel());
    } catch (error) {
      state = 'unavailable';
      reason = UNAVAILABLE;
      journal(events, 'coordinator.start-failed', {}, error);
      try {
        report(error);
      } catch {
        // Nothing a report throws changes what the worker answers
      }
      return;
    }
    await settle(kernel, began);
  };

  // run() builds the kernel before its first await, so client() is the built kernel as soon
  // as start() returns. An await ahead of makeKernel() would end that, and
  // test/kernel/coordinator.test.mjs fails on one.
  const start = () => {
    if (!started) started = run();
    return started;
  };

  /** @returns {CoordinatorStatus} */
  const status = () => {
    if (state === 'ready') return { status: 'ready' };
    return { status: 'degraded', reason: state === 'idle' || state === 'starting' ? 'starting' : reason };
  };

  return Object.freeze({
    instanceId,
    start,
    status,
    health: () => ({
      ...status(),
      coordinatorId: instanceId,
      startedAt,
      commands: [...outcomes].map(([outcome, count]) => ({
        outcome: /** @type {CoordinatorHealth['commands'][number]['outcome']} */ (outcome),
        count,
      })),
      // Until #35's journal (slice 3) there are no journal entries to replay
      oldestOrphanedEntryAt: null,
    }),
    client: () => kernel || unbuilt,
    async installed(installReason) {
      await start();
      if (!kernel || !CHECKED_ON.includes(/** @type {string} */ (installReason))) return;
      if (state === 'ready') {
        await check(kernel);
        return;
      }
      // While the upgrade is blocked, the check runs once the run's end lets the kernel open
      if (state === 'degraded' && reason === MIGRATING) checkWhenReady = true;
    },
  });
}
