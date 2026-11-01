// applyCloseDraft (#33, the stack's close-time PR): one close-time draft applied in one
// transaction (application/close-drafts.js), by the rules of domain/close-draft.js, on the
// in-memory adapter and on #17's. One test per path: saved with its deletes, merged with another
// writer's change, recovered, dropped as already in or as deletes alone, caught up, gone, and
// rule 0, each for the stack's drafts and 1.4.3's, plus the block of another note or of none, a
// resend, and below version 10.

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { unitsWork } from '../../js/kernel/core/application/work.js';
import { committed } from '../../js/kernel/core/contracts/outcomes.js';
import { blockDigest, recoveredIdOf } from '../../js/kernel/core/domain/close-draft.js';
import { noteSaveMetadata } from '../../js/kernel/core/domain/note.js';
import { createMemoryAdapter } from '../../js/kernel/core/memory/adapter.js';
import { createBaselinePolicy } from '../../js/kernel/core/ports/policy.js';
import { adapterOn, closeAll, indexedDbFixture, kernelOn, legacyEnv, profile } from './storage-fixture.mjs';
import { CALLERS, NOW, testClock, testIds } from './support.mjs';
import { createKernel } from './test-kernel.mjs';

/** @typedef {import('../../js/kernel/core/domain/close-draft.js').CloseDraft} CloseDraft */
/** @typedef {import('../../js/kernel/core/contracts/outcomes.js').Outcome} Outcome */
/** @typedef {import('../../js/kernel/core/contracts/commands.js').Command} Command */
/** @typedef {import('../../js/kernel/core/ports/repository.js').KernelAdapter} KernelAdapter */
/** @typedef {import('../../js/kernel/core/ports/repository.js').StoreName} StoreName */
/** @typedef {import('../../js/kernel/core/application/kernel.js').Kernel} Kernel */
/** @typedef {any} Row */

/** When the closing tab closed: Oct 31, 2026, 9:41 PM in the clock's zone, UTC */
const AT = Date.UTC(2026, 9, 31, 21, 41);
/** 1.4.x's records' times (legacy-env's note and block) */
const T0 = 1700000000000;

/** @type {(id: string, fields?: Row) => Row} */
const note = (id, fields) => legacyEnv.note(id, fields);
/** @type {(id: string, canvasId: string | undefined, order: number, content?: string, fields?: Row) => Row} */
const block = (id, canvasId, order, content, fields) => legacyEnv.block(id, canvasId, order, content, fields);

/**
 * One context per test: an adapter, the clock and ids its kernel runs on, and the kernel
 * @typedef {{adapter: KernelAdapter, clock: ReturnType<typeof testClock>, ids: {next(): string}, kernel: Kernel, close: () => Promise<void> | void}} Context
 */

/** @type {Array<{name: string, start: () => Promise<Context>}>} */
const FIXTURES = [
  {
    name: 'in-memory',
    async start() {
      const adapter = createMemoryAdapter();
      const clock = testClock();
      const ids = testIds();
      const kernel = createKernel({ adapter, policy: createBaselinePolicy(), caller: CALLERS.newtab, ids, clock });
      return { adapter, clock, ids, kernel, close: () => {} };
    },
  },
  {
    name: "#17's IndexedDB",
    async start() {
      const ctx = await indexedDbFixture.start();
      return { adapter: ctx.adapter, clock: ctx.clock, ids: ctx.ids, kernel: ctx.kernel(), close: ctx.close };
    },
  },
];

/**
 * Records no command writes in these states, put through the adapter's own commit
 * @param {Context} ctx
 * @param {StoreName} store
 * @param {Row[]} records
 */
async function seed(ctx, store, records) {
  const seeding = /** @type {Command} */ ({ type: 'runStartupMaintenance', commandId: ctx.ids.next() });
  const unit = {
    stores: [store],
    /** @param {import('../../js/kernel/core/ports/repository.js').Tx} tx */
    async run(tx) {
      for (const record of records) tx.put(store, /** @type {any} */ (record));
    },
  };
  const { outcome } = await ctx.adapter.commit(unitsWork(seeding, [unit], () => committed('seeded', [])));
  assert.equal(outcome.kind, 'committed', JSON.stringify(outcome));
}

/**
 * Note A (blocks a1, a2) and note B (b1), as 1.4.x stored them, with A's search entry
 * @param {Context} ctx
 * @param {{a?: Row, blocks?: Row[], notes?: Row[]}} [extra]
 */
