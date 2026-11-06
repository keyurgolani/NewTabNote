// The background coordinator's host (#35 slice 1, js/kernel/composition/coordinator.js), on
// a fake kernel: it builds the worker's kernel on its first start and never before, says
// what each welcome says (`starting`, `ready`, or degraded and why), and after an install or
// an update runs the read-only integrity check once. A kernel that can't be built leaves it
// unavailable, every command answers so, and it's `coordinator.start-failed`; a start that
// opens is `coordinator.started`. system.coordinatorHealth says the same, with when it started
// and its commands by outcome. Nothing it journals or reports changes what it answers. Once it's
// ready it drains #35's journal (slice 3), never inside its start, so a hello held while it
// starts never waits for a drain. Its one queue runs a command at a time (slice 4a), and cuts a
// turn that runs TURN_LIMIT_MS from its start (slice 4b-1). test/background-coordinator.test.js
// runs it in js/background.js.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  coordinatorHandlers,
  coordinatorInstanceId,
  createCoordinator,
  unavailableCoordinator,
} from '../../js/kernel/composition/coordinator.js';

/** When a journal entry was written, for the health's oldest orphaned entry */
const NOW_AT = Date.UTC(2026, 9, 20, 12, 0, 0);

/**
 * A turn's bound on the queue, as the lead ruled it: 120 s from the turn's start (#35 slice 4b-1,
 * TURN_LIMIT_MS in js/kernel/core/contracts/limits.js). The cases hold the queue to it a
 * millisecond either side, so they pin the module's value too.
 */
const TURN_LIMIT_MS = 120_000;

/** What a command and a query answer from a coordinator whose kernel couldn't be built */
const UNAVAILABLE = Object.freeze({
  kind: 'unavailable',
  cause: 'coordinator',
  code: 'coordinator-unavailable',
  retryable: false,
  messageKey: 'unavailable.coordinator-unavailable',
  severity: 'error',
});

/**
 * A kernel client whose open settles when the test says, with `failure` (null: it opened),
 * or rejecting when `rejects`, and that keeps the commands it runs
 * @param {{failure?: unknown, rejects?: boolean}} [options]
 */
function fakeKernel({ failure = null, rejects = false } = {}) {
  /** @type {() => void} */
  let open = () => {};
  const opened = new Promise((resolve, reject) => {
    open = () => (rejects ? reject(new Error('the open threw')) : resolve(failure));
  });
  /** @type {Array<Record<string, unknown>>} */
  const executed = [];
  let next = 0;
  const client = {
    execute: async (/** @type {Record<string, unknown>} */ command) => {
      executed.push(command);
      return { kind: 'committed', code: 'integrity-checked', changedIds: [] };
    },
    query: async () => ({ kind: 'empty', asOf: 0 }),
    subscribe: () => () => {},
    whenReady: () => opened,
    ids: { next: () => `id-${++next}` },
  };
  return { client: /** @type {any} */ (client), open, executed };
}

/** What the worker's kernel answers while an older build's open page blocks its upgrade (#17 PR 1b) */
const BLOCKED = Object.freeze({ kind: 'unavailable', cause: 'storage', code: 'blocked-upgrade', retryable: true });

/**
 * A kernel with a migration run behind it whose upgrade an older build's open page blocks, as
 * js/kernel/composition/background.js's worker client is: it answers BLOCKED at once, counting
 * each ask, and says its upgrade is blocked, until the test ends the attempt. `unblock` ends it
 * with the page gone, after which it opens with `failure` (null: it opened); with `held`, that
 * open waits until the test calls the function `unblock` returns. `endStillBlocked` ends it
 * and keeps answering BLOCKED; `blockAgain` starts another attempt, blocked too.
 * @param {{failure?: unknown}} [options]
 */
function blockedKernel({ failure = null } = {}) {
  /** @type {(outcome: unknown) => void} */
  let end = () => {};
  /** @type {Promise<unknown>} */
  let done = new Promise(resolve => {
    end = resolve;
  });
  let blocked = true;
  /** @type {Promise<void> | null} */
  let opening = null;
  const asks = { count: 0 };
  /** @type {Array<Record<string, unknown>>} */
  const executed = [];
  let next = 0;
  const client = {
    execute: async (/** @type {Record<string, unknown>} */ command) => {
      executed.push(command);
      return { kind: 'committed', code: 'integrity-checked', changedIds: [] };
    },
    query: async () => ({ kind: 'empty', asOf: 0 }),
    subscribe: () => () => {},
    whenReady: async () => {
      asks.count++;
      if (blocked) return BLOCKED;
      if (opening) await opening;
      return failure;
    },
    ids: { next: () => `id-${++next}` },
    migration: Object.freeze({
      get done() {
        return done;
      },
      blocked: () => blocked,
    }),
  };
  return {
    client: /** @type {any} */ (client),
    asks,
    executed,
    /** @param {{held?: boolean}} [options] */
    unblock({ held = false } = {}) {
      /** @type {() => void} */
      let open = () => {};
      if (held) {
        opening = new Promise(resolve => {
          open = () => resolve(undefined);
        });
      }
      blocked = false;
      end({ status: 'migrated' });
      return open;
    },
    endStillBlocked() {
      end({ status: 'migrated' });
    },
    blockAgain() {
      const ended = end;
      done = new Promise(resolve => {
        end = resolve;
      });
      ended({ status: 'failed' });
    },
  };
}

/**
 * A kernel whose migration run upgrades a database that was there until the test ends it, as
 * js/kernel/composition/background.js's worker client is while its run upgrades: its open
 * waits for the attempt, and `migration.upgrading()` says so meanwhile. `finish` ends the
 * attempt, after which it opens. With `upgrades` false, its run finds nothing to upgrade, as
 * on a current database.
 * @param {{upgrades?: boolean}} [options]
 */
