// #35 slice 3b's apply of editor saves at a page's start (js/kernel/core/application/journal-apply.js,
// the lead's S1 call on #182): a page sends each `saveNoteContent` entry with a draft that no live
// page holds as `applyCloseDraft` under `<opId>-apply`, oldest first, under DRAFTS_LOCK, as a
// close-time draft goes, on the in-memory adapter and on #17's. #33's rules decide each, as they
// did in 3a's drain. Here: those rules, the entries it leaves (a live page's, its own, a newer
// build's, one the worker holds, and every one that isn't an editor save with a draft), what it
// keeps for the next start, a note gone for the worker's sweep, a pane's covered entries (R182's
// S2), a draft it can't apply, and two pages starting together.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { applyJournalSaves } from '../../js/kernel/core/application/journal-apply.js';
import { drainJournal } from '../../js/kernel/core/application/journal-drain.js';
import { WORKER_HANDLERS } from '../../js/kernel/core/application/handlers-worker.js';
import { rejected, unavailable, unknown } from '../../js/kernel/core/contracts/outcomes.js';
import { WORKER_CATALOG } from '../../js/kernel/core/contracts/worker-catalog.js';
import { blockDigest } from '../../js/kernel/core/domain/close-draft.js';
import { journalEntry } from '../../js/kernel/core/domain/journal.js';
import { createMemoryAdapter } from '../../js/kernel/core/memory/adapter.js';
import { createMemoryJournal } from '../../js/kernel/core/memory/journal.js';
import { journaledLookup } from '../../js/kernel/core/messaging/journaled-operations.js';
import { createBaselinePolicy } from '../../js/kernel/core/ports/policy.js';
import { indexedDbFixture } from './storage-fixture.mjs';
import { CALLERS, NOW, testClock, testIds } from './support.mjs';
import { createKernel } from './test-kernel.mjs';

/** @typedef {import('../../js/kernel/core/domain/journal.js').JournalRecord} JournalRecord */
/** @typedef {import('../../js/kernel/core/domain/close-draft.js').CloseDraft} CloseDraft */
/** @typedef {import('../../js/kernel/core/application/kernel.js').Kernel} Kernel */
/** @typedef {import('../../js/kernel/core/ports/repository.js').KernelAdapter} KernelAdapter */
/** @typedef {any} Row */

/** The page this apply runs in, whose own entries are its journaling's */
const OWN = 'page-own';

/** A page that closed or crashed, whose owner lock is free */
const GONE = 'page-gone';

/** A page that's still open, holding its owner lock */
const LIVE = 'page-live';

/**
 * One page's storage: its adapter, its clock, its kernel, and a second page's on the same profile
 * @typedef {{adapter: KernelAdapter, clock: ReturnType<typeof testClock>, page: Kernel, second: () => Promise<Kernel>, close: () => Promise<void> | void}} Context
 */

/** @type {Array<{name: string, start: () => Promise<Context>}>} */
const FIXTURES = [
  {
    name: 'in-memory',
    async start() {
      const adapter = createMemoryAdapter();
      const clock = testClock();
      const ids = testIds('page');
      /** @param {string} contextId */
      const kernel = contextId =>
        createKernel({ adapter, policy: createBaselinePolicy(), caller: { surface: 'newtab', contextId }, ids, clock });
      return { adapter, clock, page: kernel('newtab-1'), second: async () => kernel('newtab-2'), close: () => {} };
    },
  },
  {
    name: "#17's IndexedDB",
    async start() {
      const ctx = await indexedDbFixture.start();
      return {
        adapter: ctx.adapter,
        clock: /** @type {ReturnType<typeof testClock>} */ (ctx.clock),
        page: ctx.kernel(),
        second: async () => (await ctx.secondContext()).kernel(),
        close: ctx.close,
      };
    },
  },
];

/**
 * Exclusive Web Locks, granted per name in request order, as navigator.locks grants them
 */
