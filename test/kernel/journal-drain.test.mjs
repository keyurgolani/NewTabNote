// #35 slice 3's drain (js/kernel/core/application/journal-drain.js), on the in-memory adapter
// and journal, through the worker's own kernel and table: what it replays and in what order,
// whose entries it leaves alone, an editor save among them, which the pages replay (slice 3b,
// the lead's call on #182), the sweep of notes deleted for good, what it keeps and raises for an
// entry it can't replay (Q6), and that storage it can't reach stops it with every entry left,
// while any other stop at an entry holds back only that entry's note (slice 3b). The stops in a row
// at an entry that isn't a journal record are counted too, and each drain says where it stopped
// (`stuck`, #35 slice 4b-1, Q6).

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { drainJournal } from '../../js/kernel/core/application/journal-drain.js';
import { WORKER_HANDLERS } from '../../js/kernel/core/application/handlers-worker.js';
import { UnavailableError, rejected, unavailable, unknown } from '../../js/kernel/core/contracts/outcomes.js';
import { blockDigest } from '../../js/kernel/core/domain/close-draft.js';
import { journalEntry } from '../../js/kernel/core/domain/journal.js';
import { createMemoryAdapter } from '../../js/kernel/core/memory/adapter.js';
import { createMemoryJournal } from '../../js/kernel/core/memory/journal.js';
import { journaledLookup } from '../../js/kernel/core/messaging/journaled-operations.js';
import { WORKER_CATALOG } from '../../js/kernel/core/contracts/worker-catalog.js';
import { createBaselinePolicy } from '../../js/kernel/core/ports/policy.js';
import { CALLERS, NOW, testClock, testIds } from './support.mjs';
import { createKernel } from './test-kernel.mjs';

/** @typedef {import('../../js/kernel/core/domain/journal.js').JournalRecord} JournalRecord */
/** @typedef {import('../../js/kernel/core/domain/close-draft.js').CloseDraft} CloseDraft */
/** @typedef {any} Row */

/** The coordinator's own session, the instance id it owns the worker's entries under */
const OWN = 'coordinator-1';

/** A page that closed or crashed, whose owner lock is free */
const GONE = 'page-gone';

/** A page that's still open, holding its owner lock */
const LIVE = 'page-live';

/** A day before the clock's, Oct 19, 2026, noon UTC */
const YESTERDAY = NOW - 24 * 60 * 60 * 1000;

/**
 * An answer that says the command may get through when it's sent again, on a code that isn't
 * storage-wide: a storage timeout at one entry
 * @type {import('../../js/kernel/core/contracts/outcomes.js').Unavailable}
 */
const TIMED_OUT = Object.freeze({
  kind: 'unavailable',
  cause: 'storage',
  code: 'timed-out',
  retryable: true,
  messageKey: 'unavailable.timed-out',
  severity: 'error',
});

/**
 * A drain's world: one memory adapter, a new tab's kernel that writes what the test sets up,
 * the worker's kernel on its own table, which the drain sends through, and the journal
 * @param {{live?: string[], inFlight?: string[]}} [options]
 */
function world({ live = [LIVE], inFlight = [] } = {}) {
  const adapter = createMemoryAdapter();
  const clock = testClock();
  // Each on the policy its root builds: the page's on the shared catalog, the worker's on its own
  const page = createKernel({
    adapter,
    policy: createBaselinePolicy(),
    caller: CALLERS.newtab,
    ids: testIds('page'),
    clock,
  });
  const worker = createKernel({
    adapter,
    policy: createBaselinePolicy(WORKER_CATALOG),
    caller: CALLERS['worker-internal'],
    handlers: WORKER_HANDLERS,
    ids: testIds('worker'),
    clock,
  });
  const journal = createMemoryJournal();
  /** @type {Array<[string, string]>} each incident the drain raised, by opId and code */
  const told = [];
  /** @type {string[]} each entry whose incident a stop raised, which a kept capture isn't told */
  const stops = [];
  /** @type {string[]} each entry it replayed */
  const replayed = [];
  /** @type {string[]} the types of the commands it sent */
  const sent = [];
  /** @type {Array<[string, string, string]>} each command it sent, by type, and its answer's kind and code */
  const answers = [];
  const holders = new Set(live);
  const flying = new Set(inFlight);
  const client = {
    /** @param {any} command */
    execute: async command => {
      sent.push(command.type);
      const outcome = await worker.execute(command);
      answers.push([command.type, outcome.kind, /** @type {any} */ (outcome).code]);
      return outcome;
    },
    /** @param {any} query */
    query: query => worker.query(query),
  };
  /** @param {Partial<import('../../js/kernel/core/application/journal-drain.js').DrainPorts>} [overrides] */
  const drain = (overrides = {}) =>
    drainJournal({
      journal,
      client,
      lookup: journaledLookup,
      liveOwners: async () => holders,
      own: { sessionId: OWN, inFlight: () => flying },
      clock,
      // Every entry here is one its own surface could send, so these cases hold the drain's own
      // rules: worker-journal.test.mjs holds the judge the worker passes (#35 slice 4b-1, F5)
      permits: () => null,
      unreplayable: (entry, code, how) => {
        told.push([entry.opId, code]);
        if (how?.stop) stops.push(entry.opId);
      },
      replayed: entry => replayed.push(entry.opId),
      ...overrides,
    });
  /**
   * @param {string} store
   * @param {string} key
   */
  const recordOf = (store, key) =>
    adapter.read([/** @type {any} */ (store)], tx => tx.get(/** @type {any} */ (store), key));
  /** @param {string} noteId */
  const blocksOf = noteId => adapter.read(['blocks'], tx => tx.getAllByIndex('blocks', 'canvasId', noteId));
  /** @param {string} noteId */
  const revisionOf = noteId =>
    adapter.read(['notes'], async tx => {
      await tx.get('notes', noteId);
      return tx.versions('notes', noteId)?.revision ?? 0;
    });
  return {
    adapter,
    clock,
    page,
    worker,
    journal,
    told,
    stops,
    replayed,
    sent,
    answers,
    holders,
    flying,
    drain,
    recordOf,
    blocksOf,
    revisionOf,
  };
}

let counted = 0;

