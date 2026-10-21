// #13's client (core/messaging/client.js): how a page or the worker's own code reaches the
// router. It opens one connection when it first has something to send, says hello, sends
// once welcomed, and answers every call with #12's outcome union or a query state, however
// the call ended (#13, "Outcomes and authorization" and "Cancellation, deadlines, payloads").

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { createKernel } from '../../js/kernel/core/application/kernel.js';
import {
  COMMAND_DEADLINE_MS,
  DEADLINE_GRACE_MS,
  PROTOCOL_VERSION,
  QUERY_DEADLINE_MS,
  SMALL_MESSAGE_BYTES,
} from '../../js/kernel/core/contracts/limits.js';
import { committed, failed, ready, rejected, unavailable, unknown } from '../../js/kernel/core/contracts/outcomes.js';
import { createClient } from '../../js/kernel/core/messaging/client.js';
import { createInProcessTransport } from '../../js/kernel/core/messaging/in-process.js';
import { createRouter } from '../../js/kernel/core/messaging/router.js';
import { createMemoryAdapter } from '../../js/kernel/core/memory/adapter.js';
import { createBaselinePolicy } from '../../js/kernel/core/ports/policy.js';
import { CALLERS, NOW, testIds } from './support.mjs';
import { VERSION, lookup, scriptedCoordinator, settle, testScheduler } from './messaging-support.mjs';

/** @typedef {import('../../js/kernel/core/messaging/link.js').Transport} Transport */
/** @typedef {import('../../js/kernel/core/messaging/client.js').ClientOptions} ClientOptions */

/**
 * A new-tab client over `transport`, on `scheduler`'s clock
 * @param {Transport} transport
 * @param {ReturnType<typeof testScheduler>} scheduler
 * @param {Partial<ClientOptions>} [options]
 */
const makeClient = (transport, scheduler, options = {}) =>
  createClient({
    transport,
    surface: 'newtab',
    extensionVersion: VERSION,
    lookup,
    ids: testIds('client'),
    clock: scheduler.clock,
    timers: scheduler.timers,
    ...options,
  });

/** What getNote answers for a note that isn't there */
const noNote = failed('storage', 'note-not-found');

/**
 * A setPinned for `noteId`, whose commandId names it too
 * @param {string} noteId
 */
const pin = noteId => ({ type: 'setPinned', commandId: `c-${noteId}`, noteId, pinned: true });

/**
 * A client and the coordinator the test plays for it, already welcomed
 * @param {Partial<ClientOptions>} [options]
 */
async function welcomed(options = {}) {
  const scheduler = testScheduler();
  const coordinator = scriptedCoordinator();
  const client = makeClient(coordinator.transport, scheduler, options);
  // A query of the coordinator's own opens the connection, and its answer is ignored
  void client.query({ type: 'system.messagingHealth' });
  await settle();
  coordinator.last.welcome();
  await settle();
  coordinator.last.frames.length = 0;
  return { scheduler, coordinator, client, connection: coordinator.last };
}

