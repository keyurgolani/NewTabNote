// #13's outcome resolution in the client (#13, "Idempotency and catch-up" and "Cancellation,
// deadlines, payloads"): a command whose reply was lost, to a dropped connection, a deadline,
// or an answer it can't take, resolves by its commandId through the IdempotencyLedger before
// its caller hears anything. Committed answers the original outcome, conflict reads back,
// absent allows one resend with the same key, and nothing shows saved or failed before then.
// A journaled command a page had in flight when it went resumes the same way, and one that
// isn't journaled is never sent again. The coordinator here is the scripted one, so each test
// chooses what's lost; restart.test.mjs runs the same on the Chrome fake.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  COMMAND_DEADLINE_MS,
  DEADLINE_GRACE_MS,
  LEDGER_READ_TIMEOUT_MS,
  MAX_MESSAGE_BYTES,
  RECONNECT_DELAYS_MS,
} from '../../js/kernel/core/contracts/limits.js';
import { committed, conflict, rejected, UnavailableError, unknown } from '../../js/kernel/core/contracts/outcomes.js';
import { createClient } from '../../js/kernel/core/messaging/client.js';
import { createLookup, operationOf } from '../../js/kernel/core/messaging/operations.js';
import { createMemoryLedger } from '../../js/kernel/core/memory/ledger.js';
import { testIds } from './support.mjs';
import { OPERATIONS, VERSION, lookup, scriptedCoordinator, settle, testScheduler } from './messaging-support.mjs';

/** @typedef {import('../../js/kernel/core/messaging/client.js').ClientOptions} ClientOptions */
/** @typedef {import('../../js/kernel/core/ports/idempotency-ledger.js').IdempotencyLedger} IdempotencyLedger */
/** @typedef {import('../../js/kernel/core/ports/idempotency-ledger.js').LedgerRead} LedgerRead */
/** @typedef {import('../../js/kernel/core/ports/journal.js').JournalEntry} JournalEntry */
/** @typedef {import('../../js/kernel/core/contracts/commands.js').CommandEntry} CommandEntry */

/**
 * `name`'s operation with its catalog entry journaled
 * @param {string} name
 */
const journaled = name =>
  operationOf(/** @type {CommandEntry} */ ({ ...OPERATIONS[name].entry, journaled: true }), OPERATIONS[name]);

/** A setPinned whose commandId names its note */
const pin = (noteId = 'n1') => ({ type: 'setPinned', commandId: `c-${noteId}`, noteId, pinned: true });

const pinned = committed('note-pinned', ['n1'], { commitSeq: 4 });

/**
 * A ledger over the in-memory one that keeps what it was asked, and can hold or fail a read
 * @param {ReturnType<typeof createMemoryLedger>} [inner]
 */
function spyLedger(inner = createMemoryLedger()) {
  /** @type {Array<Record<string, unknown>>} */
  const reads = [];
  /** @type {Array<() => void>} */
  const held = [];
  let hold = false;
  let fail = false;
  /** @type {IdempotencyLedger} */
  const ledger = {
    async read(command) {
      reads.push(structuredClone(command));
      if (hold) await new Promise(resolve => held.push(() => resolve(undefined)));
      if (fail) throw new UnavailableError('storage', 'read-failed', true);
      return inner.read(command);
    },
  };
  return {
    ledger,
    inner,
    reads,
    /** @param {boolean} value */
    set hold(value) {
      hold = value;
    },
    /** @param {boolean} value */
    set fail(value) {
      fail = value;
    },
    release: () => {
      for (const go of held.splice(0)) go();
    },
  };
}

/**
 * A client with `ledger`, welcomed by a scripted coordinator
 * @param {Partial<ClientOptions>} [options]
 */
async function welcomed(options = {}) {
  const scheduler = testScheduler();
  const coordinator = scriptedCoordinator();
  const client = createClient({
    transport: coordinator.transport,
    surface: 'newtab',
    extensionVersion: VERSION,
    lookup,
    ids: testIds('client'),
    clock: scheduler.clock,
    timers: scheduler.timers,
    ...options,
  });
  client.retry();
  await settle();
  coordinator.last.welcome();
  await settle();
  coordinator.last.frames.length = 0;
  return { scheduler, coordinator, client };
}

