// The kernel's use-case contract suite (#12, "Test plan"). It runs every use case through a
// kernel over one adapter, and any adapter can run it: memory.test.mjs runs it on the
// in-memory adapter, and #17 adds its IndexedDB adapter. Where an adapter flag changes
// what a command does, the suite expects the documented difference for the fixture's flags.

import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { COMMAND_TYPES, newCommand } from '../../js/kernel/core/contracts/commands.js';
import { CALLERS, NOW } from './support.mjs';

/** @typedef {import('./support.mjs').ContractFixture} ContractFixture */
/** @typedef {import('./support.mjs').ContractContext} ContractContext */
/** @typedef {import('../../js/kernel/core/application/kernel.js').Kernel} Kernel */
/** @typedef {import('../../js/kernel/core/contracts/commands.js').Command} Command */
/** @typedef {import('../../js/kernel/core/contracts/commands.js').CommandType} CommandType */
/** @typedef {import('../../js/kernel/core/contracts/outcomes.js').Outcome} Outcome */
/** @typedef {import('../../js/kernel/core/contracts/outcomes.js').BulkOutcome} BulkOutcome */
/** @typedef {import('../../js/kernel/core/contracts/outcomes.js').Committed} Committed */
/** @typedef {import('../../js/kernel/core/contracts/outcomes.js').Rejected} Rejected */
/** @typedef {import('../../js/kernel/core/domain/note.js').NoteRecord} NoteRecord */
/** @typedef {import('../../js/kernel/core/domain/note.js').BlockRecord} BlockRecord */
/** @typedef {import('../../js/kernel/core/domain/note.js').NoteView} NoteView */
/** @typedef {import('../../js/kernel/core/domain/folder.js').FolderRecord} FolderRecord */
/** @typedef {import('../../js/kernel/core/application/feed.js').CommitEvent} CommitEvent */

/**
 * @template {CommandType} T
 * @typedef {import('../../js/kernel/core/contracts/commands.js').CommandOf<T>} CommandOf
 */

/**
 * @param {Outcome | BulkOutcome} outcome
 * @returns {Committed}
 */
function committedOf(outcome) {
  assert.equal(outcome.kind, 'committed', JSON.stringify(outcome));
  return /** @type {Committed} */ (outcome);
}

/**
 * @param {Outcome | BulkOutcome} outcome
 * @param {Rejected['reason']} reason
 * @param {string} code
 */
function assertRejected(outcome, reason, code) {
  assert.equal(outcome.kind, 'rejected', JSON.stringify(outcome));
  const { reason: actualReason, code: actualCode } = /** @type {Rejected} */ (outcome);
  assert.deepEqual({ reason: actualReason, code: actualCode }, { reason, code });
}

/**
 * @param {Outcome | BulkOutcome} outcome
 * @returns {BulkOutcome}
 */
function bulkOf(outcome) {
  assert.equal(outcome.kind, 'bulk', JSON.stringify(outcome));
  return /** @type {BulkOutcome} */ (outcome);
}

/**
 * The note Storage.createNote writes (js/storage.js), written out here so a change to the
 * kernel's own copy of it fails the suite.
 * @param {string} id
 * @param {string} name
 * @param {number} now
 * @returns {NoteRecord}
 */
const storageNote = (id, name, now) => ({
  id,
  name,
  createdAt: now,
  updatedAt: now,
  archived: false,
  archivedAt: null,
  titleManuallySet: false,
  lastAutoTitleAt: null,
  insights: null,
  lastInsightsExtractedAt: null,
  preview: '',
  pinned: false,
  todoProgress: null,
  isDaily: false,
  dateStr: null,
  isTemplate: false,
  folderId: null,
  viewport: { scale: 1, offsetX: 0, offsetY: 0 },
  settings: { gridType: 'dots', backgroundColor: '#fafafa' },
});

/** The preferences Storage.initializeDefaultSettings writes on first run (js/storage.js) */
const STORAGE_DEFAULT_PREFERENCES = Object.freeze({
  theme: 'system',
  font: 'default',
  width: 'default',
  trashRetention: 30,
  sidebarOpen: true,
  sidebarWidth: 260,
  sidebarViewMode: 'list',
  autoTitleEnabled: false,
  autoTitleInterval: 15,
  insightsEnabled: false,
  insightsInterval: 360,
  aiSidebarWidth: 360,
});

/**
 * @param {ContractFixture} fixture
 */
