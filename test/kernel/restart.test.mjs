// #13's restart matrix on the Chrome fake (#13, "Test plan" and AC3): the worker stopping
// before a command reached it, and after it committed but before its reply; a Popup closed
// with a command in flight; a page reloaded with a stale cursor; a cursor below the commit
// log's floor. The harness keeps storage outside the fake worker, as IndexedDB outlives it:
// the in-memory adapter, its IdempotencyLedger and CommitLog, and a journal double, until
// #17's journal client lands. The worker's own memory, its kernel, router, and hint publisher,
// goes each time it stops, and its top-level code builds them again when it starts. Pages
// reach it over the runtime port, as #35's coordinator will be reached; no surface's client
// moves to the port in this slice. Streams, and a worker stop mid-stream, come with slice 4.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { openHintChannel } from '../../js/kernel/adapters/messaging/hint-channel.js';
import { createRuntimePortTransport, installRuntimePort } from '../../js/kernel/adapters/messaging/runtime-port.js';
import { createKernel } from '../../js/kernel/core/application/kernel.js';
import { COMMAND_TYPES } from '../../js/kernel/core/contracts/commands.js';
import { rejected } from '../../js/kernel/core/contracts/outcomes.js';
import { QUERY_TYPES } from '../../js/kernel/core/contracts/queries.js';
import { createCatchUp } from '../../js/kernel/core/messaging/catch-up.js';
import { createClient } from '../../js/kernel/core/messaging/client.js';
import { createHintPublisher, createHintSubscriber } from '../../js/kernel/core/messaging/hints.js';
import { createLookup, operationOf } from '../../js/kernel/core/messaging/operations.js';
import { createRouter } from '../../js/kernel/core/messaging/router.js';
import { SYSTEM_OPERATIONS } from '../../js/kernel/core/messaging/system-operations.js';
import { createMemoryAdapter } from '../../js/kernel/core/memory/adapter.js';
import { createMemoryCommitLog } from '../../js/kernel/core/memory/commit-log.js';
import { createMemoryLedger } from '../../js/kernel/core/memory/ledger.js';
import { createBaselinePolicy } from '../../js/kernel/core/ports/policy.js';
import { createChromeFake } from './chrome-fake.mjs';
import { CALLERS, testIds } from './support.mjs';
import { OPERATIONS, VERSION, lookup, settle, testScheduler } from './messaging-support.mjs';

/** @typedef {import('../../js/kernel/core/contracts/commands.js').CommandEntry} CommandEntry */
/** @typedef {import('../../js/kernel/core/contracts/outcomes.js').Outcome} Outcome */
/** @typedef {import('../../js/kernel/core/messaging/client.js').Client} Client */
/** @typedef {import('../../js/kernel/core/messaging/hints.js').Hint} Hint */
/** @typedef {import('../../js/kernel/core/messaging/router.js').Handler} Handler */
/** @typedef {import('../../js/kernel/core/ports/commit-log.js').ChangeEntry} ChangeEntry */
/** @typedef {import('../../js/kernel/core/ports/journal.js').JournalEntry} JournalEntry */

/**
 * The lookup a client builds once #35 sets createNote journaled (#13, "Desired behavior"):
 * no catalog entry is journaled yet, so these tests mark it
 */
const journaledLookup = createLookup({
  ...OPERATIONS,
  ...SYSTEM_OPERATIONS,
  createNote: operationOf(
    /** @type {CommandEntry} */ ({ ...OPERATIONS.createNote.entry, journaled: true }),
    OPERATIONS.createNote,
  ),
});

/**
 * @typedef {object} Hooks
 * @property {(payload: Record<string, any>) => unknown} [beforeCommit]
 *   Runs once the command has begun, before the kernel runs it
 * @property {(payload: Record<string, any>, outcome: unknown) => unknown} [afterCommit]
 *   Runs once it committed, before the router replies
 */

/**
 * The fake, storage outside its worker, and the worker's top-level code
 */