/**
 * Whether `promise` has settled yet
 * @param {Promise<unknown>} promise
 */
async function isSettled(promise) {
  let done = false;
  void promise.then(() => {
    done = true;
  });
  await settle();
  return done;
}

/**
 * Welcomes the connection the client opened last, once it has
 * @param {{connections: unknown[], last: import('./messaging-support.mjs').Scripted}} scripted
 * @param {number} count - how many connections it should have opened by then
 */
async function welcomeNext(scripted, count) {
  for (let tries = 0; scripted.connections.length < count && tries < 50; tries += 1) await settle();
  assert.equal(scripted.connections.length, count, 'the client opened its next connection');
  scripted.last.welcome();
  await settle();
}

describe(
  'the client: a lost reply resolves by its commandId (#13, "Idempotency and catch-up")',
  { timeout: 10_000 },
  () => {
    it('answers the outcome the ledger kept when the connection goes after the command was sent, and sends nothing again', async () => {
      const spy = spyLedger();
      spy.inner.record(pin(), pinned);
      const { coordinator, client } = await welcomed({ ledger: spy.ledger });
      const answer = client.execute(pin());
      await settle();
      assert.equal(coordinator.last.requests().length, 1);
      coordinator.last.close();
      assert.deepEqual(await answer, pinned);
      assert.deepEqual(spy.reads, [pin()]);
      assert.equal(coordinator.attempts, 1);
    });

    it('reads a conflict back as the conflict the command was kept with', async () => {
      const spy = spyLedger();
      const lost = conflict('revision-conflict', 3);
      spy.inner.record(pin(), lost);
      const { coordinator, client } = await welcomed({ ledger: spy.ledger });
      const answer = client.execute(pin());
      await settle();
      coordinator.last.close();
      assert.deepEqual(await answer, lost);
    });

    it('sends a command the ledger has no record of once more, with the same commandId, and answers what that send gets', async () => {
      const spy = spyLedger();
      const { coordinator, client } = await welcomed({ ledger: spy.ledger });
      const answer = client.execute(pin());
      await settle();
      const [first] = coordinator.last.requests();
      coordinator.last.close();
      await welcomeNext(coordinator, 2);
      const [second] = coordinator.last.requests();
      assert.deepEqual(second.payload, first.payload);
      assert.notEqual(second.requestId, first.requestId);
      coordinator.last.send({ frame: 'response', requestId: second.requestId, result: pinned });
      assert.deepEqual(await answer, pinned);
    });

    it('allows one resend only: one lost too reads the ledger again, and stays unknown while it has no record', async () => {
      const spy = spyLedger();
      const { coordinator, client } = await welcomed({ ledger: spy.ledger });
      const answer = client.execute(pin());
      await settle();
      coordinator.last.close();
      await welcomeNext(coordinator, 2);
      coordinator.last.close();
      assert.deepEqual(await answer, unknown('outcome-unknown', 'c-n1'));
      assert.equal(spy.reads.length, 2);
      assert.equal(coordinator.connections.flatMap(connection => connection.requests()).length, 2);
    });

    it('answers the outcome a lost resend committed with, once the ledger has it', async () => {
      const spy = spyLedger();
      const { coordinator, client } = await welcomed({ ledger: spy.ledger });
      const answer = client.execute(pin());
      await settle();
      coordinator.last.close();
      await welcomeNext(coordinator, 2);
      spy.inner.record(pin(), pinned);
      coordinator.last.close();
      assert.deepEqual(await answer, pinned);
    });

    it('fails closed on a key the ledger holds for another command, and sends nothing again', async () => {
      const spy = spyLedger();
      spy.inner.record({ ...pin(), pinned: false }, pinned);
      const { coordinator, client } = await welcomed({ ledger: spy.ledger });
      const answer = client.execute(pin());
      await settle();
      coordinator.last.close();
      assert.deepEqual(await answer, rejected('validation', 'idempotency-key-reuse'));
      assert.equal(coordinator.attempts, 1);
    });

    it('resolves a command whose deadline passed, or whose answer its schema refused, the same way, on the open connection', async () => {
      const spy = spyLedger();
      const { scheduler, coordinator, client } = await welcomed({ ledger: spy.ledger });
      const late = client.execute(pin('n1'));
      const garbled = client.execute(pin('n2'));
      await settle();
      const [, second] = coordinator.last.requests();
      coordinator.last.send({ frame: 'response', requestId: second.requestId, result: { kind: 'committed' } });
      /** @param {Record<string, any>} request */
      const answerIt = request =>
        coordinator.last.send({
          frame: 'response',
          requestId: request.requestId,
          result: committed('note-pinned', [request.payload.noteId]),
        });
      await settle();
      await settle();
      const [garbledAgain] = coordinator.last.requests().slice(2);
      assert.equal(garbledAgain.payload.commandId, 'c-n2');
      answerIt(garbledAgain);
      await scheduler.advance(COMMAND_DEADLINE_MS + DEADLINE_GRACE_MS);
      const [lateAgain] = coordinator.last.requests().slice(3);
      assert.equal(lateAgain.payload.commandId, 'c-n1');
      answerIt(lateAgain);
      assert.deepEqual(await Promise.all([late, garbled]), [
        committed('note-pinned', ['n1']),
        committed('note-pinned', ['n2']),
      ]);
      assert.equal(coordinator.attempts, 1);
    });

    it('shows nothing saved or failed while it verifies, and offers no Reload then', async () => {
      const spy = spyLedger();
      spy.inner.record(pin(), pinned);
      const { coordinator, client } = await welcomed({ ledger: spy.ledger });
      spy.hold = true;
      const answer = client.execute(pin());
      await settle();
      coordinator.last.close();
      await settle();
      assert.equal(spy.reads.length, 1);
      assert.equal(await isSettled(answer), false);
      assert.equal(client.canReload(), false);
      spy.release();
      assert.deepEqual(await answer, pinned);
      assert.equal(client.canReload(), true);
    });

    it('stays unknown, sending nothing again, when the ledger read fails or answers something no ledger would', async () => {
      const spy = spyLedger();
      spy.fail = true;
      const odd = /** @type {IdempotencyLedger} */ ({
        read: async () => /** @type {any} */ ({ status: 'committed', outcome: { kind: 'committed' } }),
      });
      for (const ledger of [spy.ledger, odd]) {
        const { coordinator, client } = await welcomed({ ledger });
        const answer = client.execute(pin());
        await settle();
        coordinator.last.close();
        assert.deepEqual(await answer, unknown('outcome-unknown', 'c-n1'));
        assert.equal(coordinator.attempts, 1);
      }
    });

    it('answers unknown at once without a ledger, as before', async () => {
      const { coordinator, client } = await welcomed();
      const answer = client.execute(pin());
      await settle();
      coordinator.last.close();
      assert.deepEqual(await answer, unknown('outcome-unknown', 'c-n1'));
      assert.equal(coordinator.attempts, 1);
    });

    it('answers unknown once closed while it verifies, and a ledger answer after changes nothing', async () => {
      const spy = spyLedger();
      spy.inner.record(pin(), pinned);
      const { coordinator, client } = await welcomed({ ledger: spy.ledger });
      spy.hold = true;
      const answer = client.execute(pin());
      await settle();
      coordinator.last.close();
      await settle();
      client.close();
      assert.deepEqual(await answer, unknown('outcome-unknown', 'c-n1'));
      spy.release();
      await settle();
      assert.equal(coordinator.attempts, 1);
    });

    it('keeps a cancel after the reply was lost from stopping the resend, since the command may have committed', async () => {
      const spy = spyLedger();
      const { coordinator, client } = await welcomed({ ledger: spy.ledger });
      const controller = new AbortController();
      const answer = client.execute(pin(), { signal: controller.signal });
      await settle();
      coordinator.last.close();
      await settle();
      controller.abort();
      await welcomeNext(coordinator, 2);
      const [resent] = coordinator.last.requests();
      assert.deepEqual(
        coordinator.last.frames.filter(frame => frame.frame === 'cancel'),
        [],
      );
      coordinator.last.send({ frame: 'response', requestId: resent.requestId, result: pinned });
      assert.deepEqual(await answer, pinned);
    });

    it("takes only the coordinator's answer to a resend: one the router or the connection ends reads the ledger again", async () => {
      const spy = spyLedger();
      const { scheduler, coordinator, client } = await welcomed({ ledger: spy.ledger });
      const refused = client.execute(pin('n1'));
      await settle();
      coordinator.last.close();
      await welcomeNext(coordinator, 2);
      const [resent] = coordinator.last.requests();
      coordinator.last.send({ frame: 'error', requestId: resent.requestId, code: 'unavailable' });
      assert.deepEqual(await refused, unknown('unavailable', 'c-n1'));

      // A resend that can't go at all, as when every reconnect fails, reads it again too
      const unreachable = client.execute(pin('n2'));
      await settle();
      coordinator.reach = 'unreachable';
      coordinator.last.close();
      for (const delay of RECONNECT_DELAYS_MS) await scheduler.advance(delay);
      assert.deepEqual(await unreachable, unknown('unavailable', 'c-n2'));
      assert.deepEqual(
        spy.reads.map(read => read.commandId),
        ['c-n1', 'c-n1', 'c-n2', 'c-n2'],
      );
    });

    it('asks the ledger about the command as it was sent, whatever its caller changed after', async () => {
      const spy = spyLedger();
      const { coordinator, client } = await welcomed({ ledger: spy.ledger });
      const command = pin();
      const answer = client.execute(command);
      command.pinned = false;
      await settle();
      coordinator.last.close();
      await welcomeNext(coordinator, 2);
      const [resent] = coordinator.last.requests();
      assert.equal(resent.payload.pinned, true);
      assert.deepEqual(spy.reads, [pin()]);
      coordinator.last.send({ frame: 'response', requestId: resent.requestId, result: pinned });
      await answer;
    });

    it("reads a bulk command's key from the ledger, never through the adapter's recall, which would reserve it", async () => {
      const spy = spyLedger();
      const { coordinator, client } = await welcomed({ ledger: spy.ledger });
      const archive = { type: 'runBulkAction', commandId: 'b1', action: 'archive', noteIds: ['n1', 'n2'] };
      const answer = client.execute(archive);
      await settle();
      coordinator.last.close();
      await welcomeNext(coordinator, 2);
      assert.deepEqual(spy.reads, [archive]);
      const [resent] = coordinator.last.requests();
      assert.deepEqual(resent.payload, archive);
      coordinator.last.send({ frame: 'response', requestId: resent.requestId, result: { ...bulkArchived } });
      assert.deepEqual(await answer, bulkArchived);
    });
  },
);