export function runContractSuite(fixture) {
  const { flags } = fixture;

  describe(`kernel contract on the ${fixture.name} adapter`, () => {
    /** @type {ContractContext} */
    let ctx;
    /** @type {Kernel} */
    let kernel;

    beforeEach(async () => {
      ctx = await fixture.start();
      kernel = ctx.kernel();
    });
    afterEach(() => ctx.close());

    /**
     * @template {CommandType} T
     * @param {T} type
     * @param {Omit<CommandOf<T>, 'type' | 'commandId'>} fields
     * @returns {CommandOf<T>}
     */
    const cmd = (type, fields) => newCommand(ctx.ids, type, fields);

    /** @param {Command} command */
    const run = async command => committedOf(await kernel.execute(command));

    /**
     * @param {Partial<CommandOf<'createNote'>>} [fields]
     * @returns {Promise<string>}
     */
    const createNote = async (fields = {}) => {
      const noteId = fields.noteId || ctx.ids.next();
      await run(cmd('createNote', { ...fields, noteId }));
      return noteId;
    };

    /**
     * @param {string} noteId
     * @returns {Promise<NoteRecord | undefined>}
     */
    const noteOf = async noteId => {
      const state = await kernel.query({ type: 'getNote', noteId });
      return state.kind === 'ready' ? state.data.note : undefined;
    };

    /**
     * @param {string} noteId
     * @returns {Promise<BlockRecord[]>}
     */
    const blocksOf = async noteId => {
      const state = await kernel.query({ type: 'getNoteBlocks', noteId });
      return state.kind === 'ready' ? state.data : [];
    };

    /** @param {string} noteId */
    const searchEntryOf = noteId => ctx.adapter.read(['searchIndex'], tx => tx.get('searchIndex', noteId));

    /**
     * @param {NoteView} view
     * @returns {Promise<string[]>}
     */
    const idsIn = async view => {
      const state = await kernel.query({ type: 'listNotes', view });
      return state.kind === 'ready' ? state.data.map(note => note.id) : [];
    };

    /**
     * @param {string} noteId
     * @param {number} count
     * @returns {BlockRecord[]}
     */
    const someBlocks = (noteId, count) =>
      Array.from({ length: count }, (_, index) => ({
        id: `${noteId}-block-${index}`,
        type: 'text',
        content: `Line ${index}`,
        canvasId: noteId,
        order: index,
      }));

    describe('notes', () => {
      it('createNote stores the record Storage.createNote has always written, and a search entry', async () => {
        const outcome = await run(cmd('createNote', { noteId: 'n1' }));
        assert.deepEqual([outcome.code, outcome.changedIds], ['note-created', ['n1']]);
        assert.deepEqual(await noteOf('n1'), storageNote('n1', 'Untitled', NOW));
        assert.deepEqual(await searchEntryOf('n1'), { noteId: 'n1', name: 'Untitled', content: '', updatedAt: NOW });
      });

      it('createNote files the note in a folder and stores its first blocks', async () => {
        await run(cmd('createFolder', { folderId: 'f1', name: 'Work', parentId: null }));
        await run(cmd('createNote', { noteId: 'n1', name: 'Plan', folderId: 'f1', blocks: someBlocks('n1', 2) }));
        assert.equal((await noteOf('n1'))?.folderId, 'f1');
        assert.deepEqual(
          (await blocksOf('n1')).map(block => block.id),
          ['n1-block-0', 'n1-block-1'],
        );
      });

      it("createNote into a folder that doesn't exist, or with a note's id, is rejected and writes nothing", async () => {
        assertRejected(
          await kernel.execute(cmd('createNote', { noteId: 'n1', folderId: 'nowhere' })),
          'not-found',
          'folder-not-found',
        );
        assert.equal(await noteOf('n1'), undefined);
        await createNote({ noteId: 'n2', name: 'First' });
        assertRejected(
          await kernel.execute(cmd('createNote', { noteId: 'n2', name: 'Second' })),
          'validation',
          'note-exists',
        );
        assert.equal((await noteOf('n2'))?.name, 'First');
      });

      it('renameNote marks a typed title as set by hand only when it changes, and the search entry follows', async () => {
        await createNote({ noteId: 'n1', name: 'Draft' });
        ctx.clock.advance();
        await run(cmd('renameNote', { noteId: 'n1', name: 'Draft' }));
        assert.equal((await noteOf('n1'))?.titleManuallySet, false);
        await run(cmd('renameNote', { noteId: 'n1', name: 'Plan' }));
        const renamed = await noteOf('n1');
        assert.deepEqual([renamed?.name, renamed?.titleManuallySet, renamed?.updatedAt], ['Plan', true, NOW + 1000]);
        assert.deepEqual(await searchEntryOf('n1'), { noteId: 'n1', name: 'Plan', content: '', updatedAt: NOW + 1000 });
      });

      it('renameNote with a generated title records lastAutoTitleAt and leaves titleManuallySet alone', async () => {
        await createNote({ noteId: 'n1' });
        ctx.clock.advance();
        await run(cmd('renameNote', { noteId: 'n1', name: 'Summary', origin: 'generated' }));
        const note = await noteOf('n1');
        assert.deepEqual([note?.name, note?.titleManuallySet, note?.lastAutoTitleAt], ['Summary', false, NOW + 1000]);
      });

      it('archive, unarchive, trash, and restore set their fields, and trashing takes a note out of the archive', async () => {
        await createNote({ noteId: 'n1', name: 'Keep' });
        ctx.clock.advance();
        await run(cmd('archiveNote', { noteId: 'n1' }));
        assert.deepEqual(await idsIn('archived'), ['n1']);
        await run(cmd('trashNote', { noteId: 'n1' }));
        const trashed = await noteOf('n1');
        assert.deepEqual(
          [trashed?.trashed, trashed?.trashedAt, trashed?.archived, trashed?.archivedAt],
          [true, NOW + 1000, false, null],
        );
        assert.deepEqual([await idsIn('archived'), await idsIn('trashed')], [[], ['n1']]);
        await run(cmd('restoreNote', { noteId: 'n1' }));
        assert.deepEqual(await idsIn('active'), ['n1']);
        await run(cmd('archiveNote', { noteId: 'n1' }));
        await run(cmd('unarchiveNote', { noteId: 'n1' }));
        const back = await noteOf('n1');
        assert.deepEqual([back?.archived, back?.archivedAt, back?.trashed], [false, null, false]);
      });

      it('trashNote deletes an untitled note with nothing in it, blocks included, and trashes one with content', async () => {
        await createNote({ noteId: 'empty', blocks: [{ id: 'b0', type: 'text', content: '<p> </p>' }] });
        await createNote({ noteId: 'written', blocks: [{ id: 'b1', type: 'text', content: '<p>Milk</p>' }] });
        assert.deepEqual((await run(cmd('trashNote', { noteId: 'empty' }))).code, 'note-deleted');
        assert.deepEqual([await noteOf('empty'), await blocksOf('empty')], [undefined, []]);
        assert.deepEqual((await run(cmd('trashNote', { noteId: 'written' }))).code, 'note-trashed');
        assert.equal((await noteOf('written'))?.trashed, true);
        assert.equal((await blocksOf('written')).length, 1);
      });

      it("commands on a note that doesn't exist are rejected with not-found", async () => {
        for (const command of [
          cmd('renameNote', { noteId: 'gone', name: 'X' }),
          cmd('setPinned', { noteId: 'gone', pinned: true }),
          cmd('archiveNote', { noteId: 'gone' }),
          cmd('trashNote', { noteId: 'gone' }),
          cmd('applyDerivedTitle', { noteId: 'gone', name: 'X' }),
          cmd('attachInsights', { noteId: 'gone', insights: { todos: [] } }),
        ]) {
          assertRejected(await kernel.execute(command), 'not-found', 'note-not-found');
        }
        assert.equal(await searchEntryOf('gone'), undefined);
      });
    });

    describe('saveNoteContent', () => {
      it('writes the blocks, the preview, todoProgress, and updatedAt, and no other field', async () => {
        await createNote({ noteId: 'n1', name: 'Plan' });
        await run(cmd('archiveNote', { noteId: 'n1' }));
        const before = await noteOf('n1');
        ctx.clock.advance();
        const outcome = await run(
          cmd('saveNoteContent', {
            noteId: 'n1',
            blocks: someBlocks('n1', 2),
            preview: 'Line 0',
            todoProgress: { done: 1, total: 2 },
          }),
        );
        assert.deepEqual([outcome.code, outcome.changedIds], ['content-saved', ['n1']]);
        assert.deepEqual(await noteOf('n1'), {
          ...before,
          preview: 'Line 0',
          todoProgress: { done: 1, total: 2 },
          updatedAt: NOW + 1000,
        });
        assert.deepEqual(await blocksOf('n1'), someBlocks('n1', 2));
      });

      it('puts the blocks it carries and deletes none, so a block another writer added stays', async () => {
        await createNote({ noteId: 'n1', blocks: someBlocks('n1', 2) });
        await run(cmd('saveNoteContent', { noteId: 'n1', blocks: [{ ...someBlocks('n1', 1)[0], content: 'Edited' }] }));
        assert.deepEqual(
          (await blocksOf('n1')).map(block => [block.id, block.content]),
          [
            ['n1-block-0', 'Edited'],
            ['n1-block-1', 'Line 1'],
          ],
        );
      });

      it('for a note deleted since the editor loaded it writes nothing, blocks included', async () => {
        assertRejected(
          await kernel.execute(cmd('saveNoteContent', { noteId: 'gone', blocks: someBlocks('gone', 1) })),
          'not-found',
          'note-not-found',
        );
        assert.deepEqual([await noteOf('gone'), await blocksOf('gone')], [undefined, []]);
      });

      it('commits the note fields and the blocks together on every adapter', async () => {
        await createNote({ noteId: 'n1', blocks: someBlocks('n1', 1) });
        const before = await noteOf('n1');
        ctx.failNextWrite('blocks');
        const outcome = await kernel.execute(
          cmd('saveNoteContent', { noteId: 'n1', blocks: someBlocks('n1', 3), preview: 'New' }),
        );
        assert.equal(outcome.kind, 'unavailable', JSON.stringify(outcome));
        assert.deepEqual(await noteOf('n1'), before);
        assert.equal((await blocksOf('n1')).length, 1);
      });

      it('refuses a block of another note and two blocks with one id', async () => {
        await createNote({ noteId: 'n1' });
        assertRejected(
          await kernel.execute(cmd('saveNoteContent', { noteId: 'n1', blocks: someBlocks('n2', 1) })),
          'validation',
          'block-of-another-note',
        );
        const [block] = someBlocks('n1', 1);
        assertRejected(
          await kernel.execute(cmd('saveNoteContent', { noteId: 'n1', blocks: [block, block] })),
          'validation',
          'duplicate-block',
        );
        assert.deepEqual(await blocksOf('n1'), []);
      });

      it('keeps the blocks as they were when the save started, whatever the caller does to them after', async () => {
        await createNote({ noteId: 'n1' });
        const blocks = someBlocks('n1', 1);
        const pending = kernel.execute(cmd('saveNoteContent', { noteId: 'n1', blocks }));
        blocks[0].content = 'Changed after the save started';
        committedOf(await pending);
        assert.equal((await blocksOf('n1'))[0].content, 'Line 0');
      });
    });

    describe('derived titles and insights', () => {
      it('applyDerivedTitle drops its title when the title was set by hand', async () => {
        await createNote({ noteId: 'n1', name: 'Untitled' });
        await run(cmd('renameNote', { noteId: 'n1', name: 'Mine' }));
        const before = await noteOf('n1');
        const outcome = await run(cmd('applyDerivedTitle', { noteId: 'n1', name: 'Derived' }));
        assert.deepEqual([outcome.code, outcome.changedIds, outcome.severity], ['title-kept', [], 'info']);
        assert.deepEqual(await noteOf('n1'), before);
        assert.equal((await searchEntryOf('n1'))?.name, 'Mine');
      });

      it('applyDerivedTitle sets the title, its time and content hash, and the search entry otherwise', async () => {
        await createNote({ noteId: 'n1' });
        ctx.clock.advance();
        await run(cmd('applyDerivedTitle', { noteId: 'n1', name: 'Groceries', contentHash: 'h1' }));
        const note = await noteOf('n1');
        assert.deepEqual(
          [note?.name, note?.lastAutoTitleAt, note?.lastTitleContentHash, note?.titleManuallySet],
          ['Groceries', NOW + 1000, 'h1', false],
        );
        assert.equal((await searchEntryOf('n1'))?.name, 'Groceries');
      });

      it('attachInsights writes the insight fields and nothing else, updatedAt included', async () => {
        await createNote({ noteId: 'n1', name: 'Plan' });
        const before = await noteOf('n1');
        ctx.clock.advance();
        await run(cmd('attachInsights', { noteId: 'n1', insights: { todos: ['Call'] }, contentHash: 'h2' }));
        assert.deepEqual(await noteOf('n1'), {
          ...before,
          insights: { todos: ['Call'] },
          lastInsightsExtractedAt: NOW + 1000,
          lastInsightsContentHash: 'h2',
        });
      });

      it('a derived title and insights that finish during editing lose none of the edits', async () => {
        await createNote({ noteId: 'n1' });
        // The jobs read the note, then the user types and pins it before the jobs commit
        const stale = await noteOf('n1');
        await run(cmd('saveNoteContent', { noteId: 'n1', blocks: someBlocks('n1', 1), preview: 'Typed' }));
        await run(cmd('setPinned', { noteId: 'n1', pinned: true }));
        await run(cmd('applyDerivedTitle', { noteId: 'n1', name: 'Derived', contentHash: 'h' }));
        await run(cmd('attachInsights', { noteId: 'n1', insights: { todos: [] } }));
        const note = await noteOf('n1');
        assert.equal(stale?.preview, '');
        assert.deepEqual(
          [note?.preview, note?.pinned, note?.name, note?.insights],
          ['Typed', true, 'Derived', { todos: [] }],
        );
        assert.equal((await blocksOf('n1')).length, 1);
      });

      it("pinning an open note survives the editor's next save", async () => {
        await createNote({ noteId: 'n1' });
        await run(cmd('setPinned', { noteId: 'n1', pinned: true }));
        await run(cmd('saveNoteContent', { noteId: 'n1', blocks: someBlocks('n1', 1), preview: 'Line 0' }));
        assert.equal((await noteOf('n1'))?.pinned, true);
      });

      /**
       * The revision the editor loaded the note at, as saveNoteContent sends it back
       * @param {string} noteId
       */
      const loadedRevision = async noteId => {
        const state = await kernel.query({ type: 'getNote', noteId });
        return (state.kind === 'ready' ? state.data.revision : undefined) ?? 1;
      };

      it("pinning an open note survives the editor's next save, sent with the revision it loaded", async () => {
        await createNote({ noteId: 'n1' });
        const expectedRevision = await loadedRevision('n1');
        await run(cmd('setPinned', { noteId: 'n1', pinned: true }));
        await run(cmd('archiveNote', { noteId: 'n1' }));
        const saved = await run(
          cmd('saveNoteContent', { noteId: 'n1', blocks: someBlocks('n1', 1), preview: 'Line 0', expectedRevision }),
        );
        assert.equal(saved.code, 'content-saved');
        const note = await noteOf('n1');
        assert.deepEqual([note?.pinned, note?.archived, note?.preview], [true, true, 'Line 0']);
      });

      it("insights that finish during editing don't stop the editor's save, sent with the revision it loaded", async () => {
        await createNote({ noteId: 'n1' });
        const expectedRevision = await loadedRevision('n1');
        await run(cmd('attachInsights', { noteId: 'n1', insights: { todos: ['Call'] } }));
        const saved = await run(
          cmd('saveNoteContent', { noteId: 'n1', blocks: someBlocks('n1', 1), preview: 'Typed', expectedRevision }),
        );
        assert.equal(saved.code, 'content-saved');
        const note = await noteOf('n1');
        assert.deepEqual([note?.preview, note?.insights], ['Typed', { todos: ['Call'] }]);
      });
    });

    describe('captureToDailyNote', () => {
      const page = /** @type {const} */ ({ type: 'bookmark', url: 'https://example.test/page', title: 'Example page' });

      it("creates today's Daily Note with its search entry, then adds each capture to it", async () => {
        const worker = ctx.kernel(CALLERS['worker-internal']);
        const first = committedOf(
          await worker.execute(cmd('captureToDailyNote', { noteId: 'd1', blockId: 'c1', capture: page })),
        );
        assert.deepEqual([first.code, first.changedIds], ['capture-saved', ['d1']]);
        const daily = await noteOf('d1');
        assert.deepEqual(
          [daily?.isDaily, daily?.dateStr, daily?.name],
          [true, '2026-10-20', 'Daily Note - Oct 20, 2026'],
        );
        assert.deepEqual(await searchEntryOf('d1'), {
          noteId: 'd1',
          name: 'Daily Note - Oct 20, 2026',
          content: '',
          updatedAt: NOW,
        });

        const text = /** @type {const} */ ({ type: 'text', content: 'A quote', source: 'https://example.test/a' });
        const second = committedOf(
          await worker.execute(cmd('captureToDailyNote', { noteId: 'd2', blockId: 'c2', capture: text })),
        );
        assert.deepEqual(second.changedIds, ['d1']);
        assert.equal(await noteOf('d2'), undefined);
        assert.deepEqual(
          (await blocksOf('d1')).map(({ id, type, content, url, title }) => ({ id, type, content, url, title })),
          [
            { id: 'c1', type: 'bookmark', content: '', url: page.url, title: page.title },
            {
              id: 'c2',
              type: 'text',
              content: 'A quote (Source: https://example.test/a)',
              url: undefined,
              title: undefined,
            },
          ],
        );
      });

      it('starts a new Daily Note from the Daily Note template, and an archived one still counts', async () => {
        await createNote({
          noteId: 'tpl',
          name: 'Template',
          blocks: [{ id: 't1', type: 'text', content: 'Notes for {{title}}', order: 0 }],
        });
        await run(cmd('setPreferences', { values: { dailyNoteTemplate: 'tpl' } }));
        const worker = ctx.kernel(CALLERS['worker-internal']);
        committedOf(await worker.execute(cmd('captureToDailyNote', { noteId: 'd1', blockId: 'c1', capture: page })));
        const contents = (await blocksOf('d1')).map(block => block.content);
        assert.ok(contents.includes('Notes for Daily Note - Oct 20, 2026'), JSON.stringify(contents));
        assert.equal(contents.length, 2);

        await run(cmd('archiveNote', { noteId: 'd1' }));
        committedOf(await worker.execute(cmd('captureToDailyNote', { noteId: 'd2', blockId: 'c2', capture: page })));
        assert.deepEqual([await noteOf('d2'), (await blocksOf('d1')).length], [undefined, 3]);
      });

      it("doesn't reuse a trashed Daily Note, or one from another day", async () => {
        const worker = ctx.kernel(CALLERS['worker-internal']);
        committedOf(await worker.execute(cmd('captureToDailyNote', { noteId: 'd1', blockId: 'c1', capture: page })));
        ctx.clock.advance(24 * 60 * 60 * 1000);
        committedOf(await worker.execute(cmd('captureToDailyNote', { noteId: 'd2', blockId: 'c2', capture: page })));
        assert.equal((await noteOf('d2'))?.dateStr, '2026-10-21');
        await run(cmd('trashNote', { noteId: 'd2' }));
        const third = committedOf(
          await worker.execute(cmd('captureToDailyNote', { noteId: 'd3', blockId: 'c3', capture: page })),
        );
        assert.deepEqual(third.changedIds, ['d3']);
      });
    });

    describe('runBulkAction', () => {
      it('returns one outcome per note, in order, and counts only the committed ones', async () => {
        await createNote({ noteId: 'a', name: 'A' });
        await createNote({ noteId: 'b', name: 'B' });
        const result = bulkOf(
          await kernel.execute(cmd('runBulkAction', { action: 'archive', noteIds: ['a', 'gone', 'b', 'a'] })),
        );
        assert.deepEqual(
          result.items.map(({ id, outcome }) => [id, outcome.kind]),
          [
            ['a', 'committed'],
            ['gone', 'rejected'],
            ['b', 'committed'],
          ],
        );
        assert.deepEqual(
          [result.committedIds, result.code, result.severity, result.messageKey],
          [['a', 'b'], 'archive', 'warning', 'bulk.archive'],
        );
        assert.deepEqual(await idsIn('archived'), ['a', 'b']);
      });

      it('a bulk trash where one note fails trashes the others', async () => {
        await createNote({ noteId: 'a', name: 'A' });
        await createNote({ noteId: 'b', name: 'B' });
        await createNote({ noteId: 'c', name: 'C' });
        ctx.failNextWrite('notes');
        const result = bulkOf(
          await kernel.execute(cmd('runBulkAction', { action: 'trash', noteIds: ['a', 'b', 'c'] })),
        );
        assert.deepEqual(
          result.items.map(({ outcome }) => outcome.kind),
          ['unavailable', 'committed', 'committed'],
        );
        assert.deepEqual(result.committedIds, ['b', 'c']);
        assert.deepEqual([await idsIn('trashed'), await idsIn('active')], [['b', 'c'], ['a']]);
      });

      it('a bulk action reaches every listener on the commit feed, so a second list sees it too', async () => {
        await createNote({ noteId: 'a', name: 'A' });
        await createNote({ noteId: 'b', name: 'B' });
        /** @type {string[][]} */
        const palette = [];
        kernel.subscribe(event => {
          if (event.aggregate === 'note') palette.push([...event.ids]);
        });
        await kernel.execute(cmd('runBulkAction', { action: 'archive', noteIds: ['a', 'b'] }));
        assert.deepEqual(palette, [['a'], ['b']]);
        assert.deepEqual(await idsIn('active'), []);
      });
    });

    describe('folders', () => {
      /**
       * @param {string} folderId
       * @param {string | null} parentId
       */
      const folder = (folderId, parentId) => run(cmd('createFolder', { folderId, name: folderId, parentId }));

      it('createFolder stores the record Storage.createFolder writes, under a parent that exists', async () => {
        await folder('a', null);
        const state = await kernel.query({ type: 'listFolders' });
        assert.equal(state.kind, 'ready');
        assert.deepEqual(state.kind === 'ready' && state.data, [
          { id: 'a', name: 'a', parentId: null, createdAt: NOW, updatedAt: NOW, color: null, collapsed: false },
        ]);
        assertRejected(
          await kernel.execute(cmd('createFolder', { folderId: 'b', name: 'b', parentId: 'nowhere' })),
          'not-found',
          'parent-not-found',
        );
        assertRejected(
          await kernel.execute(cmd('createFolder', { folderId: 'a', name: 'again', parentId: null })),
          'validation',
          'folder-exists',
        );
      });

      it('moveFolder rejects a move into the folder itself or anything inside it', async () => {
        await folder('a', null);
        await folder('b', 'a');
        await folder('c', 'b');
        for (const parentId of ['a', 'b', 'c']) {
          assertRejected(
            await kernel.execute(cmd('moveFolder', { folderId: 'a', parentId })),
            'validation',
            'folder-into-itself',
          );
        }
        assertRejected(
          await kernel.execute(cmd('moveFolder', { folderId: 'gone', parentId: null })),
          'not-found',
          'folder-not-found',
        );
        assertRejected(
          await kernel.execute(cmd('moveFolder', { folderId: 'c', parentId: 'gone' })),
          'not-found',
          'parent-not-found',
        );
        ctx.clock.advance();
        await run(cmd('moveFolder', { folderId: 'c', parentId: null }));
        await run(cmd('moveFolder', { folderId: 'a', parentId: 'c' }));
        const state = await kernel.query({ type: 'listFolders' });
        const parents = state.kind === 'ready' ? Object.fromEntries(state.data.map(f => [f.id, f.parentId])) : {};
        assert.deepEqual(parents, { a: 'c', b: 'a', c: null });
      });

      it('moveFolder checks the folders as committed, not the view the move came from', async () => {
        await folder('a', null);
        await folder('b', null);
        // A view loaded now still shows b at the root after another move puts b inside a
        const view = await kernel.query({ type: 'listFolders' });
        await run(cmd('moveFolder', { folderId: 'b', parentId: 'a' }));
        assert.equal(view.kind === 'ready' && view.data.find(f => f.id === 'b')?.parentId, null);
        assertRejected(
          await kernel.execute(cmd('moveFolder', { folderId: 'a', parentId: 'b' })),
          'validation',
          'folder-into-itself',
        );
      });
    });

    describe('preferences, session, and startup maintenance', () => {
      it('setPreferences stores known preferences and refuses any other key', async () => {
        const outcome = await run(cmd('setPreferences', { values: { theme: 'dark', sidebarWidth: 300 } }));
        assert.deepEqual(outcome.changedIds, ['theme', 'sidebarWidth']);
        const state = await kernel.query({ type: 'getPreferences', keys: ['theme', 'sidebarWidth', 'font'] });
        assert.deepEqual(state.kind === 'ready' && state.data, { theme: 'dark', sidebarWidth: 300 });
        assertRejected(
          await kernel.execute(cmd('setPreferences', { values: { llmApiKey: 'x' } })),
          'validation',
          'unknown-preference',
        );
        assert.equal((await kernel.query({ type: 'getPreferences', keys: ['llmApiKey'] })).kind, 'failed');
      });

      it('saveWorkspaceSession stores the keys it carries, checked by type', async () => {
        const session = { openTabs: [{ noteId: 'n1', name: 'Plan' }], activeTabIndex: 0, lastOpenedNoteId: 'n1' };
        await run(cmd('saveWorkspaceSession', { session }));
        const state = await kernel.query({ type: 'getWorkspaceSession' });
        assert.deepEqual(state.kind === 'ready' && state.data, session);
        assertRejected(
          await kernel.execute(
            cmd('saveWorkspaceSession', { session: /** @type {any} */ ({ activeTabIndex: 'first' }) }),
          ),
          'validation',
          'invalid-session',
        );
      });

      it('runStartupMaintenance writes the default preferences once and keeps what is stored', async () => {
        assert.equal((await kernel.query({ type: 'getPreferences' })).kind, 'empty');
        await run(cmd('runStartupMaintenance', {}));
        const defaults = await kernel.query({ type: 'getPreferences' });
        assert.deepEqual(defaults.kind === 'ready' && defaults.data, STORAGE_DEFAULT_PREFERENCES);
        await run(cmd('setPreferences', { values: { theme: 'dark' } }));
        committedOf(await ctx.kernel(CALLERS['worker-internal']).execute(cmd('runStartupMaintenance', {})));
        const theme = await kernel.query({ type: 'getPreferences', keys: ['theme'] });
        assert.deepEqual(theme.kind === 'ready' && theme.data, { theme: 'dark' });
      });
    });

    describe('queries', () => {
      it('lists each view in the order Storage lists it', async () => {
        await createNote({ noteId: 'old', name: 'Old' });
        ctx.clock.advance();
        await createNote({ noteId: 'new', name: 'New' });
        ctx.clock.advance();
        await createNote({ noteId: 'arch', name: 'Archived' });
        await run(cmd('archiveNote', { noteId: 'arch' }));
        assert.deepEqual(await idsIn('active'), ['new', 'old']);
        assert.deepEqual(await idsIn('withArchived'), ['arch', 'new', 'old']);
        assert.deepEqual(await idsIn('archived'), ['arch']);
        assert.deepEqual(await idsIn('trashed'), []);
        assert.equal((await kernel.query({ type: 'listNotes', view: 'trashed' })).kind, 'empty');
      });

      it('returns empty for a note with nothing stored, blocks in note order, and failed for a bad query', async () => {
        assert.deepEqual(await kernel.query({ type: 'getNote', noteId: 'gone' }), { kind: 'empty', asOf: NOW });
        const blocks = someBlocks('n1', 3).reverse();
        await createNote({ noteId: 'n1', blocks });
        assert.deepEqual(
          (await blocksOf('n1')).map(block => block.order),
          [0, 1, 2],
        );
        const bad = await kernel.query(/** @type {any} */ ({ type: 'listNotes', view: 'everything' }));
        assert.deepEqual(bad, { kind: 'failed', cause: 'validation', code: 'invalid-query' });
      });

      it("another context's kernel over the same storage sees a commit on its next read", async () => {
        await createNote({ noteId: 'n1', name: 'Shared' });
        const panel = ctx.kernel(CALLERS.sidepanel);
        const state = await panel.query({ type: 'listNotes', view: 'active' });
        assert.deepEqual(state.kind === 'ready' && state.data.map(note => note.name), ['Shared']);
      });
    });

    describe('policy', () => {
      it('lets Popup create a note and read, and rejects anything else from it before the adapter', async () => {
        const popup = ctx.kernel(CALLERS.popup);
        committedOf(await popup.execute(cmd('createNote', { noteId: 'quick', name: 'Quick' })));
        assert.equal((await popup.query({ type: 'listNotes', view: 'active' })).kind, 'ready');
        assertRejected(
          await popup.execute(cmd('renameNote', { noteId: 'quick', name: 'X' })),
          'policy',
          'not-on-surface',
        );
        assertRejected(await popup.execute(cmd('runStartupMaintenance', {})), 'policy', 'not-on-surface');
        assert.equal((await noteOf('quick'))?.name, 'Quick');
      });

      it('lets Side Panel read only, and the service worker capture and run maintenance only', async () => {
        const panel = ctx.kernel(CALLERS.sidepanel);
        assertRejected(await panel.execute(cmd('createNote', { noteId: 'n1' })), 'policy', 'not-on-surface');
        assert.equal(await noteOf('n1'), undefined);
        const worker = ctx.kernel(CALLERS['worker-internal']);
        assertRejected(await worker.execute(cmd('createNote', { noteId: 'n2' })), 'policy', 'not-on-surface');
        assert.deepEqual(await worker.query({ type: 'listNotes', view: 'active' }), {
          kind: 'failed',
          cause: 'policy',
          code: 'not-on-surface',
        });
      });

      it('lets the offscreen document and the recovery page run nothing until #13 and #35 add their entries', async () => {
        for (const caller of [CALLERS.offscreen, CALLERS.recovery]) {
          const other = ctx.kernel(caller);
          assertRejected(await other.execute(cmd('createNote', { noteId: 'n1' })), 'policy', 'not-on-surface');
          assert.deepEqual(await other.query({ type: 'listFolders' }), {
            kind: 'failed',
            cause: 'policy',
            code: 'not-on-surface',
          });
        }
        assert.equal(await noteOf('n1'), undefined);
      });

      it('rejects a command the catalog lacks, and a caller that is no surface', async () => {
        assertRejected(
          await kernel.execute(/** @type {any} */ ({ type: 'dropDatabase', commandId: 'x1' })),
          'policy',
          'unknown-command',
        );
        const stranger = ctx.kernel(/** @type {any} */ ({ surface: 'devtools', contextId: 'x' }));
        assertRejected(await stranger.execute(cmd('createNote', { noteId: 'n1' })), 'policy', 'unknown-caller');
        assert.equal(await noteOf('n1'), undefined);
      });

      it('ignores a surface a payload claims', async () => {
        const popup = ctx.kernel(CALLERS.popup);
        const claim = /** @type {any} */ ({
          ...cmd('trashNote', { noteId: 'n1' }),
          caller: CALLERS.newtab,
          surface: 'newtab',
        });
        assertRejected(await popup.execute(claim), 'policy', 'not-on-surface');
      });
    });

    describe('outcomes and the commit feed', () => {
      it('publishes {aggregate, ids} after each commit, and nothing for a rejection or a change of nothing', async () => {
        /** @type {Array<{event: CommitEvent, name: unknown}>} */
        const seen = [];
        kernel.subscribe(async event => {
          const [id] = event.ids;
          seen.push({ event, name: (await noteOf(id))?.name });
        });
        await createNote({ noteId: 'n1', name: 'First' });
        await kernel.execute(cmd('renameNote', { noteId: 'gone', name: 'X' }));
        await run(cmd('renameNote', { noteId: 'n1', name: 'Mine' }));
        await run(cmd('applyDerivedTitle', { noteId: 'n1', name: 'Derived' }));
        await run(cmd('setPreferences', { values: { theme: 'dark' } }));
        await new Promise(resolve => setImmediate(resolve));
        assert.deepEqual(
          seen.map(({ event }) => ({ ...event, ids: [...event.ids] })),
          [
            { aggregate: 'note', ids: ['n1'] },
            { aggregate: 'note', ids: ['n1'] },
            { aggregate: 'preferences', ids: ['theme'] },
          ],
        );
        // A listener reads the committed state
        assert.deepEqual(seen.map(({ name }) => name).slice(0, 2), ['First', 'Mine']);
        assert.deepEqual(Object.keys(seen[0].event), ['aggregate', 'ids']);
      });

      it('a listener that throws or rejects changes no outcome, and the others still hear the commit', async () => {
        /** @type {string[]} */
        const heard = [];
        kernel.subscribe(() => {
          throw new Error('listener bug');
        });
        kernel.subscribe(() => Promise.reject(new Error('async listener bug')));
        kernel.subscribe(event => {
          heard.push(event.aggregate);
        });
        await createNote({ noteId: 'n1' });
        assert.deepEqual(heard, ['note']);
      });

      it('outcomes carry codes, ids, a messageKey, and a severity, and no content', async () => {
        const secret = 'Secret title';
        const url = 'https://private.example.test/path';
        /** @type {Array<Outcome | BulkOutcome>} */
        const outcomes = [
          await kernel.execute(
            cmd('createNote', { noteId: 'n1', name: secret, blocks: [{ id: 'b1', type: 'text', content: secret }] }),
          ),
          await kernel.execute(cmd('renameNote', { noteId: 'n1', name: secret })),
          await kernel.execute(
            cmd('saveNoteContent', { noteId: 'n1', blocks: [{ id: 'b1', content: secret }], preview: secret }),
          ),
          await ctx.kernel(CALLERS['worker-internal']).execute(
            cmd('captureToDailyNote', {
              noteId: 'd1',
              blockId: 'c1',
              capture: { type: 'bookmark', url, title: secret },
            }),
          ),
          await kernel.execute(cmd('saveNoteContent', { noteId: 'gone', blocks: [{ id: 'b2', content: secret }] })),
          await kernel.execute(cmd('runBulkAction', { action: 'trash', noteIds: ['n1', 'gone'] })),
        ];
        for (const outcome of outcomes) {
          assert.ok(outcome.messageKey && outcome.severity && outcome.code, JSON.stringify(outcome));
          const text = JSON.stringify(outcome);
          assert.ok(!text.includes(secret) && !text.includes(url), text);
        }
      });

      it('refuses a payload that structured clone would refuse', async () => {
        const command = /** @type {any} */ (cmd('createNote', { noteId: 'n1' }));
        command.name = () => 'not data';
        assertRejected(await kernel.execute(command), 'validation', 'not-cloneable');
        assert.equal(await noteOf('n1'), undefined);
      });

      it('every catalog command is one this suite runs', () => {
        assert.deepEqual([...COMMAND_TYPES].sort(), [
          'applyDerivedTitle',
          'archiveNote',
          'attachInsights',
          'captureToDailyNote',
          'createFolder',
          'createNote',
          'moveFolder',
          'renameNote',
          'restoreNote',
          'runBulkAction',
          'runStartupMaintenance',
          'saveNoteContent',
          'saveWorkspaceSession',
          'setPinned',
          'setPreferences',
          'trashNote',
          'unarchiveNote',
        ]);
      });
    });

    describe(`adapter flags: ${JSON.stringify(flags)}`, () => {
      it('the adapter reports the flags its fixture documents', () => {
        assert.deepEqual({ ...kernel.flags }, { ...flags });
      });

      it(
        flags.revisions
          ? 'revisions: committed outcomes report the revision, and a stale expectedRevision is a conflict that writes nothing'
          : 'no revisions: outcomes carry none, and a stale expectedRevision is saved over (the last write wins)',
        async () => {
          const created = await run(cmd('createNote', { noteId: 'n1' }));
          const loaded = await kernel.query({ type: 'getNote', noteId: 'n1' });
          const revision = loaded.kind === 'ready' ? loaded.data.revision : undefined;
          await run(cmd('saveNoteContent', { noteId: 'n1', blocks: someBlocks('n1', 1), preview: 'Tab A' }));
          const stale = cmd('saveNoteContent', {
            noteId: 'n1',
            blocks: someBlocks('n1', 2),
            preview: 'Tab B',
            expectedRevision: revision ?? 1,
          });
          const outcome = await kernel.execute(stale);
          if (flags.revisions) {
            assert.equal(typeof created.revision, 'number');
            assert.equal(revision, created.revision);
            assert.equal(outcome.kind, 'conflict', JSON.stringify(outcome));
            assert.equal(outcome.kind === 'conflict' && outcome.currentRevision, /** @type {number} */ (revision) + 1);
            assert.ok(!JSON.stringify(outcome).includes('Tab B'));
            assert.equal((await noteOf('n1'))?.preview, 'Tab A');
            assert.equal((await blocksOf('n1')).length, 1);
            assert.ok(ctx.conflicts, 'a fixture for an adapter with revisions reads the conflicts it kept');
            assert.deepEqual(
              (await ctx.conflicts()).map(kept => kept.commandId),
              [stale.commandId],
            );
          } else {
            assert.equal(created.revision, undefined);
            assert.equal(revision, undefined);
            committedOf(outcome);
            assert.equal((await noteOf('n1'))?.preview, 'Tab B');
          }
        },
      );

      it(
        flags.revisions
          ? "revisions: only a change to a note's title or blocks moves its revision, and every committed outcome reports it"
          : 'no revisions: no committed outcome reports one',
        async () => {
          /** @param {Command} command */
          const revisionAfter = async command => (await run(command)).revision;
          const revisions = [
            await revisionAfter(cmd('createNote', { noteId: 'n1' })),
            await revisionAfter(cmd('setPinned', { noteId: 'n1', pinned: true })),
            await revisionAfter(cmd('archiveNote', { noteId: 'n1' })),
            await revisionAfter(cmd('unarchiveNote', { noteId: 'n1' })),
            await revisionAfter(cmd('attachInsights', { noteId: 'n1', insights: { todos: [] } })),
            await revisionAfter(cmd('applyDerivedTitle', { noteId: 'n1', name: 'Derived' })),
            await revisionAfter(cmd('renameNote', { noteId: 'n1', name: 'Mine' })),
            // Kept: the title was set by hand, so nothing changed
            await revisionAfter(cmd('applyDerivedTitle', { noteId: 'n1', name: 'Derived again' })),
            await revisionAfter(cmd('saveNoteContent', { noteId: 'n1', blocks: someBlocks('n1', 1) })),
            await revisionAfter(cmd('trashNote', { noteId: 'n1' })),
            await revisionAfter(cmd('restoreNote', { noteId: 'n1' })),
          ];
          const expected = flags.revisions ? [1, 1, 1, 1, 1, 2, 3, 3, 4, 4, 4] : revisions.map(() => undefined);
          assert.deepEqual(revisions, expected);
          // A note deleted and made again under its id starts over
          await revisionAfter(cmd('createNote', { noteId: 'n2' }));
          assert.equal((await run(cmd('trashNote', { noteId: 'n2' }))).code, 'note-deleted');
          assert.equal(await revisionAfter(cmd('createNote', { noteId: 'n2' })), flags.revisions ? 1 : undefined);
        },
      );

      it(
        flags.idempotency
          ? 'idempotency: a commandId sent again with another command is rejected as key reuse, and nothing runs'
          : 'no idempotency: a commandId sent again with another command runs that command',
        async () => {
          const create = cmd('createNote', { noteId: 'n1', name: 'Kept' });
          await run(create);
          const before = await noteOf('n1');
          const sameKey = /** @type {Command[]} */ ([
            { type: 'createNote', commandId: create.commandId, noteId: 'n2', name: 'Other' },
            { type: 'trashNote', commandId: create.commandId, noteId: 'n1' },
          ]);
          const outcomes = [];
          for (const command of sameKey) outcomes.push(await kernel.execute(command));
          if (flags.idempotency) {
            for (const outcome of outcomes) assertRejected(outcome, 'validation', 'idempotency-key-reuse');
            assert.equal(await noteOf('n2'), undefined);
            assert.deepEqual(await noteOf('n1'), before);
          } else {
            assert.deepEqual(
              outcomes.map(outcome => committedOf(outcome).code),
              ['note-created', 'note-trashed'],
            );
          }
        },
      );

      it('a rejected command leaves no record, so sending it again once it can commit commits it', async () => {
        const child = cmd('createFolder', { folderId: 'child', name: 'Child', parentId: 'parent' });
        assertRejected(await kernel.execute(child), 'not-found', 'parent-not-found');
        await run(cmd('createFolder', { folderId: 'parent', name: 'Parent', parentId: null }));
        assert.equal(committedOf(await kernel.execute(child)).code, 'folder-created');
      });

      it(
        flags.idempotency
          ? 'idempotency: two sends of one command at once commit it once, answer both with its outcome, and publish it once'
          : 'no idempotency: two sends of one command at once both run, and the second finds the note made',
        async () => {
          /** @type {string[]} */
          const published = [];
          kernel.subscribe(event => {
            published.push(...event.ids);
          });
          const create = cmd('createNote', { noteId: 'n1' });
          const [first, second] = await Promise.all([kernel.execute(create), kernel.execute(create)]);
          assert.equal(committedOf(first).code, 'note-created');
          if (flags.idempotency) {
            assert.deepEqual(second, first);
            assert.deepEqual(await kernel.execute(create), first);
          } else {
            assertRejected(second, 'validation', 'note-exists');
          }
          assert.deepEqual(published, ['n1']);
        },
      );

      it(
        flags.idempotency
          ? 'idempotency: a resent commandId gets its first outcome again and writes nothing'
          : 'no idempotency: a resent commandId runs again',
        async () => {
          await createNote({ noteId: 'n1' });
          const first = cmd('renameNote', { noteId: 'n1', name: 'First' });
          const firstOutcome = await run(first);
          await run(cmd('renameNote', { noteId: 'n1', name: 'Second' }));
          const again = await kernel.execute(first);
          assert.deepEqual(again, firstOutcome);
          assert.equal((await noteOf('n1'))?.name, flags.idempotency ? 'Second' : 'First');
        },
      );

      it(
        flags.atomicMultiStore
          ? "atomicMultiStore: a failing write in a command's later store leaves its earlier stores as they were"
          : "no atomicMultiStore: a failing write in a command's later store leaves its earlier stores written",
        async () => {
          await createNote({ noteId: 'n1', name: 'Before' });
          ctx.failNextWrite('searchIndex');
          const outcome = await kernel.execute(cmd('renameNote', { noteId: 'n1', name: 'After' }));
          assert.equal(outcome.kind, 'unavailable', JSON.stringify(outcome));
          assert.equal((await noteOf('n1'))?.name, flags.atomicMultiStore ? 'Before' : 'After');
          assert.equal((await searchEntryOf('n1'))?.name, 'Before');
        },
      );

      it(
        flags.revisions
          ? "two contexts: when both save one note's blocks from the revision they loaded, the later save is a conflict"
          : "two contexts: when both save one note's blocks from the revision they loaded, the later save wins",
        async () => {
          await createNote({ noteId: 'n1', blocks: someBlocks('n1', 1) });
          const tabA = kernel;
          const tabB = (await ctx.secondContext()).kernel();
          const [loadedA, loadedB] = await Promise.all([
            tabA.query({ type: 'getNote', noteId: 'n1' }),
            tabB.query({ type: 'getNote', noteId: 'n1' }),
          ]);
          /** @param {typeof loadedA} state */
          const revisionOf = state => (state.kind === 'ready' ? state.data.revision : undefined) ?? 1;
          /** @param {string} content */
          const edit = content => [{ ...someBlocks('n1', 1)[0], content }];
          committedOf(
            await tabA.execute(
              cmd('saveNoteContent', { noteId: 'n1', blocks: edit('A'), expectedRevision: revisionOf(loadedA) }),
            ),
          );
          const later = await tabB.execute(
            cmd('saveNoteContent', { noteId: 'n1', blocks: edit('B'), expectedRevision: revisionOf(loadedB) }),
          );
          assert.equal(later.kind, flags.revisions ? 'conflict' : 'committed', JSON.stringify(later));
          assert.equal((await blocksOf('n1'))[0].content, flags.revisions ? 'A' : 'B');
        },
      );
    });
  });
}
