// #35 slice 3's drain (js/kernel/core/application/journal-drain.js), on the in-memory adapter
// and journal, through the worker's own kernel and table: what it replays and in what order,
// whose entries it leaves alone, the sweep of notes deleted for good, an editor save replayed by
// #33's rules (the lead's answer to the plan's Q1), what it keeps and raises for an entry it
// can't replay (Q6), and that storage it can't reach stops it with every entry left.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { drainJournal } from '../../js/kernel/core/application/journal-drain.js';
import { WORKER_HANDLERS } from '../../js/kernel/core/application/handlers-worker.js';
import { blockDigest } from '../../js/kernel/core/domain/close-draft.js';
import { journalEntry } from '../../js/kernel/core/domain/journal.js';
import { createMemoryAdapter } from '../../js/kernel/core/memory/adapter.js';
import { createMemoryJournal } from '../../js/kernel/core/memory/journal.js';
import { journaledLookup } from '../../js/kernel/core/messaging/journaled-operations.js';
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
 * A drain's world: one memory adapter, a new tab's kernel that writes what the test sets up,
 * the worker's kernel on its own table, which the drain sends through, and the journal
 * @param {{live?: string[], inFlight?: string[]}} [options]
 */
function world({ live = [LIVE], inFlight = [] } = {}) {
  const adapter = createMemoryAdapter();
  const clock = testClock();
  const policy = createBaselinePolicy();
  const page = createKernel({ adapter, policy, caller: CALLERS.newtab, ids: testIds('page'), clock });
  const worker = createKernel({
    adapter,
    policy,
    caller: CALLERS['worker-internal'],
    handlers: WORKER_HANDLERS,
    ids: testIds('worker'),
    clock,
  });
  const journal = createMemoryJournal();
  /** @type {Array<[string, string]>} each incident the drain raised, by opId and code */
  const told = [];
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
      unreplayable: (entry, code) => told.push([entry.opId, code]),
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

  it("replays an editor's save by #33's rules: dropped when it's in, saved where its blocks are as the page saw them, recovered where they changed", async () => {
    // In already: the save committed, and its page went before it removed the entry
    const inAlready = world();
    await noteA(inAlready);
    const first = await saveOfA(inAlready, 'c-save-1', 'alpha, edited');
    assert.equal((await inAlready.page.execute(/** @type {any} */ (first.command))).kind, 'committed');
    await inAlready.journal.put(entryOf(first.command, { draft: first.draft }));
    const dropped = await inAlready.drain();
    assert.deepEqual([dropped.replayed, dropped.left, dropped.recovered], [1, 0, []]);
    assert.deepEqual(inAlready.sent, ['applyCloseDraft']);

    // Not in, on blocks as the page saw them: saved
    const saved = world();
    await noteA(saved);
    const second = await saveOfA(saved, 'c-save-2', 'alpha, edited');
    await saved.journal.put(entryOf(second.command, { draft: second.draft }));
    const savedResult = await saved.drain();
    assert.deepEqual([savedResult.replayed, savedResult.left, savedResult.recovered], [1, 0, []]);
    const [a1] = (await saved.blocksOf('A')).filter((/** @type {Row} */ block) => block.id === 'a1');
    assert.equal(a1.content, 'alpha, edited');

    // Another writer changed a1 since the page saw it: one recovered note, and the newer text stays
    const changed = world();
    await noteA(changed);
    const third = await saveOfA(changed, 'c-save-3', 'alpha, the older edit');
    const newer = await changed.page.execute({
      type: 'saveNoteContent',
      commandId: 'c-other-tab',
      noteId: 'A',
      blocks: [{ id: 'a1', type: 'text', content: 'alpha, a newer edit', order: 0 }],
      deriveFromStored: true,
    });
    assert.equal(newer.kind, 'committed');
    await changed.journal.put(entryOf(third.command, { draft: third.draft }));
    const recovered = await changed.drain();
    assert.deepEqual([recovered.replayed, recovered.left], [1, 0]);
    assert.deepEqual(recovered.recovered, [{ id: 'c-save-3-recovered', of: 'A' }]);
    const [kept] = (await changed.blocksOf('A')).filter((/** @type {Row} */ block) => block.id === 'a1');
    assert.equal(kept.content, 'alpha, a newer edit');
    assert.ok(await changed.recordOf('notes', 'c-save-3-recovered'));
  });

  it("saves an editor's save into its note in the Trash, as #33's rules do, and names that note", async () => {
    const w = world();
    await noteA(w);
    const save = await saveOfA(w, 'c-save-trash', 'alpha, edited');
    const trashed = await w.page.execute({ type: 'trashNote', commandId: 'c-trash-a', noteId: 'A' });
    assert.equal(trashed.kind, 'committed', JSON.stringify(trashed));
    await w.journal.put(entryOf(save.command, { draft: save.draft }));
    const result = await w.drain();
    assert.deepEqual([result.replayed, result.left, result.recovered, result.savedInTrash], [1, 0, [], ['A']]);
    assert.deepEqual(w.answers, [['applyCloseDraft', 'committed', 'close-draft-saved-in-trash']]);
    const [a1] = (await w.blocksOf('A')).filter((/** @type {Row} */ block) => block.id === 'a1');
    assert.equal(a1.content, 'alpha, edited');
    assert.deepEqual(w.told, []);
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
    // An editor's save whose note is gone with no tombstone found stays too
    const gone = world();
    await noteA(gone);
    const save = await saveOfA(gone, 'c-save', 'alpha, edited');
    await gone.journal.put(entryOf({ ...save.command, noteId: 'B' }, { draft: { ...save.draft, noteId: 'B' } }));
    const kept = await gone.drain();
    assert.deepEqual([kept.replayed, kept.left], [0, 1]);
    assert.deepEqual(gone.told, [['c-save', 'note-not-found']]);
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

  it('keeps a malformed entry, a save with no draft, and one the kernel refuses as a conflict record, and then removes it', async () => {
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
    const result = await w.drain();
    assert.deepEqual([result.status, result.kept, result.left], ['drained', 3, 0]);
    assert.deepEqual(w.told, [
      ['c-odd', 'invalid-payload'],
      ['c-bare', 'invalid-payload'],
      ['c-filed', 'replay-refused'],
    ]);
    for (const opId of ['c-odd', 'c-bare', 'c-filed']) {
      const record = await w.recordOf('conflicts', opId);
      assert.ok(record, opId);
      assert.equal(record.command.commandId, opId);
      assert.equal(record.expected, null);
    }
    assert.equal((await w.recordOf('conflicts', 'c-bare')).noteId, 'n1');
  });

  it("stops when the kernel can't answer, leaving every entry it hadn't removed", async () => {
    const w = world();
    await w.journal.put(entryOf(quickNote('c1', 'n1')));
    await w.journal.put(entryOf(quickNote('c2', 'n2'), { createdAt: NOW + 1 }));
    let calls = 0;
    const result = await w.drain({
      client: {
        execute: async command => {
          calls += 1;
          if (calls === 1) return w.worker.execute(command);
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
    assert.deepEqual(
      [result.status, result.code, result.replayed, result.left],
      ['stopped', 'transaction-failed', 1, 1],
    );
    assert.deepEqual(
      w.journal.entries().map(entry => entry.opId),
      ['c2'],
    );
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
    assert.deepEqual([blind.status, blind.code, blind.replayed, blind.left], ['stopped', 'unreadable', 0, 1]);
  });

  it('answers empty for an empty journal, and sends nothing', async () => {
    const w = world();
    const result = await w.drain();
    assert.deepEqual([result.status, result.left, result.oldestOrphanedEntryAt], ['empty', 0, null]);
    assert.deepEqual(w.sent, []);
  });
});
