// The worker's own client (#35 slice 4a, "One committer"; composition/worker-internal.js): #13's
// client on the in-process transport, as `worker-internal`, to a router of its own on the worker's
// catalog, which serves the capture alone and hands it to the coordinator's one queue
// (composition/coordinator.js). The port router stays on the shared catalog with no command
// (test/kernel/worker-router.test.mjs), so no port sender reaches the capture. It's in-process,
// so no message limit applies to it: 1.5.0 saves a capture over 1 MiB, and so does this (the
// lead's ruling for 4a). A capture whose turn doesn't come by its deadline is answered
// `unavailable`, retryable, and never runs, so js/background.js keeps it.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { createWorkerInternalClient, createWorkerInternalRouter } from '../../js/kernel/composition/worker-internal.js';
import { createCoordinator } from '../../js/kernel/composition/coordinator.js';
import { COMMAND_DEADLINE_MS, DEADLINE_GRACE_MS, MAX_MESSAGE_BYTES } from '../../js/kernel/core/contracts/limits.js';
import { VERSION, hello, rawConnection, request, settle, testScheduler } from './messaging-support.mjs';
import { NOW, testIds } from './support.mjs';

/**
 * A kernel that opens at once and holds each command until the test lets it answer, keeping
 * when each one started and ended, in order
 */
