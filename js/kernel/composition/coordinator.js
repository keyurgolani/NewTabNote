/**
 * The background coordinator's host in the service worker (#35 slice 1,
 * docs/adr/0001-kernel-stack.md, "Where the kernel runs"). js/background.js registers every
 * listener first and builds this last, so a throw while building it leaves the menus, the
 * commands and #13's port listener in place. Building it opens nothing: it starts once per
 * worker instance, on the first event that needs storage (an install or update, a browser
 * start, a page's hello on #13's port, a capture), and builds the worker's kernel then.
 *
 * Each welcome says what it can do (#13, "Handshake and compatibility"). A hello while it's
 * starting waits for the start, WELCOME_WAIT_MS at most. When the start takes longer, its
 * welcome says `migrating` while the run upgrades the database (#35 slice 2), and `starting`
 * otherwise. Once the start is in, it's `ready`, or degraded and why: the open's code
 * (`newer-schema`, `missing-core-stores`), else `storage-unavailable`, and
 * `coordinator-unavailable` when the kernel couldn't be built at all, which every command then
 * answers too. A start writes first-run settings only; the read-only integrity check runs
 * after an install or an update (`installed`). system.coordinatorHealth says the same, with
 * this instance's start and the commands it ran by outcome. Loading this module touches no
 * browser API.
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
 *
 * Once it's ready it drains #35's journal (slice 3, ./journal.js), as it runs the integrity
 * check: after the start, never inside it, so a hello held while it starts never waits for a
 * drain, and one that comes during a drain is welcomed `ready` at once. drain() runs one more
 * when a page wakes the worker for it. system.coordinatorHealth says when the oldest entry the
 * last drain left with no live owner was written, names the notes it held back (slice 3b), and
 * says the last stop it made at an entry, with how many drains in a row stopped there (`stuck`,
 * #35 slice 4b-1), so a drain stuck at one entry shows before its incident is raised.
 *
 * One queue runs the kernel's commands one at a time, in the order they came (#35 slice 4a, "One
 * committer"): what a surface sends through a router's handler (enqueue()), the worker's own
 * capture among them, and the drain's replays, on client(). A command whose request ended before
 * its turn never runs. The read-only integrity check, the start's own maintenance and the
 * coordinator's health aren't on it, since none is a surface's command, and IndexedDB orders the
 * maintenance's transactions against the queue's.
 *
 * A turn has a bound of its own, TURN_LIMIT_MS from its start (#35 slice 4b-1): past it the queue
 * cuts the turn and starts the next, so one command that never settles can't hold every later one
 * for the worker's life. The cut command answers `unavailable`, retryable, `turn-exceeded`, and
 * commits nothing from the cut on (the kernel's fence, core/application/kernel.js, which the
 * adapter asks again inside the commit's transaction, #247), so no later command is overtaken by
 * an older one landing late. Only a commit IndexedDB had already begun can land after its cut, and
 * each that does is `coordinator.turn-landed-late`, by the command's type and its age then. A
 * caller with a client deadline had its answer from that client long before, since a client gives
 * up 31 s after it sends. One that sends with none, as the journal drain's replays and
 * js/background.js's rerun of a capture with no entry do, gets its answer from the cut
 * (contracts/limits.js, TURN_LIMIT_MS), and a journaled one replays at the next drain. Each cut is
 * `coordinator.turn-stuck`, by the command's type and how long it ran.
 * system.coordinatorHealth says which command holds the queue (`running`), and how many turns it
 * cut in this worker's life (`cutTurns`).
 *
 * It pauses while another context restores the notes (#35 slice 7, core/messaging/
 * restore-messages.js). It checks Web Lock `storage.restore` with `locks.query()` at its start,
 * before each dequeue, and at once on `storage.restoring`. While another context holds it, nothing
 * dequeues, its kernel opens nothing, its adapter closes once the command running then is in, and
 * each welcome and system.coordinatorHealth say `restoring`, which the router answers a command
 * still waiting at its deadline with. Queued commands need no flush to the journal: a journaled one
 * has its page's entry, and the rest answer `restoring` there. It resumes once it can take the lock
 * itself, so a restorer that dies mid-restore holds it no longer than its context lives (call 9),
 * and `storage.restored` only makes it check at once. Then it reopens its adapter, drains the
 * journal on the queue, and the commands that waited run in order, each asking its request's
 * `begin` at its own dequeue, so one the router answered meanwhile never runs.
 */