function serialLocks() {
  /** @type {Map<string, Promise<unknown>>} */
  const tails = new Map();
  return {
    /**
     * @template T
     * @param {string} name
     * @param {{mode: 'exclusive'}} options
     * @param {() => Promise<T>} callback
     * @returns {Promise<T>}
     */
    request(name, options, callback) {
      const turn = (tails.get(name) || Promise.resolve()).then(callback);
      tails.set(
        name,
        turn.catch(() => {}),
      );
      return turn;
    },
  };
}

/**
 * A page's start, with the journal its closed tabs left: the page's kernel and the worker's on
 * one profile, the journal, the drafts' lock, and what the apply sends and tells
 * @param {{start: () => Promise<Context>}} fixture
 */
async function world(fixture) {
  const ctx = await fixture.start();
  const worker = createKernel({
    adapter: ctx.adapter,
    policy: createBaselinePolicy(WORKER_CATALOG),
    caller: CALLERS['worker-internal'],
    handlers: WORKER_HANDLERS,
    ids: testIds('worker'),
    clock: ctx.clock,
  });
  const journal = createMemoryJournal();
  const locks = serialLocks();
  const holders = new Set([LIVE]);
  /** @type {string[]} the commandId of each command the apply sent */
  const sent = [];
  /** @type {Array<{id: string, of: string}>} each recovered note the next new tab's toast tells */
  const told = [];
  /** @type {string[]} each note in the Trash a save went into, for the toast */
  const toldSaved = [];
  let woken = 0;
  /** @param {Kernel} kernel */
  const clientOf = kernel => ({
    /** @param {any} command */
    execute: async command => {
      sent.push(command.commandId);
      return kernel.execute(command);
    },
  });
  /** @param {Partial<Parameters<typeof applyJournalSaves>[0]>} [overrides] */
  const apply = (overrides = {}) =>
    applyJournalSaves({
      journal,
      client: clientOf(ctx.page),
      liveOwners: async () => holders,
      sessionId: OWN,
      locks,
      store: {
        tell: (/** @type {{id: string, of: string}} */ entry) => told.push(entry),
        tellSaved: (/** @type {string} */ id) => toldSaved.push(id),
      },
      wake: () => {
        woken += 1;
      },
      ...overrides,
    });
  /** The worker's drain of the same journal, which the page wakes */
  const drain = () =>
    drainJournal({
      journal,
      client: { execute: command => worker.execute(command), query: query => worker.query(query) },
      lookup: journaledLookup,
      liveOwners: async () => holders,
      own: { sessionId: 'coordinator-1', inFlight: () => new Set() },
      clock: ctx.clock,
    });
  /**
   * @param {string} store
   * @param {string} key
   */
  const recordOf = (store, key) =>
    ctx.adapter.read([/** @type {any} */ (store)], tx => tx.get(/** @type {any} */ (store), key));
  /** @param {string} noteId */
  const blocksOf = noteId => ctx.adapter.read(['blocks'], tx => tx.getAllByIndex('blocks', 'canvasId', noteId));
  /** @param {string} noteId */
  const revisionOf = noteId =>
    ctx.adapter.read(['notes'], async tx => {
      await tx.get('notes', noteId);
      return tx.versions('notes', noteId)?.revision ?? 0;
    });
  return {
    ...ctx,
    worker,
    journal,
    holders,
    sent,
    told,
    toldSaved,
    woken: () => woken,
    clientOf,
    apply,
    drain,
    recordOf,
    blocksOf,
    revisionOf,
  };
}

/** @typedef {Awaited<ReturnType<typeof world>>} World */

let counted = 0;

/**
 * The entry a page wrote for `command` before it sent it
 * @param {Record<string, any>} command
 * @param {{owner?: string, createdAt?: number, draft?: CloseDraft, v?: number, pane?: string}} [options]
 * @returns {JournalRecord}
 */
function entryOf(command, { owner = GONE, createdAt = NOW, draft, v = 1, pane } = {}) {
  counted += 1;
  return journalEntry({
    command: /** @type {any} */ (command),
    v,
    noteId: command.noteId,
    surface: 'newtab',
    ownerSessionId: owner,
    seq: counted,
    createdAt,
    draft,
    pane,
  });
}

