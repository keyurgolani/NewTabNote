// The background coordinator's host (#35 slice 1, js/kernel/composition/coordinator.js), on
// a fake kernel: it builds the worker's kernel on its first start and never before, says
// what each welcome says (`starting`, `ready`, or degraded and why), and after an install or
// an update runs the read-only integrity check once. A kernel that can't be built leaves it
// unavailable, every command answers so, and it's `coordinator.start-failed`; a start that
// opens is `coordinator.started`. system.coordinatorHealth says the same, with when it started
// and its commands by outcome. Nothing it journals or reports changes what it answers.
// test/background-coordinator.test.js runs it in js/background.js.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  coordinatorHandlers,
  coordinatorInstanceId,
  createCoordinator,
  unavailableCoordinator,
} from '../../js/kernel/composition/coordinator.js';

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
 * each ask, until the test ends the attempt. `unblock` ends it with the page gone, after which
 * it opens with `failure` (null: it opened); `endStillBlocked` ends it and keeps answering
 * BLOCKED; `blockAgain` starts another attempt, blocked too.
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
      return blocked ? BLOCKED : failure;
    },
    ids: { next: () => `id-${++next}` },
    migration: Object.freeze({
      get done() {
        return done;
      },
    }),
  };
  return {
    client: /** @type {any} */ (client),
    asks,
    executed,
    unblock() {
      blocked = false;
      end({ status: 'migrated' });
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

describe("the coordinator's stand-in and instance id", () => {
  it('answers as unavailable, for js/background.js until the real one is built or when building it threw', async () => {
    const standIn = unavailableCoordinator('coordinator-1');
    assert.equal(standIn.instanceId, 'coordinator-1');
    assert.deepEqual(standIn.status(), { status: 'degraded', reason: 'coordinator-unavailable' });
    await standIn.start();
    await standIn.installed('install');
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