function harness() {
  const fake = createChromeFake();
  const scheduler = testScheduler();
  const ledger = createMemoryLedger();
  const commitLog = createMemoryCommitLog();
  const adapter = createMemoryAdapter({ ledger, commitLog });
  /** @type {string[]} the commandIds the worker's handlers ran, across its starts */
  const runs = [];
  /** @type {Hooks} */
  const hooks = {};
  let documents = 0;

  fake.worker.install(chrome => {
    // Everything here is the worker's memory, which goes when it stops
    const kernel = createKernel({
      adapter,
      policy: createBaselinePolicy(),
      caller: CALLERS.newtab,
      ids: testIds(`worker-${fake.worker.starts + 1}`),
      clock: scheduler.clock,
    });
    /** @type {ReturnType<typeof createHintPublisher> | null} */
    let publisher = null;
    /** @param {Outcome} outcome */
    const hint = async outcome => {
      if (outcome.kind !== 'committed' || outcome.commitSeq === undefined) return;
      const context = fake.worker.context;
      if (!context) return;
      publisher ??= createHintPublisher({
        channel: openHintChannel({ origin: fake.origin, BroadcastChannel: context.BroadcastChannel }),
      });
      const read = await commitLog.readChangesSince(outcome.commitSeq - 1, 1);
      if (read.kind === 'changes')
        for (const { commitSeq, ...change } of read.entries) publisher.publish({ ...change, commitSeq });
    };
    /** @type {Record<string, Handler>} */
    const handlers = Object.fromEntries([
      ...COMMAND_TYPES.map(type => [
        type,
        /** @type {Handler} */ (
          async (payload, context) => {
            if (!context.begin()) return rejected('validation', 'cancelled');
            const command = /** @type {Record<string, any>} */ (payload);
            runs.push(command.commandId);
            await hooks.beforeCommit?.(command);
            const outcome = await kernel.execute(/** @type {any} */ (command));
            await hint(/** @type {Outcome} */ (outcome));
            await hooks.afterCommit?.(command, outcome);
            return outcome;
          }
        ),
      ]),
      ...QUERY_TYPES.map(type => [
        type,
        /** @type {Handler} */ (payload => kernel.query(/** @type {any} */ (payload))),
      ]),
    ]);
    const router = createRouter({
      lookup,
      handlers,
      policy: createBaselinePolicy(),
      ...scheduler,
      coordinatorId: `coordinator-${fake.worker.starts + 1}`,
      extensionVersion: VERSION,
    });
    installRuntimePort({ runtime: chrome.runtime, router });
  });

  /**
   * A page of `surface` with a client to the worker over the runtime port, the ledger, and,
   * when given, a journal double
   * @param {'newtab' | 'popup'} surface
   * @param {{journal?: JournalEntry[]}} [options]
   */
  const open = (surface, { journal } = {}) => {
    const context = fake.page(surface);
    documents += 1;
    const client = createClient({
      transport: createRuntimePortTransport({ runtime: context.chrome.runtime }),
      surface,
      extensionVersion: VERSION,
      lookup: journal ? journaledLookup : lookup,
      ids: testIds(`${surface}-${documents}`),
      ...scheduler,
      ledger,
      ...(journal ? { journal: { inFlight: async () => structuredClone(journal) } } : {}),
    });
    return { context, client };
  };

  /**
   * A page's projection: the notes it shows, read in-process from storage as Popup and Side
   * Panel read today, with catch-up from the commit log
   * @param {{BroadcastChannel: any}} context - the page's, whose hint channel it hears
   */
  const projection = context => {
    const kernel = createKernel({
      adapter,
      policy: createBaselinePolicy(),
      caller: CALLERS.newtab,
      ids: testIds('page-kernel'),
      clock: scheduler.clock,
    });
    /** @type {Map<string, number>} each note it shows, at its revision */
    const notes = new Map();
    /** @type {ChangeEntry[]} */
    const applied = [];
    let reads = 0;
    const subscriber = createHintSubscriber({
      channel: openHintChannel({ origin: fake.origin, BroadcastChannel: context.BroadcastChannel }),
    });
    const catchUp = createCatchUp({
      subscribe: subscriber.subscribe,
      commitLog,
      async project() {
        reads += 1;
        const asOf = await commitLog.head();
        const listed = await kernel.query({ type: 'listNotes', view: 'withArchived' });
        notes.clear();
        if (listed.kind === 'ready') for (const note of listed.data) notes.set(note.id, 0);
        return asOf;
      },
      apply(entries) {
        applied.push(...entries);
        for (const entry of entries) notes.set(entry.entityId, entry.revision);
      },
    });
    return {
      catchUp,
      notes,
      applied,
      get reads() {
        return reads;
      },
    };
  };

  return { fake, scheduler, ledger, commitLog, adapter, runs, hooks, open, projection };
}