async function profileOf(ctx, { a = {}, blocks = [], notes = [] } = {}) {
  await seed(ctx, 'notes', [
    note('A', { name: 'Alpha plan', preview: 'alpha', ...a }),
    note('B', { name: 'Bravo', preview: 'bravo' }),
    ...notes,
  ]);
  await seed(ctx, 'blocks', [block('a1', 'A', 0, 'alpha'), block('a2', 'A', 1, 'alpha two'), block('b1', 'B', 0, 'bravo'), ...blocks]);
  await seed(ctx, 'searchIndex', [{ noteId: 'A', name: 'Alpha plan', content: 'alpha alpha two', updatedAt: T0 }]);
}

/**
 * A stored record, with its versions when the adapter keeps them
 * @param {Context} ctx
 * @param {StoreName} store
 * @param {string} key
 * @returns {Promise<{record: Row | undefined, versions: import('../../js/kernel/core/ports/repository.js').Versions | undefined}>}
 */
const recordOf = (ctx, store, key) =>
  ctx.adapter.read([store], async tx => {
    const record = await tx.get(store, key);
    return { record, versions: store === 'notes' && record ? tx.versions('notes', key) : undefined };
  });

/**
 * @param {Context} ctx
 * @param {StoreName} store
 * @returns {Promise<Row[]>}
 */
const allOf = (ctx, store) => ctx.adapter.read([store], tx => tx.getAll(store));

/**
 * Note `noteId`'s blocks, by id
 * @param {Context} ctx
 * @param {string} noteId
 * @returns {Promise<Record<string, Row>>}
 */
const blocksOf = async (ctx, noteId) =>
  Object.fromEntries(
    (await ctx.adapter.read(['blocks'], tx => tx.getAllByIndex('blocks', 'canvasId', noteId))).map(row => [row.id, row]),
  );

/**
 * The digests of `rows` as note `noteId` stores them, by id
 * @param {Row[]} rows
 * @param {string} [noteId]
 */
const digests = (rows, noteId = 'A') => Object.fromEntries(rows.map(row => [row.id, blockDigest(row, noteId)]));

/** A1 and a2 as the profile stores them, which a stack draft's page last saw commit */
const BASE_BLOCKS = () => [block('a1', 'A', 0, 'alpha'), block('a2', 'A', 1, 'alpha two')];

/**
 * A stack draft of note A's edit: a1 changed, on a base the page saw at revision `revision`
 * @param {Partial<CloseDraft> & {revision?: number, baseBlocks?: Row[], issuedSaves?: Array<{name?: string, blocks: Row[]}>}} [fields]
 * @returns {CloseDraft}
 */
function stackDraft({ revision = 0, baseBlocks = BASE_BLOCKS(), issuedSaves = [], base, ...fields } = {}) {
  return /** @type {CloseDraft} */ ({
    v: 1,
    id: 'draft-1',
    page: 'page-1',
    noteId: 'A',
    at: AT,
    base: {
      revision,
      updatedAt: T0,
      issued: [],
      name: 'Alpha plan',
      blocks: digests(baseBlocks),
      issuedSaves: issuedSaves.map(save => ({ name: save.name, blocks: digests(save.blocks) })),
      ...base,
    },
    blocks: [block('a1', 'A', 0, 'alpha, edited as the tab closed', { updatedAt: T0 + 5 })],
    deletedBlockIds: [],
    preview: 'alpha, edited as the tab closed',
    todoProgress: null,
    linkedNames: [],
    ...fields,
  });
}

/**
 * A 1.4.3 draft of note A's edit, as 1.4.3's editor writes one: a1 changed, on the record's
 * `updatedAt` its editor last saw, with the stamps its saves made since
 * @param {Partial<CloseDraft> & {updatedAt?: number, issued?: number[]}} [fields]
 * @returns {CloseDraft}
 */
function legacyDraft({ updatedAt = T0, issued = [], ...fields } = {}) {
  return /** @type {CloseDraft} */ ({
    v: 1,
    id: '1761946860000-abcdefghi',
    noteId: 'A',
    base: { revision: null, updatedAt, issued },
    at: AT,
    blocks: [block('a1', 'A', 0, 'alpha, edited as the tab closed', { updatedAt: T0 + 5 })],
    deletedBlockIds: [],
    preview: 'alpha, edited as the tab closed',
    todoProgress: null,
    linkedNames: [],
    ...fields,
  });
}