/** What archiving n1 and n2 answers */
const bulkArchived = {
  kind: 'bulk',
  code: 'archive',
  items: [
    { id: 'n1', outcome: committed('note-archived', ['n1']) },
    { id: 'n2', outcome: committed('note-archived', ['n2']) },
  ],
  committedIds: ['n1', 'n2'],
  messageKey: 'bulk.archive',
  severity: 'success',
};

/**
 * A lookup in which createNote and setPinned are journaled, as #35 will set createNote
 * (#13, "Desired behavior"): no catalog entry is journaled yet
 */
const journaledLookup = createLookup({
  ...OPERATIONS,
  createNote: journaled('createNote'),
  setPinned: journaled('setPinned'),
});

/**
 * A journal double behind the port, until #17's journal client lands
 * @param {JournalEntry[]} entries
 */
const journalOf = entries => ({ inFlight: async () => structuredClone(entries) });

describe(
  'the client: resuming what a page had in flight (#13, "Idempotency and catch-up")',
  { timeout: 10_000 },
  () => {
    it('answers each journaled command the ledger has a record of with it, and sends none of them', async () => {
      const spy = spyLedger();
      spy.inner.record(pin('n1'), pinned);
      const lost = conflict('revision-conflict', 2);
      spy.inner.record(pin('n2'), lost);
      const scheduler = testScheduler();
      const coordinator = scriptedCoordinator();
      const client = createClient({
        transport: coordinator.transport,
        surface: 'newtab',
        extensionVersion: VERSION,
        lookup: journaledLookup,
        ids: testIds('client'),
        ...scheduler,
        ledger: spy.ledger,
        journal: journalOf([
          { v: 1, command: pin('n1') },
          { v: 1, command: pin('n2') },
        ]),
      });
      assert.deepEqual(await client.resume(), [
        { commandId: 'c-n1', outcome: pinned },
        { commandId: 'c-n2', outcome: lost },
      ]);
      assert.equal(coordinator.attempts, 0);
    });

    it('sends a journaled command the ledger has no record of once, with its key, and answers what it gets', async () => {
      const scheduler = testScheduler();
      const coordinator = scriptedCoordinator();
      const client = createClient({
        transport: coordinator.transport,
        surface: 'newtab',
        extensionVersion: VERSION,
        lookup: journaledLookup,
        ids: testIds('client'),
        ...scheduler,
        ledger: spyLedger().ledger,
        journal: journalOf([{ v: 1, command: pin('n1') }]),
      });
      const resumed = client.resume();
      await welcomeNext(coordinator, 1);
      const [sent] = coordinator.last.requests();
      assert.deepEqual(sent.payload, pin('n1'));
      coordinator.last.send({ frame: 'response', requestId: sent.requestId, result: pinned });
      assert.deepEqual(await resumed, [{ commandId: 'c-n1', outcome: pinned }]);
    });

    it("never sends again a command that isn't journaled, or one the catalog can't take back, and fails closed on key reuse", async () => {
      const spy = spyLedger();
      spy.inner.record({ ...pin('n3'), pinned: false }, pinned);
      const scheduler = testScheduler();
      const coordinator = scriptedCoordinator();
      const client = createClient({
        transport: coordinator.transport,
        surface: 'newtab',
        extensionVersion: VERSION,
        lookup: journaledLookup,
        ids: testIds('client'),
        ...scheduler,
        ledger: spy.ledger,
        journal: journalOf([
          // renameNote isn't journaled: its outcome comes from reading the projection again
          { v: 1, command: { type: 'renameNote', commandId: 'c-r', noteId: 'n1', name: 'A', origin: 'typed' } },
          { v: 2, command: pin('n2') },
          { v: 1, command: pin('n3') },
          { v: 1, command: { type: 'getNote', noteId: 'n1' } },
        ]),
      });
      assert.deepEqual(await client.resume(), [
        { commandId: 'c-r', outcome: unknown('outcome-unknown', 'c-r') },
        { commandId: 'c-n2', outcome: unknown('unsupported-version', 'c-n2') },
        { commandId: 'c-n3', outcome: rejected('validation', 'idempotency-key-reuse') },
        { commandId: '', outcome: rejected('validation', 'unknown-operation') },
      ]);
      assert.equal(coordinator.attempts, 0);
    });

    it('waits on a journaled command it still has open rather than sending it twice', async () => {
      const spy = spyLedger();
      const { coordinator, client } = await welcomed({
        lookup: journaledLookup,
        ledger: spy.ledger,
        journal: journalOf([{ v: 1, command: pin('n1') }]),
      });
      const answer = client.execute(pin('n1'));
      await settle();
      const resumed = client.resume();
      await settle();
      const [sent] = coordinator.last.requests();
      assert.equal(coordinator.last.requests().length, 1);
      coordinator.last.send({ frame: 'response', requestId: sent.requestId, result: pinned });
      assert.deepEqual(await answer, pinned);
      assert.deepEqual(await resumed, [{ commandId: 'c-n1', outcome: pinned }]);
      assert.deepEqual(spy.reads, []);
    });

    it('resumes nothing without a journal and a ledger, or when the journal read fails', async () => {
      const { client } = await welcomed({ ledger: spyLedger().ledger });
      assert.deepEqual(await client.resume(), []);
      const failing = await welcomed({
        ledger: spyLedger().ledger,
        journal: {
          inFlight: async () => {
            throw new UnavailableError('storage', 'read-failed', true);
          },
        },
      });
      assert.deepEqual(await failing.client.resume(), []);
      assert.equal(failing.coordinator.attempts, 1);
    });
  },
);