/**
 * Note A as the page made it: a1 and a2
 * @param {World} w
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
 * An editor's save of one of a note's blocks, note A's unless it says, and its draft on what the
 * page last saw commit: the stored block and the revision now, as 3b's editor writes them beside
 * the save
 * @param {World} w
 * @param {string} commandId
 * @param {string} text
 * @param {{block?: string, order?: number, note?: string, name?: string}} [options]
 */
async function saveOf(w, commandId, text, { block = 'a1', order = 0, note = 'A', name = 'Alpha plan' } = {}) {
  const [stored] = (await w.blocksOf(note)).filter((/** @type {Row} */ row) => row.id === block);
  const revision = await w.revisionOf(note);
  const blocks = [{ id: block, type: 'text', content: text, order }];
  const command = { type: 'saveNoteContent', commandId, noteId: note, blocks, deriveFromStored: true };
  /** @type {CloseDraft} */
  const draft = {
    v: 1,
    id: commandId,
    page: 'page-1',
    noteId: note,
    at: NOW,
    base: { revision, updatedAt: null, issued: [], name, blocks: { [block]: blockDigest(stored, note) } },
    blocks: blocks.map(row => ({ ...row, canvasId: note })),
    deletedBlockIds: [],
    preview: text,
    todoProgress: null,
    linkedNames: [],
  };
  return { command, draft };
}

/**
 * A block of a note's, note A's unless it says, as stored
 * @param {World} w
 * @param {string} id
 * @param {string} [note]
 */
async function blockOf(w, id, note = 'A') {
  const found = (await w.blocksOf(note)).find((/** @type {Row} */ row) => row.id === id);
  assert.ok(found, `${id} is stored`);
  return found;
}