/**
 * The page's apply of `draft`, under the draft's own commandId, as composition/close-drafts.js sends it
 * @param {Context} ctx
 * @param {CloseDraft} draft
 * @returns {Promise<Outcome>}
 */
const apply = (ctx, draft) =>
  /** @type {Promise<Outcome>} */ (
    ctx.kernel.execute(/** @type {Command} */ ({ type: 'applyCloseDraft', commandId: `${draft.id}-apply`, draft }))
  );

/**
 * A command's outcome's code and the notes it changed
 * @param {Outcome | import('../../js/kernel/core/contracts/outcomes.js').BulkOutcome} outcome
 */
const said = outcome => {
  assert.equal(outcome.kind, 'committed', JSON.stringify(outcome));
  const done = /** @type {import('../../js/kernel/core/contracts/outcomes.js').Committed} */ (outcome);
  return [done.code, done.changedIds];
};

/**
 * Another tab's save of note A's blocks, as its editor sends it
 * @param {Context} ctx
 * @param {Row[]} blocks
 */
async function savedElsewhere(ctx, blocks) {
  const outcome = await ctx.kernel.execute({
    type: 'saveNoteContent',
    commandId: ctx.ids.next(),
    noteId: 'A',
    blocks,
    preview: noteSaveMetadata(blocks).preview,
  });
  assert.equal(outcome.kind, 'committed', JSON.stringify(outcome));
}