/**
 * A client that resumes `entries`, over a scripted coordinator it hasn't connected to yet
 * @param {JournalEntry[]} entries
 * @param {Partial<ClientOptions>} [options]
 */
function resuming(entries, options = {}) {
  const scheduler = testScheduler();
  const coordinator = scriptedCoordinator();
  const client = createClient({
    transport: coordinator.transport,
    surface: 'newtab',
    extensionVersion: VERSION,
    lookup: journaledLookup,
    ids: testIds('client'),
    ...scheduler,
    journal: journalOf(entries),
    ...options,
  });
  return { scheduler, coordinator, client };
}

describe('the client: resuming in journal order, by the record first', { timeout: 10_000 }, () => {
  it("resends what has no record in the journal's order, each once the one before it answered, whatever order the reads finish in", async () => {
    const note = { type: 'createNote', commandId: 'c1', noteId: 'n1', name: 'Plan' };
    const pinIt = { type: 'setPinned', commandId: 'c2', noteId: 'n1', pinned: true };
    /** @type {Array<() => void>} */
    const slow = [];
    const ledger = /** @type {IdempotencyLedger} */ ({
      read: async command => {
        // Only the first read of c1 is slow, not the one just before it goes again
        if (command.commandId === 'c1' && slow.length === 0) {
          await new Promise(resolve => slow.push(() => resolve(undefined)));
        }
        return { status: 'absent' };
      },
    });
    const { coordinator, client } = resuming(
      [
        { v: 1, command: note },
        { v: 1, command: pinIt },
      ],
      { ledger },
    );
    const resumed = client.resume();
    await settle();
    assert.equal(coordinator.attempts, 0);
    assert.equal(slow.length, 1);
    slow[0]();
    await welcomeNext(coordinator, 1);
    assert.deepEqual(
      coordinator.last.requests().map(request => request.payload.commandId),
      ['c1'],
    );
    const [first] = coordinator.last.requests();
    coordinator.last.send({ frame: 'response', requestId: first.requestId, result: committed('note-created', ['n1']) });
    for (let tries = 0; coordinator.last.requests().length < 2 && tries < 50; tries += 1) await settle();
    const [, second] = coordinator.last.requests();
    assert.equal(second.payload.commandId, 'c2');
    coordinator.last.send({ frame: 'response', requestId: second.requestId, result: pinned });
    assert.deepEqual(
      (await resumed).map(({ commandId }) => commandId),
      ['c1', 'c2'],
    );
  });

  it('reads the record before anything could refuse it: a committed command answers committed once the client is closed, unsupported, or the command too large, and one with none stays unknown', async () => {
    const big = { type: 'createNote', commandId: 'big', noteId: 'n9', name: 'x'.repeat(MAX_MESSAGE_BYTES) };
    const created = committed('note-created', ['n9'], { commitSeq: 2 });
    for (const recorded of [true, false]) {
      const spy = spyLedger();
      if (recorded) {
        spy.inner.record(pin('n1'), pinned);
        spy.inner.record(big, created);
      }
      // Closed
      const closed = resuming([{ v: 1, command: pin('n1') }], { ledger: spy.ledger });
      closed.client.close();
      // Unsupported: the coordinator speaks another major version
      const unsupported = resuming([{ v: 1, command: pin('n1') }], { ledger: spy.ledger });
      unsupported.client.retry();
      await settle();
      unsupported.coordinator.last.welcome({ protocol: { major: 9, minor: 0 } });
      await settle();
      assert.equal(unsupported.client.state(), 'unsupported');
      // Too large to send
      const large = resuming([{ v: 1, command: big }], { ledger: spy.ledger });
      assert.deepEqual(
        await Promise.all([closed.client.resume(), unsupported.client.resume(), large.client.resume()]),
        recorded
          ? [
              [{ commandId: 'c-n1', outcome: pinned }],
              [{ commandId: 'c-n1', outcome: pinned }],
              [{ commandId: 'big', outcome: created }],
            ]
          : [
              [{ commandId: 'c-n1', outcome: unknown('unavailable', 'c-n1') }],
              [{ commandId: 'c-n1', outcome: unknown('unsupported-version', 'c-n1') }],
              [{ commandId: 'big', outcome: unknown('payload-too-large', 'big') }],
            ],
      );
      assert.equal(large.coordinator.attempts, 0);
    }
  });

  it('reads the record of the command as the journal wrote it, and takes it to the current version only to send it again', async () => {
    // setPinned at catalog version 2, with no step from 1: an entry written at 1 can't go again
    const later = createLookup({
      ...OPERATIONS,
      setPinned: operationOf(
        /** @type {CommandEntry} */ ({ ...OPERATIONS.setPinned.entry, version: 2, journaled: true }),
        OPERATIONS.setPinned,
      ),
    });
    const spy = spyLedger();
    spy.inner.record(pin('n1'), pinned);
    const { coordinator, client } = resuming(
      [
        { v: 1, command: pin('n1') },
        { v: 1, command: pin('n2') },
      ],
      { ledger: spy.ledger, lookup: later },
    );
    assert.deepEqual(await client.resume(), [
      { commandId: 'c-n1', outcome: pinned },
      { commandId: 'c-n2', outcome: unknown('unsupported-version', 'c-n2') },
    ]);
    assert.deepEqual(spy.reads, [pin('n1'), pin('n2')]);
    assert.equal(coordinator.attempts, 0);
  });
});