function heldKernel() {
  /** @type {string[]} */
  const log = [];
  /** @type {Map<string, () => void>} */
  const held = new Map();
  /** @type {Map<string, Record<string, unknown>>} */
  const ran = new Map();
  let next = 0;
  const client = {
    execute: (/** @type {Record<string, unknown>} */ command) =>
      new Promise(resolve => {
        const commandId = String(command.commandId);
        log.push(`start ${commandId}`);
        ran.set(commandId, command);
        held.set(commandId, () => {
          log.push(`end ${commandId}`);
          resolve({
            kind: 'committed',
            code: 'capture-saved',
            changedIds: [String(command.noteId)],
            messageKey: 'committed.capture-saved',
            severity: 'success',
          });
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
    ran,
    /** @param {string} commandId */
    release: commandId => /** @type {() => void} */ (held.get(commandId))(),
  };
}

/**
 * A capture as js/background.js sends it, of `content` when it's text
 * @param {string} commandId
 * @param {string} [content]
 * @returns {import('../../js/kernel/core/contracts/commands.js').CommandOf<'captureToDailyNote'>}
 */
const captureOf = (commandId, content) => ({
  type: 'captureToDailyNote',
  commandId,
  noteId: `${commandId}-daily`,
  blockId: `${commandId}-block`,
  capture:
    content === undefined
      ? { type: 'bookmark', url: 'https://example.test/', title: 'Example' }
      : { type: 'text', content, source: 'https://example.test/' },
  at: NOW,
});

/**
 * The coordinator on a held kernel, started, and the worker's own router and client on it, on
 * the test's clock and timers
 */
async function workerInternal() {
  const scheduler = testScheduler();
  const kernel = heldKernel();
  const coordinator = createCoordinator({
    instanceId: 'coordinator-1',
    makeKernel: () => kernel.client,
    report: () => {},
    clock: scheduler.clock,
  });
  await coordinator.start();
  const router = createWorkerInternalRouter({
    coordinatorId: coordinator.instanceId,
    extensionVersion: VERSION,
    status: () => coordinator.status(),
    settled: () => coordinator.start(),
    enqueue: (command, dispatch) => coordinator.enqueue(command, dispatch),
    clock: scheduler.clock,
    timers: scheduler.timers,
  });
  const client = createWorkerInternalClient({
    router,
    extensionVersion: VERSION,
    clock: scheduler.clock,
    timers: scheduler.timers,
    ids: testIds('worker'),
  });
  return { scheduler, kernel, coordinator, router, client };
}

/** @param {any} outcome */
const kindOf = outcome => ({
  kind: outcome.kind,
  cause: outcome.cause,
  code: outcome.code,
  retryable: outcome.retryable,
});

describe("the worker's own client and router (#35 slice 4a)", () => {
  it("sends the worker's capture to the coordinator's queue as worker-internal, and answers with its outcome", async () => {
    const { kernel, client } = await workerInternal();
    const answer = client.execute(captureOf('c-1'));
    await settle();
    await settle();
    assert.deepEqual(kernel.log, ['start c-1']);
    kernel.release('c-1');
    assert.deepEqual(kindOf(await answer), {
      kind: 'committed',
      cause: undefined,
      code: 'capture-saved',
      retryable: undefined,
    });
    assert.deepEqual(kernel.ran.get('c-1'), captureOf('c-1'));
  });

  it("puts the capture behind what holds the queue, and answers one whose turn doesn't come by its deadline as unavailable and retryable, never running it", async () => {
    const { scheduler, kernel, coordinator, client } = await workerInternal();
    const ahead = coordinator.client().execute(captureOf('c-ahead'));
    const late = client.execute(captureOf('c-late'));
    await scheduler.advance(COMMAND_DEADLINE_MS - 1);
    assert.deepEqual(kernel.log, ['start c-ahead'], 'it waits its turn');
    await scheduler.advance(1 + DEADLINE_GRACE_MS);
    assert.deepEqual(kindOf(await late), {
      kind: 'unavailable',
      cause: 'coordinator',
      code: 'deadline-exceeded',
      retryable: true,
    });
    kernel.release('c-ahead');
    await /** @type {Promise<unknown>} */ (ahead);
    await settle();
    await settle();
    assert.deepEqual(kernel.log, ['start c-ahead', 'end c-ahead'], 'the late capture never ran');
  });

  it("sends a capture over #13's message limit, as 1.5.0 saves one: no limit applies in-process (the lead's ruling for 4a)", async () => {
    const { kernel, client } = await workerInternal();
    const content = 'x'.repeat(2 * MAX_MESSAGE_BYTES);
    const answer = client.execute(captureOf('c-big', content));
    for (let round = 0; round < 5 && kernel.log.length === 0; round++) await settle();
    assert.deepEqual(kernel.log, ['start c-big']);
    assert.equal(/** @type {any} */ (kernel.ran.get('c-big')).capture.content.length, content.length);
    kernel.release('c-big');
    assert.equal((await answer).kind, 'committed');
  });

  it("welcomes the worker's own hello with the coordinator's instance id and what it can do now", async () => {
    const { coordinator, router } = await workerInternal();
    const own = rawConnection(router, 'worker-internal');
    own.send(hello('worker-internal'));
    await settle();
    const welcome = own.frames.find(frame => frame.frame === 'welcome');
    assert.deepEqual(welcome && [welcome.coordinatorId, welcome.status], [coordinator.instanceId, 'ready']);
  });

  it("refuses a page's surface the capture, which never reaches the queue", async () => {
    const { kernel, router } = await workerInternal();
    const popup = rawConnection(router, 'popup');
    popup.send(hello('popup'));
    await settle();
    popup.send(request('r-capture', captureOf('c-popup')));
    await settle();
    assert.deepEqual(
      popup.framesFor('r-capture').map(frame => [frame.frame, frame.code]),
      [['error', 'forbidden-for-surface']],
    );
    assert.deepEqual(kernel.log, [], "the page's capture never reached the queue");
  });

  it("serves no command but the capture: the createNote the worker's catalog grants worker-internal is unknown here, and the worker's own capture is served", async () => {
    const { kernel, router } = await workerInternal();
    const own = rawConnection(router, 'worker-internal');
    own.send(hello('worker-internal'));
    await settle();
    // The worker's catalog grants it createNote, which its drain replays, but this router serves the capture alone
    own.send(request('r-create', { type: 'createNote', commandId: 'c-create', noteId: 'n-create', name: 'A note' }));
    own.send(request('r-own', captureOf('c-own')));
    await settle();
    await settle();
    assert.deepEqual(
      own.framesFor('r-create').map(frame => [frame.frame, frame.code]),
      [['error', 'unknown-operation']],
    );
    assert.deepEqual(kernel.log, ['start c-own'], 'only the capture reached the queue');
    kernel.release('c-own');
    await settle();
    await settle();
    assert.deepEqual(
      own.framesFor('r-own').map(frame => [frame.frame, frame.result && frame.result.kind]),
      [['response', 'committed']],
    );
  });
});
