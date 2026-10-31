// The background coordinator's host (#35 slice 1, js/kernel/composition/coordinator.js), on
// a fake kernel: it builds the worker's kernel on its first start and never before, says
// what each welcome says (`starting`, `ready`, or degraded and why), and after an install or
// an update runs the read-only integrity check once. A kernel that can't be built leaves it
// unavailable, and every command answers so. Nothing it journals or reports changes what it
// answers. test/background-coordinator.test.js runs it in js/background.js.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
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
 * @param {ReturnType<typeof fakeKernel>} kernel
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
    assert.equal(coordinator.client(), kernel.client);
    await coordinator.start();
    assert.equal(built.count, 1);
    assert.deepEqual(seen, []);
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
      assert.equal(coordinator.client(), kernel.client);
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

  it("is unavailable when its kernel can't be built: every command answers so, and the report hears why once", async () => {
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
    await coordinator.start();
    await coordinator.start();
    await coordinator.installed('install');
    assert.equal(builds, 1);
    assert.deepEqual(reported, [thrown]);
    assert.deepEqual(seen, []);
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