function upgradingKernel({ upgrades = true } = {}) {
  let upgrading = upgrades;
  /** @type {() => void} */
  let open = () => {};
  const opened = new Promise(resolve => {
    open = () => {
      upgrading = false;
      resolve(null);
    };
  });
  /** @type {Array<Record<string, unknown>>} */
  const executed = [];
  let next = 0;
  const client = {
    execute: async (/** @type {Record<string, unknown>} */ command) => {
      executed.push(command);
      return { kind: 'committed', code: 'integrity-checked', changedIds: [] };
    },
    query: async () => ({ kind: 'empty', asOf: 0 }),
    subscribe: () => () => {},
    whenReady: () => opened,
    ids: { next: () => `id-${++next}` },
    migration: Object.freeze({
      get done() {
        return opened;
      },
      upgrading: () => upgrading,
      blocked: () => false,
    }),
  };
  return { client: /** @type {any} */ (client), executed, finish: () => open() };
}

/** Lets `n` rounds of queued work run: every promise reaction, then the next macrotask */
async function turns(n = 5) {
  for (let i = 0; i < n; i++) await new Promise(resolve => setImmediate(resolve));
}

/** A journal that keeps each event as [code, fields, error] */
function recordedEvents() {
  /** @type {Array<[string, unknown, unknown]>} */
  const seen = [];
  return {
    seen,
    events: {
      event: (/** @type {string} */ code, /** @type {unknown} */ fields, /** @type {unknown} */ error) =>
        seen.push([code, fields, error]),
    },
  };
}

/**
 * A coordinator on `kernel`, counting the times it builds it
 * @param {{client: any}} kernel - fakeKernel()'s or blockedKernel()'s
 * @param {Record<string, unknown>} [options]
 */
function coordinatorOn(kernel, options = {}) {
  const built = { count: 0 };
  const coordinator = createCoordinator({
    instanceId: 'coordinator-1',
    makeKernel: () => {
      built.count++;
      return kernel.client;
    },
    report: () => {},
    ...options,
  });
  return { coordinator, built };
}