/**
 * Lets the fake's messages and the client's reads run until `done` holds
 * @param {() => boolean} done
 */
async function until(done) {
  for (let tries = 0; !done() && tries < 200; tries += 1) await settle();
  assert.ok(done(), 'it got there');
}

/** A note made by `commandId`, which names it too */
const create = (commandId = 'c1') => ({ type: 'createNote', commandId, noteId: `n-${commandId}`, name: 'Plan' });

/**
 * Stops the worker as soon as `client` is welcomed, before the request it flushed then arrives
 * @param {ReturnType<typeof harness>} h
 * @param {Client} client
 */
function stopOnWelcome(h, client) {
  let armed = true;
  client.subscribe(state => {
    if (state !== 'connected' || !armed) return;
    armed = false;
    h.fake.worker.stop();
  });
}

/** @param {ChangeEntry[]} entries */
const seqs = entries => entries.map(entry => `${entry.entityId}@${entry.commitSeq}`);

describe('the restart matrix on the Chrome fake (#13, AC3)', () => {
  it('worker stop before receipt: the ledger has no record, and the one resend commits it once', async () => {
    const h = harness();
    const { client } = h.open('newtab');
    stopOnWelcome(h, client);
    const outcome = await client.execute(create());
    assert.equal(outcome.kind, 'committed');
    assert.equal(h.fake.worker.starts, 2);
    assert.deepEqual(h.runs, ['c1']);
    assert.equal(await h.commitLog.head(), 1);
    assert.deepEqual(await h.ledger.read(create()), { status: 'committed', outcome });
  });

  it('worker stop after commit and before reply: the ledger answers the original outcome, and a retry gives one commit and that outcome', async () => {
    const h = harness();
    h.hooks.afterCommit = () => {
      h.hooks.afterCommit = undefined;
      h.fake.worker.stop();
    };
    const { client } = h.open('newtab');
    const outcome = await client.execute(create());
    const read = await h.ledger.read(create());
    assert.deepEqual(read, { status: 'committed', outcome });
    assert.deepEqual(outcome.kind === 'committed' && outcome.commitSeq, 1);
    // Resolved by its key, so nothing was sent again and the worker stayed stopped
    assert.equal(h.fake.worker.running, false);
    assert.deepEqual(h.runs, ['c1']);

    // The caller retrying with the same commandId wakes the worker, which answers from its record
    assert.deepEqual(await client.execute(create()), outcome);
    assert.equal(h.fake.worker.starts, 2);
    assert.deepEqual(h.runs, ['c1', 'c1']);
    assert.equal(await h.commitLog.head(), 1);
  });

  it('a Popup closed with a command in flight: it commits once, and a Popup opened again sends nothing for a command that is not journaled', async () => {
    const h = harness();
    const first = h.open('popup');
    h.hooks.beforeCommit = () => {
      h.hooks.beforeCommit = undefined;
      first.context.close();
    };
    void first.client.execute(create());
    await until(() => h.runs.length === 1);
    await until(() => h.ledger.size() === 1);
    assert.equal(await h.commitLog.head(), 1);

    const again = h.open('popup', { journal: [] });
    assert.deepEqual(await again.client.resume(), []);
    assert.deepEqual(h.runs, ['c1']);
    // Its outcome comes from reading the projection again
    const view = h.projection(again.context);
    await view.catchUp.start();
    assert.deepEqual([...view.notes.keys()], ['n-c1']);
  });

  it('a Popup closed with a journaled command in flight: opened again, it resolves the command by its key, sending it once only if it never arrived', async () => {
    // Closed after it committed: the ledger answers, and nothing is sent
    const committedFirst = harness();
    const first = committedFirst.open('popup');
    committedFirst.hooks.afterCommit = () => {
      committedFirst.hooks.afterCommit = undefined;
      first.context.close();
    };
    void first.client.execute(create());
    await until(() => committedFirst.ledger.size() === 1);
    const reopened = committedFirst.open('popup', { journal: [{ v: 1, command: create() }] });
    const [resolved] = await reopened.client.resume();
    assert.deepEqual(await committedFirst.ledger.read(create()), { status: 'committed', outcome: resolved.outcome });
    assert.deepEqual(committedFirst.runs, ['c1']);

    // Closed before it arrived, while the worker couldn't be woken: no record, so it's sent
    // once, and commits once
    const lostFirst = harness();
    lostFirst.fake.worker.wakeable = false;
    const second = lostFirst.open('popup');
    void second.client.execute(create());
    await until(() => second.client.state() === 'reconnecting');
    second.context.close();
    lostFirst.fake.worker.wakeable = true;
    assert.deepEqual(lostFirst.runs, []);
    const resumed = lostFirst.open('popup', { journal: [{ v: 1, command: create() }] });
    const [sentOnce] = await resumed.client.resume();
    assert.equal(sentOnce.outcome.kind, 'committed');
    assert.deepEqual(lostFirst.runs, ['c1']);
    assert.equal(await lostFirst.commitLog.head(), 1);
  });

  it('a page reloaded with a stale cursor catches up from it: each commit it missed once, in order, then hints, with duplicates dropped', async () => {
    const h = harness();
    const writer = h.open('newtab');
    await writer.client.execute(create('c1'));
    const before = h.open('newtab');
    const kept = h.projection(before.context);
    await kept.catchUp.start();
    const cursor = /** @type {number} */ (kept.catchUp.cursor());
    assert.equal(cursor, 1);
    // The page reloads, keeping its projection and cursor, and misses what commits meanwhile
    before.context.close();
    kept.catchUp.stop();
    await writer.client.execute(create('c2'));
    await writer.client.execute(create('c3'));

    const after = h.open('newtab');
    const view = h.projection(after.context);
    await view.catchUp.start(cursor);
    assert.equal(view.reads, 0);
    assert.deepEqual(seqs(view.applied), ['n-c2@2', 'n-c3@3']);

    await writer.client.execute(create('c4'));
    await until(() => view.applied.length === 3);
    // A hint posted again, and one older than the cursor, change nothing
    const channel = openHintChannel({ origin: h.fake.origin, BroadcastChannel: writer.context.BroadcastChannel });
    for (const commitSeq of [4, 2]) {
      channel.post(
        JSON.stringify({ frame: 'hint', entityType: 'note', entityId: `n-c${commitSeq}`, revision: 1, commitSeq }),
      );
    }
    await settle();
    await settle();
    assert.deepEqual(seqs(view.applied), ['n-c2@2', 'n-c3@3', 'n-c4@4']);
  });

  it("a cursor below the commit log's floor reads the projection again, at the log's head", async () => {
    const h = harness();
    const writer = h.open('newtab');
    for (const commandId of ['c1', 'c2', 'c3']) await writer.client.execute(create(commandId));
    h.commitLog.prune(2);
    const after = h.open('newtab');
    const view = h.projection(after.context);
    await view.catchUp.start(1);
    assert.equal(view.reads, 1);
    assert.deepEqual(view.applied, []);
    assert.equal(view.catchUp.cursor(), 3);
    assert.deepEqual([...view.notes.keys()].sort(), ['n-c1', 'n-c2', 'n-c3']);
  });

  it('reads the projection again once its client reconnects to a worker that restarted', async () => {
    const h = harness();
    const page = h.open('newtab');
    const view = h.projection(page.context);
    const catchUp = createCatchUp({
      subscribe: () => () => {},
      commitLog: h.commitLog,
      project: async () => {
        view.notes.set('read', (view.notes.get('read') ?? 0) + 1);
        return h.commitLog.head();
      },
      apply: () => {},
      client: page.client,
    });
    await catchUp.start();
    await page.client.execute(create('c1'));
    h.fake.worker.stop();
    await until(() => page.client.state() === 'idle');
    assert.equal(view.notes.get('read'), 1);
    await page.client.execute(create('c2'));
    await until(() => view.notes.get('read') === 2);
    assert.equal(h.fake.worker.starts, 2);
  });
});