describe("the client: ledger reads that don't answer, and what closing does to a resume", { timeout: 10_000 }, () => {
  /** A ledger that never answers */
  const silent = /** @type {IdempotencyLedger} */ ({ read: () => new Promise(() => {}) });

  it('gives a lost reply up as unknown once the ledger has not answered in LEDGER_READ_TIMEOUT_MS, and sends nothing again', async () => {
    const { scheduler, coordinator, client } = await welcomed({ ledger: silent });
    const answer = client.execute(pin());
    await settle();
    coordinator.last.close();
    await scheduler.advance(LEDGER_READ_TIMEOUT_MS - 1);
    assert.equal(await isSettled(answer), false);
    await scheduler.advance(1);
    assert.deepEqual(await answer, unknown('outcome-unknown', 'c-n1'));
    assert.equal(coordinator.attempts, 1);
  });

  it("answers a journal entry whose record doesn't come in time unknown, and sends nothing", async () => {
    const { scheduler, coordinator, client } = resuming([{ v: 1, command: pin('n1') }], { ledger: silent });
    const resumed = client.resume();
    await scheduler.advance(LEDGER_READ_TIMEOUT_MS);
    assert.deepEqual(await resumed, [{ commandId: 'c-n1', outcome: unknown('outcome-unknown', 'c-n1') }]);
    assert.equal(coordinator.attempts, 0);
  });

  it('stops a running resume when closed: what it has not resolved is unavailable, at once', async () => {
    const { coordinator, client } = resuming(
      [
        { v: 1, command: pin('n1') },
        { v: 1, command: pin('n2') },
      ],
      { ledger: silent },
    );
    const resumed = client.resume();
    await settle();
    client.close();
    assert.deepEqual(await resumed, [
      { commandId: 'c-n1', outcome: unknown('unavailable', 'c-n1') },
      { commandId: 'c-n2', outcome: unknown('unavailable', 'c-n2') },
    ]);
    assert.equal(coordinator.attempts, 0);
  });

  it('answers an entry of an operation it does not know, under a commandId, unknown rather than a definite refusal', async () => {
    const { client } = resuming([{ v: 1, command: { type: 'renamedSince', commandId: 'c-x', noteId: 'n1' } }], {
      ledger: spyLedger().ledger,
    });
    assert.deepEqual(await client.resume(), [{ commandId: 'c-x', outcome: unknown('unknown-operation', 'c-x') }]);
  });

  it('reads the ledger again just before each resend, so one recorded meanwhile goes no more', async () => {
    const spy = spyLedger();
    const { coordinator, client } = resuming(
      [
        { v: 1, command: pin('n1') },
        { v: 1, command: pin('n2') },
      ],
      { ledger: spy.ledger },
    );
    const resumed = client.resume();
    await welcomeNext(coordinator, 1);
    const [first] = coordinator.last.requests();
    // Another context committed the second while the first was out
    spy.inner.record(pin('n2'), committed('note-pinned', ['n2']));
    coordinator.last.send({ frame: 'response', requestId: first.requestId, result: pinned });
    assert.deepEqual(await resumed, [
      { commandId: 'c-n1', outcome: pinned },
      { commandId: 'c-n2', outcome: committed('note-pinned', ['n2']) },
    ]);
    assert.deepEqual(
      coordinator.last.requests().map(request => request.payload.commandId),
      ['c-n1'],
    );
  });
});
