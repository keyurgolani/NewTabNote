// #13's client (core/messaging/client.js): how a page or the worker's own code reaches the
// router. It opens one connection when it first has something to send, says hello, sends
// once welcomed, and answers every call with #12's outcome union or a query state, however
// the call ended (#13, "Outcomes and authorization" and "Cancellation, deadlines, payloads").

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { createKernel } from './test-kernel.mjs';
import {
  COMMAND_DEADLINE_MS,
  DEADLINE_GRACE_MS,
  HANDSHAKE_TIMEOUT_MS,
  MAX_MESSAGE_BYTES,
  PROTOCOL_VERSION,
  QUERY_DEADLINE_MS,
  RECONNECTING_AFTER_MS,
  RECONNECT_DELAYS_MS,
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
  client.retry();
  await settle();
  coordinator.last.welcome();
  await settle();
  coordinator.last.frames.length = 0;
  return { scheduler, coordinator, client, connection: coordinator.last };
}

/** A getNote, the query the status tests wait on */
const getNote = { type: 'getNote', noteId: 'n1' };

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

  it('reconnects for a call that found its connection closing under it, and sends it on the next', async () => {
    const { coordinator, connection, client } = await welcomed();
    // The coordinator went, and the client hasn't heard yet, so the send fails and the call waits
    connection.close();
    const answer = client.query({ type: 'getNote', noteId: 'n1' });
    await settle();
    assert.equal(coordinator.connections.length, 2);
    coordinator.last.welcome();
    await settle();
    const [sent] = coordinator.last.requests();
    assert.deepEqual(sent.payload, { type: 'getNote', noteId: 'n1' });
    coordinator.last.send({ frame: 'response', requestId: sent.requestId, result: noNote });
    assert.deepEqual(await answer, noNote);
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

  it('sends what a call held when it was made, whatever its caller changes before the welcome', async () => {
    const scheduler = testScheduler();
    const coordinator = scriptedCoordinator();
    const client = makeClient(coordinator.transport, scheduler);
    /** @type {Record<string, any>} */
    const command = pin('n1');
    /** @type {Record<string, any>} */
    const query = { type: 'getNote', noteId: 'n1' };
    /** @type {Record<string, any>} */
    const save = { type: 'createNote', commandId: 'c-save', noteId: 'n2', blocks: [{ id: 'b1', content: 'Line' }] };
    const answers = [
      client.execute(/** @type {any} */ (command)),
      client.query(/** @type {any} */ (query)),
      client.execute(/** @type {any} */ (save)),
    ];
    // Each change would have changed the command under the same commandId, made it unencodable,
    // or grown it past what its entry takes
    command.pinned = false;
    command.at = new Date(NOW);
    query.noteId = 'n2';
    save.blocks[0].content = 'x'.repeat(MAX_MESSAGE_BYTES);
    await settle();
    coordinator.last.welcome();
    await settle();
    const sent = coordinator.last.requests();
    assert.deepEqual(
      sent.map(frame => frame.payload),
      [
        pin('n1'),
        { type: 'getNote', noteId: 'n1' },
        { type: 'createNote', commandId: 'c-save', noteId: 'n2', blocks: [{ id: 'b1', content: 'Line' }] },
      ],
    );
    const results = [committed('note-pinned', ['n1']), noNote, committed('note-created', ['n2'])];
    sent.forEach((frame, index) =>
      coordinator.last.send({ frame: 'response', requestId: frame.requestId, result: results[index] }),
    );
    assert.deepEqual(await Promise.all(answers), results);
  });

  it("settles a waiting call whose frame can't be encoded when it goes, and keeps serving the rest", async () => {
    const scheduler = testScheduler();
    const coordinator = scriptedCoordinator();
    let broken = false;
    // A clock that reads NaN makes a deadline no frame can carry
    const client = makeClient(coordinator.transport, scheduler, {
      clock: { now: () => (broken ? Number.NaN : scheduler.clock.now()) },
    });
    const waiting = [client.execute(pin('n1')), client.query({ type: 'getNote', noteId: 'n1' })];
    await settle();
    broken = true;
    assert.doesNotThrow(() => coordinator.last.welcome());
    await settle();
    assert.deepEqual(await Promise.all(waiting), [
      rejected('validation', 'invalid-payload'),
      failed('validation', 'invalid-payload'),
    ]);
    broken = false;
    const later = client.query({ type: 'getNote', noteId: 'n1' });
    await settle();
    const [sent] = coordinator.last.requests();
    coordinator.last.send({ frame: 'response', requestId: sent.requestId, result: noNote });
    assert.deepEqual([await later, client.state()], [noNote, 'connected']);
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

describe('the client: connection status (#13, "Product and interaction requirements" and AC3)', () => {
  /**
   * A client over a coordinator the test plays, and every state its listeners heard
   * @param {Partial<ClientOptions>} [options]
   */
  function watched(options = {}) {
    const scheduler = testScheduler();
    const coordinator = scriptedCoordinator();
    const client = makeClient(coordinator.transport, scheduler, options);
    /** @type {string[]} */
    const states = [];
    client.subscribe(state => states.push(state));
    return { scheduler, coordinator, client, states };
  }

  it('opens nothing while idle, and a worker that stops while nothing waits changes nothing on screen', async () => {
    const { scheduler, coordinator, client, states } = watched();
    assert.equal(client.state(), 'idle');
    await scheduler.advance(60_000);
    assert.equal(coordinator.attempts, 0);
    const answer = client.query(getNote);
    await settle();
    coordinator.last.welcome();
    await settle();
    const [sent] = coordinator.last.requests();
    coordinator.last.send({ frame: 'response', requestId: sent.requestId, result: noNote });
    await answer;
    // The worker stops while idle: no Reconnecting, no reconnect, and no keep-alive
    coordinator.last.close();
    await settle();
    assert.deepEqual(states, ['connecting', 'connected', 'idle']);
    assert.equal(scheduler.waiting, 0);
    await scheduler.advance(60_000);
    assert.equal(coordinator.attempts, 1);
  });

  it('shows Reconnecting only once a user-visible request has waited RECONNECTING_AFTER_MS without a welcome', async () => {
    const { scheduler, coordinator, client, states } = watched();
    // A request the user isn't waiting on shows nothing
    void client.query(getNote, { userVisible: false });
    await scheduler.advance(RECONNECTING_AFTER_MS);
    assert.deepEqual(states, ['connecting']);
    void client.query(getNote);
    await scheduler.advance(RECONNECTING_AFTER_MS - 1);
    assert.deepEqual(states, ['connecting']);
    await scheduler.advance(1);
    assert.deepEqual(states, ['connecting', 'reconnecting']);
    coordinator.last.welcome();
    await settle();
    assert.deepEqual(states, ['connecting', 'reconnecting', 'connected']);
    assert.equal(coordinator.attempts, 1);
  });

  it('shows Reconnecting at once when waking the worker fails, and Coordinator unavailable after the third retry, at 0.5, 1, and 2 s', async () => {
    const { scheduler, coordinator, client, states } = watched();
    coordinator.reach = 'unreachable';
    const answer = client.execute(pin('n1'));
    await settle();
    assert.deepEqual(states, ['connecting', 'reconnecting']);
    /** @type {number[]} */
    const attempts = [];
    for (const delay of RECONNECT_DELAYS_MS) {
      await scheduler.advance(delay - 1);
      attempts.push(coordinator.attempts);
      await scheduler.advance(1);
      attempts.push(coordinator.attempts);
    }
    assert.deepEqual(attempts, [1, 2, 2, 3, 3, 4]);
    assert.deepEqual(states, ['connecting', 'reconnecting', 'unavailable']);
    // It was never sent, so it definitely didn't run
    assert.deepEqual(await answer, unavailable('coordinator', 'unavailable', true));
    assert.equal(scheduler.waiting, 0);

    // A page whose extension context is gone can't connect either
    const gone = watched();
    gone.coordinator.reach = 'throws';
    void gone.client.query(getNote);
    await settle();
    assert.deepEqual(gone.states, ['reconnecting']);
  });

  it('counts a handshake that never answers as a failed attempt, HANDSHAKE_TIMEOUT_MS on', async () => {
    const { scheduler, coordinator, client } = watched();
    void client.query(getNote);
    await scheduler.advance(HANDSHAKE_TIMEOUT_MS - 1);
    assert.equal(coordinator.last.closed, false);
    await scheduler.advance(1);
    assert.equal(coordinator.last.closed, true);
    await scheduler.advance(RECONNECT_DELAYS_MS[0]);
    assert.equal(coordinator.attempts, 2);
    // The request has waited past RECONNECTING_AFTER_MS all the while
    assert.equal(client.state(), 'reconnecting');
    coordinator.last.welcome();
    await settle();
    assert.equal(client.state(), 'connected');
    assert.equal(coordinator.last.requests().length, 1);
  });

  it('connects at once on retry() while it waits to try again, and does nothing while a connection opens or is open', async () => {
    const { scheduler, coordinator, client } = watched();
    coordinator.reach = 'unreachable';
    void client.query(getNote);
    await settle();
    assert.deepEqual([coordinator.attempts, client.state()], [1, 'reconnecting']);
    client.retry();
    await settle();
    assert.equal(coordinator.attempts, 2);
    // The wait it cut short doesn't try as well, and the next one runs from this attempt
    await scheduler.advance(RECONNECT_DELAYS_MS[1] - 1);
    assert.equal(coordinator.attempts, 2);
    coordinator.reach = 'open';
    await scheduler.advance(1);
    assert.equal(coordinator.attempts, 3);
    client.retry();
    assert.equal(coordinator.attempts, 3);
    coordinator.last.welcome();
    await settle();
    client.retry();
    assert.deepEqual([coordinator.attempts, client.state()], [3, 'connected']);
  });

  it('tries again once the coordinator was unavailable, on the next request or Retry, and a welcome resolves it', async () => {
    const { scheduler, coordinator, client, states } = watched();
    coordinator.reach = 'unreachable';
    void client.query(getNote);
    await scheduler.advance(RECONNECT_DELAYS_MS.reduce((sum, delay) => sum + delay, 0));
    assert.equal(client.state(), 'unavailable');
    coordinator.reach = 'open';
    client.retry();
    await settle();
    coordinator.last.welcome();
    await settle();
    assert.deepEqual(states, ['connecting', 'reconnecting', 'unavailable', 'reconnecting', 'connected']);
    // The next request after an idle stop, by contrast, reconnects silently
    coordinator.last.close();
    await settle();
    void client.query(getNote);
    await settle();
    coordinator.last.welcome();
    await settle();
    assert.deepEqual(states.slice(-3), ['idle', 'connecting', 'connected']);
  });

  it('sends nothing more on a major-version mismatch, and offers Reload only with no composition or pending commit', async () => {
    let composing = false;
    let pendingCommit = false;
    const { coordinator, client, states } = watched({
      isComposing: () => composing,
      hasPendingCommit: () => pendingCommit,
    });
    const answer = client.execute(pin('n1'));
    await settle();
    coordinator.last.welcome({ protocol: { major: PROTOCOL_VERSION.major + 1, minor: 0 } });
    await settle();
    assert.deepEqual(states, ['connecting', 'unsupported']);
    assert.deepEqual(await answer, rejected('validation', 'unsupported-version'));
    assert.equal(coordinator.last.closed, true);
    assert.deepEqual(coordinator.last.requests(), []);
    assert.deepEqual(await client.query(getNote), failed('validation', 'unsupported-version'));
    client.retry();
    await settle();
    assert.equal(coordinator.attempts, 1);

    assert.equal(client.canReload(), true);
    composing = true;
    assert.equal(client.canReload(), false);
    composing = false;
    pendingCommit = true;
    assert.equal(client.canReload(), false);
  });

  it("doesn't offer Reload while a command of its own waits for its answer, or a check it asks throws", async () => {
    const { connection, client } = await welcomed();
    assert.equal(client.canReload(), true);
    const command = client.execute(pin('n1'));
    await settle();
    assert.equal(client.canReload(), false);
    const [sent] = connection.requests();
    connection.send({ frame: 'response', requestId: sent.requestId, result: committed('note-pinned', ['n1']) });
    await command;
    assert.equal(client.canReload(), true);
    const broken = await welcomed({
      isComposing: () => {
        throw new Error('broken');
      },
    });
    assert.equal(broken.client.canReload(), false);
  });

  it('keeps a status listener that throws from stopping the others, and one that unsubscribed hears nothing', async () => {
    /** @type {string[]} */
    const reported = [];
    const { coordinator, client } = watched({ logger: { warn: event => reported.push(event) } });
    client.subscribe(() => {
      throw new Error('a broken listener');
    });
    /** @type {string[]} */
    const heard = [];
    const stop = client.subscribe(state => heard.push(state));
    client.retry();
    await settle();
    assert.deepEqual(heard, ['connecting']);
    assert.ok(reported.includes('client-status-listener-failed'));
    stop();
    coordinator.last.welcome();
    await settle();
    assert.deepEqual(heard, ['connecting']);
  });
});