describe('the background coordinator (#35 slice 1)', () => {
  it('builds nothing until its first start, starts once however often it is asked, and says starting until the open', async () => {
    const kernel = fakeKernel();
    const { seen, events } = recordedEvents();
    const { coordinator, built } = coordinatorOn(kernel, { events });
    assert.equal(coordinator.instanceId, 'coordinator-1');
    assert.equal(built.count, 0);
    assert.deepEqual(coordinator.status(), { status: 'degraded', reason: 'starting' });

    const first = coordinator.start();
    assert.equal(coordinator.start(), first);
    assert.equal(built.count, 1);
    assert.deepEqual(coordinator.status(), { status: 'degraded', reason: 'starting' });

    kernel.open();
    await first;
    assert.deepEqual(coordinator.status(), { status: 'ready' });
    await coordinator.start();
    assert.equal(built.count, 1);
    // A start that opened resolves a coordinator.start-failed an earlier instance raised (#20)
    assert.deepEqual(seen, [['coordinator.started', {}, undefined]]);
    // The worker's handlers run on the kernel it built
    await coordinator.client().execute({ type: 'runIntegrityCheck', commandId: 'c1' });
    assert.deepEqual(kernel.executed, [{ type: 'runIntegrityCheck', commandId: 'c1' }]);
  });

  it("says why it's degraded when the open failed, and journals the failed open with how long it took", async () => {
    for (const [failure, reason] of /** @type {Array<[unknown, string]>} */ ([
      [{ kind: 'unavailable', cause: 'newer-schema', code: 'version-too-new' }, 'newer-schema'],
      [{ kind: 'unavailable', cause: 'storage', code: 'missing-core-stores' }, 'missing-core-stores'],
      [{ kind: 'unavailable', cause: 'storage', code: 'open-failed' }, 'storage-unavailable'],
    ])) {
      const kernel = fakeKernel({ failure });
      const { seen, events } = recordedEvents();
      let now = 1000;
      const { coordinator } = coordinatorOn(kernel, { events, clock: { now: () => now } });
      const started = coordinator.start();
      now = 1250;
      kernel.open();
      await started;
      assert.deepEqual(coordinator.status(), { status: 'degraded', reason }, reason);
      assert.deepEqual(seen, [['storage.open-failed', { subjectId: 'CanvasTabDB', durationMs: 250 }, failure]], reason);
      // Its commands answer the failure themselves
      assert.equal(await coordinator.client().whenReady(), failure, reason);
    }

    const kernel = fakeKernel({ rejects: true });
    const { seen, events } = recordedEvents();
    const { coordinator } = coordinatorOn(kernel, { events });
    const started = coordinator.start();
    kernel.open();
    await started;
    assert.deepEqual(coordinator.status(), { status: 'degraded', reason: 'storage-unavailable' });
    assert.deepEqual(
      seen.map(([code]) => code),
      ['storage.open-failed'],
    );
  });

  it("is unavailable when its kernel can't be built: every command answers so, and the journal and the report hear why once", async () => {
    const thrown = new Error('no Storage');
    /** @type {unknown[]} */
    const reported = [];
    let builds = 0;
    const { seen, events } = recordedEvents();
    const coordinator = createCoordinator({
      instanceId: 'coordinator-1',
      makeKernel: () => {
        builds++;
        throw thrown;
      },
      events,
      report: error => reported.push(error),
    });
    // The throw never leaves the start, even one nobody awaits, as js/background.js's
    // storage.migrate handler and storageUpgrade start it
    /** @type {unknown[]} */
    const unhandled = [];
    const onUnhandled = (/** @type {unknown} */ reason) => unhandled.push(reason);
    process.on('unhandledRejection', onUnhandled);
    try {
      coordinator.start();
      await turns();
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
    assert.deepEqual(unhandled, []);
    await coordinator.start();
    await coordinator.installed('install');
    assert.equal(builds, 1);
    assert.deepEqual(reported, [thrown]);
    // #20 raises the coordinator provider's incident from it
    assert.deepEqual(seen, [['coordinator.start-failed', {}, thrown]]);
    assert.deepEqual(coordinator.status(), { status: 'degraded', reason: 'coordinator-unavailable' });
    const client = coordinator.client();
    assert.deepEqual(await client.execute({ type: 'runIntegrityCheck', commandId: client.ids.next() }), UNAVAILABLE);
    assert.deepEqual(await client.whenReady(), UNAVAILABLE);
    assert.deepEqual(await client.query({ type: 'listFolders' }), {
      kind: 'failed',
      cause: 'coordinator',
      code: 'coordinator-unavailable',
    });
    assert.equal(typeof client.ids.next(), 'string');
  });

  it('answers the same when its journal or its report throws', async () => {
    const throwing = {
      event: () => {
        throw new Error('the journal is broken');
      },
    };
    const kernel = fakeKernel({ failure: { kind: 'unavailable', cause: 'storage', code: 'open-failed' } });
    const { coordinator } = coordinatorOn(kernel, { events: throwing });
    const started = coordinator.start();
    kernel.open();
    await started;
    assert.deepEqual(coordinator.status(), { status: 'degraded', reason: 'storage-unavailable' });

    const unbuilt = createCoordinator({
      instanceId: 'coordinator-2',
      makeKernel: () => {
        throw new Error('no Storage');
      },
      events: throwing,
      report: () => {
        throw new Error('the console is broken');
      },
    });
    await unbuilt.start();
    assert.deepEqual(unbuilt.status(), { status: 'degraded', reason: 'coordinator-unavailable' });
  });
});

describe("the coordinator on a kernel with #17's migration run (PR 1b)", () => {
  it('builds the kernel before start() returns, so client() is the built kernel at once, its run included', () => {
    // js/background.js's storage.migrate handler and #34's storageUpgrade start it, then read
    // the run at once: an await ahead of makeKernel() in start() fails this
    const kernel = blockedKernel();
    const { coordinator, built } = coordinatorOn(kernel);
    assert.equal(/** @type {any} */ (coordinator.client()).migration, undefined, 'the stand-in until the start');
    coordinator.start();
    assert.equal(built.count, 1);
    assert.equal(/** @type {any} */ (coordinator.client()).migration, kernel.client.migration);
  });

  it("is migrating while an older build's open page blocks the upgrade: no failed open, no asks while it waits, and ready once the run ends", async () => {
    const kernel = blockedKernel();
    const { seen, events } = recordedEvents();
    const { coordinator } = coordinatorOn(kernel, { events });
    // No timer, of any length: whatever one it set, it would show here
    const timers = { count: 0 };
    const { setTimeout: realTimeout, setInterval: realInterval } = globalThis;
    globalThis.setTimeout = /** @type {any} */ ((/** @type {any[]} */ ...args) => {
      timers.count++;
      return /** @type {any} */ (realTimeout)(...args);
    });
    globalThis.setInterval = /** @type {any} */ ((/** @type {any[]} */ ...args) => {
      timers.count++;
      return /** @type {any} */ (realInterval)(...args);
    });
    try {
      // The start resolves on the kernel's first answer, so what awaits it, a capture, goes on
      await coordinator.start();
      assert.deepEqual(coordinator.status(), { status: 'degraded', reason: 'migrating' });
      assert.deepEqual(coordinator.health().reason, 'migrating');
      // A capture hears the blocked upgrade at once, and makes its own refusal of it
      assert.deepEqual(await coordinator.client().whenReady(), BLOCKED);
      await turns(50);
    } finally {
      globalThis.setTimeout = realTimeout;
      globalThis.setInterval = realInterval;
    }
    assert.equal(timers.count, 0, 'no timer');
    assert.equal(kernel.asks.count, 2, "the start's ask and the capture's: the coordinator waits on the run, not a timer");
    assert.deepEqual(seen, [], 'a blocked upgrade is no failed open');
    assert.deepEqual(coordinator.status(), { status: 'degraded', reason: 'migrating' });

    // The older page closes, the upgrade goes on, and the run ends: one more ask, which opens
    kernel.unblock();
    await turns();
    assert.equal(kernel.asks.count, 3);
    assert.deepEqual(coordinator.status(), { status: 'ready' });
    // Which resolves a coordinator.start-failed an earlier instance raised (#20)
    assert.deepEqual(seen, [['coordinator.started', {}, undefined]]);
  });

  it('says migrating while its run upgrades the database, not only while an older page blocks it, and ready once the attempt is in (#35 slice 2)', async () => {
    const kernel = upgradingKernel();
    const { coordinator } = coordinatorOn(kernel);
    assert.deepEqual(coordinator.status(), { status: 'degraded', reason: 'starting' });
    assert.equal(coordinator.health().migration, null);
    const started = coordinator.start();
    assert.deepEqual(coordinator.status(), { status: 'degraded', reason: 'migrating' });
    assert.deepEqual([coordinator.health().reason, coordinator.health().migration], ['migrating', 'running']);
    kernel.finish();
    await started;
    assert.deepEqual(coordinator.status(), { status: 'ready' });
    assert.equal(coordinator.health().migration, null);
  });

  it("says starting while its run hasn't found an upgrade to make, as for a current database", async () => {
    const kernel = upgradingKernel({ upgrades: false });
    const { coordinator } = coordinatorOn(kernel);
    const started = coordinator.start();
    assert.deepEqual(coordinator.status(), { status: 'degraded', reason: 'starting' });
    assert.equal(coordinator.health().migration, null);
    kernel.finish();
    await started;
    assert.deepEqual(coordinator.status(), { status: 'ready' });
  });

  it("tells system.coordinatorHealth an upgrade an older build's open page blocks from one that runs (#35 slice 2)", async () => {
    const kernel = blockedKernel();
    const { coordinator } = coordinatorOn(kernel);
    await coordinator.start();
    assert.deepEqual([coordinator.health().reason, coordinator.health().migration], ['migrating', 'blocked']);
    // Once the page closes, the upgrade runs, no longer blocked, until the kernel opens
    const open = kernel.unblock({ held: true });
    await turns();
    assert.deepEqual([coordinator.health().reason, coordinator.health().migration], ['migrating', 'running']);
    open();
    await turns();
    assert.deepEqual([coordinator.status(), coordinator.health().migration], [{ status: 'ready' }, null]);
  });

  it('waits again on an attempt that starts blocked as one ends, and a run that ends still blocked is a failed open, not a loop', async () => {
    const again = blockedKernel();
    const { coordinator } = coordinatorOn(again);
    await coordinator.start();
    again.blockAgain();
    await turns();
    assert.deepEqual([coordinator.status(), again.asks.count], [{ status: 'degraded', reason: 'migrating' }, 2]);
    again.unblock();
    await turns();
    assert.deepEqual([coordinator.status(), again.asks.count], [{ status: 'ready' }, 3]);

    const stuck = blockedKernel();
    const { seen, events } = recordedEvents();
    const { coordinator: waiting } = coordinatorOn(stuck, { events });
    await waiting.start();
    stuck.endStillBlocked();
    await turns(20);
    assert.deepEqual(waiting.status(), { status: 'degraded', reason: 'storage-unavailable' });
    assert.equal(stuck.asks.count, 2);
    assert.deepEqual(seen.map(([code]) => code), ['storage.open-failed']);
  });

  it("is a failed open when the kernel can't open once the blocked run ends", async () => {
    const failure = { kind: 'unavailable', cause: 'storage', code: 'open-failed' };
    const kernel = blockedKernel({ failure });
    const { seen, events } = recordedEvents();
    let now = 1000;
    const { coordinator } = coordinatorOn(kernel, { events, clock: { now: () => now } });
    await coordinator.start();
    now = 61_000;
    kernel.unblock();
    await turns();
    assert.deepEqual(coordinator.status(), { status: 'degraded', reason: 'storage-unavailable' });
    assert.deepEqual(seen, [['storage.open-failed', { subjectId: 'CanvasTabDB', durationMs: 60_000 }, failure]]);
  });

  for (const reason of ['install', 'update']) {
    it(`runs an ${reason}'s integrity check once the blocked run ends and the kernel opens, not before`, async () => {
      const kernel = blockedKernel();
      const { coordinator } = coordinatorOn(kernel);
      await coordinator.installed(reason);
      await turns();
      assert.deepEqual(kernel.executed, []);
      kernel.unblock();
      await turns();
      assert.deepEqual(kernel.executed, [{ type: 'runIntegrityCheck', commandId: 'id-1' }]);
      await coordinator.start();
      assert.equal(kernel.executed.length, 1);
    });
  }

  it("doesn't run the check for a start, or Chrome's own update, when the blocked run ends", async () => {
    for (const reason of ['chrome_update', undefined]) {
      const kernel = blockedKernel();
      const { coordinator } = coordinatorOn(kernel);
      await coordinator.installed(reason);
      kernel.unblock();
      await turns();
      assert.deepEqual([coordinator.status(), kernel.executed], [{ status: 'ready' }, []], String(reason));
    }
  });
});

describe("the coordinator's health (#35 slice 1, system.coordinatorHealth)", () => {
  it('says what the welcome says, when its start began, and the commands it ran by outcome', async () => {
    const kernel = fakeKernel();
    let now = 1000;
    const { coordinator } = coordinatorOn(kernel, { clock: { now: () => now } });
    const before = {
      status: 'degraded',
      reason: 'starting',
      coordinatorId: 'coordinator-1',
      startedAt: null,
      commands: [],
      oldestOrphanedEntryAt: null,
      migration: null,
    };
    assert.deepEqual(coordinator.health(), before);
    const started = coordinator.start();
    now = 1500;
    kernel.open();
    await started;
    const client = coordinator.client();
    await client.execute({ type: 'runIntegrityCheck', commandId: 'c1' });
    await client.execute({ type: 'runIntegrityCheck', commandId: 'c2' });
    kernel.client.execute = async () => ({ kind: 'unavailable', cause: 'storage', code: 'quota', retryable: false });
    await client.execute({ type: 'runIntegrityCheck', commandId: 'c3' });
    assert.deepEqual(coordinator.health(), {
      status: 'ready',
      coordinatorId: 'coordinator-1',
      startedAt: 1000,
      commands: [
        { outcome: 'committed', count: 2 },
        { outcome: 'unavailable', count: 1 },
      ],
      oldestOrphanedEntryAt: null,
      migration: null,
    });
  });

  it("answers through the router's handler from the coordinator there is when it's asked", async () => {
    /** @type {import('../../js/kernel/composition/coordinator.js').Coordinator} */
    let current = unavailableCoordinator('coordinator-1');
    const handlers = coordinatorHandlers(() => current, { now: () => 42 });
    const ask = () => /** @type {any} */ (handlers['system.coordinatorHealth']({}, /** @type {any} */ ({})));
    assert.deepEqual(ask(), {
      kind: 'ready',
      asOf: 42,
      data: {
        status: 'degraded',
        reason: 'coordinator-unavailable',
        coordinatorId: 'coordinator-1',
        startedAt: null,
        commands: [],
        oldestOrphanedEntryAt: null,
        migration: null,
      },
    });
    const kernel = fakeKernel();
    kernel.open();
    current = coordinatorOn(kernel).coordinator;
    await current.start();
    assert.equal(ask().data.status, 'ready');
  });
});

describe("the coordinator's integrity check (#35 slice 1, the lead's Q2)", () => {
  for (const reason of ['install', 'update']) {
    it(`runs once after an ${reason}, once the open is done`, async () => {
      const kernel = fakeKernel();
      const { coordinator } = coordinatorOn(kernel);
      const installed = coordinator.installed(reason);
      assert.deepEqual(kernel.executed, []);
      kernel.open();
      await installed;
      assert.deepEqual(kernel.executed, [{ type: 'runIntegrityCheck', commandId: 'id-1' }]);
    });
  }

  it('runs it once the transforms and the catch-up the start set off are in, not before (#35 slice 2)', async () => {
    for (const reason of ['install', 'update']) {
      const kernel = fakeKernel();
      /** @type {Record<string, () => void>} */
      const end = {};
      const transforms = new Promise(resolve => {
        end.transforms = () => resolve(null);
      });
      const caughtUp = new Promise(resolve => {
        end.caughtUp = () => resolve(null);
      });
      kernel.client.transforms = { done: transforms };
      kernel.client.recordsCatchUp = { done: caughtUp };
      const { coordinator } = coordinatorOn(kernel);
      const installed = coordinator.installed(reason);
      kernel.open();
      await turns();
      assert.deepEqual(kernel.executed, [], `${reason}: while the transforms run`);
      end.transforms();
      await turns();
      assert.deepEqual(kernel.executed, [], `${reason}: while the catch-up runs`);
      end.caughtUp();
      await installed;
      assert.deepEqual(kernel.executed, [{ type: 'runIntegrityCheck', commandId: 'id-1' }], reason);
    }
  });

  it('runs it when the transforms or the catch-up end in a rejection, and only once', async () => {
    const kernel = fakeKernel();
    const threw = Promise.reject(new Error('test: the transforms threw'));
    // Handled here too, so it's no unhandled rejection before the check reaches it
    threw.catch(() => {});
    kernel.client.transforms = { done: threw };
    kernel.client.recordsCatchUp = { done: Promise.resolve(null) };
    kernel.open();
    const { coordinator } = coordinatorOn(kernel);
    await coordinator.installed('update');
    assert.deepEqual(kernel.executed, [{ type: 'runIntegrityCheck', commandId: 'id-1' }]);
  });

  it("doesn't run after Chrome's own update, a shared module's, or a start", async () => {
    for (const reason of ['chrome_update', 'shared_module_update', undefined]) {
      const kernel = fakeKernel();
      kernel.open();
      const { coordinator } = coordinatorOn(kernel);
      await coordinator.installed(reason);
      await coordinator.start();
      assert.deepEqual(kernel.executed, [], String(reason));
    }
  });

  it("doesn't run on a database it couldn't open, and a check that throws changes nothing", async () => {
    const failed = fakeKernel({ failure: { kind: 'unavailable', cause: 'newer-schema', code: 'version-too-new' } });
    failed.open();
    await coordinatorOn(failed).coordinator.installed('update');
    assert.deepEqual(failed.executed, []);

    const kernel = fakeKernel();
    kernel.open();
    kernel.client.execute = async () => {
      throw new Error('the check threw');
    };
    const { coordinator } = coordinatorOn(kernel);
    await coordinator.installed('install');
    assert.deepEqual(coordinator.status(), { status: 'ready' });
  });
});

/**
 * A worker journal whose drains the test holds open, each until it calls `release`, and whose
 * oldest orphaned entry, and the notes its last drain held back, it sets
 */
function heldJournal() {
  /** @type {Array<{client: unknown, release: () => void}>} */
  const drains = [];
  /** @type {number | null} */
  let oldest = null;
  /** @type {unknown} */
  let heldBack = [];
  return {
    drains,
    /** @param {number | null} at */
    setOldest(at) {
      oldest = at;
    },
    /** @param {unknown} notes */
    setHeld(notes) {
      heldBack = notes;
    },
    journal: {
      /** @param {unknown} client */
      drain(client) {
        return new Promise(resolve => {
          drains.push({ client, release: () => resolve({ status: 'drained', replayed: 1 }) });
        });
      },
      oldestOrphanedEntryAt: () => oldest,
      held: () => /** @type {any} */ (heldBack),
    },
  };
}

describe("the coordinator's journal drain (#35 slice 3)", () => {
  it('drains once it is ready, never before, on its kernel, and its start never waits for the drain', async () => {
    const kernel = fakeKernel();
    const held = heldJournal();
    const { coordinator } = coordinatorOn(kernel, { journal: held.journal });
    const started = coordinator.start();
    await turns();
    assert.equal(held.drains.length, 0, 'none while it starts');
    kernel.open();
    // The drain stays held, and the start, which a hello held while it's starting waits on, is in
    await started;
    assert.deepEqual(coordinator.status(), { status: 'ready' });
    await turns();
    assert.equal(held.drains.length, 1);
    assert.equal(held.drains[0].client, coordinator.client());
    // A hello during the drain is welcomed ready at once
    assert.deepEqual(coordinator.status(), { status: 'ready' });
    held.drains[0].release();
  });

  it("doesn't drain while degraded, and drains once the run an older page blocked ends and the kernel opens", async () => {
    for (const failure of [
      { kind: 'unavailable', cause: 'newer-schema', code: 'version-too-new' },
      { kind: 'unavailable', cause: 'storage', code: 'open-failed' },
    ]) {
      const kernel = fakeKernel({ failure });
      const held = heldJournal();
      const { coordinator } = coordinatorOn(kernel, { journal: held.journal });
      const started = coordinator.start();
      kernel.open();
      await started;
      await turns();
      assert.equal(held.drains.length, 0, failure.code);
      assert.equal(await coordinator.drain(), null, failure.code);
    }
    const kernel = blockedKernel();
    const held = heldJournal();
    const { coordinator } = coordinatorOn(kernel, { journal: held.journal });
    await coordinator.start();
    await turns();
    assert.deepEqual(coordinator.status(), { status: 'degraded', reason: 'migrating' });
    assert.equal(held.drains.length, 0, 'none while the upgrade is blocked');
    kernel.unblock();
    await turns();
    assert.deepEqual(coordinator.status(), { status: 'ready' });
    assert.equal(held.drains.length, 1, "the captures kept meanwhile replay once it's ready");
  });

  it('drains again when a page asks, once it is ready, and answers what the drain did', async () => {
    const kernel = fakeKernel();
    const held = heldJournal();
    const { coordinator } = coordinatorOn(kernel, { journal: held.journal });
    const asked = coordinator.drain();
    await turns();
    // The ask started it, and waits for its start
    assert.equal(held.drains.length, 0);
    kernel.open();
    await turns();
    // The start's own drain, then the one asked for
    assert.equal(held.drains.length, 2);
    // Each on the queue, as client() is, so its replays wait their turn (#204's review, T2)
    assert.equal(held.drains[1].client, coordinator.client(), 'the asked drain runs on the queue');
    held.drains[0].release();
    held.drains[1].release();
    assert.deepEqual(await asked, { status: 'drained', replayed: 1 });
  });

  it('says when the oldest entry with no live owner was written, and null for anything else the journal says', async () => {
    const kernel = fakeKernel();
    const held = heldJournal();
    const { coordinator } = coordinatorOn(kernel, { journal: held.journal });
    assert.equal(coordinator.health().oldestOrphanedEntryAt, null);
    held.setOldest(NOW_AT);
    assert.equal(coordinator.health().oldestOrphanedEntryAt, NOW_AT);
    held.setOldest(/** @type {any} */ ('yesterday'));
    assert.equal(coordinator.health().oldestOrphanedEntryAt, null);
  });

  it('names the notes its last drain held back, each by id and why, at most 10 with the total, and says nothing of them while none is held (slice 3b)', async () => {
    const kernel = fakeKernel();
    const held = heldJournal();
    const { coordinator } = coordinatorOn(kernel, { journal: held.journal });
    // As an older worker answers
    assert.equal(Object.hasOwn(coordinator.health(), 'held'), false);
    held.setHeld([{ noteId: 'n1', code: 'timed-out' }]);
    assert.deepEqual(coordinator.health().held, {
      total: 1,
      notes: [{ noteId: 'n1', code: 'timed-out' }],
    });
    const many = Array.from({ length: 12 }, (_, index) => ({ noteId: `n${index}`, code: 'not-cloneable' }));
    held.setHeld(many);
    assert.deepEqual(coordinator.health().held, { total: 12, notes: many.slice(0, 10) });
    // Ids and codes only, never what a note holds
    held.setHeld([{ noteId: 'n1', code: 'timed-out', text: 'Call the plumber' }]);
    assert.deepEqual(coordinator.health().held, {
      total: 1,
      notes: [{ noteId: 'n1', code: 'timed-out' }],
    });
    held.setHeld([]);
    assert.equal(Object.hasOwn(coordinator.health(), 'held'), false);
  });

  it('answers the same when its journal throws or rejects', async () => {
    for (const journal of [
      {
        drain: () => {
          throw new Error('the journal is broken');
        },
        oldestOrphanedEntryAt: () => {
          throw new Error('the journal is broken');
        },
        held: () => {
          throw new Error('the journal is broken');
        },
      },
      { drain: () => Promise.reject(new Error('the journal is broken')), oldestOrphanedEntryAt: () => null },
    ]) {
      const kernel = fakeKernel();
      const { coordinator } = coordinatorOn(kernel, { journal });
      const started = coordinator.start();
      kernel.open();
      await started;
      await turns();
      assert.deepEqual(coordinator.status(), { status: 'ready' });
      assert.equal(coordinator.health().oldestOrphanedEntryAt, null);
      // A journal that can't say what it held, or an older one that has no say, names none
      assert.equal(Object.hasOwn(coordinator.health(), 'held'), false);
      assert.equal(await coordinator.drain(), null);
    }
  });
});

/**
 * A kernel that opens at once and holds each command until the test lets it answer, keeping
 * when each one started and ended, in order, and the `live` its turn gave it (#35 slice 4b-1).
 * `fail` makes one command's call reject.
 */
function heldKernel() {
  /** @type {string[]} */
  const log = [];
  /** @type {Map<string, (outcome?: unknown) => void>} */
  const held = new Map();
  /** @type {Map<string, (error: unknown) => void>} */
  const failing = new Map();
  /** @type {Map<string, unknown>} */
  const lives = new Map();
  let next = 0;
  const client = {
    execute: (/** @type {Record<string, unknown>} */ command, /** @type {{live?: unknown} | undefined} */ options) =>
      new Promise((resolve, reject) => {
        const commandId = String(command.commandId);
        lives.set(commandId, options?.live);
        log.push(`start ${commandId}`);
        held.set(commandId, () => {
          log.push(`end ${commandId}`);
          resolve({ kind: 'committed', code: 'held', changedIds: [] });
        });
        failing.set(commandId, error => {
          log.push(`threw ${commandId}`);
          reject(error);
        });
      }),
    query: async () => ({ kind: 'empty', asOf: 0 }),
    subscribe: () => () => {},
    whenReady: async () => null,
    ids: { next: () => `id-${++next}` },
  };
  return {
    client: /** @type {any} */ (client),
    log,
    /** @param {string} commandId */
    release: commandId => /** @type {() => void} */ (held.get(commandId))(),
    /** @param {string} commandId */
    fail: commandId => /** @type {(error: unknown) => void} */ (failing.get(commandId))(new Error('the kernel threw')),
    /**
     * The `live` that `commandId`'s turn gave it, which answers false once the queue has cut that turn
     * @param {string} commandId
     */
    live: commandId => /** @type {() => boolean} */ (lives.get(commandId)),
  };
}

/**
 * A capture as the worker sends it
 * @param {string} commandId
 */
const captureOf = commandId => ({
  type: /** @type {const} */ ('captureToDailyNote'),
  commandId,
  noteId: `${commandId}-daily`,
  blockId: `${commandId}-block`,
  capture: { type: /** @type {const} */ ('bookmark'), url: 'https://example.test/', title: 'Example' },
});

describe("the coordinator's one queue (#35 slice 4a, one committer)", () => {
  it('runs one command at a time, in the order they came: the second starts once the first has its outcome', async () => {
    const kernel = heldKernel();
    const { coordinator } = coordinatorOn(kernel);
    await coordinator.start();
    const first = coordinator.client().execute(captureOf('c-1'));
    const second = coordinator.client().execute(captureOf('c-2'));
    const third = coordinator.client().execute(captureOf('c-3'));
    await turns();
    assert.deepEqual(kernel.log, ['start c-1']);
    kernel.release('c-1');
    await turns();
    assert.deepEqual(kernel.log, ['start c-1', 'end c-1', 'start c-2']);
    kernel.release('c-2');
    await turns();
    kernel.release('c-3');
    assert.deepEqual(
      (await Promise.all([first, second, third])).map(outcome => outcome.kind),
      ['committed', 'committed', 'committed'],
    );
    assert.deepEqual(kernel.log, ['start c-1', 'end c-1', 'start c-2', 'end c-2', 'start c-3', 'end c-3']);
  });

  it("puts the drain's replays on the same queue, so a command sent while a replay runs starts once the replay has its outcome", async () => {
    const kernel = heldKernel();
    const held = heldJournal();
    const { coordinator } = coordinatorOn(kernel, { journal: held.journal });
    await coordinator.start();
    await turns();
    assert.equal(held.drains.length, 1);
    // The drain replays an entry on the client it was given
    const drainClient = /** @type {any} */ (held.drains[0].client);
    const replay = drainClient.execute(captureOf('c-replayed'));
    const capture = coordinator.client().execute(captureOf('c-1'));
    await turns();
    assert.deepEqual(kernel.log, ['start c-replayed']);
    kernel.release('c-replayed');
    await turns();
    assert.deepEqual(kernel.log, ['start c-replayed', 'end c-replayed', 'start c-1']);
    kernel.release('c-1');
    assert.deepEqual([(await replay).kind, (await capture).kind], ['committed', 'committed']);
    held.drains[0].release();
  });

  it('never runs a command whose request ended before its turn, and runs the one after it', async () => {
    const kernel = heldKernel();
    const { coordinator } = coordinatorOn(kernel);
    await coordinator.start();
    const first = coordinator.client().execute(captureOf('c-1'));
    // A router's request is still waited on until its deadline, a cancel, or its connection's close
    let waited = true;
    const ended = coordinator.enqueue(captureOf('c-2'), { begin: () => waited });
    const after = coordinator.enqueue(captureOf('c-3'), { begin: () => true });
    await turns();
    // Its deadline comes while it waits, so the router answers it and stops waiting
    waited = false;
    kernel.release('c-1');
    await turns();
    assert.deepEqual(kernel.log, ['start c-1', 'end c-1', 'start c-3']);
    assert.equal(await ended, null);
    kernel.release('c-3');
    assert.deepEqual([(await first).kind, (await after)?.kind], ['committed', 'committed']);
  });

  it("answers a command enqueued on the stand-in, or on one whose kernel couldn't be built, as unavailable", async () => {
    assert.deepEqual(await unavailableCoordinator('coordinator-1').enqueue(captureOf('c-1')), UNAVAILABLE);
    const { coordinator } = coordinatorOn(
      {
        client: null,
      },
      {
        makeKernel: () => {
          throw new Error('the kernel threw as it was built');
        },
      },
    );
    assert.deepEqual(await coordinator.enqueue(captureOf('c-2'), { begin: () => true }), UNAVAILABLE);
  });

  it('runs the next command when one throws or its kernel rejects, and answers the one that did with that', async () => {
    const kernel = heldKernel();
    const { coordinator } = coordinatorOn(kernel);
    await coordinator.start();
    const first = coordinator.client().execute(captureOf('c-1'));
    const second = coordinator.client().execute(captureOf('c-2'));
    await turns();
    kernel.fail('c-1');
    await assert.rejects(first, /the kernel threw/);
    await turns();
    assert.deepEqual(kernel.log, ['start c-1', 'threw c-1', 'start c-2']);
    kernel.release('c-2');
    assert.equal((await second).kind, 'committed');
  });

  it('runs the integrity check, and answers system.coordinatorHealth, while a command holds the queue: neither is on it', async () => {
    const kernel = heldKernel();
    const { coordinator } = coordinatorOn(kernel);
    await coordinator.start();
    const capture = coordinator.client().execute(captureOf('c-1'));
    await turns();
    const installed = coordinator.installed('install');
    await turns();
    assert.equal(kernel.log.length, 2, JSON.stringify(kernel.log));
    assert.equal(kernel.log[0], 'start c-1');
    assert.match(kernel.log[1], /^start id-\d+$/, 'the check runs at once, off the queue');
    const handlers = coordinatorHandlers(() => coordinator);
    const health = handlers['system.coordinatorHealth'](undefined, /** @type {any} */ ({}));
    assert.equal(/** @type {any} */ (health).kind, 'ready', 'the health answers at once, off the queue');
    kernel.release(kernel.log[1].slice('start '.length));
    await installed;
    kernel.release('c-1');
    assert.equal((await capture).kind, 'committed');
  });
});

/**
 * A clock and timers a test moves by hand, as one: a timer is due `ms` after it was set, by the
 * clock, and `advance` moves the clock on, then fires each timer due by then, soonest first
 * @param {number} [start]
 */
function steppedTime(start = NOW_AT) {
  let now = start;
  let next = 1;
  /** @type {Map<number, {due: number, callback: () => void}>} */
  const pending = new Map();
  return {
    clock: { now: () => now },
    timers: {
      /** @param {() => void} callback @param {number} ms */
      set: (callback, ms) => {
        const handle = next++;
        pending.set(handle, { due: now + ms, callback });
        return handle;
      },
      /** @param {unknown} handle */
      clear: handle => {
        pending.delete(/** @type {number} */ (handle));
      },
    },
    /** @param {number} ms */
    advance(ms) {
      now += ms;
      const due = [...pending].filter(([, timer]) => timer.due <= now).sort(([, a], [, b]) => a.due - b.due);
      for (const [handle, { callback }] of due) {
        pending.delete(handle);
        callback();
      }
    },
  };
}

/**
 * A note's creation, as the drain replays a page's
 * @param {string} commandId
 */
const noteOf = commandId =>
  /** @type {any} */ ({ type: 'createNote', commandId, noteId: `${commandId}-note`, name: 'Plan', blocks: [] });

/** What a command whose turn the queue cut answers */
const TURN_EXCEEDED = Object.freeze({
  kind: 'unavailable',
  cause: 'coordinator',
  code: 'turn-exceeded',
  retryable: true,
  messageKey: 'unavailable.turn-exceeded',
  severity: 'error',
});

describe("the coordinator's bound on a turn (#35 slice 4b-1, F4)", () => {
  it('says which command holds the queue: its type, when its turn began and how many wait behind it, and nothing while the queue is idle', async () => {
    const kernel = heldKernel();
    const time = steppedTime(1000);
    const { coordinator } = coordinatorOn(kernel, { clock: time.clock, timers: time.timers });
    await coordinator.start();
    assert.equal(Object.hasOwn(coordinator.health(), 'running'), false, 'nothing while the queue is idle');
    const first = coordinator.client().execute(captureOf('c-1'));
    await turns();
    time.advance(500);
    const second = coordinator.enqueue(noteOf('c-2'), { begin: () => true });
    const third = coordinator.client().execute(captureOf('c-3'));
    await turns();
    assert.deepEqual(coordinator.health().running, { type: 'captureToDailyNote', since: 1000, waiting: 2 });
    kernel.release('c-1');
    await turns();
    assert.deepEqual(coordinator.health().running, { type: 'createNote', since: 1500, waiting: 1 });
    kernel.release('c-2');
    await turns();
    kernel.release('c-3');
    await Promise.all([first, second, third]);
    await turns();
    assert.equal(Object.hasOwn(coordinator.health(), 'running'), false, 'nothing once the queue is idle again');
  });

  it("cuts a turn TURN_LIMIT_MS after it began: the next command runs, the cut one answers unavailable, retryable, turn-exceeded, its turn's live() answers false, and coordinator.turn-stuck is journaled once with its type and age", async () => {
    const kernel = heldKernel();
    const time = steppedTime(1000);
    const { seen, events } = recordedEvents();
    const { coordinator } = coordinatorOn(kernel, { clock: time.clock, timers: time.timers, events });
    await coordinator.start();
    const first = coordinator.client().execute(captureOf('c-1'));
    const second = coordinator.client().execute(captureOf('c-2'));
    await turns();
    time.advance(TURN_LIMIT_MS - 1);
    await turns();
    assert.deepEqual(kernel.log, ['start c-1'], 'not cut before its bound');
    time.advance(1);
    await turns();
    assert.deepEqual(kernel.log, ['start c-1', 'start c-2'], 'cut at its bound, so the next command runs');
    assert.deepEqual(await first, TURN_EXCEEDED);
    assert.equal(kernel.live('c-1')(), false, 'the cut turn is no longer live, so the kernel commits nothing of it');
    assert.equal(kernel.live('c-2')(), true);
    const stuck = () => seen.filter(([code]) => code === 'coordinator.turn-stuck');
    assert.deepEqual(stuck(), [
      ['coordinator.turn-stuck', { commandType: 'captureToDailyNote', ageMs: TURN_LIMIT_MS }, undefined],
    ]);
    assert.equal(coordinator.health().cutTurns, 1);
    // What the cut command settles with later changes nothing
    kernel.release('c-1');
    await turns();
    assert.equal(stuck().length, 1, 'once per cut');
    kernel.release('c-2');
    assert.equal((await second).kind, 'committed');
    await turns();
    assert.equal(coordinator.health().cutTurns, 1, "it counts for the worker's life, and stays while the queue is idle");
  });

  it("gives a turn that starts late its whole TURN_LIMIT_MS from its own start, not its request's", async () => {
    const kernel = heldKernel();
    const time = steppedTime(1000);
    const { coordinator } = coordinatorOn(kernel, { clock: time.clock, timers: time.timers });
    await coordinator.start();
    const first = coordinator.client().execute(captureOf('c-1'));
    const second = coordinator.client().execute(captureOf('c-2'));
    const third = coordinator.client().execute(captureOf('c-3'));
    await turns();
    // The second waits 100 s behind the first, then starts
    time.advance(100_000);
    kernel.release('c-1');
    await turns();
    assert.deepEqual(kernel.log, ['start c-1', 'end c-1', 'start c-2']);
    // 130 s after its request, and to the last millisecond of its own bound, it holds the queue
    time.advance(30_000);
    await turns();
    time.advance(TURN_LIMIT_MS - 30_000 - 1);
    await turns();
    assert.deepEqual(kernel.log, ['start c-1', 'end c-1', 'start c-2'], 'its bound runs from its own start');
    kernel.release('c-2');
    await turns();
    kernel.release('c-3');
    assert.deepEqual(
      (await Promise.all([first, second, third])).map(outcome => outcome?.kind),
      ['committed', 'committed', 'committed'],
    );
  });
});

describe("the coordinator's stand-in and instance id", () => {
  it('answers as unavailable, for js/background.js until the real one is built or when building it threw', async () => {
    const standIn = unavailableCoordinator('coordinator-1');
    assert.equal(standIn.instanceId, 'coordinator-1');
    assert.deepEqual(standIn.status(), { status: 'degraded', reason: 'coordinator-unavailable' });
    await standIn.start();
    await standIn.installed('install');
    // It has no journal to drain
    assert.equal(await standIn.drain(), null);
    const client = standIn.client();
    const capture = {
      type: /** @type {const} */ ('captureToDailyNote'),
      commandId: 'c1',
      noteId: 'n1',
      blockId: 'b1',
      capture: { type: /** @type {const} */ ('bookmark'), url: 'https://example.test/', title: 'Example' },
    };
    assert.deepEqual(await client.execute(capture), UNAVAILABLE);
    assert.deepEqual(await client.whenReady(), UNAVAILABLE);
  });

  it('makes a new id each time, and one from the clock where crypto throws', () => {
    const [a, b] = [coordinatorInstanceId(), coordinatorInstanceId()];
    assert.equal(typeof a, 'string');
    assert.notEqual(a, b);
    const descriptor = /** @type {PropertyDescriptor} */ (Object.getOwnPropertyDescriptor(globalThis, 'crypto'));
    Object.defineProperty(globalThis, 'crypto', {
      configurable: true,
      value: {
        randomUUID: () => {
          throw new Error('no crypto');
        },
      },
    });
    try {
      assert.match(coordinatorInstanceId(), /^coordinator-[0-9a-z]+-[0-9a-z]+$/);
    } finally {
      Object.defineProperty(globalThis, 'crypto', descriptor);
    }
  });
});