for (const fixture of FIXTURES) {
  describe(`applyCloseDraft on the ${fixture.name} adapter`, () => {
    /** @type {Context} */
    let ctx;
    beforeEach(async () => {
      ctx = await fixture.start();
    });
    afterEach(() => ctx.close());

    describe("a stack draft, by the note's revision and its blocks' digests", () => {
      it('saves on its own base, with its deletes, its title and links, and a record made from the blocks', async () => {
        await profileOf(ctx);
        ctx.clock.advance(1000);
        const draft = stackDraft({ deletedBlockIds: ['a2'], name: 'Alpha plan, renamed', titleOrigin: 'typed', linkedNames: ['Bravo'] });
        const outcome = await apply(ctx, draft);
        assert.deepEqual(said(outcome), ['close-draft-saved', ['A']]);
        const { record: a, versions } = await recordOf(ctx, 'notes', 'A');
        assert.deepEqual(Object.keys(await blocksOf(ctx, 'A')), ['a1']);
        assert.equal((await blocksOf(ctx, 'A')).a1.content, 'alpha, edited as the tab closed');
        assert.deepEqual(
          [a?.name, a?.titleManuallySet, a?.preview, a?.updatedAt],
          ['Alpha plan, renamed', true, 'alpha, edited as the tab closed', ctx.clock.now()],
        );
        assert.equal(versions?.revision, 1, 'a content save moves the revision once');
        assert.equal((await recordOf(ctx, 'searchIndex', 'A')).record?.name, 'Alpha plan, renamed');
        assert.deepEqual(
          (await allOf(ctx, 'links')).map(link => [link.fromNoteId, link.toNoteId]),
          [['A', 'B']],
        );
      });

      it("saves through a placement change made elsewhere since its base, a pin's, an archive's, and the Trash's (V3)", async () => {
        await profileOf(ctx);
        const pin = await ctx.kernel.execute({ type: 'setPinned', commandId: ctx.ids.next(), noteId: 'A', pinned: true });
        assert.equal(pin.kind, 'committed');
        assert.deepEqual(said(await apply(ctx, stackDraft())), ['close-draft-saved', ['A']]);
        assert.equal((await blocksOf(ctx, 'A')).a1.content, 'alpha, edited as the tab closed');
        assert.equal((await recordOf(ctx, 'notes', 'A')).record?.pinned, true, 'the pin stays');

        const trashed = await ctx.kernel.execute({ type: 'trashNote', commandId: ctx.ids.next(), noteId: 'A' });
        assert.equal(trashed.kind, 'committed');
        const { versions } = await recordOf(ctx, 'notes', 'A');
        const later = stackDraft({
          id: 'draft-2',
          revision: versions?.revision,
          baseBlocks: [block('a1', 'A', 0, 'alpha, edited as the tab closed', { updatedAt: T0 + 5 }), block('a2', 'A', 1, 'alpha two')],
          blocks: [block('a2', 'A', 1, 'alpha two, edited in the Trash')],
        });
        assert.deepEqual(said(await apply(ctx, later)), ['close-draft-saved-in-trash', ['A']]);
        const { record } = await recordOf(ctx, 'notes', 'A');
        assert.deepEqual([record?.trashed, (await blocksOf(ctx, 'A')).a2.content], [true, 'alpha two, edited in the Trash']);
        assert.deepEqual(await allOf(ctx, 'notes').then(rows => rows.map(row => row.id).sort()), ['A', 'B'], 'no recovered note');
      });

      it('recovers one whose block another writer changed since its base: one note holding the residue, and the original as that writer left it', async () => {
        await profileOf(ctx);
        await savedElsewhere(ctx, [block('a1', 'A', 0, 'alpha, from another tab'), block('a2', 'A', 1, 'alpha two')]);
        const draft = stackDraft();
        const recoveredId = recoveredIdOf(draft);
        assert.deepEqual(said(await apply(ctx, draft)), ['close-draft-recovered', [recoveredId]]);
        assert.equal((await blocksOf(ctx, 'A')).a1.content, 'alpha, from another tab');
        const copies = Object.values(await blocksOf(ctx, recoveredId)).sort((x, y) => x.order - y.order);
        assert.deepEqual(
          copies.map(row => [row.id, row.type, row.order]),
          [[`${recoveredId}-0`, 'callout', 0], [`${recoveredId}-1`, 'text', 1]],
        );
        assert.equal(copies[1].content, 'alpha, edited as the tab closed');
        const { record } = await recordOf(ctx, 'notes', recoveredId);
        assert.equal(record?.name, 'Recovered: Alpha plan (Oct\u00a031,\u00a09:41\u00a0PM)');
        assert.equal((await recordOf(ctx, 'searchIndex', recoveredId)).record?.name, record?.name);
      });

      it("merges one whose note another writer changed elsewhere: both edits are kept, the record made from both, and no recovered note", async () => {
        await profileOf(ctx);
        await savedElsewhere(ctx, [
          block('a1', 'A', 0, 'alpha'),
          block('a2', 'A', 1, 'alpha two, from another tab', { type: 'todo', checked: true }),
        ]);
        const draft = stackDraft({ blocks: [block('a1', 'A', 0, 'alpha, edited as the tab closed', { type: 'todo' })] });
        assert.deepEqual(said(await apply(ctx, draft)), ['close-draft-saved', ['A']]);
        const blocks = await blocksOf(ctx, 'A');
        assert.deepEqual([blocks.a1.content, blocks.a2.content], ['alpha, edited as the tab closed', 'alpha two, from another tab']);
        const { record } = await recordOf(ctx, 'notes', 'A');
        assert.deepEqual(
          [record?.preview, record?.todoProgress],
          ['alpha, edited as the tab closed', { completed: 1, total: 2 }],
          "made from both writers' blocks, not the draft's own",
        );
        assert.equal((await allOf(ctx, 'notes')).length, 2);
      });

      it("composes one page's two panes: different blocks are both saved, and on the same block the later draft wins", async () => {
        await profileOf(ctx);
        // The pop-out closed first, with a2's edit, and the main pane's draft, a1's, comes after it
        const popOut = stackDraft({ id: 'draft-pop-out', at: AT, blocks: [block('a2', 'A', 1, 'alpha two, from the pop-out')] });
        const main = stackDraft({ id: 'draft-main', at: AT + 1 });
        assert.deepEqual(said(await apply(ctx, popOut)), ['close-draft-saved', ['A']]);
        assert.deepEqual(said(await apply(ctx, main)), ['close-draft-saved', ['A']]);
        const both = await blocksOf(ctx, 'A');
        assert.deepEqual([both.a1.content, both.a2.content], ['alpha, edited as the tab closed', 'alpha two, from the pop-out']);

        // The same block: the pop-out's version is one the page issued, so the main pane's wins
        const fromPopOut = block('a1', 'A', 0, 'alpha, from the pop-out');
        const sameBlock = stackDraft({
          id: 'draft-main-2',
          at: AT + 3,
          revision: (await recordOf(ctx, 'notes', 'A')).versions?.revision,
          baseBlocks: [block('a1', 'A', 0, 'alpha, edited as the tab closed', { updatedAt: T0 + 5 }), block('a2', 'A', 1, 'alpha two, from the pop-out')],
          issuedSaves: [{ blocks: [fromPopOut] }],
          blocks: [block('a1', 'A', 0, 'alpha, from the main pane')],
        });
        const popOutAgain = stackDraft({
          id: 'draft-pop-out-2',
          at: AT + 2,
          revision: sameBlock.base.revision ?? 0,
          baseBlocks: [block('a1', 'A', 0, 'alpha, edited as the tab closed', { updatedAt: T0 + 5 }), block('a2', 'A', 1, 'alpha two, from the pop-out')],
          blocks: [fromPopOut],
        });
        assert.deepEqual(said(await apply(ctx, popOutAgain)), ['close-draft-saved', ['A']]);
        assert.deepEqual(said(await apply(ctx, sameBlock)), ['close-draft-saved', ['A']]);
        assert.equal((await blocksOf(ctx, 'A')).a1.content, 'alpha, from the main pane');
        assert.equal((await allOf(ctx, 'notes')).length, 2, 'no recovered note');
      });

      it("saves one whose page's own save committed after the close, by that save's digests", async () => {
        await profileOf(ctx);
        const inFlight = [block('a1', 'A', 0, 'alpha, saved as the tab closed'), block('a2', 'A', 1, 'alpha two')];
        await savedElsewhere(ctx, inFlight);
        const draft = stackDraft({ issuedSaves: [{ name: 'Alpha plan', blocks: inFlight }] });
        assert.deepEqual(said(await apply(ctx, draft)), ['close-draft-saved', ['A']]);
        assert.equal((await blocksOf(ctx, 'A')).a1.content, 'alpha, edited as the tab closed');
      });

      it("drops one of deletes alone over a note changed since, and the blocks stay (the lead's Q5)", async () => {
        await profileOf(ctx);
        await savedElsewhere(ctx, [block('a1', 'A', 0, 'alpha, from another tab'), block('a2', 'A', 1, 'alpha two')]);
        assert.deepEqual(said(await apply(ctx, stackDraft({ blocks: [], deletedBlockIds: ['a2'] }))), ['close-draft-dropped', []]);
        assert.deepEqual(Object.keys(await blocksOf(ctx, 'A')).sort(), ['a1', 'a2']);
      });

      it('recovers one that renamed a note another writer renamed since', async () => {
        await profileOf(ctx);
        const renamed = await ctx.kernel.execute({ type: 'renameNote', commandId: ctx.ids.next(), noteId: 'A', name: 'Alpha, from another tab' });
        assert.equal(renamed.kind, 'committed');
        const draft = stackDraft({ blocks: [], name: 'Alpha plan, renamed', titleOrigin: 'typed' });
        assert.deepEqual(said(await apply(ctx, draft)), ['close-draft-recovered', [recoveredIdOf(draft)]]);
        assert.equal((await recordOf(ctx, 'notes', 'A')).record?.name, 'Alpha, from another tab');
      });
    });

    describe("a 1.4.3 draft, by 1.4.3's own base", () => {
      it('saves on its own base, and on a stamp its own save made', async () => {
        await profileOf(ctx);
        assert.deepEqual(said(await apply(ctx, legacyDraft())), ['close-draft-saved', ['A']]);
        assert.equal((await blocksOf(ctx, 'A')).a1.content, 'alpha, edited as the tab closed');
      });

      it("saves when the stored updatedAt is a stamp its editor's own save made", async () => {
        await profileOf(ctx, { a: { updatedAt: T0 + 50 } });
        assert.deepEqual(said(await apply(ctx, legacyDraft({ issued: [T0 + 50] }))), ['close-draft-saved', ['A']]);
      });

      it('recovers one whose note another writer saved after its base', async () => {
        await profileOf(ctx, { a: { updatedAt: T0 + 70 } });
        const draft = legacyDraft();
        assert.deepEqual(said(await apply(ctx, draft)), ['close-draft-recovered', [recoveredIdOf(draft)]]);
        assert.equal((await blocksOf(ctx, 'A')).a1.content, 'alpha');
      });

      it("#144's U4: blocks the closing write stored but not its name, over a note saved since, make one rename-only recovered note holding no block", async () => {
        // The pop-out's closing write stored c1's edit and left the record's old name, and the
        // main pane saved after the pop-out's base, so the residue is the name alone
        await profileOf(ctx, { a: { updatedAt: T0 + 70 }, blocks: [block('c1', 'A', 2, 'charlie, edited in the pop-out')] });
        const draft = legacyDraft({
          blocks: [block('c1', 'A', 2, 'charlie, edited in the pop-out', { updatedAt: T0 + 9 })],
          name: 'Alpha plan, renamed',
          titleOrigin: 'typed',
        });
        const recoveredId = recoveredIdOf(draft);
        assert.deepEqual(said(await apply(ctx, draft)), ['close-draft-recovered', [recoveredId]]);
        const copies = Object.values(await blocksOf(ctx, recoveredId));
        assert.deepEqual(copies.map(row => row.type), ['callout'], 'only the callout: no repeat of c1');
        assert.equal(
          copies[0].content,
          'A tab that closed on Oct 31, 2026 at 9:41 PM renamed “Alpha plan” to “Alpha plan, renamed” before the new name was saved.'
            + ' That note was saved elsewhere too, so NewTabNote kept the new name here and left it as it is.'
            + ' To use the new name, rename that note, then delete this one.',
        );
      });

      it('drops one whose only change is an AI title, over a note saved elsewhere since', async () => {
        await profileOf(ctx, { a: { updatedAt: T0 + 70 } });
        const draft = legacyDraft({ blocks: [], name: 'An AI title', titleOrigin: 'generated' });
        assert.deepEqual(said(await apply(ctx, draft)), ['close-draft-dropped', []]);
        assert.equal((await recordOf(ctx, 'notes', 'A')).record?.name, 'Alpha plan');
      });

      it('never lets a generated title replace one set by hand: the rest of the draft saves', async () => {
        await profileOf(ctx, { a: { titleManuallySet: true } });
        const outcome = await apply(ctx, legacyDraft({ name: 'An AI title', titleOrigin: 'generated' }));
        assert.deepEqual(said(outcome), ['close-draft-saved', ['A']]);
        const { record } = await recordOf(ctx, 'notes', 'A');
        assert.deepEqual([record?.name, (await blocksOf(ctx, 'A')).a1.content], ['Alpha plan', 'alpha, edited as the tab closed']);
      });
    });

    describe('every draft', () => {
      it('is dropped with nothing written when its edit is already in, the revision and updatedAt as they were', async () => {
        await profileOf(ctx, { blocks: [] });
        const draft = stackDraft({ blocks: [block('a1', 'A', 0, 'alpha', { updatedAt: T0 + 5 })], deletedBlockIds: ['gone-since'] });
        const before = await recordOf(ctx, 'notes', 'A');
        assert.deepEqual(said(await apply(ctx, draft)), ['close-draft-dropped', []]);
        assert.deepEqual(await recordOf(ctx, 'notes', 'A'), before);
      });

      it("catches the record up with its blocks when a delete committed alone, moving no revision and keeping updatedAt (3.1 (a))", async () => {
        // The editor's delete of a2 committed as its own command, and the page went before its save
        await profileOf(ctx, { a: { preview: 'alpha alpha two, deleted since', todoProgress: { completed: 0, total: 1 } } });
        const removed = await ctx.kernel.execute({ type: 'deleteBlocks', commandId: ctx.ids.next(), noteId: 'A', blockIds: ['a2'] });
        assert.equal(removed.kind, 'committed');
        const before = await recordOf(ctx, 'notes', 'A');
        const draft = stackDraft({ blocks: [], deletedBlockIds: ['a2'] });
        assert.deepEqual(said(await apply(ctx, draft)), ['close-draft-caught-up', ['A']]);
        const after = await recordOf(ctx, 'notes', 'A');
        assert.deepEqual([after.record?.preview, after.record?.todoProgress], ['alpha', null]);
        assert.deepEqual(
          [after.record?.updatedAt, after.versions?.revision],
          [before.record?.updatedAt, before.versions?.revision],
          'its revision and updatedAt as they were',
        );
      });

      it('is gone, writing nothing, when its note was deleted for good', async () => {
        await profileOf(ctx);
        const draft = stackDraft({ noteId: 'Z' });
        assert.deepEqual(said(await apply(ctx, draft)), ['close-draft-gone', []]);
        assert.equal((await recordOf(ctx, 'notes', recoveredIdOf(draft))).record, undefined);
      });

      it("rule 0: finds the recovered note an earlier start made and makes no second one, 1.4.3's included", async () => {
        await profileOf(ctx, { a: { updatedAt: T0 + 70 } });
        const draft = legacyDraft();
        const recoveredId = recoveredIdOf(draft);
        await seed(ctx, 'notes', [note(recoveredId, { name: 'Recovered: Alpha plan (an earlier start)' })]);
        assert.deepEqual(said(await apply(ctx, draft)), ['close-draft-recovered', []]);
        assert.equal((await recordOf(ctx, 'notes', recoveredId)).record?.name, 'Recovered: Alpha plan (an earlier start)');
        assert.deepEqual(await blocksOf(ctx, recoveredId), {});
      });

      it('holding a block another note holds, becomes a recovered note, and both notes stay as they were', async () => {
        await profileOf(ctx);
        const draft = stackDraft({ blocks: [block('b1', 'A', 3, 'bravo, edited in A')] });
        const recoveredId = recoveredIdOf(draft);
        assert.deepEqual(said(await apply(ctx, draft)), ['close-draft-recovered', [recoveredId]]);
        const b1 = (await recordOf(ctx, 'blocks', 'b1')).record;
        assert.deepEqual([b1?.canvasId, b1?.content], ['B', 'bravo']);
        assert.deepEqual(Object.keys(await blocksOf(ctx, 'A')).sort(), ['a1', 'a2']);
        assert.ok(Object.values(await blocksOf(ctx, recoveredId)).some(row => row.content === 'bravo, edited in A'));
      });

      it("holding a block no note holds, becomes a recovered note, by the kernel's rule (the lead's Q6)", async () => {
        await profileOf(ctx, { blocks: [block('x1', undefined, 5, 'an orphan')] });
        const draft = stackDraft({ blocks: [block('x1', 'A', 2, 'an orphan, edited in A')] });
        assert.deepEqual(said(await apply(ctx, draft)), ['close-draft-recovered', [recoveredIdOf(draft)]]);
        const x1 = (await recordOf(ctx, 'blocks', 'x1')).record;
        assert.deepEqual([x1?.canvasId, x1?.content], [undefined, 'an orphan']);
      });

      it("deletes none of another note's blocks when a saved draft lists one among its deletes", async () => {
        await profileOf(ctx);
        assert.deepEqual(said(await apply(ctx, stackDraft({ deletedBlockIds: ['b1'] }))), ['close-draft-saved', ['A']]);
        const b1 = (await recordOf(ctx, 'blocks', 'b1')).record;
        assert.deepEqual([b1?.canvasId, b1?.content], ['B', 'bravo']);
      });

      it('sent again under its commandId, replays its outcome and writes nothing again', async () => {
        await profileOf(ctx);
        const draft = stackDraft();
        const first = await apply(ctx, draft);
        ctx.clock.advance(1000);
        const after = await recordOf(ctx, 'notes', 'A');
        assert.deepEqual(await apply(ctx, draft), first);
        assert.deepEqual(await recordOf(ctx, 'notes', 'A'), after);
      });

      it('is refused, writing nothing, when it is no draft this build applies', async () => {
        await profileOf(ctx);
        const outcome = await apply(ctx, /** @type {CloseDraft} */ (/** @type {unknown} */ ({ ...stackDraft(), v: 2 })));
        assert.deepEqual([outcome.kind, outcome.code], ['rejected', 'invalid-command']);
      });
    });
  });
}

describe('applyCloseDraft below version 10, where no ledger keeps a commit', () => {
  it('content first finds the work done when the page went before removing the draft: the resend writes nothing', async () => {
    const of = profile();
    await legacyEnv.createDatabase(of.real, {
      records: {
        canvases: [note('A', { name: 'Alpha plan' })],
        elements: [block('a1', 'A', 0, 'alpha'), block('a2', 'A', 1, 'alpha two')],
      },
    });
    const clock = testClock();
    const adapter = adapterOn(of, { mode: 'existing', clock });
    await adapter.open();
    const kernel = kernelOn(adapter, { ids: testIds(), clock });
    try {
      const draft = legacyDraft();
      const send = () => kernel.execute(/** @type {Command} */ ({ type: 'applyCloseDraft', commandId: `${draft.id}-apply`, draft }));
      assert.deepEqual(said(await send()), ['close-draft-saved', ['A']]);
      clock.advance(1000);
      assert.deepEqual(said(await send()), ['close-draft-dropped', []]);
      const [stored] = await adapter.read(['notes'], tx => tx.getAll('notes'));
      assert.equal(stored.updatedAt, NOW, 'written once');
    } finally {
      closeAll(of);
    }
  });
});