import { TURN_EXCEEDED } from '../core/application/kernel.js';
import { WORKER_PAGE_HANDLERS, WORKER_RECOVERY_HANDLERS } from '../core/application/handlers-worker.js';
import { isRecord } from '../core/contracts/checks.js';
import { TURN_LIMIT_MS } from '../core/contracts/limits.js';
import { HELD_NOTES_NAMED } from '../core/contracts/operations/system-coordinator-health.js';
import { failed, ready, unavailable } from '../core/contracts/outcomes.js';
import { RESTORE_LOCK, RESTORING } from '../core/messaging/restore-messages.js';
import { systemClock } from '../core/ports/runtime.js';
import { hostTimers, randomIds } from './messaging.js';

/** @typedef {import('./host.js').Client} Client */
/** @typedef {import('../core/contracts/commands.js').Command} Command */
/** @typedef {import('../core/contracts/outcomes.js').Outcome} Outcome */
/** @typedef {import('../core/contracts/outcomes.js').BulkOutcome} BulkOutcome */
/** @typedef {import('../core/contracts/outcomes.js').Unavailable} Unavailable */
/** @typedef {import('../core/contracts/operations/system-coordinator-health.js').CoordinatorHealth} CoordinatorHealth */
/** @typedef {import('../core/messaging/router.js').CoordinatorStatus} CoordinatorStatus */
/** @typedef {import('../core/messaging/router.js').Handler} Handler */
/** @typedef {import('../core/ports/runtime.js').Timers} Timers */
/** @typedef {NonNullable<CoordinatorHealth['running']>} RunningTurn */

/**
 * What the coordinator journals through: the worker's failure events (./trust.js's
 * createFailureEvents), which never throw, though a stand-in might
 * @typedef {{event(code: string, fields?: Record<string, unknown>, error?: unknown): void}} Events
 */

/**
 * The worker's journal, as the coordinator drains it (./journal.js): `held` is what its last drain
 * held back, and `stuck` the last stop it made at an entry, which an older journal can't say
 * @typedef {{
 *   drain(client: Client): Promise<unknown>,
 *   oldestOrphanedEntryAt(): number | null,
 *   held?: () => Array<{noteId: string, code: string}>,
 *   stuck?: () => {code: string, count?: number} | null,
 *   ownerGone?: (sessionId: string) => Promise<unknown>,
 * }} CoordinatorJournal
 */

/**
 * What a kernel with #17's migration run behind it adds (./background.js's worker client): the
 * latest attempt's end, which the coordinator waits on while the run's upgrade is blocked,
 * whether the run is upgrading now and whether that upgrade is blocked, which its
 * `migrating` reads (#35 slice 2), and the transforms and the catch-up the attempt starts,
 * which the integrity check after an install or an update waits for
 * @typedef {{
 *   migration?: {readonly done: Promise<unknown>, upgrading?: () => boolean, blocked?: () => boolean},
 *   transforms?: {readonly done: Promise<unknown>},
 *   recordsCatchUp?: {readonly done: Promise<unknown>},
 * }} WithMigration
 */

/**
 * What a worker kernel adds for the pause while another context restores (#35 slice 7,
 * ./background.js's worker client): close() closes its adapter, and reopen() opens one again,
 * through a new migration attempt
 * @typedef {{close?: () => unknown, reopen?: () => Promise<unknown>}} Pausable
 */

/**
 * Web Locks, as the coordinator watches Web Lock `storage.restore` with them (#35 slice 7):
 * query() for what's held now, and request(), which waits until it can take the lock
 * @typedef {{
 *   query: () => Promise<{held?: Array<{name?: string}>}>,
 *   request: (name: string, callback: () => unknown) => Promise<unknown>,
 * }} RestoreLocks
 */