describe('the client: requests (#13, "Topology")', () => {
  it('opens its connection on the first request, says hello, and sends the request once welcomed', async () => {
    const scheduler = testScheduler();
    const coordinator = scriptedCoordinator();
    const client = makeClient(coordinator.transport, scheduler);
    await settle();
    assert.equal(coordinator.attempts, 0);
    const answer = client.query({ type: 'getNote', noteId: 'n1' });
    await settle();
    const connection = coordinator.last;
    assert.deepEqual(connection.frames, [
      {
        frame: 'hello',
        protocol: PROTOCOL_VERSION,
        extensionVersion: VERSION,
        surface: 'newtab',
        sessionId: client.sessionId,
      },
    ]);
    await scheduler.advance(100);
    connection.welcome();
    await settle();
    // The deadline runs from when the request is sent
    const [sent] = connection.requests();
    assert.deepEqual(sent, {
      frame: 'request',
      requestId: sent.requestId,
      operation: 'getNote',
      version: 1,
      deadline: NOW + 100 + QUERY_DEADLINE_MS,
      payload: { type: 'getNote', noteId: 'n1' },
    });
    connection.send({ frame: 'response', requestId: sent.requestId, result: noNote });
    assert.deepEqual(await answer, noNote);
    assert.equal(coordinator.attempts, 1);
    assert.deepEqual(client.coordinator(), { coordinatorId: 'coordinator-1', status: 'ready' });
  });

  it('answers a command with its outcome and a query with its state, through the router', async () => {
    const scheduler = testScheduler();
    const kernel = createKernel({
      adapter: createMemoryAdapter(),
      policy: createBaselinePolicy(),
      caller: CALLERS.newtab,
      ids: testIds('kernel'),
      clock: scheduler.clock,
    });
    const router = createRouter({
      lookup,
      policy: createBaselinePolicy(),
      ...scheduler,
      coordinatorId: 'coordinator-1',
      extensionVersion: VERSION,
      handlers: {
        createNote: (payload, context) =>
          context.begin() ? kernel.execute(/** @type {any} */ (payload)) : rejected('validation', 'cancelled'),
        getNote: payload => kernel.query(/** @type {any} */ (payload)),
      },
    });
    const client = makeClient(createInProcessTransport({ router, surface: 'newtab' }), scheduler);
    const outcome = await client.execute({
      type: 'createNote',
      commandId: 'c1',
      noteId: 'n1',
      name: 'Plan',
      blocks: [{ id: 'b1', type: 'text', content: 'Line' }],
    });
    assert.equal(outcome.kind, 'committed');
    const state = await client.query({ type: 'getNote', noteId: 'n1' });
    assert.equal(state.kind, 'ready');
    assert.equal(/** @type {any} */ (state).data.note.name, 'Plan');
    const health = await client.query({ type: 'system.messagingHealth' });
    assert.equal(/** @type {any} */ (health).data.handshakes, 1);
  });

  it("refuses what it can't send without opening a connection: an operation it doesn't know, a payload the codec can't carry, one over its size", async () => {
    const scheduler = testScheduler();
    const coordinator = scriptedCoordinator();
    const client = makeClient(coordinator.transport, scheduler);
    const answers = await Promise.all([
      client.execute({ type: 'noSuchCommand', commandId: 'c1' }),
      // A query isn't a command, nor a command a query
      client.execute({ type: 'getNote', commandId: 'c2', noteId: 'n1' }),
      client.query({ type: 'createNote' }),
      client.query({ type: 'constructor' }),
      client.execute({ ...pin('n1'), at: new Date(NOW) }),
      client.query({ type: 'getNote', noteId: 'x'.repeat(SMALL_MESSAGE_BYTES) }),
    ]);
    assert.deepEqual(answers, [
      rejected('validation', 'unknown-operation'),
      rejected('validation', 'unknown-operation'),
      failed('validation', 'unknown-operation'),
      failed('validation', 'unknown-operation'),
      rejected('validation', 'invalid-payload'),
      failed('validation', 'payload-too-large'),
    ]);
    assert.equal(coordinator.attempts, 0);
  });

  it("turns the router's refusals into the outcome or state of a request that never started", async () => {
    const { connection, client } = await welcomed();
    const answers = [
      client.execute(pin('policy')),
      client.execute(pin('late')),
      client.execute(pin('lost')),
      client.execute(pin('stopped')),
      client.query({ type: 'getNote', noteId: 'n1' }),
      client.query({ type: 'getNote', noteId: 'n2' }),
    ];
    await settle();
    const ids = connection.requests().map(frame => frame.requestId);
    connection.send({ frame: 'error', requestId: ids[0], code: 'forbidden-for-surface' });
    connection.send({ frame: 'error', requestId: ids[1], code: 'deadline-exceeded' });
    connection.send({ frame: 'error', requestId: ids[2], code: 'outcome-unknown' });
    connection.send({ frame: 'cancelled', requestId: ids[3] });
    connection.send({ frame: 'error', requestId: ids[4], code: 'unavailable' });
    connection.send({ frame: 'cancelled', requestId: ids[5] });
    assert.deepEqual(await Promise.all(answers), [
      rejected('policy', 'forbidden-for-surface'),
      unavailable('coordinator', 'deadline-exceeded', true),
      unknown('outcome-unknown', 'c-lost'),
      rejected('validation', 'cancelled'),
      failed('coordinator', 'unavailable'),
      failed('validation', 'cancelled'),
    ]);
  });

  it('takes an answer only once its result schema does, and ignores one for a request it never sent', async () => {
    const { connection, client } = await welcomed();
    const command = client.execute(pin('n1'));
    const query = client.query({ type: 'getNote', noteId: 'n1' });
    await settle();
    const [commandId, queryId] = connection.requests().map(frame => frame.requestId);
    connection.send({ frame: 'response', requestId: 'never-sent', result: noNote });
    connection.send({ frame: 'response', requestId: commandId, result: { kind: 'committed', code: 'Pinned!' } });
    connection.send({ frame: 'response', requestId: queryId, result: { kind: 'ready', asOf: NOW } });
    // It may have committed, so the command is unknown until slice 3 resolves it by its key
    assert.deepEqual(await command, unknown('outcome-unknown', 'c-n1'));
    assert.deepEqual(await query, failed('coordinator', 'unavailable'));
  });

  it('matches each answer to its request by requestId, whatever order they come in', async () => {
    const { connection, client } = await welcomed();
    const first = client.query({ type: 'getNote', noteId: 'n1' });
    const second = client.query({ type: 'getNote', noteId: 'n2' });
    await settle();
    const [one, two] = connection.requests().map(frame => frame.requestId);
    assert.notEqual(one, two);
    const note = (/** @type {string} */ id) => ready(NOW, { note: { id } });
    connection.send({ frame: 'response', requestId: two, result: note('n2') });
    connection.send({ frame: 'response', requestId: one, result: note('n1') });
    assert.deepEqual(await Promise.all([first, second]), [note('n1'), note('n2')]);
  });

  it('cancels: a request not yet sent never goes, and one that went ends as the router says', async () => {
    const scheduler = testScheduler();
    const coordinator = scriptedCoordinator();
    const client = makeClient(coordinator.transport, scheduler);
    // Cancelled before it could be sent
    const early = new AbortController();
    const queued = client.query({ type: 'getNote', noteId: 'n1' }, { signal: early.signal });
    early.abort();
    assert.deepEqual(await queued, failed('validation', 'cancelled'));
    const done = new AbortController();
    done.abort();
    assert.deepEqual(await client.execute(pin('n0'), { signal: done.signal }), rejected('validation', 'cancelled'));
    await settle();
    coordinator.last.welcome();
    await settle();
    assert.deepEqual(coordinator.last.requests(), []);

    // Cancelled once sent: the router answers cancelled, or too-late with the outcome
    const connection = coordinator.last;
    const queryCancel = new AbortController();
    const commandCancel = new AbortController();
    const query = client.query({ type: 'getNote', noteId: 'n1' }, { signal: queryCancel.signal });
    const command = client.execute(pin('n1'), { signal: commandCancel.signal });
    await settle();
    const [queryId, commandId] = connection.requests().map(frame => frame.requestId);
    queryCancel.abort();
    commandCancel.abort();
    await settle();
    assert.deepEqual(
      connection.frames.filter(frame => frame.frame === 'cancel'),
      [
        { frame: 'cancel', requestId: queryId },
        { frame: 'cancel', requestId: commandId },
      ],
    );
    const outcome = committed('note-pinned', ['n1']);
    connection.send({ frame: 'cancelled', requestId: queryId });
    connection.send({ frame: 'too-late', requestId: commandId, outcome });
    connection.send({ frame: 'response', requestId: commandId, result: outcome });
    assert.deepEqual(await query, failed('validation', 'cancelled'));
    assert.deepEqual(await command, outcome);
  });

  it('gives up DEADLINE_GRACE_MS after the deadline, never sooner: a sent command is unknown, a sent query failed', async () => {
    const { scheduler, client } = await welcomed();
    /** @type {unknown[]} */
    const answers = [];
    void client.execute(pin('n1')).then(answer => answers.push(answer));
    void client.query({ type: 'getNote', noteId: 'n1' }).then(answer => answers.push(answer));
    await scheduler.advance(QUERY_DEADLINE_MS + DEADLINE_GRACE_MS - 1);
    assert.deepEqual(answers, []);
    await scheduler.advance(1);
    assert.deepEqual(answers, [failed('coordinator', 'deadline-exceeded')]);
    await scheduler.advance(COMMAND_DEADLINE_MS - QUERY_DEADLINE_MS);
    assert.deepEqual(answers, [failed('coordinator', 'deadline-exceeded'), unknown('deadline-exceeded', 'c-n1')]);
  });

  it('settles what was in flight when the connection closes, and reconnects for the next request in the same session', async () => {
    const { coordinator, connection, client } = await welcomed();
    const command = client.execute(pin('n1'));
    const query = client.query({ type: 'getNote', noteId: 'n1' });
    await settle();
    connection.close();
    // A command that may have reached the coordinator is unknown, and a query failed
    assert.deepEqual(await command, unknown('outcome-unknown', 'c-n1'));
    assert.deepEqual(await query, failed('coordinator', 'unavailable'));
    void client.query({ type: 'getNote', noteId: 'n1' });
    await settle();
    assert.equal(coordinator.connections.length, 2);
    assert.deepEqual(
      coordinator.last.frames.map(frame => [frame.frame, frame.sessionId]),
      [['hello', client.sessionId]],
    );
  });

  it('refuses every call once closed, and settles what it had', async () => {
    const { connection, client } = await welcomed();
    const command = client.execute(pin('n1'));
    await settle();
    client.close();
    assert.deepEqual(await command, unknown('outcome-unknown', 'c-n1'));
    assert.equal(connection.closed, true);
    assert.deepEqual(await client.query({ type: 'getNote', noteId: 'n1' }), failed('coordinator', 'unavailable'));
  });
});