/**
 * The entry a context writes for `command`, before it sends it
 * @param {Record<string, any>} command
 * @param {{owner?: string, createdAt?: number, noteId?: string, draft?: CloseDraft, v?: number}} [options]
 * @returns {JournalRecord}
 */
function entryOf(command, { owner = GONE, createdAt = NOW, noteId = command.noteId, draft, v = 1 } = {}) {
  counted += 1;
  return journalEntry({
    command: /** @type {any} */ (command),
    v,
    noteId,
    surface: owner === OWN ? 'worker-internal' : 'newtab',
    ownerSessionId: owner,
    seq: counted,
    createdAt,
    draft,
  });
}

/**
 * A Popup quick note's creation
 * @param {string} commandId
 * @param {string} noteId
 * @param {string} [text]
 * @returns {any}
 */
const quickNote = (commandId, noteId, text = 'Call the plumber') => ({
  type: 'createNote',
  commandId,
  noteId,
  name: text,
  blocks: [{ id: `${noteId}-b1`, type: 'text', content: text }],
});

/**
 * A capture the worker sends
 * @param {string} commandId
 * @param {{at?: number, content?: string}} [options]
 */
const capture = (commandId, { at = NOW, content = 'A quote' } = {}) => ({
  type: 'captureToDailyNote',
  commandId,
  noteId: `daily-${commandId}`,
  blockId: `block-${commandId}`,
  capture: { type: 'text', content },
  at,
});

/**
 * Note A as the page made it: a1 and a2
 * @param {ReturnType<typeof world>} w
 */
async function noteA(w) {
  const made = await w.page.execute({
    type: 'createNote',
    commandId: 'c-make-a',
    noteId: 'A',
    name: 'Alpha plan',
    blocks: [
      { id: 'a1', type: 'text', content: 'alpha', order: 0 },
      { id: 'a2', type: 'text', content: 'alpha two', order: 1 },
    ],
  });
  assert.equal(made.kind, 'committed', JSON.stringify(made));
}

/**
 * An editor's save of note A's a1, and its draft on what the page last saw commit: the stored
 * a1 and the revision then, as 3b's editor writes them beside the save
 * @param {ReturnType<typeof world>} w
 * @param {string} commandId
 * @param {string} text
 */
async function saveOfA(w, commandId, text) {
  const [a1] = (await w.blocksOf('A')).filter((/** @type {Row} */ block) => block.id === 'a1');
  const revision = await w.revisionOf('A');
  const blocks = [{ id: 'a1', type: 'text', content: text, order: 0 }];
  const command = { type: 'saveNoteContent', commandId, noteId: 'A', blocks, deriveFromStored: true };
  /** @type {CloseDraft} */
  const draft = {
    v: 1,
    id: commandId,
    page: 'page-1',
    noteId: 'A',
    at: NOW,
    base: { revision, updatedAt: null, issued: [], name: 'Alpha plan', blocks: { a1: blockDigest(a1, 'A') } },
    blocks: blocks.map(block => ({ ...block, canvasId: 'A' })),
    deletedBlockIds: [],
    preview: text,
    todoProgress: null,
    linkedNames: [],
  };
  return { command, draft };
}