for (const fixture of FIXTURES) {
  describe(`the pages' apply of editor saves at their start (#35 slice 3b), on ${fixture.name}`, () => {
    it("applies an editor save's entry by #33's rules, under `<opId>-apply`: dropped when it's in, saved where its blocks are as the page saw them, recovered where they changed", async () => {
      // In already: the save committed, and its page went before it removed the entry
      const inAlready = await world(fixture);
      await noteA(inAlready);
      const first = await saveOf(inAlready, 'c-save-1', 'alpha, edited');
      assert.equal((await inAlready.page.execute(/** @type {any} */ (first.command))).kind, 'committed');
      await inAlready.journal.put(entryOf(first.command, { draft: first.draft }));
      const dropped = await inAlready.apply();
      assert.deepEqual([dropped.saved, dropped.recovered], [[], []]);
      assert.deepEqual(inAlready.sent, ['c-save-1-apply']);
      assert.deepEqual(inAlready.journal.entries(), []);
      await inAlready.close();

      // Not in, on blocks as the page saw them: saved
      const saved = await world(fixture);
      await noteA(saved);
      const second = await saveOf(saved, 'c-save-2', 'alpha, edited');
      await saved.journal.put(entryOf(second.command, { draft: second.draft }));
      const savedResult = await saved.apply();
      assert.deepEqual([savedResult.saved, savedResult.recovered], [['A'], []]);
      assert.equal((await blockOf(saved, 'a1')).content, 'alpha, edited');
      assert.deepEqual(saved.journal.entries(), []);
      assert.deepEqual([saved.told, saved.toldSaved], [[], []]);
      await saved.close();

      // Another writer changed a1 since the page saw it: one recovered note, told for the next
      // new tab's toast, and the newer text stays
      const changed = await world(fixture);
      await noteA(changed);
      const third = await saveOf(changed, 'c-save-3', 'alpha, the older edit');
      const newer = await changed.page.execute({
        type: 'saveNoteContent',
        commandId: 'c-other-tab',
        noteId: 'A',
        blocks: [{ id: 'a1', type: 'text', content: 'alpha, a newer edit', order: 0 }],
        deriveFromStored: true,
      });
      assert.equal(newer.kind, 'committed');
      await changed.journal.put(entryOf(third.command, { draft: third.draft }));
      const recovered = await changed.apply();
      assert.deepEqual(recovered.recovered, [{ noteId: 'A', recoveredId: 'c-save-3-recovered' }]);
      assert.deepEqual(changed.told, [{ id: 'c-save-3-recovered', of: 'A' }]);
      assert.equal((await blockOf(changed, 'a1')).content, 'alpha, a newer edit');
      assert.ok(await changed.recordOf('notes', 'c-save-3-recovered'));
      assert.deepEqual(changed.journal.entries(), []);
      await changed.close();
    });

    it("saves an editor save into its note in the Trash, as #33's rules do, and tells that note for the toast", async () => {
      const w = await world(fixture);
      await noteA(w);
      const save = await saveOf(w, 'c-save-trash', 'alpha, edited');
      const trashed = await w.page.execute({ type: 'trashNote', commandId: 'c-trash-a', noteId: 'A' });
      assert.equal(trashed.kind, 'committed', JSON.stringify(trashed));
      await w.journal.put(entryOf(save.command, { draft: save.draft }));
      const result = await w.apply();
      assert.deepEqual([result.savedInTrash, result.recovered], [['A'], []]);
      assert.deepEqual([w.toldSaved, w.told], [['A'], []]);
      assert.equal((await blockOf(w, 'a1')).content, 'alpha, edited');
      assert.deepEqual(w.journal.entries(), []);
      await w.close();
    });

    it("leaves a live page's entry, its own, a newer build's, one the worker holds, and every one that isn't an editor save with a draft", async () => {
      const w = await world(fixture);
      await noteA(w);
      /** @type {JournalRecord[]} */
      const left = [];
      const live = await saveOf(w, 'c-live', 'alpha, a live page');
      left.push(entryOf(live.command, { draft: live.draft, owner: LIVE }));
      const own = await saveOf(w, 'c-own', 'alpha, its own');
      left.push(entryOf(own.command, { draft: own.draft, owner: OWN }));
      // A newer build's, which a page of that build applies
      const newer = await saveOf(w, 'c-newer', 'alpha, a newer build');
      left.push(entryOf(newer.command, { draft: newer.draft, v: 2 }));
      // One the worker holds, under a tombstone the sweep keeps for (the lead's Q6)
      const held = await saveOf(w, 'c-held', 'alpha, held');
      left.push({ ...entryOf(held.command, { draft: held.draft }), unreplayable: { code: 'note-deleted', at: NOW } });
      // Input not sent yet, #2's
      const typed = await saveOf(w, 'c-typed', 'alpha, typed');
      left.push({ ...entryOf(typed.command, { draft: typed.draft }), state: 'draft' });
      // The worker's to replay, or to keep as a conflict record
      left.push(
        entryOf({
          type: 'createNote',
          commandId: 'c-quick',
          noteId: 'n-quick',
          name: 'Call the plumber',
          blocks: [{ id: 'n-quick-b1', type: 'text', content: 'Call the plumber' }],
        }),
      );
      left.push(entryOf((await saveOf(w, 'c-bare', 'alpha, no draft')).command));
      // Even one that holds a draft, which no page writes beside anything but an editor save
      left.push(
        entryOf(
          {
            type: 'insertBlocks',
            commandId: 'c-append',
            noteId: 'A',
            blocks: [{ id: 'a3', type: 'text', content: 'alpha three' }],
          },
          { draft: (await saveOf(w, 'c-append', 'alpha, appended')).draft },
        ),
      );
      for (const entry of left) await w.journal.put(entry);
      await w.apply();
      assert.deepEqual(w.sent, []);
      assert.deepEqual(
        w.journal.entries().map(entry => entry.opId),
        left.map(entry => entry.opId),
      );
      assert.equal((await blockOf(w, 'a1')).content, 'alpha');

      // Nor another page's at all when it can't tell which pages are alive
      const blind = await world(fixture);
      await noteA(blind);
      const orphaned = await saveOf(blind, 'c-orphaned', 'alpha, edited');
      await blind.journal.put(entryOf(orphaned.command, { draft: orphaned.draft }));
      await blind.apply({ liveOwners: async () => null });
      assert.deepEqual(blind.sent, []);
      // It goes by the version and the tombstone the worker holds for, not by any mark: one an
      // older build's worker marked, at this page's version, applies
      await blind.journal.mark('c-orphaned', { code: 'unsupported-version', at: NOW });
      await blind.apply();
      assert.deepEqual(blind.sent, ['c-orphaned-apply']);
      assert.equal((await blockOf(blind, 'a1')).content, 'alpha, edited');
      await w.close();
      await blind.close();
    });

    it('keeps an entry the kernel refuses, or has no answer for, for the next start, and goes on past a refusal', async () => {
      const w = await world(fixture);
      await noteA(w);
      const refused = await saveOf(w, 'c-refused', 'alpha, refused');
      await w.journal.put(entryOf(refused.command, { draft: refused.draft, pane: 'one' }));
      const fine = await saveOf(w, 'c-fine', 'alpha two, edited', { block: 'a2', order: 1 });
      await w.journal.put(entryOf(fine.command, { draft: fine.draft, pane: 'two', createdAt: NOW + 1 }));
      const result = await w.apply({
        client: {
          /** @param {any} command */
          execute: async command => {
            w.sent.push(command.commandId);
            return command.commandId === 'c-refused-apply'
              ? rejected('validation', 'invalid-command')
              : w.page.execute(command);
          },
        },
      });
      assert.deepEqual(w.sent, ['c-refused-apply', 'c-fine-apply']);
      assert.deepEqual(result.saved, ['A']);
      assert.deepEqual(
        w.journal.entries().map(entry => entry.opId),
        ['c-refused'],
      );
      await w.close();

      for (const answer of [unavailable('storage', 'timed-out', true), unknown('outcome-unknown', 'c-save-apply')]) {
        const quiet = await world(fixture);
        await noteA(quiet);
        const save = await saveOf(quiet, 'c-save', 'alpha, edited');
        await quiet.journal.put(entryOf(save.command, { draft: save.draft }));
        await quiet.apply({ client: { execute: async () => answer } });
        assert.deepEqual(
          quiet.journal.entries().map(entry => entry.opId),
          ['c-save'],
          answer.kind,
        );
        assert.equal((await blockOf(quiet, 'a1')).content, 'alpha', answer.kind);
        await quiet.close();
      }
    });

    it("leaves an entry whose note is gone to the worker's sweep, which tells a tombstone it keeps for from one it deletes for, and wakes the drain", async () => {
      const w = await world(fixture);
      await noteA(w);
      const save = await saveOf(w, 'c-save', 'alpha, edited');
      await w.page.execute({ type: 'trashNote', commandId: 'c-trash-a', noteId: 'A' });
      const deleted = await w.page.execute({ type: 'deleteNotePermanently', commandId: 'c-delete-a', noteId: 'A' });
      assert.equal(deleted.kind, 'committed', JSON.stringify(deleted));
      await w.journal.put(entryOf(save.command, { draft: save.draft }));
      const result = await w.apply();
      assert.deepEqual(result.gone, ['A']);
      // A page can't read the tombstones, and one the sweep keeps for holds the save's text
      assert.deepEqual(
        w.journal.entries().map(entry => entry.opId),
        ['c-save'],
      );
      assert.equal(w.woken(), 1);
      const swept = await w.drain();
      assert.deepEqual([swept.swept, swept.left], [1, 0]);
      await w.close();
    });

    it("drops an entry its pane's later entry for the note covers, before it applies any, so no older text becomes a recovered note, and applies another pane's, and its pane's of another note, on their own (R182's S2, P2b)", async () => {
      const w = await world(fixture);
      await noteA(w);
      const madeB = await w.page.execute({
        type: 'createNote',
        commandId: 'c-make-b',
        noteId: 'B',
        name: 'Beta plan',
        blocks: [{ id: 'b1', type: 'text', content: 'beta', order: 0 }],
      });
      assert.equal(madeB.kind, 'committed', JSON.stringify(madeB));
      // Two saves from the main pane that didn't land, the later carrying everything the pane
      // changed since its last commit, and between them one from the side pane, of another block,
      // and one from the main pane of note B, which it had open in between
      const older = await saveOf(w, 'c-main-1', 'alpha, first');
      const side = await saveOf(w, 'c-side', 'alpha two, from the side', { block: 'a2', order: 1 });
      const ofB = await saveOf(w, 'c-main-b', 'beta, edited', { block: 'b1', note: 'B', name: 'Beta plan' });
      const later = await saveOf(w, 'c-main-2', 'alpha, second');
      await w.journal.put(entryOf(older.command, { draft: older.draft, pane: 'main' }));
      await w.journal.put(entryOf(side.command, { draft: side.draft, pane: 'side', createdAt: NOW + 1 }));
      await w.journal.put(entryOf(ofB.command, { draft: ofB.draft, pane: 'main', createdAt: NOW + 2 }));
      await w.journal.put(entryOf(later.command, { draft: later.draft, pane: 'main', createdAt: NOW + 3 }));
      const result = await w.apply();
      assert.deepEqual(w.sent, ['c-side-apply', 'c-main-b-apply', 'c-main-2-apply']);
      assert.deepEqual(result.recovered, []);
      assert.deepEqual(w.told, []);
      assert.equal((await blockOf(w, 'a1')).content, 'alpha, second');
      assert.equal((await blockOf(w, 'a2')).content, 'alpha two, from the side');
      assert.equal((await blockOf(w, 'b1', 'B')).content, 'beta, edited');
      assert.deepEqual(w.journal.entries(), []);
      await w.close();

      // Another closed page's pane of the same name is another pane, so its later entry covers
      // none of the first page's
      const two = await world(fixture);
      await noteA(two);
      const mine = await saveOf(two, 'c-page-1', 'alpha, from one page');
      const theirs = await saveOf(two, 'c-page-2', 'alpha two, from another', { block: 'a2', order: 1 });
      await two.journal.put(entryOf(mine.command, { draft: mine.draft, pane: 'main' }));
      await two.journal.put(
        entryOf(theirs.command, { draft: theirs.draft, pane: 'main', owner: 'page-gone-2', createdAt: NOW + 1 }),
      );
      const both = await two.apply();
      assert.deepEqual(two.sent, ['c-page-1-apply', 'c-page-2-apply']);
      assert.deepEqual([both.saved, both.recovered], [['A', 'A'], []]);
      assert.equal((await blockOf(two, 'a1')).content, 'alpha, from one page');
      assert.equal((await blockOf(two, 'a2')).content, 'alpha two, from another');
      await two.close();
    });

    it("covers by the page's own count of its entries, not by the journal's order, so the pane's later save lands when the page's clock stepped back between the two (R191's finding 2)", async () => {
      const w = await world(fixture);
      await noteA(w);
      // Two saves from the main pane that didn't land, the later written after the page's clock
      // stepped back, so the journal lists it first
      const older = await saveOf(w, 'c-main-1', 'alpha, first');
      const later = await saveOf(w, 'c-main-2', 'alpha, second');
      const olderEntry = entryOf(older.command, { draft: older.draft, pane: 'main', createdAt: NOW + 5000 });
      const laterEntry = entryOf(later.command, { draft: later.draft, pane: 'main' });
      assert.ok(laterEntry.seq > olderEntry.seq, 'the page counted the later save after the older');
      await w.journal.put(olderEntry);
      await w.journal.put(laterEntry);
      assert.deepEqual(
        w.journal.entries().map(entry => entry.opId),
        ['c-main-2', 'c-main-1'],
      );
      const result = await w.apply();
      assert.deepEqual(w.sent, ['c-main-2-apply']);
      assert.deepEqual([result.saved, result.recovered], [['A'], []]);
      assert.equal((await blockOf(w, 'a1')).content, 'alpha, second');
      assert.deepEqual(w.journal.entries(), []);
      await w.close();
    });

    it("saves a later entry over the pane's earlier save that committed, by the issued saves its draft names, not as a recovered note (R182's S2, P2)", async () => {
      const w = await world(fixture);
      await noteA(w);
      // The later save was issued while the earlier was in flight, so its base is the same commit
      const earlier = await saveOf(w, 'c-main-1', 'alpha, first');
      const later = await saveOf(w, 'c-main-2', 'alpha, second');
      assert.equal((await w.page.execute(/** @type {any} */ (earlier.command))).kind, 'committed');
      later.draft.base.issuedSaves = [{ blocks: { a1: blockDigest(await blockOf(w, 'a1'), 'A') } }];
      await w.journal.put(entryOf(later.command, { draft: later.draft, pane: 'main' }));
      const result = await w.apply();
      assert.deepEqual([result.saved, result.recovered], [['A'], []]);
      assert.equal((await blockOf(w, 'a1')).content, 'alpha, second');
      assert.equal(await w.recordOf('notes', 'c-main-2-recovered'), undefined);
      await w.close();
    });

    it("writes an entry whose draft it can't apply back without it and wakes the drain, which keeps the save as a conflict record with its text (the lead's pick on 3b's plan)", async () => {
      const w = await world(fixture);
      await noteA(w);
      // Its pane's earlier entry, which one it can't read covers nothing of, still applies
      const good = await saveOf(w, 'c-good', 'alpha, before');
      await w.journal.put(entryOf(good.command, { draft: good.draft, pane: 'main' }));
      const save = await saveOf(w, 'c-bad', 'alpha, typed');
      await w.journal.put(
        entryOf(save.command, { draft: /** @type {any} */ ({ v: 1, id: 'c-bad' }), pane: 'main', createdAt: NOW + 1 }),
      );
      await w.apply();
      assert.deepEqual(w.sent, ['c-good-apply']);
      assert.equal((await blockOf(w, 'a1')).content, 'alpha, before');
      assert.equal(w.woken(), 1);
      const [stripped] = w.journal.entries();
      assert.deepEqual([stripped.opId, stripped.draft, stripped.command], ['c-bad', undefined, save.command]);
      const kept = await w.drain();
      assert.deepEqual([kept.kept, kept.left], [1, 0]);
      const record = await w.recordOf('conflicts', 'c-bad');
      assert.equal(record?.command.blocks[0].content, 'alpha, typed');
      await w.close();
    });

    it("applies an entry once when two pages start together: the second, under DRAFTS_LOCK after the first, finds it gone (the lead's timing check)", async () => {
      const w = await world(fixture);
      await noteA(w);
      const save = await saveOf(w, 'c-save', 'alpha, the older edit');
      // Another writer changed a1 since, so the apply makes a recovered note
      const newer = await w.page.execute({
        type: 'saveNoteContent',
        commandId: 'c-other-tab',
        noteId: 'A',
        blocks: [{ id: 'a1', type: 'text', content: 'alpha, a newer edit', order: 0 }],
        deriveFromStored: true,
      });
      assert.equal(newer.kind, 'committed');
      await w.journal.put(entryOf(save.command, { draft: save.draft }));
      const second = await w.second();
      const results = await Promise.all([w.apply(), w.apply({ client: w.clientOf(second) })]);
      assert.deepEqual(w.sent, ['c-save-apply'], 'applied once');
      assert.deepEqual(
        results.flatMap((/** @type {{recovered: unknown[]}} */ result) => result.recovered),
        [{ noteId: 'A', recoveredId: 'c-save-recovered' }],
      );
      assert.deepEqual(w.told, [{ id: 'c-save-recovered', of: 'A' }]);
      assert.deepEqual(w.journal.entries(), []);
      await w.close();
    });
  });
}