/** A gate: `shut` waits until `open()` lets it through */
const gate = () => {
  /** @type {() => void} */
  let open = () => {};
  /** @type {Promise<unknown>} */
  const shut = new Promise(resolve => {
    open = () => resolve(undefined);
  });
  return { shut, open };
};

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
 *   The kernel the drain runs on, which counts each outcome by kind, with each command on the queue
 * @property {(command: Command, dispatch?: {begin?: () => boolean, surface?: import('../core/contracts/surfaces.js').Surface}) => Promise<Outcome | BulkOutcome | null>} enqueue
 *   Runs `command` on the queue for a router's handler, starting the coordinator first. With the
 *   router's `begin`, it runs only if the request is still waited on at its turn, and answers
 *   null when it isn't, since the router answered it then. With a page's `surface`, it runs on the
 *   worker's kernel of that surface (#35 slice 4b-2, rule 5). A coordinator that can't serve answers
 *   as client() does.
 * @property {(reason: unknown) => Promise<void>} installed
 *   Starts it for an onInstalled event, and after an install or an update runs the read-only
 *   integrity check once, after the transforms and the catch-up the start set off: when the
 *   start opens, or while the upgrade is blocked, once the run's end lets it open
 * @property {() => Promise<unknown>} drain
 *   Starts it, and once it's ready drains the journal, answering what the drain did; null when
 *   it isn't ready, since it drains once it is. It never rejects.
 * @property {(session: import('../core/messaging/router.js').Session) => Promise<unknown>} closed
 *   What the router tells it of a connection that closed: once the page that owns the session's
 *   entries is gone, it drains, so what that page journaled and sent just before it went lands then,
 *   not at the next start (#35 slice 4b-2, rule 7). It never rejects.
 * @property {() => Promise<CoordinatorStatus>} restoring
 *   What js/background.js tells it of a `storage.restoring` (#35 slice 7): it checks Web Lock
 *   `storage.restore` at once, and answers what a welcome says once it has paused, the command
 *   running then in and its adapter closed, or at once when no other context holds the lock. It
 *   never rejects.
 * @property {() => Promise<CoordinatorStatus>} restored
 *   What it tells it of a `storage.restored`: it checks the lock at once and answers what a welcome
 *   says then. The resume never waits for it. It never rejects.
 */

/** The reason a welcome gives, and the code every command answers, when the kernel can't be built */
const UNAVAILABLE = 'coordinator-unavailable';

/**
 * The reason a welcome gives while the run upgrades the database, and while an older build's
 * open page blocks that upgrade (#17 PR 1b, #35 slice 2): a migration and not a failure,
 * which #20's `coordinator` provider shows as unverified
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
 * The queue's turn task: what it runs, given its turn's `live`, which answers false once the
 * queue has cut the turn
 * @template T
 * @typedef {(live: () => boolean) => Promise<T>} Task
 */

/**
 * One FIFO queue (#35 slice 4a, "One committer"): each task runs once the one before it has
 * settled, in the order they came, and one that throws or rejects answers with that and lets the
 * next one run. A task given `begin` runs only if `begin()` answers true at its turn, as #13's
 * router's does while it still waits for the request (core/messaging/router.js, Dispatch), and
 * answers null when it doesn't.
 *
 * A turn that hasn't settled `limitMs` after it began, by `timers`, is cut (#35 slice 4b-1): the
 * next one starts, the task's `live()` answers false from then on, the turn answers `unavailable`,
 * retryable, `turn-exceeded`, and `onCut` hears the turn's type and how long it ran. What the task
 * settles with after its cut changes nothing, but `onLate` hears the type and the turn's age when
 * that's a commit (#247). `running()` is the turn that holds the queue: its type, when it began,
 * and how many wait behind it, or null while the queue is idle. `idle()` resolves once that turn
 * has its outcome or its cut, and at once while the queue is idle.
 *
 * `before`, when it's given, runs before each dequeue, and the turn waits for it (#35 slice 7: the
 * coordinator's check of Web Lock `storage.restore`, and its pause): `begin` is asked once it's in,
 * so a request that ended meanwhile never runs. One that throws or rejects holds nothing up.
 * @param {{
 *   timers?: Timers,
 *   clock?: {now(): number},
 *   limitMs?: number,
 *   onCut?: (type: string, ageMs: number) => void,
 *   onLate?: (type: string, ageMs: number) => void,
 *   before?: (() => unknown) | null,
 * }} [options]
 * @returns {{
 *   run: <T>(task: Task<T>, begin?: () => boolean, type?: string) => Promise<T | Unavailable | null>,
 *   running: () => RunningTurn | null,
 *   idle: () => Promise<unknown>,
 * }}
 */
export function commandQueue({
  timers = hostTimers,
  clock = systemClock,
  limitMs = TURN_LIMIT_MS,
  onCut = () => {},
  onLate = () => {},
  before = null,
} = {}) {
  /** @type {Promise<unknown>} */
  let tail = Promise.resolve();
  /** @type {{type: string, since: number, over: Promise<unknown>} | null} the turn that holds the queue */
  let current = null;
  /** How many turns wait behind the one that holds the queue */
  let waiting = 0;

  /**
   * One turn of `task`, from now: its answer, or the cut's once `limitMs` passes first
   * @template T
   * @param {Task<T>} task
   * @param {string} type
   * @returns {Promise<T | Unavailable>}
   */
  const turnOf = (task, type) =>
    new Promise((resolve, reject) => {
      const since = clock.now();
      const { shut: over, open: done } = gate();
      const turn = { type, since, over };
      current = turn;
      let cut = false;
      let settled = false;
      const end = () => {
        settled = true;
        if (current === turn) current = null;
        done();
      };
      const bound = timers.set(() => {
        if (settled) return;
        cut = true;
        end();
        onCut(type, Math.max(0, clock.now() - since));
        resolve(unavailable('coordinator', TURN_EXCEEDED, true));
      }, limitMs);
      /** @type {Promise<T>} */
      let ran;
      try {
        ran = Promise.resolve(task(() => !cut));
      } catch (error) {
        ran = Promise.reject(error);
      }
      ran.then(
        value => {
          if (cut) {
            // A commit IndexedDB had begun before the cut, which no check inside it could stop
            if (isRecord(value) && value.kind === 'committed') onLate(type, Math.max(0, clock.now() - since));
            return;
          }
          end();
          timers.clear(bound);
          resolve(value);
        },
        error => {
          if (cut) return;
          end();
          timers.clear(bound);
          reject(error);
        },
      );
    });

  return Object.freeze({
    /**
     * @template T
     * @param {Task<T>} task
     * @param {() => boolean} [begin]
     * @param {string} [type] - the command's type, which running() names the turn by
     * @returns {Promise<T | Unavailable | null>}
     */
    run(task, begin = () => true, type = '') {
      waiting++;
      const due = before
        ? tail
            .then(() => before())
            .then(
              () => {},
              () => {},
            )
        : tail;
      const turn = due.then(() => {
        waiting--;
        return begin() ? turnOf(task, type) : null;
      });
      tail = turn.then(
        () => {},
        () => {},
      );
      return turn;
    },
    running: () =>
      current ? { type: /** @type {RunningTurn['type']} */ (current.type), since: current.since, waiting } : null,
    idle: () => (current ? current.over : Promise.resolve()),
  });
}

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
 * The router's handlers for the commands a page sends over the port (#35 slice 4b-2, rule 5): each
 * waits its turn on the queue of whichever coordinator `current` gives, with its request's `begin`,
 * so it runs only if it's still waited on then, and on the worker's kernel of the surface the router
 * verified, which checks that surface again. recovery.html's rebuild batches are among them (#35
 * slice 8), so js/background.js serves them with no handler of its own.
 * @param {() => Coordinator} current
 * @returns {Readonly<Record<string, Handler>>}
 */
export function pageCommandHandlers(current) {
  /** @type {Handler} */
  const onQueue = (payload, { caller, begin }) =>
    current().enqueue(/** @type {Command} */ (payload), { begin, surface: caller.surface });
  const types = [...Object.keys(WORKER_PAGE_HANDLERS.commands), ...Object.keys(WORKER_RECOVERY_HANDLERS.commands)];
  return Object.freeze(Object.fromEntries(types.map(type => [type, onQueue])));
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
  /** @returns {CoordinatorStatus} */
  const status = () => ({ status: 'degraded', reason: UNAVAILABLE });
  return Object.freeze({
    instanceId,
    start,
    status,
    health: () => ({
      status: /** @type {const} */ ('degraded'),
      reason: UNAVAILABLE,
      coordinatorId: instanceId,
      startedAt: null,
      commands: [],
      oldestOrphanedEntryAt: null,
      migration: null,
    }),
    client: () => client,
    enqueue: command => client.execute(command),
    installed: start,
    drain: () => Promise.resolve(null),
    closed: () => Promise.resolve(null),
    // It holds nothing open, so a restore waits on nothing of it (#35 slice 7)
    restoring: () => Promise.resolve(status()),
    restored: () => Promise.resolve(status()),
  });
}

/**
 * The worker's coordinator. `makeKernel` builds the worker's kernel, which opens the database
 * as it's built, so it's called on the first start, never before, and synchronously: start()
 * awaits nothing before it. A throw from it leaves the coordinator unavailable for this
 * instance, is `coordinator.start-failed`, and goes to `report`.
 * `journal` is the worker's journal, which it drains once it's ready (#35 slice 3). `timers` time
 * each turn on its queue against TURN_LIMIT_MS (#35 slice 4b-1). With `locks`, navigator.locks in
 * the worker, it pauses while another context holds Web Lock `storage.restore` (#35 slice 7), and
 * hands makeKernel `whenClear`, which each of the kernel's attempts waits for before it reads or
 * opens anything. Without them it never pauses.
 * @param {{
 *   instanceId: string,
 *   makeKernel: (gates: {whenClear: () => Promise<unknown>}) => Client,
 *   events?: Events | null,
 *   clock?: {now(): number},
 *   timers?: Timers,
 *   report?: (error: unknown) => void,
 *   journal?: CoordinatorJournal | null,
 *   locks?: RestoreLocks | null,
 * }} options
 * @returns {Coordinator}
 */
export function createCoordinator({
  instanceId,
  makeKernel,
  events = null,
  clock = systemClock,
  timers = hostTimers,
  report = reportUnbuilt,
  journal: entries = null,
  locks = null,
}) {
  /** @type {'idle' | 'starting' | 'ready' | 'degraded' | 'unavailable'} */
  let state = 'idle';
  /** @type {string} */
  let reason = '';
  /** @type {Client | null} */
  let kernel = null;
  /** How many turns the queue cut in this worker's life (#35 slice 4b-1) */
  let cutTurns = 0;
  /** Whether another context holds `storage.restore`, as last checked, so it's paused (#35 slice 7) */
  let paused = false;
  /** Whether the kernel's storage may be open: its start's check found no restore, or it resumed */
  let opened = false;
  /** Whether this pause closed the kernel's adapter, so the resume reopens it */
  let closed = false;
  /** @type {Promise<void>} the start's check of the lock, which the kernel and the queue wait for */
  let startChecked = Promise.resolve();
  /** @type {Promise<unknown>} resolves once the pause holds nothing open */
  let quiet = Promise.resolve();
  /** @type {Promise<void> | null} the coordinator's own wait to take the lock */
  let lockWait = null;
  /** @type {ReturnType<typeof gate> | null} what the kernel's attempts wait on, from a pause until the lock frees */
  let storageGate = null;
  /** @type {ReturnType<typeof gate> | null} what each dequeue waits on, from a pause until its reopen is in */
  let queueGate = null;
  /**
   * The one queue the kernel's commands wait their turn on (#35 slice 4a). A turn it cuts is
   * journaled by the command's type and how long it ran, and nothing more: no incident, since a
   * journaled command replays at the next drain, and the health shows the cut (the lead's ruling).
   * With `locks`, each dequeue first checks for a restore, and waits out a pause (#35 slice 7).
   */
  const queue = commandQueue({
    timers,
    clock,
    onCut: (type, ageMs) => {
      cutTurns++;
      journal(events, 'coordinator.turn-stuck', { commandType: type, ageMs });
    },
    // A cut command that landed anyway, journaled as each cut is, with no incident and no count
    // (#247, the lead's ruling)
    onLate: (type, ageMs) => journal(events, 'coordinator.turn-landed-late', { commandType: type, ageMs }),
    before: locks
      ? async () => {
          await startChecked;
          if (!paused && (await heldElsewhere())) pause();
          while (queueGate) await queueGate.shut;
        }
      : null,
  });

  /**
   * Whether another context holds Web Lock `storage.restore` now. A lock manager that can't say
   * holds nothing up. It never rejects.
   * @returns {Promise<boolean>}
   */
  const heldElsewhere = async () => {
    if (!locks) return false;
    try {
      const snapshot = await locks.query();
      const held = snapshot && Array.isArray(snapshot.held) ? snapshot.held : [];
      return held.some(lock => Boolean(lock) && lock.name === RESTORE_LOCK);
    } catch {
      return false;
    }
  };

  /** What each of the kernel's attempts waits for before it reads or opens anything */
  const whenClear = () => startChecked.then(() => (storageGate ? storageGate.shut : undefined));

  /** Closes the kernel's adapter for the pause, where its kernel can (Pausable) */
  const closeKernel = () => {
    try {
      const { close } = /** @type {Pausable} */ (/** @type {unknown} */ (kernel ?? {}));
      if (typeof close === 'function') close();
    } catch {
      // A close that throws leaves nothing more to do
    }
  };

  /**
   * Pauses while another context restores: nothing dequeues, the kernel opens nothing, its adapter
   * closes once the command running now is in, and it waits to take the lock itself
   */
  const pause = () => {
    if (paused) return;
    paused = true;
    if (!storageGate) storageGate = gate();
    if (!queueGate) queueGate = gate();
    quiet = opened
      ? queue.idle().then(() => {
          if (paused && !closed) {
            closed = true;
            closeKernel();
          }
        })
      : Promise.resolve();
    waitForRestore();
  };

  /**
   * Waits until it can take the lock, which frees whether the restorer let it go or its context
   * died (call 9), lets it go at once, and resumes. It never rejects.
   */
  const waitForRestore = () => {
    if (lockWait || !locks) return;
    const held = locks;
    lockWait = Promise.resolve()
      .then(() => held.request(RESTORE_LOCK, () => undefined))
      .catch(() => undefined)
      .then(() => {
        lockWait = null;
        return resume();
      })
      .catch(() => undefined);
  };

  /** Lets the commands that waited go on, in order, unless another pause has begun */
  const release = () => {
    if (paused || !queueGate) return;
    const waited = queueGate;
    queueGate = null;
    waited.open();
  };

  /**
   * Resumes once no other context holds the lock: the kernel may open again, its adapter reopens
   * if this pause closed it, and once its open has answered, it drains the journal on the queue
   * and lets the commands that waited go on
   */
  const resume = async () => {
    // Another restore may have taken the lock as this one let it go
    if (await heldElsewhere()) {
      waitForRestore();
      return;
    }
    paused = false;
    const reopening = closed;
    closed = false;
    opened = true;
    const storage = storageGate;
    storageGate = null;
    if (storage) storage.open();
    try {
      const { reopen } = /** @type {Pausable} */ (/** @type {unknown} */ (kernel ?? {}));
      if (reopening && typeof reopen === 'function') await reopen();
    } catch {
      // Its open answers why it couldn't, below
    }
    try {
      if (kernel && state !== 'unavailable') await settle(kernel, clock.now());
    } finally {
      release();
    }
  };

  /**
   * Checks the lock now, and pauses while another context holds it. It never rejects.
   * @returns {Promise<void>}
   */
  const checkNow = async () => {
    if (!locks) return;
    await startChecked;
    if (await heldElsewhere()) pause();
  };
  /** @type {Client | null} the kernel with each command on the queue: what client() hands out and the drain runs on */
  let queued = null;
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
   * Drains the journal on `built`, in the background of whatever asked: never inside a start,
   * and never rejecting, whatever the journal does
   * @param {Client} built
   * @returns {Promise<unknown>}
   */
  const drainOn = built => {
    if (!entries) return Promise.resolve(null);
    return Promise.resolve()
      .then(() => entries.drain(built))
      .catch(() => null);
  };

  /**
   * `built`, counting each command's outcome by kind for system.coordinatorHealth
   * @param {Client} built
   * @returns {Client}
   */
  const counted = built => {
    /**
     * @param {import('../core/contracts/commands.js').Command} command
     * @param {import('../core/application/kernel.js').ExecuteOptions} [options]
     */
    const execute = async (command, options) => {
      const outcome = await built.execute(command, options);
      outcomes.set(outcome.kind, (outcomes.get(outcome.kind) ?? 0) + 1);
      return outcome;
    };
    // The same overloads as the kernel's own execute, which this calls
    return Object.freeze({ ...built, execute: /** @type {Client['execute']} */ (/** @type {unknown} */ (execute)) });
  };

  /**
   * `command` run on `built` in its turn on the queue, `begin` deciding at its turn whether it
   * still runs, and its turn's `live` going with it to the kernel's commit, with the `surface` of
   * the page that sent it, whose kernel it runs on (#35 slice 4b-2, rule 5)
   * @param {Client} built
   * @param {Command} command
   * @param {() => boolean} [begin]
   * @param {import('../core/contracts/surfaces.js').Surface} [surface]
   */
  const inTurn = (built, command, begin, surface) =>
    queue.run(live => built.execute(command, { live, surface }), begin, /** @type {string} */ (command?.type));

  /**
   * `built`, with each command it runs waiting its turn on the queue
   * @param {Client} built
   * @returns {Client}
   */
  const onQueue = built => {
    /** @param {Command} command */
    const execute = command => inTurn(built, command);
    // The same overloads as the kernel's own execute, which this calls in its turn
    return Object.freeze({ ...built, execute: /** @type {Client['execute']} */ (/** @type {unknown} */ (execute)) });
  };

  /**
   * The read-only integrity check, on `checking`, once the transforms and the catch-up its
   * attempt started are in (#35 slice 2), so it reads what they leave
   * @param {Client} checking
   * @returns {Promise<void>}
   */
  const check = async checking => {
    const { transforms, recordsCatchUp } = /** @type {WithMigration} */ (/** @type {unknown} */ (checking));
    for (const step of [transforms, recordsCatchUp]) {
      try {
        if (step) await step.done;
      } catch {
        // A step that failed journals itself, and the check goes on
      }
    }
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
    // Another context began a restore meanwhile, so the resume asks again (#35 slice 7)
    if (paused) return;
    if (!failure) {
      state = 'ready';
      reason = '';
      // A start that opened resolves a coordinator.start-failed an earlier instance raised
      journal(events, 'coordinator.started', {});
      // What a context journaled and didn't live to see answered, after the start, which
      // nothing that waits on the start waits for (#35 slice 3), each replay on the queue
      drainOn(queued || onQueue(built));
      // After a pause, the commands that waited go on now, ahead of the drain's replays
      release();
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
    // The start's check of `storage.restore` (#35 slice 7), begun before the kernel is built and
    // never awaited before it: the kernel's first attempt waits for it, so it opens nothing while
    // another context restores
    if (locks) {
      startChecked = heldElsewhere().then(held => {
        if (held) pause();
        else opened = true;
      });
    } else {
      opened = true;
    }
    try {
      kernel = counted(makeKernel({ whenClear }));
      queued = onQueue(kernel);
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
    if (locks) {
      await startChecked;
      // Another context restores: the start resolves now, so a hello is welcomed `restoring` at
      // once, and the resume opens the kernel once that context lets the lock go
      if (paused) return;
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

  /**
   * What the structural run is doing while the coordinator says `migrating` (#35 slice 2):
   * `running` while it upgrades, `blocked` while an older build's open page holds that
   * upgrade, and null otherwise
   * @returns {'running' | 'blocked' | null}
   */
  const migrationNow = () => {
    const migration = kernel ? /** @type {WithMigration} */ (/** @type {unknown} */ (kernel)).migration : undefined;
    // It says `restoring` then, not `migrating` (#35 slice 7)
    if (paused) return null;
    if (state === 'degraded' && reason === MIGRATING) {
      return migration && typeof migration.blocked === 'function' && !migration.blocked() ? 'running' : 'blocked';
    }
    if (state === 'starting' && migration && typeof migration.upgrading === 'function' && migration.upgrading()) {
      return 'running';
    }
    return null;
  };

  /**
   * When the oldest entry the last drain left with no live owner was written, or null
   * @returns {number | null}
   */
  const oldestOrphaned = () => {
    try {
      const at = entries ? entries.oldestOrphanedEntryAt() : null;
      return Number.isSafeInteger(at) && /** @type {number} */ (at) >= 0 ? at : null;
    } catch {
      return null;
    }
  };

  /**
   * The notes the last drain held back, the first HELD_NOTES_NAMED by id and the code each
   * stopped at, with the total of every one held (slice 3b), or nothing while none is held, so the
   * answer is as before then. A journal that can't say names none.
   * @returns {{held?: NonNullable<CoordinatorHealth['held']>}}
   */
  const heldNotes = () => {
    try {
      const list = entries && typeof entries.held === 'function' ? entries.held() : [];
      if (!Array.isArray(list) || list.length === 0) return {};
      const notes = list.map(({ noteId, code }) => ({ noteId, code }));
      return { held: { total: notes.length, notes: notes.slice(0, HELD_NOTES_NAMED) } };
    } catch {
      return {};
    }
  };

  /**
   * The last stop the last drain made at an entry, with how many drains in a row stopped there
   * where that's counted (#35 slice 4b-1, Q6), or nothing while it made none, so the answer is as
   * before then. A journal that can't say says none.
   * @returns {{stuck?: NonNullable<CoordinatorHealth['stuck']>}}
   */
  const stuckNow = () => {
    try {
      const stuck = entries && typeof entries.stuck === 'function' ? entries.stuck() : null;
      if (!stuck || typeof stuck.code !== 'string') return {};
      const { code, count } = stuck;
      return { stuck: Number.isSafeInteger(count) ? { code, count } : { code } };
    } catch {
      return {};
    }
  };

  /**
   * The turn that holds the queue, while one does, and the turns it cut, from the first (#35 slice
   * 4b-1), so the answer is as before while neither is there
   * @returns {{running?: RunningTurn, cutTurns?: number}}
   */
  const turnNow = () => {
    const running = queue.running();
    return { ...(running ? { running } : {}), ...(cutTurns > 0 ? { cutTurns } : {}) };
  };

  /** @returns {CoordinatorStatus} */
  const status = () => {
    // Another context restores, and nothing dequeues until it lets the lock go (#35 slice 7)
    if (paused) return { status: 'degraded', reason: RESTORING };
    if (state === 'ready') return { status: 'ready' };
    if (migrationNow() !== null) return { status: 'degraded', reason: MIGRATING };
    return { status: 'degraded', reason: state === 'idle' || state === 'starting' ? 'starting' : reason };
  };

  /**
   * What a drain once it's ready did, and null while it isn't ready, or while another context
   * restores, since the resume drains (#35 slice 7)
   * @returns {Promise<unknown>}
   */
  const drain = async () => {
    await start();
    if (state !== 'ready' || !queued || paused) return null;
    return drainOn(queued);
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
      oldestOrphanedEntryAt: oldestOrphaned(),
      migration: migrationNow(),
      ...heldNotes(),
      ...stuckNow(),
      ...turnNow(),
    }),
    client: () => queued || unbuilt,
    enqueue(command, { begin, surface } = {}) {
      start();
      const built = kernel;
      if (!built) return unbuilt.execute(command);
      return inTurn(built, command, begin, surface);
    },
    async installed(installReason) {
      await start();
      if (!kernel || !CHECKED_ON.includes(/** @type {string} */ (installReason))) return;
      if (state === 'ready' && !paused) {
        await check(kernel);
        return;
      }
      // While the upgrade is blocked, or another context restores (#35 slice 7), the check runs
      // once the kernel opens, and never reopens it meanwhile
      if (paused || (state === 'degraded' && reason === MIGRATING)) checkWhenReady = true;
    },
    drain,
    closed(session) {
      if (!entries || typeof entries.ownerGone !== 'function') return Promise.resolve(null);
      const owner = entries.ownerGone;
      return Promise.resolve()
        .then(() => owner(session.sessionId))
        .then(drain, () => null);
    },
    async restoring() {
      await checkNow();
      await quiet;
      return status();
    },
    async restored() {
      await checkNow();
      return status();
    },
  });
}