describe('the journal drain (#35 slice 3)', () => {
  it('replays each entry no live context holds, oldest first, under its own key, and removes it once it is in', async () => {
    const w = world();
    await w.journal.put(entryOf(quickNote('c2', 'n2', 'Second'), { createdAt: NOW + 5 }));
    await w.journal.put(entryOf(quickNote('c1', 'n1', 'First'), { createdAt: NOW }));
    await w.journal.put(
      entryOf(
        {
          type: 'insertBlocks',
          commandId: 'c3',
          noteId: 'n1',
          blocks: [{ id: 'n1-b2', type: 'text', content: 'More' }],
        },
        { createdAt: NOW + 9 },
      ),
    );
    const result = await w.drain();
    assert.deepEqual(
      [result.status, result.replayed, result.left, result.oldestOrphanedEntryAt],
      ['drained', 3, 0, null],
    );
    assert.deepEqual(w.sent, ['createNote', 'createNote', 'insertBlocks']);
    assert.deepEqual(w.replayed, ['c1', 'c2', 'c3']);
    assert.equal((await w.recordOf('notes', 'n1'))?.name, 'First');
    assert.deepEqual((await w.blocksOf('n1')).map((/** @type {Row} */ block) => block.content).sort(), [
      'First',
      'More',
    ]);
    assert.equal((await w.recordOf('notes', 'n2'))?.name, 'Second');
    assert.deepEqual(w.journal.entries(), []);
    assert.deepEqual(w.told, []);
  });

  it("leaves a live context's entries, a draft, and its own capture in flight, and replays its own once it's released", async () => {
    const w = world({ inFlight: ['c-flying'] });
    await w.journal.put(entryOf(quickNote('c-live', 'n-live'), { owner: LIVE }));
    await w.journal.put({ ...entryOf(quickNote('c-draft', 'n-draft')), state: 'draft' });
    await w.journal.put(entryOf(capture('c-flying'), { owner: OWN, noteId: 'daily-c-flying' }));
    await w.journal.put(entryOf(capture('c-kept'), { owner: OWN, noteId: 'daily-c-kept', createdAt: NOW + 1 }));
    const first = await w.drain();
    assert.deepEqual([first.replayed, first.left], [1, 3]);
    assert.deepEqual(w.replayed, ['c-kept']);
    // The live page's and the capture in flight are held; the draft's page is gone
    assert.equal(first.oldestOrphanedEntryAt, NOW);
    w.flying.delete('c-flying');
    w.holders.delete(LIVE);
    const second = await w.drain();
    assert.deepEqual([second.replayed, second.left], [2, 1]);
    assert.deepEqual(
      w.journal.entries().map(entry => [entry.opId, entry.state]),
      [['c-draft', 'draft']],
    );
  });

  it("replays no other context's entry when it can't tell which are alive", async () => {
    const w = world();
    await w.journal.put(entryOf(quickNote('c1', 'n1')));
    await w.journal.put(entryOf(capture('c-kept'), { owner: OWN, noteId: 'daily-c-kept' }));
    const result = await w.drain({ liveOwners: async () => null });
    assert.deepEqual([result.replayed, result.left], [1, 1]);
    assert.deepEqual(w.replayed, ['c-kept']);
    assert.equal(result.oldestOrphanedEntryAt, null);
  });

  it('answers a command that committed already with its ledger row, and runs nothing twice', async () => {
    const w = world();
    const created = await w.page.execute(quickNote('c1', 'n1'));
    assert.equal(created.kind, 'committed');
    await w.page.execute({ type: 'renameNote', commandId: 'c-rename', noteId: 'n1', name: 'Renamed since' });
    // The page went before it removed its entry
    await w.journal.put(entryOf(quickNote('c1', 'n1')));
    const result = await w.drain();
    assert.deepEqual([result.status, result.replayed, result.left], ['drained', 1, 0]);
    // What it answered then, from the ledger, not a second create refused
    assert.deepEqual(w.answers, [['createNote', 'committed', 'note-created']]);
    assert.equal((await w.recordOf('notes', 'n1'))?.name, 'Renamed since');
  });

  it("lands a capture in the Daily Note of the day it was made, and a capture that's in already once", async () => {
    const w = world();
    await w.journal.put(entryOf(capture('c-yesterday', { at: YESTERDAY, content: 'Said yesterday' }), { owner: OWN }));
    const result = await w.drain();
    assert.deepEqual([result.replayed, result.left], [1, 0]);
    const daily = await w.recordOf('notes', 'daily-c-yesterday');
    assert.equal(daily?.dateStr, '2026-10-19');
    assert.deepEqual(
      (await w.blocksOf('daily-c-yesterday')).map((/** @type {Row} */ block) => block.id),
      ['block-c-yesterday'],
    );
    // Its block is in, so the same capture again, past the ledger's window, is in already
    await w.journal.put(
      entryOf({ ...capture('c-again', { at: YESTERDAY }), blockId: 'block-c-yesterday' }, { owner: OWN }),
    );
    const again = await w.drain();
    assert.deepEqual([again.replayed, again.left], [1, 0]);
    assert.equal((await w.blocksOf('daily-c-yesterday')).length, 1);
  });

  it('deletes the entries of a note deleted for good, unreplayed, whatever their owner, and keeps one under any other reason', async () => {
    const w = world();
    await w.page.execute(quickNote('c-make', 'n1'));
    await w.page.execute({ type: 'trashNote', commandId: 'c-trash', noteId: 'n1' });
    const deleted = await w.page.execute({ type: 'deleteNotePermanently', commandId: 'c-delete', noteId: 'n1' });
    assert.equal(deleted.kind, 'committed', JSON.stringify(deleted));
    await w.journal.put(
      entryOf({
        type: 'insertBlocks',
        commandId: 'c-gone',
        noteId: 'n1',
        blocks: [{ id: 'x1', type: 'text', content: 'Lost' }],
      }),
    );
    await w.journal.put(
      entryOf(
        {
          type: 'insertBlocks',
          commandId: 'c-live',
          noteId: 'n1',
          blocks: [{ id: 'x2', type: 'text', content: 'Lost' }],
        },
        { owner: LIVE },
      ),
    );
    const result = await w.drain();
    assert.deepEqual([result.swept, result.replayed, result.left], [2, 0, 0]);
    assert.deepEqual(w.sent, []);
    assert.equal(await w.recordOf('notes', 'n1'), undefined);

    // A tombstone for a reason the sweep doesn't delete for, as #20's restore and reset will write
    const kept = world();
    await kept.page.execute(quickNote('c-make', 'n2'));
    await kept.page.execute({ type: 'trashNote', commandId: 'c-trash', noteId: 'n2' });
    await kept.page.execute({ type: 'deleteNotePermanently', commandId: 'c-delete', noteId: 'n2' });
    await kept.journal.put(entryOf(quickNote('c-n2', 'n2')));
    const reasons = await kept.drain({
      client: {
        execute: command => kept.worker.execute(command),
        query: async query => {
          const state = await kept.worker.query(query);
          return state.kind === 'ready'
            ? { ...state, data: { tombstones: [{ id: 'n2', reason: 'restored-elsewhere' }] } }
            : state;
        },
      },
    });
    assert.deepEqual([reasons.swept, reasons.replayed, reasons.left], [0, 0, 1]);
    assert.deepEqual(kept.told, [['c-n2', 'note-deleted']]);
    assert.equal(await kept.recordOf('notes', 'n2'), undefined);
  });

  it("leaves an editor's save to the pages, sweeps it once its note is deleted for good, and keeps one with no draft as a conflict record", async () => {
    // With its draft, the pages apply it by #33's rules (slice 3b): the worker sends nothing for it,
    // and it stays, orphaned, for them
    const w = world();
    await noteA(w);
    const save = await saveOfA(w, 'c-save', 'alpha, edited');
    await w.journal.put(entryOf(save.command, { draft: save.draft, createdAt: NOW - 5 }));
    const left = await w.drain();
    assert.deepEqual([left.status, left.replayed, left.kept, left.left], ['drained', 0, 0, 1]);
    assert.equal(left.oldestOrphanedEntryAt, NOW - 5);
    assert.deepEqual([w.sent, w.told], [[], []]);
    const [a1] = (await w.blocksOf('A')).filter((/** @type {Row} */ block) => block.id === 'a1');
    assert.equal(a1.content, 'alpha', 'nothing applied');

    // Its note deleted for good: swept, as every entry of that note is
    await w.page.execute({ type: 'trashNote', commandId: 'c-trash-a', noteId: 'A' });
    await w.page.execute({ type: 'deleteNotePermanently', commandId: 'c-delete-a', noteId: 'A' });
    const swept = await w.drain();
    assert.deepEqual([swept.swept, swept.left], [1, 0]);

    // With no draft, no one can apply it: kept as a conflict record, and its text with it
    const bare = world();
    await noteA(bare);
    await bare.journal.put(entryOf((await saveOfA(bare, 'c-bare', 'alpha, edited')).command));
    const kept = await bare.drain();
    assert.deepEqual([kept.kept, kept.left], [1, 0]);
    assert.deepEqual(bare.sent, ['keepJournalEntry']);
    assert.ok(await bare.recordOf('conflicts', 'c-bare'));
  });

  it("keeps an entry whose note isn't there, raising its incident once", async () => {
    const w = world();
    await w.journal.put(
      entryOf({
        type: 'insertBlocks',
        commandId: 'c-orphan',
        noteId: 'n-none',
        blocks: [{ id: 'x1', type: 'text', content: 'Kept' }],
      }),
    );
    const first = await w.drain();
    assert.deepEqual([first.status, first.replayed, first.left, first.oldestOrphanedEntryAt], ['drained', 0, 1, NOW]);
    assert.deepEqual(w.told, [['c-orphan', 'note-not-found']]);
    assert.deepEqual(w.journal.entries()[0].unreplayable, { code: 'note-not-found', at: NOW });
    await w.drain();
    assert.deepEqual(w.told, [['c-orphan', 'note-not-found']], 'raised once');
  });

  it("keeps a newer build's entry and one naming an operation it doesn't journal, for a build that can replay them (the lead's Q6)", async () => {
    const w = world();
    await w.journal.put(entryOf(quickNote('c-newer', 'n-newer'), { v: 2 }));
    await w.journal.put(entryOf({ type: 'renameNote', commandId: 'c-rename', noteId: 'n1', name: 'Later' }));
    const result = await w.drain();
    assert.deepEqual([result.replayed, result.kept, result.left], [0, 0, 2]);
    assert.deepEqual(w.told, [
      ['c-newer', 'unsupported-version'],
      ['c-rename', 'unknown-operation'],
    ]);
    assert.deepEqual(w.sent, []);
  });

  it("holds an editor's save a newer build wrote, and one under a tombstone it keeps for, raising each incident once, marked so the pages leave it too (the lead's Q6, 3b)", async () => {
    const w = world();
    await noteA(w);
    const newer = await saveOfA(w, 'c-save-newer', 'alpha, as a newer build saved it');
    await w.journal.put(entryOf(newer.command, { draft: newer.draft, v: 2 }));
    // One at this build's version is left to the pages, with no incident
    const ours = await saveOfA(w, 'c-save-ours', 'alpha, edited');
    await w.journal.put(entryOf(ours.command, { draft: ours.draft, createdAt: NOW + 1 }));
    for (const run of [1, 2]) {
      const result = await w.drain();
      assert.deepEqual(
        [result.status, result.replayed, result.kept, result.left],
        ['drained', 0, 0, 2],
        `drain ${run}`,
      );
    }
    assert.deepEqual(w.told, [['c-save-newer', 'unsupported-version']], 'once');
    assert.deepEqual([w.sent, w.stops], [[], []]);
    assert.deepEqual(
      w.journal.entries().map(entry => [entry.opId, entry.unreplayable?.code]),
      [
        ['c-save-newer', 'unsupported-version'],
        ['c-save-ours', undefined],
      ],
    );

    // Under a tombstone of a reason the sweep keeps for, as #20's restore and reset will write
    const kept = world();
    await noteA(kept);
    const save = await saveOfA(kept, 'c-save-kept', 'alpha, edited');
    await kept.page.execute({ type: 'trashNote', commandId: 'c-trash-a', noteId: 'A' });
    const deleted = await kept.page.execute({ type: 'deleteNotePermanently', commandId: 'c-delete-a', noteId: 'A' });
    assert.equal(deleted.kind, 'committed', JSON.stringify(deleted));
    await kept.journal.put(entryOf(save.command, { draft: save.draft }));
    const restoring = {
      /** @param {any} command */
      execute: command => {
        kept.sent.push(command.type);
        return kept.worker.execute(command);
      },
      /** @param {any} query */
      query: async query => {
        const state = await kept.worker.query(query);
        return state.kind === 'ready'
          ? { ...state, data: { tombstones: [{ id: 'A', reason: 'restored-elsewhere' }] } }
          : state;
      },
    };
    for (const run of [1, 2]) {
      const result = await kept.drain({ client: restoring });
      assert.deepEqual([result.swept, result.replayed, result.kept, result.left], [0, 0, 0, 1], `drain ${run}`);
    }
    assert.deepEqual(kept.told, [['c-save-kept', 'note-deleted']], 'once');
    assert.deepEqual([kept.sent, kept.stops], [[], []]);
    assert.equal(kept.journal.entries()[0].unreplayable?.code, 'note-deleted');
  });

  it('keeps a malformed entry, a save with no draft or no version it can read, and one the kernel refuses as a conflict record, and then removes it', async () => {
    const w = world();
    await w.page.execute(quickNote('c-make', 'n1'));
    // Malformed: a field its schema doesn't declare
    await w.journal.put(entryOf({ ...quickNote('c-odd', 'n-odd'), color: 'red' }));
    // An editor's save with no draft, which can't be replayed safely
    await w.journal.put(
      entryOf({
        type: 'saveNoteContent',
        commandId: 'c-bare',
        noteId: 'n1',
        blocks: [{ id: 'n1-b1', type: 'text', content: 'Typed' }],
      }),
    );
    // A note in a folder deleted since
    await w.journal.put(entryOf({ ...quickNote('c-filed', 'n-filed'), folderId: 'f-gone' }));
    // An editor's save with its draft, but a version no build reads (3b)
    const unversioned = {
      type: 'saveNoteContent',
      commandId: 'c-unversioned',
      noteId: 'n1',
      blocks: [{ id: 'n1-b1', type: 'text', content: 'Typed again' }],
    };
    await w.journal.put(
      entryOf(unversioned, {
        v: 0,
        draft: /** @type {any} */ ({ v: 1, id: 'c-unversioned', noteId: 'n1', blocks: [], deletedBlockIds: [] }),
      }),
    );
    const result = await w.drain();
    assert.deepEqual([result.status, result.kept, result.left], ['drained', 4, 0]);
    assert.deepEqual(w.told, [
      ['c-odd', 'invalid-payload'],
      ['c-bare', 'invalid-payload'],
      ['c-filed', 'replay-refused'],
      ['c-unversioned', 'invalid-payload'],
    ]);
    // None of them is a stop: each is told as what it is
    assert.deepEqual(w.stops, []);
    for (const opId of ['c-odd', 'c-bare', 'c-filed', 'c-unversioned']) {
      const record = await w.recordOf('conflicts', opId);
      assert.ok(record, opId);
      assert.equal(record.command.commandId, opId);
      assert.equal(record.expected, null);
    }
    assert.equal((await w.recordOf('conflicts', 'c-bare')).noteId, 'n1');

    // A damaged entry with a null command, or none: kept as a conflict record, and the entry
    // after it still replays
    for (const command of [null, undefined]) {
      const damaged = world();
      /** @type {Record<string, unknown>} */
      const bad = { ...entryOf(quickNote('c-damaged', 'n-damaged')), command };
      if (command === undefined) delete bad.command;
      await damaged.journal.put(/** @type {any} */ (bad));
      await damaged.journal.put(entryOf(quickNote('c-after', 'n-after'), { createdAt: NOW + 1 }));
      const drained = await damaged.drain();
      assert.deepEqual(
        [drained.status, drained.kept, drained.replayed, drained.left],
        ['drained', 1, 1, 0],
        String(command),
      );
      assert.deepEqual(damaged.told, [['c-damaged', 'invalid-payload']], String(command));
      assert.deepEqual((await damaged.recordOf('conflicts', 'c-damaged'))?.command, {}, String(command));
      assert.ok(await damaged.recordOf('notes', 'n-after'), String(command));
    }
  });

  it("stops at a code that says storage can't answer, leaving every entry it hadn't removed, and at any other holds back only that entry's note", async () => {
    const w = world();
    await w.journal.put(entryOf(quickNote('c1', 'n1')));
    await w.journal.put(entryOf(quickNote('c2', 'n2'), { createdAt: NOW + 1 }));
    // A later entry, which the stop at c2 keeps from going before it
    await w.journal.put(entryOf(quickNote('c3', 'n3'), { createdAt: NOW + 2 }));
    /** @type {string[]} */
    const sent = [];
    const result = await w.drain({
      client: {
        execute: async command => {
          sent.push(command.commandId);
          if (sent.length === 1) return w.worker.execute(command);
          return {
            kind: 'unavailable',
            cause: 'storage',
            code: 'transaction-failed',
            retryable: true,
            messageKey: 'unavailable.transaction-failed',
            severity: 'error',
          };
        },
        query: query => w.worker.query(query),
      },
    });
    // A stop of the whole drain holds back no note by name: its code says why
    assert.deepEqual(
      [result.status, result.code, result.replayed, result.left, result.held],
      ['stopped', 'transaction-failed', 1, 2, []],
    );
    assert.deepEqual(sent, ['c1', 'c2'], 'nothing after the stop is sent');
    assert.deepEqual(
      w.journal.entries().map(entry => entry.opId),
      ['c2', 'c3'],
    );
    // A stop it can retry raises nothing: the next drain may get through
    assert.deepEqual([w.told, w.stops], [[], []]);
    // A journal it can't read stops it before anything runs
    w.journal.failNext('list');
    const unread = await w.drain();
    assert.deepEqual([unread.status, unread.code, unread.replayed], ['stopped', 'transaction-aborted', 0]);
    // Nor does it replay anything when it can't read the tombstones first
    const blind = await w.drain({
      client: {
        execute: command => w.worker.execute(command),
        query: async () => ({ kind: 'failed', cause: 'storage', code: 'unreadable' }),
      },
    });
    assert.deepEqual([blind.status, blind.code, blind.replayed, blind.left], ['stopped', 'unreadable', 0, 2]);

    // Each code that says storage itself can't answer stops it the same way, at whichever entry
    for (const [cause, code, retryable] of /** @type {const} */ ([
      ['quota', 'quota', false],
      ['adapter', 'transaction-inactive', false],
      ['storage', 'database-closed', true],
      ['storage', 'open-failed', true],
    ])) {
      const wide = world();
      await wide.journal.put(entryOf(quickNote('c1', 'n1')));
      await wide.journal.put(entryOf(quickNote('c2', 'n2'), { createdAt: NOW + 1 }));
      /** @type {string[]} */
      const tried = [];
      /** @type {import('../../js/kernel/core/application/journal-drain.js').DrainClient} */
      const client = {
        execute: async command => {
          tried.push(command.commandId);
          return {
            kind: 'unavailable',
            cause,
            code,
            retryable,
            messageKey: `unavailable.${code}`,
            severity: 'error',
          };
        },
        query: query => wide.worker.query(query),
      };
      for (const run of [1, 2, 3]) {
        const stopped = await wide.drain({ client });
        assert.deepEqual(
          [stopped.status, stopped.code, stopped.replayed, stopped.left, stopped.held],
          ['stopped', code, 0, 2, []],
          `${code}, drain ${run}`,
        );
      }
      assert.deepEqual(tried, ['c1', 'c1', 'c1'], code);
      // It's storage's, not the entry's, so drains in a row that stop there raise nothing, while
      // one it can't retry is raised once, as any stop it can't retry is
      assert.deepEqual(wide.told, retryable ? [] : [['c1', code]], code);
    }

    // So does a throw at no entry, here the sweep's removal
    const sweeping = world();
    await sweeping.page.execute(quickNote('c-make', 'n-deleted'));
    await sweeping.page.execute({ type: 'trashNote', commandId: 'c-trash', noteId: 'n-deleted' });
    await sweeping.page.execute({ type: 'deleteNotePermanently', commandId: 'c-delete', noteId: 'n-deleted' });
    await sweeping.journal.put(entryOf(quickNote('c-swept', 'n-deleted')));
    await sweeping.journal.put(entryOf(quickNote('c-other', 'n-other'), { createdAt: NOW + 1 }));
    const unswept = await sweeping.drain({
      journal: {
        ...sweeping.journal,
        remove: async () => {
          throw new Error('A bug that throws in the sweep');
        },
      },
    });
    assert.deepEqual(
      [unswept.status, unswept.code, unswept.replayed, unswept.held],
      ['stopped', 'drain-failed', 0, []],
    );
    assert.deepEqual([sweeping.sent, sweeping.told], [[], []]);

    // Any other code at an entry holds back only that entry's note: the note's later entries wait
    // behind it, so they still go oldest first, and another note's lands past it (the lead's call
    // on 3b's plan)
    const one = world();
    await one.journal.put(entryOf(quickNote('c1', 'n1')));
    await one.journal.put(
      entryOf(
        {
          type: 'insertBlocks',
          commandId: 'c1-more',
          noteId: 'n1',
          blocks: [{ id: 'n1-b2', type: 'text', content: 'More' }],
        },
        { createdAt: NOW + 1 },
      ),
    );
    await one.journal.put(entryOf(quickNote('c2', 'n2'), { createdAt: NOW + 2 }));
    /** @type {string[]} */
    const tried = [];
    const held = await one.drain({
      client: {
        execute: async command => {
          tried.push(command.commandId);
          return command.commandId === 'c1' ? TIMED_OUT : one.worker.execute(command);
        },
        query: query => one.worker.query(query),
      },
    });
    // It answers stopped with the hold's code, and names the note it held back and why, which
    // system.coordinatorHealth tells the Trust provider (the lead, 18:04 and 18:24)
    assert.deepEqual(
      [held.status, held.code, held.replayed, held.left, held.held],
      ['stopped', 'timed-out', 1, 2, [{ noteId: 'n1', code: 'timed-out' }]],
    );
    assert.deepEqual(tried, ['c1', 'c2']);
    assert.deepEqual(
      one.journal.entries().map(entry => entry.opId),
      ['c1', 'c1-more'],
    );
    assert.equal((await one.recordOf('notes', 'n2'))?.name, 'Call the plumber');
    // A stop it can retry, at one drain, raises nothing
    assert.deepEqual([one.told, one.stops], [[], []]);

    // No answer is a stop it can retry too, since the next drain's ledger answers it
    const unsure = world();
    await unsure.journal.put(entryOf(quickNote('c-unsure', 'n-unsure')));
    const unanswered = await unsure.drain({
      client: {
        execute: async command => unknown('outcome-unknown', command.commandId),
        query: query => unsure.worker.query(query),
      },
    });
    assert.deepEqual(
      [unanswered.status, unanswered.code, unanswered.held, unsure.told],
      ['stopped', 'outcome-unknown', [{ noteId: 'n-unsure', code: 'outcome-unknown' }], []],
    );
  });

  it("raises an entry's incident once, as a stop, on the third drain in a row that stops at it on a code it can retry, and never before (the lead's call on 3b's plan)", async () => {
    const w = world();
    // A capture an earlier worker kept, which times out every time it's sent
    await w.journal.put(entryOf(capture('c-busy'), { owner: 'coordinator-0' }));
    const client = {
      /** @param {any} command */
      execute: async command => (command.commandId === 'c-busy' ? TIMED_OUT : w.worker.execute(command)),
      /** @param {any} query */
      query: query => w.worker.query(query),
    };
    for (const run of [1, 2]) {
      const result = await w.drain({ client });
      assert.deepEqual(
        [result.status, result.code, result.left, result.held],
        ['stopped', 'timed-out', 1, [{ noteId: 'daily-c-busy', code: 'timed-out' }]],
        `drain ${run}`,
      );
      assert.deepEqual(w.told, [], `drain ${run}: the next may get through`);
    }
    await w.drain({ client });
    assert.deepEqual(w.told, [['c-busy', 'timed-out']], 'the third');
    // As a stop, so a kept capture hears nothing more than it heard when it was kept
    assert.deepEqual(w.stops, ['c-busy']);
    await w.drain({ client });
    assert.deepEqual(w.told, [['c-busy', 'timed-out']], 'once');
    // Still kept, for the drain that gets through
    const through = await w.drain();
    assert.deepEqual([through.status, through.replayed, through.left], ['drained', 1, 0]);
    assert.ok(await w.recordOf('notes', 'daily-c-busy'));

    // An incident raised there for anything else starts the count again, on the mark and in the
    // worker's memory alike: here an append to a note that isn't there, which the third drain gets
    const row = world();
    await row.journal.put(
      entryOf({
        type: 'insertBlocks',
        commandId: 'c-row',
        noteId: 'n-none',
        blocks: [{ id: 'n-none-b1', type: 'text', content: 'More' }],
      }),
    );
    let drains = 0;
    const scripted = {
      /** @param {any} command */
      execute: async command => (drains === 2 ? row.worker.execute(command) : TIMED_OUT),
      /** @param {any} query */
      query: query => row.worker.query(query),
    };
    const stops = new Map();
    for (; drains < 5; drains++) await row.drain({ client: scripted, stops });
    assert.deepEqual(row.told, [['c-row', 'note-not-found']], 'two stops since the refusal');
    await row.drain({ client: scripted, stops });
    assert.deepEqual(
      row.told,
      [
        ['c-row', 'note-not-found'],
        ['c-row', 'timed-out'],
      ],
      'the third since',
    );
  });

  it("adds up the drains in a row that stop at an entry on different codes it can retry, raises the third on its own code, once, and counts no more stops there on that code (R191's finding 3)", async () => {
    const w = world();
    // A capture an earlier worker kept, which each drain stops at on a code it can retry
    await w.journal.put(entryOf(capture('c-busy'), { owner: 'coordinator-0' }));
    const aborted = unavailable('storage', 'transaction-aborted', true);
    const inTurn = [TIMED_OUT, unknown('outcome-unknown', 'c-busy'), aborted, aborted, aborted, aborted];
    let drains = 0;
    const client = {
      /** @param {any} command */
      execute: async command => (command.commandId === 'c-busy' ? inTurn[drains] : w.worker.execute(command)),
      /** @param {any} query */
      query: query => w.worker.query(query),
    };
    /** The entry's mark, by its code and count, as the drain left it */
    const mark = () => {
      const [entry] = w.journal.entries();
      return entry.unreplayable ? [entry.unreplayable.code, entry.unreplayable.count ?? null] : null;
    };
    /** @type {unknown[]} */
    const marks = [];
    for (; drains < 2; drains++) {
      await w.drain({ client });
      marks.push(mark());
    }
    assert.deepEqual(
      marks,
      [
        ['timed-out', 1],
        ['outcome-unknown', 2],
      ],
      'one count across the codes',
    );
    assert.deepEqual(w.told, []);
    await w.drain({ client });
    drains++;
    assert.deepEqual(w.told, [['c-busy', 'transaction-aborted']], 'the third, on its own code');
    assert.deepEqual(w.stops, ['c-busy']);
    assert.deepEqual(mark(), ['transaction-aborted', null], 'raised');
    // Raised, the drains that stop there again on that code count nothing and raise nothing
    for (; drains < inTurn.length; drains++) {
      await w.drain({ client });
      assert.deepEqual(mark(), ['transaction-aborted', null], `drain ${drains + 1}`);
    }
    assert.deepEqual(w.told, [['c-busy', 'transaction-aborted']], 'once');
  });

  it("raises an entry's incident once when it stops every drain there, on a code it can't retry or a throw, and holds back only its note", async () => {
    /** @type {import('../../js/kernel/core/contracts/outcomes.js').Unavailable} */
    const cannotRetry = {
      kind: 'unavailable',
      cause: 'adapter',
      code: 'not-cloneable',
      retryable: false,
      messageKey: 'unavailable.not-cloneable',
      severity: 'error',
    };
    for (const stop of /** @type {const} */ (['cannot-retry', 'throws'])) {
      const w = world();
      // A capture an earlier worker kept, and a note made after it
      await w.journal.put(entryOf(capture('c-stuck'), { owner: 'coordinator-0' }));
      await w.journal.put(entryOf(quickNote('c-later', 'n-later'), { createdAt: NOW + 1 }));
      /** @type {string[]} */
      const sent = [];
      const client = {
        /** @param {any} command */
        execute: async command => {
          sent.push(command.commandId);
          if (command.commandId !== 'c-stuck') return w.worker.execute(command);
          if (stop === 'throws') throw new Error('A bug that throws on this entry');
          return cannotRetry;
        },
        /** @param {any} query */
        query: query => w.worker.query(query),
      };
      const code = stop === 'throws' ? 'drain-failed' : 'not-cloneable';
      const drains = [await w.drain({ client }), await w.drain({ client })];
      assert.deepEqual(
        drains.map(result => [result.status, result.code, result.replayed, result.left, result.held]),
        [
          ['stopped', code, 1, 1, [{ noteId: 'daily-c-stuck', code }]],
          ['stopped', code, 0, 1, [{ noteId: 'daily-c-stuck', code }]],
        ],
        stop,
      );
      // Once, though two drains stopped at it, so a capture says "Not captured" once
      assert.deepEqual(w.told, [['c-stuck', code]], stop);
      // Raised as a stop, which leaves a kept capture kept, so its worker tells it nothing
      assert.deepEqual(w.stops, ['c-stuck'], stop);
      // It holds back only its own note's entries, so another note's landed past it
      assert.deepEqual(sent, ['c-stuck', 'c-later', 'c-stuck'], stop);
      assert.ok(await w.recordOf('notes', 'n-later'), stop);
      assert.deepEqual(
        w.journal.entries().map(entry => [entry.opId, entry.unreplayable?.code]),
        [['c-stuck', code]],
        stop,
      );
    }

    // The same when the conflict record that would keep an entry can't be written for good
    const w = world();
    await w.journal.put(entryOf({ ...quickNote('c-odd', 'n-odd'), color: 'red' }));
    await w.journal.put(entryOf(quickNote('c-later', 'n-later'), { createdAt: NOW + 1 }));
    const client = {
      /** @param {any} command */
      execute: async command => (command.type === 'keepJournalEntry' ? cannotRetry : w.worker.execute(command)),
      /** @param {any} query */
      query: query => w.worker.query(query),
    };
    const drains = [await w.drain({ client }), await w.drain({ client })];
    assert.deepEqual(
      drains.map(result => [result.status, result.code, result.replayed, result.left, result.held]),
      [
        ['stopped', 'not-cloneable', 1, 1, [{ noteId: 'n-odd', code: 'not-cloneable' }]],
        ['stopped', 'not-cloneable', 0, 1, [{ noteId: 'n-odd', code: 'not-cloneable' }]],
      ],
    );
    assert.deepEqual(w.told, [['c-odd', 'not-cloneable']]);
    assert.deepEqual(w.stops, ['c-odd']);
    assert.ok(await w.recordOf('notes', 'n-later'));

    // A removal that fails for good once the entry's command is in raises nothing, since the
    // next drain's ledger answers it
    const removing = world();
    await removing.journal.put(entryOf(quickNote('c-in', 'n-in')));
    const failingRemove = {
      ...removing.journal,
      remove: async () => {
        throw new UnavailableError('quota', 'quota', false);
      },
    };
    const first = await removing.drain({ journal: failingRemove });
    assert.deepEqual(
      [first.status, first.code, first.replayed, first.held, removing.told],
      ['stopped', 'quota', 0, [], []],
    );
    assert.ok(await removing.recordOf('notes', 'n-in'), 'its command is in');
    const next = await removing.drain();
    assert.deepEqual([next.status, next.replayed, next.left, removing.told], ['drained', 1, 0, []]);

    // A throw that says it may get through raises nothing, as a stop it can retry doesn't, and
    // holds back its note
    const busy = world();
    await busy.journal.put(entryOf(quickNote('c-busy', 'n-busy')));
    const stopped = await busy.drain({
      client: {
        execute: async () => {
          throw new UnavailableError('storage', 'transaction-aborted', true);
        },
        /** @param {any} query */
        query: query => busy.worker.query(query),
      },
    });
    assert.deepEqual(
      [stopped.status, stopped.code, stopped.held, busy.told],
      ['stopped', 'transaction-aborted', [{ noteId: 'n-busy', code: 'transaction-aborted' }], []],
    );
  });

  it("raises once per worker the incident of an entry that isn't a journal record when its keep stops for good, with no mark (probe E4, #35 slice 4a)", async () => {
    /** @type {import('../../js/kernel/core/contracts/outcomes.js').Unavailable} */
    const cannotRetry = {
      kind: 'unavailable',
      cause: 'adapter',
      code: 'not-cloneable',
      retryable: false,
      messageKey: 'unavailable.not-cloneable',
      severity: 'error',
    };
    const w = world();
    // No owner, so no record to mark: a damaged entry whose conflict record can't be written for good
    /** @type {Record<string, unknown>} */
    const damaged = { ...entryOf(quickNote('c-no-owner', 'n-no-owner')) };
    delete damaged.ownerSessionId;
    await w.journal.put(/** @type {any} */ (damaged));
    const client = {
      /** @param {any} command */
      execute: async command => (command.type === 'keepJournalEntry' ? cannotRetry : w.worker.execute(command)),
      /** @param {any} query */
      query: query => w.worker.query(query),
    };
    // What the worker remembers it raised, for its life
    const raised = new Set();
    const drains = [await w.drain({ client, raised }), await w.drain({ client, raised })];
    assert.deepEqual(
      drains.map(result => [result.status, result.code, result.left]),
      [
        ['stopped', 'not-cloneable', 1],
        ['stopped', 'not-cloneable', 1],
      ],
    );
    // Once, though two drains stopped at it, and as a stop, since the entry is still there
    assert.deepEqual(w.told, [['c-no-owner', 'not-cloneable']]);
    assert.deepEqual(w.stops, ['c-no-owner']);
    // Nothing is marked on an entry that isn't a record
    assert.deepEqual(
      w.journal.entries().map(entry => [entry.opId, entry.unreplayable]),
      [['c-no-owner', undefined]],
    );
    // A later worker, with nothing remembered, raises it once more
    const later = await w.drain({ client, raised: new Set() });
    assert.equal(later.status, 'stopped');
    assert.deepEqual(w.told, [
      ['c-no-owner', 'not-cloneable'],
      ['c-no-owner', 'not-cloneable'],
    ]);
  });

  it("counts the drains in a row that stop at an entry that isn't a journal record on a code it can retry, and raises it on the third, once, as a stop, saying the count on the way (#35 slice 4b-1, Q6)", async () => {
    const w = world();
    // No owner, so no record to mark: a damaged entry whose conflict record the disk can't take now
    /** @type {Record<string, unknown>} */
    const damaged = { ...entryOf(quickNote('c-no-owner', 'n-no-owner')) };
    delete damaged.ownerSessionId;
    await w.journal.put(/** @type {any} */ (damaged));
    const client = {
      /** @param {any} command */
      execute: async command => (command.type === 'keepJournalEntry' ? TIMED_OUT : w.worker.execute(command)),
      /** @param {any} query */
      query: query => w.worker.query(query),
    };
    // What the worker remembers it raised and counted, for its life
    const raised = new Set();
    const counts = new Map();
    const drains = [];
    for (let run = 0; run < 3; run++) drains.push(await w.drain({ client, raised, stops: counts }));
    // The third raises it, as a stop, since the entry is still there
    assert.deepEqual(w.told, [['c-no-owner', 'timed-out']]);
    assert.deepEqual(w.stops, ['c-no-owner']);
    // Each drain says where it stopped, and how many in a row stopped there
    assert.deepEqual(
      drains.map(result => [result.status, result.stuck]),
      [
        ['stopped', { code: 'timed-out', count: 1 }],
        ['stopped', { code: 'timed-out', count: 2 }],
        ['stopped', { code: 'timed-out', count: 3 }],
      ],
    );
    // Once: a fourth drain raises nothing more, and counts no further
    const fourth = await w.drain({ client, raised, stops: counts });
    assert.deepEqual(w.told, [['c-no-owner', 'timed-out']]);
    assert.deepEqual(fourth.stuck, { code: 'timed-out' });
    // Nothing is marked on an entry that isn't a record
    assert.deepEqual(
      w.journal.entries().map(entry => [entry.opId, entry.unreplayable]),
      [['c-no-owner', undefined]],
    );
    // A later worker, with nothing remembered, counts from 1 again
    const later = await w.drain({ client, raised: new Set(), stops: new Map() });
    assert.deepEqual(later.stuck, { code: 'timed-out', count: 1 });
    assert.equal(w.told.length, 1);
  });

  it("raises nothing for a stop it can retry at an entry that isn't a journal record when the next drain gets through (#35 slice 4b-1, Q6)", async () => {
    const w = world();
    /** @type {Record<string, unknown>} */
    const damaged = { ...entryOf(quickNote('c-no-owner', 'n-no-owner')) };
    delete damaged.ownerSessionId;
    await w.journal.put(/** @type {any} */ (damaged));
    let keeps = 0;
    const client = {
      /** @param {any} command */
      execute: async command =>
        command.type === 'keepJournalEntry' && ++keeps === 1 ? TIMED_OUT : w.worker.execute(command),
      /** @param {any} query */
      query: query => w.worker.query(query),
    };
    const raised = new Set();
    const counts = new Map();
    const first = await w.drain({ client, raised, stops: counts });
    assert.deepEqual([first.status, first.left], ['stopped', 1]);
    // The next drain keeps it as a conflict record, and it goes: told so once, and never as a stop
    const second = await w.drain({ client, raised, stops: counts });
    assert.deepEqual([second.status, second.kept, second.left, second.stuck], ['drained', 1, 0, null]);
    assert.deepEqual(w.told, [['c-no-owner', 'invalid-payload']]);
    assert.deepEqual(w.stops, []);
  });

  it("starts the count again once a drain gets past an entry that isn't a journal record, so only stops in a row raise it (#35 slice 4b-1, Q6)", async () => {
    const w = world();
    /** @type {Record<string, unknown>} */
    const damaged = { ...entryOf(quickNote('c-no-owner', 'n-no-owner')) };
    delete damaged.ownerSessionId;
    await w.journal.put(/** @type {any} */ (damaged));
    // The keep's answers, drain by drain: two stops, one the drain gets past with the entry left,
    // as nowhere will take it, then two stops more
    const answers = [TIMED_OUT, TIMED_OUT, rejected('validation', 'invalid-command'), TIMED_OUT, TIMED_OUT];
    const client = {
      /** @param {any} command */
      execute: async command =>
        command.type === 'keepJournalEntry' ? /** @type {any} */ (answers.shift()) : w.worker.execute(command),
      /** @param {any} query */
      query: query => w.worker.query(query),
    };
    const raised = new Set();
    const counts = new Map();
    const drains = [];
    for (let run = 0; run < 5; run++) drains.push(await w.drain({ client, raised, stops: counts }));
    assert.deepEqual(w.told, [], 'no three in a row');
    assert.deepEqual(
      drains.map(result => [result.status, result.left]),
      [
        ['stopped', 1],
        ['stopped', 1],
        ['drained', 1],
        ['stopped', 1],
        ['stopped', 1],
      ],
    );
    assert.deepEqual(drains[3].stuck, { code: 'timed-out', count: 1 });
  });

  it('answers empty for an empty journal, and sends nothing', async () => {
    const w = world();
    const result = await w.drain();
    assert.deepEqual([result.status, result.left, result.oldestOrphanedEntryAt], ['empty', 0, null]);
    assert.deepEqual(w.sent, []);
  });
});
