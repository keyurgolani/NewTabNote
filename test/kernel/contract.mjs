// The kernel's use-case contract suite (#12, "Test plan"). It runs every use case through a
// kernel over one adapter, and any adapter can run it: memory.test.mjs runs it on the
// in-memory adapter, and #17 adds its IndexedDB adapter. Where an adapter flag changes
// what a command does, the suite expects the documented difference for the fixture's flags.

import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { createKernel } from '../../js/kernel/core/application/kernel.js';
import { unitsWork } from '../../js/kernel/core/application/work.js';
import { decode, encode } from '../../js/kernel/core/contracts/codec.js';
import { COMMAND_TYPES, newCommand } from '../../js/kernel/core/contracts/commands.js';
import { committed } from '../../js/kernel/core/contracts/outcomes.js';
import { createBaselinePolicy } from '../../js/kernel/core/ports/policy.js';
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

/** The workspace session keys Storage.initializeDefaultSettings writes on first run */
const STORAGE_DEFAULT_SESSION = Object.freeze({ openTabs: null, activeTabIndex: 0 });

/** The versions #17's IndexedDB adapter keeps on each note it writes (adapters/indexeddb/versions.js) */
const VERSION_FIELDS = Object.freeze(['revision', 'placementVersion', 'sourceRevision']);

/**
 * A note's own fields, without the versions an adapter may keep on its record, which outcomes
 * and getNote report, so one note compares alike on every adapter
 * @template {Record<string, unknown> | undefined} T
 * @param {T} note
 * @returns {T}
 */
const withoutVersions = note =>
  note &&
  /** @type {T} */ (Object.fromEntries(Object.entries(note).filter(([field]) => !VERSION_FIELDS.includes(field))));

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
    const noteOf = async noteId => withoutVersions(await storedNoteOf(noteId));

    /**
     * The note as getNote reads it, versions included, as every other query reads it
     * @param {string} noteId
     * @returns {Promise<NoteRecord | undefined>}
     */
    const storedNoteOf = async noteId => {
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

    /**
     * Puts records no command writes (media, vectors, snapshots, links no note's text made, and
     * notes in states no command reaches yet, such as a template), through the adapter's own
     * commit, so any adapter can run the cases that need them.
     * @param {'media' | 'vectors' | 'snapshots' | 'links' | 'notes'} store
     * @param {Array<{id: string} & Record<string, unknown>>} records
     */
    const seed = async (store, records) => {
      const seeding = /** @type {Command} */ ({ type: 'runStartupMaintenance', commandId: ctx.ids.next() });
      const unit = {
        stores: [store],
        /** @param {import('../../js/kernel/core/ports/repository.js').Tx} tx */
        async run(tx) {
          for (const record of records) tx.put(store, record);
        },
      };
      const { outcome } = await ctx.adapter.commit(unitsWork(seeding, [unit], () => committed('seeded', [])));
      assert.equal(outcome.kind, 'committed', JSON.stringify(outcome));
    };

    /**
     * @param {'media' | 'vectors' | 'snapshots'} store
     * @returns {Promise<string[]>}
     */
    const idsInStore = async store =>
      (await ctx.adapter.read([store], tx => tx.getAll(store))).map(record => record.id).sort();

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

      it('createNote keeps the pin and the hand-set title of a note the editor saves as a new one', async () => {
        await run(cmd('createFolder', { folderId: 'f1', name: 'Work', parentId: null }));
        const outcome = await run(
          cmd('createNote', { noteId: 'n1', name: 'Plan', folderId: 'f1', pinned: true, titleManuallySet: true }),
        );
        assert.deepEqual([outcome.code, outcome.changedIds], ['note-created', ['n1']]);
        assert.deepEqual(await noteOf('n1'), {
          ...storageNote('n1', 'Plan', NOW),
          folderId: 'f1',
          pinned: true,
          titleManuallySet: true,
        });
        assertRejected(
          await kernel.execute(cmd('createNote', { noteId: 'n2', pinned: /** @type {any} */ ('yes') })),
          'validation',
          'invalid-command',
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

      it('createNote commits the note, its search entry, and its first blocks together on every adapter', async () => {
        await run(cmd('createFolder', { folderId: 'f1', name: 'Work', parentId: null }));
        ctx.failNextWrite('blocks');
        const outcome = await kernel.execute(
          cmd('createNote', { noteId: 'n1', name: 'Imported', folderId: 'f1', blocks: someBlocks('n1', 3) }),
        );
        assert.equal(outcome.kind, 'unavailable', JSON.stringify(outcome));
        assert.deepEqual(
          [await noteOf('n1'), await searchEntryOf('n1'), await blocksOf('n1')],
          [undefined, undefined, []],
        );
        // Sent again under a new commandId, it lands whole
        await run(cmd('createNote', { noteId: 'n1', name: 'Imported', folderId: 'f1', blocks: someBlocks('n1', 3) }));
        assert.equal((await blocksOf('n1')).length, 3);
        assert.equal((await searchEntryOf('n1'))?.name, 'Imported');
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

      it('renameNote with a generated title keeps a title set by hand marked as set by hand', async () => {
        await createNote({ noteId: 'n1', name: 'Draft' });
        await run(cmd('renameNote', { noteId: 'n1', name: 'Mine' }));
        await run(cmd('renameNote', { noteId: 'n1', name: 'Summary', origin: 'generated' }));
        const note = await noteOf('n1');
        assert.deepEqual([note?.name, note?.titleManuallySet], ['Summary', true]);
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
        await createNote({ noteId: 'empty', blocks: [{ id: 'b0', type: 'text', content: ' <br>&nbsp;' }] });
        await createNote({ noteId: 'written', blocks: [{ id: 'b1', type: 'text', content: '<p>Milk</p>' }] });
        // Markup in a text block, or a block of another type, is content
        await createNote({ noteId: 'markup', blocks: [{ id: 'b2', type: 'text', content: '<p> </p>' }] });
        await createNote({ noteId: 'divider', blocks: [{ id: 'b3', type: 'divider', content: '' }] });
        assert.deepEqual((await run(cmd('trashNote', { noteId: 'empty' }))).code, 'note-deleted');
        assert.deepEqual([await noteOf('empty'), await blocksOf('empty')], [undefined, []]);
        for (const noteId of ['written', 'markup', 'divider']) {
          assert.deepEqual((await run(cmd('trashNote', { noteId }))).code, 'note-trashed', noteId);
          assert.equal((await noteOf(noteId))?.trashed, true, noteId);
          assert.equal((await blocksOf(noteId)).length, 1, noteId);
        }
      });

      it("trashNote deletes an empty untitled note's media, vectors, and snapshots, and keeps a trashed note's", async () => {
        await createNote({ noteId: 'empty' });
        await createNote({ noteId: 'written', name: 'Plan' });
        await seed('media', [
          { id: 'm-empty', canvasId: 'empty' },
          { id: 'm-written', canvasId: 'written' },
        ]);
        await seed('vectors', [{ id: 'empty' }, { id: 'written' }]);
        await seed('snapshots', [
          { id: 's-empty', noteId: 'empty', timestamp: NOW },
          { id: 's-written', noteId: 'written', timestamp: NOW },
        ]);
        assert.equal((await run(cmd('trashNote', { noteId: 'empty' }))).code, 'note-deleted');
        assert.equal((await run(cmd('trashNote', { noteId: 'written' }))).code, 'note-trashed');
        assert.deepEqual(
          [await idsInStore('media'), await idsInStore('vectors'), await idsInStore('snapshots')],
          [['m-written'], ['written'], ['s-written']],
        );
      });

      it(
        'on a database without the search index, media, vectors, or snapshots, notes are made, renamed, trashed, and deleted as Storage does',
        { skip: fixture.startWithout ? false : 'only a database an older 1.x profile left can lack stores' },
        async () => {
          const startWithout = /** @type {NonNullable<ContractFixture['startWithout']>} */ (fixture.startWithout);
          for (const missing of /** @type {const} */ (['searchIndex', 'media', 'vectors', 'snapshots'])) {
            const other = await startWithout([missing]);
            try {
              const tab = other.kernel();
              /** @param {Command} command */
              const codeOf = async command => {
                const outcome = await tab.execute(command);
                assert.equal(outcome.kind, 'committed', `without ${missing}: ${JSON.stringify(outcome)}`);
                return /** @type {Committed} */ (outcome).code;
              };
              const blocks = someBlocks('kept', 1);
              assert.equal(
                await codeOf(newCommand(other.ids, 'createNote', { noteId: 'kept', name: 'Plan', blocks })),
                'note-created',
              );
              assert.equal(
                await codeOf(newCommand(other.ids, 'renameNote', { noteId: 'kept', name: 'Renamed' })),
                'note-renamed',
              );
              assert.equal(await codeOf(newCommand(other.ids, 'trashNote', { noteId: 'kept' })), 'note-trashed');
              assert.equal(await codeOf(newCommand(other.ids, 'createNote', { noteId: 'empty' })), 'note-created');
              assert.equal(await codeOf(newCommand(other.ids, 'trashNote', { noteId: 'empty' })), 'note-deleted');
              const trashed = await tab.query({ type: 'listNotes', view: 'trashed' });
              assert.deepEqual(trashed.kind === 'ready' && trashed.data.map(note => note.name), ['Renamed'], missing);
            } finally {
              await other.close();
            }
          }
        },
      );

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
            todoProgress: { completed: 1, total: 2 },
          }),
        );
        assert.deepEqual([outcome.code, outcome.changedIds], ['content-saved', ['n1']]);
        assert.deepEqual(await noteOf('n1'), {
          ...before,
          preview: 'Line 0',
          todoProgress: { completed: 1, total: 2 },
          updatedAt: NOW + 1000,
        });
        assert.deepEqual(await blocksOf('n1'), someBlocks('n1', 2));
      });

      it('a save into a trashed note commits what was typed, and the note stays in the trash (#33)', async () => {
        // Another tab's pane can stay on a note trashed elsewhere, and its typing isn't lost
        await createNote({ noteId: 'n1', name: 'Plan' });
        await run(cmd('trashNote', { noteId: 'n1' }));
        const trashedAt = (await noteOf('n1'))?.trashedAt;
        ctx.clock.advance();
        const typed = [{ ...someBlocks('n1', 1)[0], content: 'Typed after the trash' }];
        const outcome = await run(cmd('saveNoteContent', { noteId: 'n1', blocks: typed, preview: 'A late save' }));
        assert.deepEqual([outcome.code, outcome.changedIds], ['content-saved', ['n1']]);
        assert.deepEqual(await blocksOf('n1'), typed);
        assert.equal((await noteOf('n1'))?.preview, 'A late save');
        assert.equal((await noteOf('n1'))?.trashed, true);
        // A save doesn't restamp trashedAt, which would restart the trash's retention
        assert.equal(typeof trashedAt, 'number');
        assert.equal((await noteOf('n1'))?.trashedAt, trashedAt);
        assert.deepEqual([await idsIn('trashed'), await idsIn('active')], [['n1'], []]);
      });

      it('a save that carries no preview or todoProgress keeps the ones stored', async () => {
        await createNote({ noteId: 'n1' });
        await run(
          cmd('saveNoteContent', {
            noteId: 'n1',
            blocks: someBlocks('n1', 1),
            preview: 'Line 0',
            todoProgress: { completed: 0, total: 1 },
          }),
        );
        await run(cmd('saveNoteContent', { noteId: 'n1', blocks: someBlocks('n1', 2) }));
        const note = await noteOf('n1');
        assert.deepEqual([note?.preview, note?.todoProgress], ['Line 0', { completed: 0, total: 1 }]);
        assert.equal((await blocksOf('n1')).length, 2);
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

      it('writes a typed title with the blocks, marked as set by hand, and the search entry follows', async () => {
        await createNote({ noteId: 'n1', name: 'Draft' });
        const before = await noteOf('n1');
        ctx.clock.advance();
        // The title and the first line were typed inside one debounce, so one save carries both
        const outcome = await run(
          cmd('saveNoteContent', { noteId: 'n1', blocks: someBlocks('n1', 1), preview: 'Line 0', name: 'Groceries' }),
        );
        assert.deepEqual([outcome.code, outcome.changedIds], ['content-saved', ['n1']]);
        assert.deepEqual(await noteOf('n1'), {
          ...before,
          name: 'Groceries',
          titleManuallySet: true,
          preview: 'Line 0',
          updatedAt: NOW + 1000,
        });
        assert.deepEqual(await blocksOf('n1'), someBlocks('n1', 1));
        assert.deepEqual(await searchEntryOf('n1'), {
          noteId: 'n1',
          name: 'Groceries',
          content: '',
          updatedAt: NOW + 1000,
        });
      });

      it('commits a typed title and the blocks together on every adapter', async () => {
        await createNote({ noteId: 'n1', name: 'Draft', blocks: someBlocks('n1', 1) });
        const before = await noteOf('n1');
        const entry = await searchEntryOf('n1');
        ctx.failNextWrite('blocks');
        const outcome = await kernel.execute(
          cmd('saveNoteContent', { noteId: 'n1', blocks: someBlocks('n1', 2), name: 'Groceries' }),
        );
        assert.equal(outcome.kind, 'unavailable', JSON.stringify(outcome));
        assert.deepEqual(await noteOf('n1'), before);
        assert.equal((await blocksOf('n1')).length, 1);
        assert.deepEqual(await searchEntryOf('n1'), entry);
      });

      it('writes a generated title with the blocks and lastAutoTitleAt, leaving titleManuallySet as it was', async () => {
        await createNote({ noteId: 'n1', name: 'Untitled' });
        const before = await noteOf('n1');
        ctx.clock.advance();
        const outcome = await run(
          cmd('saveNoteContent', {
            noteId: 'n1',
            blocks: someBlocks('n1', 1),
            preview: 'Line 0',
            name: 'Weekly plan',
            titleOrigin: 'generated',
          }),
        );
        assert.deepEqual([outcome.code, outcome.changedIds], ['content-saved', ['n1']]);
        assert.deepEqual(await noteOf('n1'), {
          ...before,
          name: 'Weekly plan',
          lastAutoTitleAt: NOW + 1000,
          preview: 'Line 0',
          updatedAt: NOW + 1000,
        });
        assert.equal((await searchEntryOf('n1'))?.name, 'Weekly plan');
        assertRejected(
          await kernel.execute(
            cmd('saveNoteContent', {
              noteId: 'n1',
              blocks: [],
              name: 'x',
              titleOrigin: /** @type {any} */ ('pasted'),
            }),
          ),
          'validation',
          'invalid-command',
        );
      });

      it('drops a generated title when the note has a title set by hand, and still saves the blocks', async () => {
        await createNote({ noteId: 'n1', name: 'Untitled' });
        // Another tab named the note while this editor's provider call ran
        await run(cmd('renameNote', { noteId: 'n1', name: 'Mine' }));
        const before = await noteOf('n1');
        ctx.clock.advance();
        const outcome = await run(
          cmd('saveNoteContent', {
            noteId: 'n1',
            blocks: someBlocks('n1', 1),
            preview: 'Line 0',
            name: 'Weekly plan',
            titleOrigin: 'generated',
          }),
        );
        assert.deepEqual(
          [outcome.code, outcome.changedIds, outcome.severity],
          ['content-saved-title-kept', ['n1'], 'info'],
        );
        assert.deepEqual(await noteOf('n1'), { ...before, preview: 'Line 0', updatedAt: NOW + 1000 });
        assert.equal((await blocksOf('n1')).length, 1);
        assert.equal((await searchEntryOf('n1'))?.name, 'Mine');
      });

      it('a typed title in a save over a title set by hand still lands', async () => {
        await createNote({ noteId: 'n1', name: 'Untitled' });
        await run(cmd('renameNote', { noteId: 'n1', name: 'Mine' }));
        const outcome = await run(
          cmd('saveNoteContent', { noteId: 'n1', blocks: someBlocks('n1', 1), name: 'Mine again' }),
        );
        assert.equal(outcome.code, 'content-saved');
        assert.deepEqual([(await noteOf('n1'))?.name, (await searchEntryOf('n1'))?.name], ['Mine again', 'Mine again']);
      });

      it('a save with no typed title leaves the stored one, so a rename made elsewhere stays', async () => {
        await createNote({ noteId: 'n1', name: 'Draft' });
        await run(cmd('renameNote', { noteId: 'n1', name: 'Renamed in another tab' }));
        await run(cmd('saveNoteContent', { noteId: 'n1', blocks: someBlocks('n1', 1), preview: 'Line 0' }));
        const note = await noteOf('n1');
        assert.deepEqual([note?.name, note?.preview], ['Renamed in another tab', 'Line 0']);
        assert.equal((await searchEntryOf('n1'))?.name, 'Renamed in another tab');
      });

      /**
       * The notes `noteId`'s wiki links point at, in the order they were stored
       * @param {string} noteId
       */
      const linksFrom = async noteId => {
        const links = await ctx.adapter.read(['links'], tx => tx.getAllByIndex('links', 'fromNoteId', noteId));
        for (const link of links) {
          assert.deepEqual(Object.keys(link).sort(), ['createdAt', 'fromNoteId', 'id', 'toNoteId']);
          assert.equal(typeof link.id, 'string');
        }
        return [...links].sort((a, b) => (a.id < b.id ? -1 : 1)).map(link => [link.toNoteId, link.createdAt]);
      };

      it("replaces the note's wiki links with links to the notes its text names, as Storage.updateNoteLinks finds them", async () => {
        await createNote({ noteId: 'n1', name: 'Plan' });
        await createNote({ noteId: 'old', name: 'groceries' });
        ctx.clock.advance();
        // Of two notes with one name, whatever the case, the one updated last
        await createNote({ noteId: 'new', name: 'Groceries' });
        await createNote({ noteId: 'archived', name: 'Archive me' });
        await run(cmd('archiveNote', { noteId: 'archived' }));
        await createNote({ noteId: 'trashed', name: 'Trash me' });
        await run(cmd('trashNote', { noteId: 'trashed' }));
        await seed('notes', [{ ...storageNote('template', 'Template', NOW), isTemplate: true }]);
        ctx.clock.advance();
        const linkedNames = ['GROCERIES', 'Archive me', 'Trash me', 'Template', 'Plan', 'Nowhere', 'groceries'];
        await run(cmd('saveNoteContent', { noteId: 'n1', blocks: someBlocks('n1', 1), linkedNames }));
        assert.deepEqual(await linksFrom('n1'), [
          ['new', NOW + 2000],
          ['archived', NOW + 2000],
        ]);
      });

      it('a later save replaces the links, one with no names deletes them, and one that carries none keeps them', async () => {
        await createNote({ noteId: 'n1', name: 'Plan' });
        await createNote({ noteId: 'n2', name: 'Groceries' });
        await createNote({ noteId: 'n3', name: 'Recipes' });
        /** @param {Partial<CommandOf<'saveNoteContent'>>} fields */
        const save = fields => run(cmd('saveNoteContent', { noteId: 'n1', blocks: someBlocks('n1', 1), ...fields }));
        await save({ linkedNames: ['Groceries'] });
        await save({ linkedNames: ['Recipes'] });
        assert.deepEqual(await linksFrom('n1'), [['n3', NOW]]);
        await save({});
        assert.deepEqual(await linksFrom('n1'), [['n3', NOW]]);
        await save({ linkedNames: [] });
        assert.deepEqual(await linksFrom('n1'), []);
        // A note linking here keeps its own links
        await run(cmd('saveNoteContent', { noteId: 'n2', blocks: someBlocks('n2', 1), linkedNames: ['Plan'] }));
        await save({ linkedNames: [] });
        assert.deepEqual(await linksFrom('n2'), [['n1', NOW]]);
      });

      it('writes no links for a note deleted since the editor loaded it', async () => {
        await createNote({ noteId: 'n2', name: 'Groceries' });
        assertRejected(
          await kernel.execute(
            cmd('saveNoteContent', { noteId: 'gone', blocks: someBlocks('gone', 1), linkedNames: ['Groceries'] }),
          ),
          'not-found',
          'note-not-found',
        );
        assert.deepEqual(await linksFrom('gone'), []);
      });

      it(
        'on a database without the links store, a save stores the note and its blocks and skips the links, as Storage does',
        { skip: fixture.startWithout ? false : 'only a database an older 1.x profile left can lack stores' },
        async () => {
          const startWithout = /** @type {NonNullable<ContractFixture['startWithout']>} */ (fixture.startWithout);
          const other = await startWithout(['links']);
          try {
            const tab = other.kernel();
            /** @param {Command} command */
            const send = async command => committedOf(await tab.execute(command));
            await send(newCommand(other.ids, 'createNote', { noteId: 'n1', name: 'Plan' }));
            await send(newCommand(other.ids, 'createNote', { noteId: 'n2', name: 'Groceries' }));
            const blocks = someBlocks('n1', 1);
            await send(newCommand(other.ids, 'saveNoteContent', { noteId: 'n1', blocks, linkedNames: ['Groceries'] }));
            await send(newCommand(other.ids, 'saveNoteContent', { noteId: 'n1', blocks, linkedNames: [] }));
            const stored = await tab.query({ type: 'getNoteBlocks', noteId: 'n1' });
            assert.deepEqual(stored.kind === 'ready' && stored.data, blocks);
          } finally {
            await other.close();
          }
        },
      );

      it('deleteBlocks deletes the blocks of the note it names, and a block already gone is nothing to delete', async () => {
        await createNote({ noteId: 'n1', blocks: someBlocks('n1', 3) });
        const deleted = await run(
          cmd('deleteBlocks', { noteId: 'n1', blockIds: ['n1-block-0', 'n1-block-2', 'never-saved'] }),
        );
        assert.deepEqual([deleted.code, deleted.changedIds], ['blocks-deleted', ['n1']]);
        assert.deepEqual(
          (await blocksOf('n1')).map(block => block.id),
          ['n1-block-1'],
        );
        const nothing = await run(cmd('deleteBlocks', { noteId: 'n1', blockIds: ['n1-block-0'] }));
        assert.deepEqual([nothing.code, nothing.changedIds], ['blocks-deleted', []]);
      });

      it('deleteBlocks refuses a block another note holds, and deletes none of the blocks it names', async () => {
        await createNote({ noteId: 'n1', blocks: someBlocks('n1', 1) });
        await createNote({ noteId: 'n2', blocks: someBlocks('n2', 1) });
        assertRejected(
          await kernel.execute(cmd('deleteBlocks', { noteId: 'n1', blockIds: ['n1-block-0', 'n2-block-0'] })),
          'validation',
          'block-of-another-note',
        );
        assert.equal((await blocksOf('n1')).length, 1);
        assert.equal((await blocksOf('n2')).length, 1);
        assertRejected(
          await kernel.execute(cmd('deleteBlocks', { noteId: 'n1', blockIds: [] })),
          'validation',
          'invalid-command',
        );
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

    describe('job bookkeeping', () => {
      /**
       * @param {string} noteId
       * @returns {Promise<number | null | undefined>}
       */
      const pendingSince = async noteId => {
        const state = await kernel.query({ type: 'getInsightsPending', noteId });
        return state.kind === 'ready' ? state.data.since : undefined;
      };

      it('setInsightsPending marks a note with the kernel clock, clears it, and getInsightsPending reads it', async () => {
        await createNote({ noteId: 'n1' });
        assert.equal(await pendingSince('n1'), null);
        ctx.clock.advance();
        const marked = await run(cmd('setInsightsPending', { noteId: 'n1', pending: true }));
        assert.deepEqual([marked.code, marked.changedIds], ['insights-pending', ['n1']]);
        assert.equal(await pendingSince('n1'), NOW + 1000);
        assert.equal(await pendingSince('n2'), null, 'only the note it names');
        const cleared = await run(cmd('setInsightsPending', { noteId: 'n1', pending: false }));
        assert.deepEqual([cleared.code, cleared.changedIds], ['insights-pending-cleared', ['n1']]);
        assert.equal(await pendingSince('n1'), null);
        assertRejected(
          await kernel.execute(cmd('setInsightsPending', { noteId: 'n1', pending: /** @type {any} */ ('yes') })),
          'validation',
          'invalid-command',
        );
        assert.equal(
          (await kernel.query({ type: 'getInsightsPending', noteId: /** @type {any} */ (7) })).kind,
          'failed',
        );
      });

      it('recordJobRun stamps each job with the kernel clock, and getJobRuns reads 0 for one that never ran', async () => {
        const never = await kernel.query({ type: 'getJobRuns' });
        assert.deepEqual(never.kind === 'ready' && never.data, { lastAutoTitleRun: 0, lastInsightsRun: 0 });
        ctx.clock.advance();
        const outcome = await run(cmd('recordJobRun', { job: 'autoTitle' }));
        assert.deepEqual([outcome.code, outcome.changedIds], ['job-run-recorded', ['autoTitle']]);
        ctx.clock.advance();
        await run(cmd('recordJobRun', { job: 'insights' }));
        const state = await kernel.query({ type: 'getJobRuns' });
        assert.deepEqual(state.kind === 'ready' && state.data, {
          lastAutoTitleRun: NOW + 1000,
          lastInsightsRun: NOW + 2000,
        });
        assertRejected(
          await kernel.execute(cmd('recordJobRun', { job: /** @type {any} */ ('backup') })),
          'validation',
          'invalid-command',
        );
      });

      it('a bookkeeping write the storage refuses is unavailable, and leaves what was stored', async () => {
        await run(cmd('setInsightsPending', { noteId: 'n1', pending: true }));
        const since = await pendingSince('n1');
        ctx.failNextWrite('jobs');
        const outcome = await kernel.execute(cmd('setInsightsPending', { noteId: 'n1', pending: false }));
        assert.equal(outcome.kind, 'unavailable', JSON.stringify(outcome));
        assert.equal(await pendingSince('n1'), since);
      });

      it("changes no note, so a note's record and revision stay as they were", async () => {
        await createNote({ noteId: 'n1', name: 'Plan' });
        const before = await kernel.query({ type: 'getNote', noteId: 'n1' });
        ctx.clock.advance();
        await run(cmd('setInsightsPending', { noteId: 'n1', pending: true }));
        await run(cmd('recordJobRun', { job: 'insights' }));
        await run(cmd('setInsightsPending', { noteId: 'n1', pending: false }));
        const after = await kernel.query({ type: 'getNote', noteId: 'n1' });
        assert.deepEqual(after.kind === 'ready' && after.data, before.kind === 'ready' && before.data);
      });

      it('runs from the new tab only', async () => {
        for (const caller of [CALLERS.popup, CALLERS.sidepanel, CALLERS['worker-internal']]) {
          const other = ctx.kernel(caller);
          assertRejected(
            await other.execute(cmd('setInsightsPending', { noteId: 'n1', pending: true })),
            'policy',
            'not-on-surface',
          );
          assertRejected(await other.execute(cmd('recordJobRun', { job: 'autoTitle' })), 'policy', 'not-on-surface');
          assert.deepEqual(await other.query({ type: 'getInsightsPending', noteId: 'n1' }), {
            kind: 'failed',
            cause: 'policy',
            code: 'not-on-surface',
          });
          assert.deepEqual(await other.query({ type: 'getJobRuns' }), {
            kind: 'failed',
            cause: 'policy',
            code: 'not-on-surface',
          });
        }
        assert.equal(await pendingSince('n1'), null);
      });
    });

    describe('version history', () => {
      /**
       * A note's snapshots as listSnapshots lists them
       * @param {string} noteId
       */
      const listOf = async noteId => {
        const state = await kernel.query({ type: 'listSnapshots', noteId });
        return state.kind === 'ready' ? state.data : [];
      };

      /** @param {string} snapshotId */
      const snapshotOf = async snapshotId => {
        const state = await kernel.query({ type: 'getSnapshot', snapshotId });
        return state.kind === 'ready' ? state.data : undefined;
      };

      /**
       * Blocks as the editor serializes them, which a snapshot holds
       * @param {string[]} contents
       */
      const serialized = contents => contents.map((content, index) => ({ id: `s-${index}`, type: 'text', content }));

      /**
       * A note with blocks, a pin, a folder, a trash, and a hand-set title, made the ways the user
       * makes them, and a snapshot of it from before
       */
      const placedNote = async () => {
        await run(cmd('createFolder', { folderId: 'f1', name: 'Work', parentId: null }));
        await createNote({ noteId: 'n1', name: 'Draft', blocks: someBlocks('n1', 3) });
        await run(
          cmd('saveSnapshot', { noteId: 'n1', snapshotId: 'old', blocks: serialized(['Then']), title: 'Then' }),
        );
        await run(cmd('renameNote', { noteId: 'n1', name: 'Now' }));
        await run(cmd('setPinned', { noteId: 'n1', pinned: true }));
        await seed('notes', [{ .../** @type {NoteRecord} */ (await noteOf('n1')), folderId: 'f1' }]);
        await run(cmd('trashNote', { noteId: 'n1' }));
        ctx.clock.advance();
      };

      it('saveSnapshot stores the record Storage.saveSnapshot stores, stamped by the kernel clock, and the queries read it', async () => {
        await createNote({ noteId: 'n1', name: 'Plan' });
        ctx.clock.advance();
        const outcome = await run(
          cmd('saveSnapshot', { noteId: 'n1', snapshotId: 's1', blocks: serialized(['Milk']), title: 'Plan' }),
        );
        assert.deepEqual([outcome.code, outcome.changedIds], ['snapshot-saved', ['s1']]);
        assert.deepEqual(await snapshotOf('s1'), {
          id: 's1',
          noteId: 'n1',
          timestamp: NOW + 1000,
          blocks: serialized(['Milk']),
          title: 'Plan',
        });
        ctx.clock.advance();
        await run(
          cmd('saveSnapshot', { noteId: 'n1', snapshotId: 's2', blocks: serialized(['Eggs']), title: 'Later' }),
        );
        assert.deepEqual(await listOf('n1'), [
          { id: 's2', timestamp: NOW + 2000, title: 'Later' },
          { id: 's1', timestamp: NOW + 1000, title: 'Plan' },
        ]);
        assert.equal((await kernel.query({ type: 'listSnapshots', noteId: 'n2' })).kind, 'empty');
        assert.equal((await kernel.query({ type: 'getSnapshot', snapshotId: 'gone' })).kind, 'empty');
        assert.equal((await kernel.query({ type: 'listSnapshots', noteId: /** @type {any} */ (7) })).kind, 'failed');
      });

      it("keeps a note's newest 50, as Storage.pruneSnapshots does, and no other note's", async () => {
        await createNote({ noteId: 'n1' });
        await createNote({ noteId: 'n2' });
        const old = Array.from({ length: 50 }, (_, index) => ({
          id: `old-${String(index).padStart(2, '0')}`,
          noteId: 'n1',
          timestamp: NOW - 1000 * (index + 1),
          blocks: [],
          title: `${index}`,
        }));
        await seed('snapshots', [...old, { id: 'other', noteId: 'n2', timestamp: 1, blocks: [], title: 'Other' }]);
        await run(cmd('saveSnapshot', { noteId: 'n1', snapshotId: 'new', blocks: [], title: 'New' }));
        const kept = (await listOf('n1')).map(summary => summary.id);
        assert.equal(kept.length, 50);
        assert.deepEqual([kept[0], kept.at(-1)], ['new', 'old-48']);
        assert.equal(await snapshotOf('old-49'), undefined, 'the oldest goes');
        assert.deepEqual(
          (await listOf('n2')).map(summary => summary.id),
          ['other'],
        );
      });

      it("saveSnapshot of a note that's gone, or under a snapshot's id, is refused and stores nothing", async () => {
        assertRejected(
          await kernel.execute(cmd('saveSnapshot', { noteId: 'gone', snapshotId: 's1', blocks: [], title: 'X' })),
          'not-found',
          'note-not-found',
        );
        assert.equal(await snapshotOf('s1'), undefined);
        await createNote({ noteId: 'n1' });
        await run(cmd('saveSnapshot', { noteId: 'n1', snapshotId: 's1', blocks: serialized(['First']), title: 'A' }));
        assertRejected(
          await kernel.execute(cmd('saveSnapshot', { noteId: 'n1', snapshotId: 's1', blocks: [], title: 'B' })),
          'validation',
          'snapshot-exists',
        );
        assert.equal((await snapshotOf('s1'))?.title, 'A');
      });

      it('restoreSnapshot puts back the blocks and the title, keeps the pin, folder, trash, and hand-set flag, and snapshots the note first', async () => {
        await placedNote();
        const before = /** @type {NoteRecord} */ (await noteOf('n1'));
        assert.deepEqual(
          [before.pinned, before.folderId, before.trashed, before.titleManuallySet],
          [true, 'f1', true, true],
        );
        const outcome = await run(
          cmd('restoreSnapshot', {
            noteId: 'n1',
            snapshotId: 'old',
            preSnapshotId: 'pre',
            blocks: serialized(['Then']),
            name: 'Then',
          }),
        );
        assert.deepEqual([outcome.code, outcome.changedIds], ['snapshot-restored', ['n1']]);
        assert.deepEqual(await noteOf('n1'), { ...before, name: 'Then', updatedAt: NOW + 1000 });
        assert.deepEqual(await blocksOf('n1'), [
          { id: 's-0', type: 'text', content: 'Then', canvasId: 'n1', order: 0 },
        ]);
        assert.equal((await searchEntryOf('n1'))?.name, 'Then');
        // What the note was, as stored, with no note or place of its own in each block
        assert.deepEqual(await snapshotOf('pre'), {
          id: 'pre',
          noteId: 'n1',
          timestamp: NOW + 1000,
          blocks: someBlocks('n1', 3).map(({ id, type, content }) => ({ id, type, content })),
          title: 'Now',
        });
        assert.deepEqual(
          (await listOf('n1')).map(summary => summary.id),
          ['pre', 'old'],
        );
      });

      it('restoreSnapshot without a title leaves the name as it is', async () => {
        await createNote({ noteId: 'n1', name: 'Kept', blocks: someBlocks('n1', 1) });
        await run(cmd('saveSnapshot', { noteId: 'n1', snapshotId: 'old', blocks: serialized(['Then']), title: '' }));
        await run(
          cmd('restoreSnapshot', {
            noteId: 'n1',
            snapshotId: 'old',
            preSnapshotId: 'pre',
            blocks: serialized(['Then']),
          }),
        );
        assert.equal((await noteOf('n1'))?.name, 'Kept');
        assert.equal((await searchEntryOf('n1'))?.name, 'Kept');
        assert.deepEqual(
          (await blocksOf('n1')).map(block => block.content),
          ['Then'],
        );
      });

      it("restoreSnapshot of another note's snapshot, a snapshot or note that's gone, or onto a snapshot's id writes nothing", async () => {
        await createNote({ noteId: 'n1', name: 'One', blocks: someBlocks('n1', 2) });
        await createNote({ noteId: 'n2', name: 'Two' });
        await run(cmd('saveSnapshot', { noteId: 'n2', snapshotId: 'theirs', blocks: serialized(['X']), title: 'Two' }));
        await run(cmd('saveSnapshot', { noteId: 'n1', snapshotId: 'mine', blocks: serialized(['Y']), title: 'One' }));
        const before = [await noteOf('n1'), await blocksOf('n1'), await listOf('n1')];
        /** @param {Partial<CommandOf<'restoreSnapshot'>>} fields */
        const restore = fields =>
          kernel.execute(
            cmd('restoreSnapshot', {
              noteId: 'n1',
              snapshotId: 'mine',
              preSnapshotId: 'pre',
              blocks: serialized(['Y']),
              name: 'One',
              ...fields,
            }),
          );
        assertRejected(await restore({ snapshotId: 'theirs' }), 'validation', 'snapshot-of-another-note');
        assertRejected(await restore({ snapshotId: 'gone' }), 'not-found', 'snapshot-not-found');
        assertRejected(await restore({ preSnapshotId: 'theirs' }), 'validation', 'snapshot-exists');
        assertRejected(await restore({ preSnapshotId: 'mine' }), 'validation', 'invalid-command');
        assertRejected(await restore({ noteId: 'gone' }), 'not-found', 'note-not-found');
        assertRejected(await restore({ blocks: [{ id: 'x', canvasId: 'n2' }] }), 'validation', 'block-of-another-note');
        assert.deepEqual([await noteOf('n1'), await blocksOf('n1'), await listOf('n1')], before);
      });

      it('restoreSnapshot is one unit on every adapter: a write it fails leaves the blocks, the note, and the snapshots as they were', async () => {
        await placedNote();
        const before = [await noteOf('n1'), await blocksOf('n1'), await listOf('n1')];
        // The note's write is its last, so the snapshot and the blocks have been written when it fails
        ctx.failNextWrite('notes');
        const outcome = await kernel.execute(
          cmd('restoreSnapshot', {
            noteId: 'n1',
            snapshotId: 'old',
            preSnapshotId: 'pre',
            blocks: serialized(['Then']),
            name: 'Then',
          }),
        );
        assert.equal(outcome.kind, 'unavailable', JSON.stringify(outcome));
        assert.deepEqual([await noteOf('n1'), await blocksOf('n1'), await listOf('n1')], before);
        assert.equal((await searchEntryOf('n1'))?.name, 'Now');
      });

      it("a snapshot moves no revision and publishes as a snapshot, and a restore moves the note's", async () => {
        await createNote({ noteId: 'n1', name: 'Plan', blocks: someBlocks('n1', 1) });
        /** @type {CommitEvent[]} */
        const seen = [];
        kernel.subscribe(event => {
          seen.push(event);
        });
        const revisionOf = async () => {
          const state = await kernel.query({ type: 'getNote', noteId: 'n1' });
          return state.kind === 'ready' ? state.data.revision : undefined;
        };
        const created = await revisionOf();
        const saved = await run(cmd('saveSnapshot', { noteId: 'n1', snapshotId: 's1', blocks: [], title: 'Plan' }));
        assert.equal(saved.revision, undefined);
        assert.equal(await revisionOf(), created);
        const restored = await run(
          cmd('restoreSnapshot', { noteId: 'n1', snapshotId: 's1', preSnapshotId: 'pre', blocks: [], name: 'Plan' }),
        );
        if (flags.revisions) {
          assert.equal(await revisionOf(), /** @type {number} */ (created) + 1);
          assert.equal(restored.revision, /** @type {number} */ (created) + 1);
        } else {
          assert.equal(await revisionOf(), undefined);
        }
        await new Promise(resolve => setImmediate(resolve));
        assert.deepEqual(
          seen.map(event => ({ ...event, ids: [...event.ids] })),
          [
            { aggregate: 'snapshot', ids: ['s1'] },
            { aggregate: 'note', ids: ['n1'] },
          ],
        );
      });

      it(
        'on a database without the snapshots store, saving one is refused as store-unavailable and nothing commits',
        { skip: fixture.startWithout ? false : 'only a database an older 1.x profile left can lack stores' },
        async () => {
          const startWithout = /** @type {NonNullable<ContractFixture['startWithout']>} */ (fixture.startWithout);
          const other = await startWithout(['snapshots']);
          try {
            const tab = other.kernel();
            committedOf(await tab.execute(newCommand(other.ids, 'createNote', { noteId: 'n1', name: 'Plan' })));
            const saved = await tab.execute(
              newCommand(other.ids, 'saveSnapshot', { noteId: 'n1', snapshotId: 's1', blocks: [], title: 'Plan' }),
            );
            assert.deepEqual(
              saved.kind === 'unavailable' && { cause: saved.cause, code: saved.code },
              { cause: 'storage', code: 'store-unavailable' },
              JSON.stringify(saved),
            );
            const restored = await tab.execute(
              newCommand(other.ids, 'restoreSnapshot', {
                noteId: 'n1',
                snapshotId: 's1',
                preSnapshotId: 'pre',
                blocks: [],
                name: 'Then',
              }),
            );
            assert.notEqual(restored.kind, 'committed', JSON.stringify(restored));
            assert.equal((await tab.query({ type: 'listSnapshots', noteId: 'n1' })).kind, 'empty');
            const note = await tab.query({ type: 'getNote', noteId: 'n1' });
            assert.equal(note.kind === 'ready' && note.data.note.name, 'Plan');
          } finally {
            await other.close();
          }
        },
      );
    });

    describe('insertBlocks', () => {
      /**
       * Blocks as AI chat parses a reply into them, each with the id the chat took for it
       * @param {string[]} contents
       */
      const reply = contents => contents.map((content, index) => ({ id: `ai-${index}`, type: 'text', content }));

      /** @param {string} noteId */
      const placesOf = async noteId => (await blocksOf(noteId)).map(block => [block.id, block.order]);

      it('at a place, moves the blocks at or past it down, stores the new ones there, and the note shows them', async () => {
        await createNote({ noteId: 'n1', name: 'Plan', blocks: someBlocks('n1', 3) });
        await run(cmd('setPinned', { noteId: 'n1', pinned: true }));
        const before = /** @type {NoteRecord} */ (await noteOf('n1'));
        ctx.clock.advance();
        const outcome = await run(
          cmd('insertBlocks', {
            noteId: 'n1',
            blocks: [
              { id: 'ai-0', type: 'todo', content: 'Call', checked: true },
              { id: 'ai-1', type: 'todo', content: 'Write' },
            ],
            atOrder: 1,
          }),
        );
        assert.deepEqual([outcome.code, outcome.changedIds], ['blocks-inserted', ['n1']]);
        assert.deepEqual(await placesOf('n1'), [
          ['n1-block-0', 0],
          ['ai-0', 1],
          ['ai-1', 2],
          ['n1-block-1', 3],
          ['n1-block-2', 4],
        ]);
        const added = (await blocksOf('n1')).find(block => block.id === 'ai-0');
        assert.deepEqual(added, {
          id: 'ai-0',
          type: 'todo',
          content: 'Call',
          checked: true,
          canvasId: 'n1',
          order: 1,
          createdAt: NOW + 1000,
          updatedAt: NOW + 1000,
        });
        assert.deepEqual(await noteOf('n1'), {
          ...before,
          preview: 'Line 0',
          todoProgress: { completed: 1, total: 2 },
          updatedAt: NOW + 1000,
        });
      });

      it('with no place, adds the blocks after the last one, and a note with none starts at 0', async () => {
        await createNote({ noteId: 'n1', blocks: someBlocks('n1', 2) });
        await run(cmd('insertBlocks', { noteId: 'n1', blocks: reply(['One', 'Two']) }));
        assert.deepEqual(await placesOf('n1'), [
          ['n1-block-0', 0],
          ['n1-block-1', 1],
          ['ai-0', 2],
          ['ai-1', 3],
        ]);
        await createNote({ noteId: 'n2' });
        await run(
          cmd('insertBlocks', { noteId: 'n2', blocks: [{ id: 'first', type: 'text', content: '<b>Hello</b>' }] }),
        );
        assert.deepEqual(await placesOf('n2'), [['first', 0]]);
        const made = await noteOf('n2');
        assert.deepEqual([made?.preview, made?.todoProgress], ['Hello', null]);
      });

      it("replaces the note's wiki links with the ones its blocks hold once the new ones are in", async () => {
        await createNote({
          noteId: 'n1',
          name: 'Plan',
          blocks: [{ id: 'b0', type: 'text', content: 'See [[Groceries]]' }],
        });
        await createNote({ noteId: 'g', name: 'Groceries' });
        await createNote({ noteId: 'w', name: 'Work' });
        await run(cmd('insertBlocks', { noteId: 'n1', blocks: reply(['And [[work]]']), atOrder: 0 }));
        const links = await ctx.adapter.read(['links'], tx => tx.getAllByIndex('links', 'fromNoteId', 'n1'));
        assert.deepEqual(links.map(link => link.toNoteId).sort(), ['g', 'w']);
      });

      it("is refused for a note that's gone, a block another note holds, or a block id already stored, and writes nothing", async () => {
        await createNote({ noteId: 'n1', blocks: someBlocks('n1', 2) });
        await createNote({ noteId: 'n2', blocks: someBlocks('n2', 1) });
        const before = [await noteOf('n1'), await blocksOf('n1'), await blocksOf('n2')];
        /** @param {Partial<CommandOf<'insertBlocks'>>} fields */
        const insert = fields => kernel.execute(cmd('insertBlocks', { noteId: 'n1', blocks: reply(['X']), ...fields }));
        assertRejected(await insert({ noteId: 'gone' }), 'not-found', 'note-not-found');
        assertRejected(await insert({ blocks: [{ id: 'n2-block-0' }] }), 'validation', 'block-of-another-note');
        assertRejected(await insert({ blocks: [{ id: 'x', canvasId: 'n2' }] }), 'validation', 'block-of-another-note');
        assertRejected(await insert({ blocks: [{ id: 'n1-block-1' }] }), 'validation', 'duplicate-block');
        assertRejected(await insert({ blocks: [{ id: 'x' }, { id: 'x' }] }), 'validation', 'duplicate-block');
        assertRejected(await insert({ blocks: [] }), 'validation', 'invalid-command');
        assertRejected(await insert({ atOrder: -1 }), 'validation', 'invalid-command');
        assert.deepEqual([await noteOf('n1'), await blocksOf('n1'), await blocksOf('n2')], before);
      });

      it('moves, adds, and sets the preview in one unit on every adapter: a write it fails leaves them as they were', async () => {
        await createNote({ noteId: 'n1', blocks: someBlocks('n1', 3) });
        const before = [await noteOf('n1'), await blocksOf('n1')];
        ctx.failNextWrite('notes');
        const outcome = await kernel.execute(cmd('insertBlocks', { noteId: 'n1', blocks: reply(['X']), atOrder: 0 }));
        assert.equal(outcome.kind, 'unavailable', JSON.stringify(outcome));
        assert.deepEqual([await noteOf('n1'), await blocksOf('n1')], before);
      });

      it("moves the note's revision, publishes the note, and a save sent from before it keeps the inserted blocks", async () => {
        await createNote({ noteId: 'n1', blocks: someBlocks('n1', 1) });
        /** @type {CommitEvent[]} */
        const seen = [];
        kernel.subscribe(event => {
          seen.push(event);
        });
        const created = await kernel.query({ type: 'getNote', noteId: 'n1' });
        const inserted = await run(cmd('insertBlocks', { noteId: 'n1', blocks: reply(['From the chat']) }));
        if (flags.revisions) {
          const revision = created.kind === 'ready' ? created.data.revision : undefined;
          assert.equal(inserted.revision, /** @type {number} */ (revision) + 1);
        }
        // An editor save from what it held before the insert puts its own blocks and deletes
        // none, so the inserted block stays
        await run(cmd('saveNoteContent', { noteId: 'n1', blocks: [{ ...someBlocks('n1', 1)[0], content: 'Typed' }] }));
        assert.deepEqual(
          (await blocksOf('n1')).map(block => block.content),
          ['Typed', 'From the chat'],
        );
        await new Promise(resolve => setImmediate(resolve));
        assert.deepEqual(
          seen.map(event => ({ ...event, ids: [...event.ids] })),
          [
            { aggregate: 'note', ids: ['n1'] },
            { aggregate: 'note', ids: ['n1'] },
          ],
        );
      });
    });

    describe('version history and inserts run from the new tab only', () => {
      it('refuses each from Popup, Side Panel, and the service worker', async () => {
        await createNote({ noteId: 'n1', blocks: someBlocks('n1', 1) });
        await run(cmd('saveSnapshot', { noteId: 'n1', snapshotId: 's1', blocks: [], title: 'Plan' }));
        const before = [await noteOf('n1'), await blocksOf('n1')];
        for (const caller of [CALLERS.popup, CALLERS.sidepanel, CALLERS['worker-internal']]) {
          const other = ctx.kernel(caller);
          for (const command of [
            cmd('saveSnapshot', { noteId: 'n1', snapshotId: 's2', blocks: [], title: 'X' }),
            cmd('restoreSnapshot', { noteId: 'n1', snapshotId: 's1', preSnapshotId: 'p', blocks: [] }),
            cmd('insertBlocks', { noteId: 'n1', blocks: [{ id: 'ai-0', type: 'text', content: 'X' }] }),
          ]) {
            assertRejected(await other.execute(command), 'policy', 'not-on-surface');
          }
          for (const query of /** @type {const} */ ([
            { type: 'listSnapshots', noteId: 'n1' },
            { type: 'getSnapshot', snapshotId: 's1' },
          ])) {
            assert.deepEqual(await other.query(query), { kind: 'failed', cause: 'policy', code: 'not-on-surface' });
          }
        }
        assert.deepEqual([await noteOf('n1'), await blocksOf('n1')], before);
        assert.equal((await kernel.query({ type: 'getSnapshot', snapshotId: 's2' })).kind, 'empty');
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
        // Each carries when it was captured, which a UUID doesn't say, for the readers that go by
        // when each block was made (#17 PR 2a)
        assert.deepEqual(
          (await blocksOf('d1')).map(({ createdAt, updatedAt, order }) => [createdAt, updatedAt, order]),
          [
            [NOW, NOW, NOW],
            [NOW, NOW, NOW],
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

    describe('ensureDailyNote', () => {
      /** @param {string} noteId */
      const searchNameOf = async noteId => (await searchEntryOf(noteId))?.name;
      /** @returns {Promise<NoteRecord[]>} */
      const dailyNotes = async () => {
        const state = await kernel.query({ type: 'listNotes', view: 'withArchived' });
        return state.kind === 'ready' ? state.data.filter(note => note.isDaily) : [];
      };
      /**
       * The Daily Note findDailyNote reads for `dateStr`, as the new tab reads it after an ensure
       * @param {string} dateStr
       */
      const dailyIdOn = async dateStr => {
        const state = await kernel.query({ type: 'findDailyNote', dateStr });
        return state.kind === 'ready' ? state.data.note.id : undefined;
      };

      it("makes today's Daily Note with its search entry, then finds it and makes no other", async () => {
        const made = await run(cmd('ensureDailyNote', { noteId: 'd1' }));
        assert.deepEqual([made.code, made.changedIds], ['daily-note-created', ['d1']]);
        assert.deepEqual(await noteOf('d1'), {
          ...storageNote('d1', 'Daily Note - Oct 20, 2026', NOW),
          isDaily: true,
          dateStr: '2026-10-20',
        });
        assert.deepEqual(await searchEntryOf('d1'), {
          noteId: 'd1',
          name: 'Daily Note - Oct 20, 2026',
          content: '',
          updatedAt: NOW,
        });
        ctx.clock.advance();
        const found = await run(cmd('ensureDailyNote', { noteId: 'd2' }));
        assert.deepEqual([found.code, found.changedIds, found.severity], ['daily-note-exists', [], 'info']);
        assert.equal(await noteOf('d2'), undefined);
        assert.equal((await noteOf('d1'))?.updatedAt, NOW, 'finding it writes nothing');
        assert.equal(await dailyIdOn('2026-10-20'), 'd1', 'findDailyNote reads it');
      });

      it('a Daily Note it finds changes nothing: no commit-feed event, no commitSeq, and no revision move', async () => {
        await run(cmd('ensureDailyNote', { noteId: 'd1' }));
        const revisionOf = async () => {
          const state = await kernel.query({ type: 'getNote', noteId: 'd1' });
          return state.kind === 'ready' ? state.data.revision : undefined;
        };
        const before = await revisionOf();
        /** @type {CommitEvent[]} */
        const seen = [];
        kernel.subscribe(event => {
          seen.push(event);
        });
        const found = await run(cmd('ensureDailyNote', { noteId: 'd2' }));
        await new Promise(resolve => setImmediate(resolve));
        assert.deepEqual([found.code, found.changedIds, found.commitSeq], ['daily-note-exists', [], undefined]);
        assert.deepEqual(seen, [], 'nothing on the commit feed');
        assert.equal(await revisionOf(), before, 'the revision stays');
        if (flags.revisions) assert.equal(before, 1);
      });

      it('findDailyNote reads the Daily Note for a day, archived included, and nothing for a day without one', async () => {
        await run(cmd('ensureDailyNote', { noteId: 'd1', dateStr: '2026-10-18' }));
        await run(cmd('archiveNote', { noteId: 'd1' }));
        const state = await kernel.query({ type: 'findDailyNote', dateStr: '2026-10-18' });
        assert.deepEqual(state.kind === 'ready' && [state.data.note.id, state.data.note.archived], ['d1', true]);
        assert.equal((await kernel.query({ type: 'findDailyNote', dateStr: '2026-10-19' })).kind, 'empty');
        await run(cmd('trashNote', { noteId: 'd1' }));
        assert.equal((await kernel.query({ type: 'findDailyNote', dateStr: '2026-10-18' })).kind, 'empty');
        const bad = await kernel.query({ type: 'findDailyNote', dateStr: '2026-13-40' });
        assert.deepEqual(bad.kind === 'failed' && [bad.cause, bad.code], ['validation', 'invalid-query']);
        for (const surface of /** @type {const} */ (['popup', 'sidepanel', 'worker-internal'])) {
          const refused = await ctx.kernel(CALLERS[surface]).query({ type: 'findDailyNote', dateStr: '2026-10-18' });
          assert.deepEqual(refused.kind === 'failed' && refused.cause, 'policy', surface);
        }
      });

      it("takes today from the instant it's given, so a caller reads that same day back across midnight", async () => {
        // Asked for at 23:59:59.900 UTC on Oct 20, run after midnight by the kernel's clock
        const asked = Date.UTC(2026, 9, 20, 23, 59, 59, 900);
        ctx.clock.advance(asked + 200 - NOW);
        const made = await run(cmd('ensureDailyNote', { noteId: 'd1', at: asked }));
        assert.deepEqual(made.changedIds, ['d1']);
        const note = await noteOf('d1');
        const day = new Date(asked).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
        assert.deepEqual([note?.dateStr, note?.name], ['2026-10-20', `Daily Note - ${day}`]);
        assert.equal(await dailyIdOn('2026-10-20'), 'd1');
        // Without an instant, the kernel's own clock says it's Oct 21
        assert.deepEqual((await run(cmd('ensureDailyNote', { noteId: 'd2' }))).changedIds, ['d2']);
        assert.equal((await noteOf('d2'))?.dateStr, '2026-10-21');
      });

      it("keys and names a calendar day's Daily Note by that day, apart from today's", async () => {
        const day = await run(cmd('ensureDailyNote', { noteId: 'd1', dateStr: '2026-10-18' }));
        assert.deepEqual(day.changedIds, ['d1']);
        const note = await noteOf('d1');
        assert.deepEqual([note?.isDaily, note?.dateStr, note?.name], [true, '2026-10-18', 'Daily Note - Oct 18, 2026']);
        assert.equal(await searchNameOf('d1'), 'Daily Note - Oct 18, 2026');
        assert.deepEqual((await run(cmd('ensureDailyNote', { noteId: 'd2', dateStr: '2026-10-18' }))).changedIds, []);
        assert.equal(await dailyIdOn('2026-10-18'), 'd1');
        // Today's is another note, and the capture that comes next finds it
        assert.deepEqual((await run(cmd('ensureDailyNote', { noteId: 'd3' }))).changedIds, ['d3']);
        const worker = ctx.kernel(CALLERS['worker-internal']);
        const page = /** @type {const} */ ({ type: 'bookmark', url: 'https://example.test/page', title: 'Page' });
        const capture = committedOf(
          await worker.execute(cmd('captureToDailyNote', { noteId: 'd4', blockId: 'c1', capture: page })),
        );
        assert.deepEqual(capture.changedIds, ['d3']);
        assert.deepEqual((await dailyNotes()).map(daily => daily.id).sort(), ['d1', 'd3']);
      });

      it('starts a new Daily Note from the Daily Note template, and an archived one still counts', async () => {
        await createNote({
          noteId: 'tpl',
          name: 'Template',
          blocks: [
            { id: 't1', type: 'text', content: 'Notes for {{title}}', order: 0 },
            { id: 't2', type: 'todo', content: 'Review', order: 1 },
          ],
        });
        await run(cmd('setPreferences', { values: { dailyNoteTemplate: 'tpl' } }));
        await run(cmd('ensureDailyNote', { noteId: 'd1', dateStr: '2026-10-18' }));
        const blocks = await blocksOf('d1');
        assert.deepEqual(
          blocks.map(({ type, content, canvasId }) => ({ type, content, canvasId })),
          [
            { type: 'text', content: 'Notes for Daily Note - Oct 18, 2026', canvasId: 'd1' },
            { type: 'todo', content: 'Review', canvasId: 'd1' },
          ],
        );
        assert.ok(
          blocks.every(block => block.id !== 't1' && block.id !== 't2'),
          'copies get ids of their own',
        );
        assert.equal((await blocksOf('tpl')).length, 2, 'the template keeps its blocks');

        await run(cmd('archiveNote', { noteId: 'd1' }));
        const again = await run(cmd('ensureDailyNote', { noteId: 'd2', dateStr: '2026-10-18' }));
        assert.deepEqual(
          [again.code, await noteOf('d2'), (await blocksOf('d1')).length],
          ['daily-note-exists', undefined, 2],
        );
      });

      it("doesn't reuse a trashed Daily Note", async () => {
        await run(cmd('ensureDailyNote', { noteId: 'd1' }));
        await run(cmd('trashNote', { noteId: 'd1' }));
        const next = await run(cmd('ensureDailyNote', { noteId: 'd2' }));
        assert.deepEqual([next.code, next.changedIds], ['daily-note-created', ['d2']]);
      });

      it('two at once make one Daily Note, and a capture at the same time adds to it', async () => {
        const worker = ctx.kernel(CALLERS['worker-internal']);
        const page = /** @type {const} */ ({ type: 'bookmark', url: 'https://example.test/page', title: 'Page' });
        const outcomes = await Promise.all([
          kernel.execute(cmd('ensureDailyNote', { noteId: 'd1' })),
          kernel.execute(cmd('ensureDailyNote', { noteId: 'd2' })),
          worker.execute(cmd('captureToDailyNote', { noteId: 'd3', blockId: 'c1', capture: page })),
        ]);
        const daily = await dailyNotes();
        assert.equal(daily.length, 1, JSON.stringify(daily.map(note => note.id)));
        assert.equal(await dailyIdOn('2026-10-20'), daily[0].id);
        assert.deepEqual(committedOf(outcomes[2]).changedIds, [daily[0].id], 'the capture added to it');
        // The capture made it, or exactly one of the two did, and the other found it
        const codes = outcomes
          .slice(0, 2)
          .map(outcome => committedOf(outcome).code)
          .sort();
        assert.deepEqual(
          codes,
          daily[0].id === 'd3'
            ? ['daily-note-exists', 'daily-note-exists']
            : ['daily-note-created', 'daily-note-exists'],
        );
        assert.deepEqual(
          (await blocksOf(daily[0].id)).map(block => block.id),
          ['c1'],
        );
      });

      it('commits the Daily Note, its search entry, and its template blocks together on every adapter', async () => {
        await createNote({ noteId: 'tpl', name: 'Template', blocks: someBlocks('tpl', 2) });
        await run(cmd('setPreferences', { values: { dailyNoteTemplate: 'tpl' } }));
        ctx.failNextWrite('blocks');
        const outcome = await kernel.execute(cmd('ensureDailyNote', { noteId: 'd1' }));
        assert.equal(outcome.kind, 'unavailable', JSON.stringify(outcome));
        assert.deepEqual(
          [await noteOf('d1'), await searchEntryOf('d1'), await blocksOf('d1')],
          [undefined, undefined, []],
        );
        assert.deepEqual((await run(cmd('ensureDailyNote', { noteId: 'd2' }))).changedIds, ['d2']);
        assert.equal((await blocksOf('d2')).length, 2);
      });

      it('refuses a day that is no YYYY-MM-DD, and runs from the new tab only', async () => {
        assertRejected(
          await kernel.execute(cmd('ensureDailyNote', { noteId: 'd1', dateStr: '2026-10-18', at: NOW })),
          'validation',
          'invalid-command',
        );
        assertRejected(
          await kernel.execute(cmd('ensureDailyNote', { noteId: 'd1', at: -1 })),
          'validation',
          'invalid-command',
        );
        for (const dateStr of ['2026-13-01', '20261018', 'yesterday', '']) {
          assertRejected(
            await kernel.execute(cmd('ensureDailyNote', { noteId: 'd1', dateStr })),
            'validation',
            'invalid-command',
          );
        }
        assert.deepEqual(await dailyNotes(), []);
        for (const surface of /** @type {const} */ (['popup', 'sidepanel', 'worker-internal'])) {
          const outcome = await ctx.kernel(CALLERS[surface]).execute(cmd('ensureDailyNote', { noteId: 'd1' }));
          assert.equal(outcome.kind, 'rejected', surface);
          assert.equal(/** @type {Rejected} */ (outcome).reason, 'policy', surface);
        }
        assert.deepEqual(await dailyNotes(), []);
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

      it("a bulk command that's refused answers with a plain outcome, with no items", async () => {
        await createNote({ noteId: 'a', name: 'A' });
        const popup = ctx.kernel(CALLERS.popup);
        const refused = await popup.execute(cmd('runBulkAction', { action: 'archive', noteIds: ['a'] }));
        assertRejected(refused, 'policy', 'not-on-surface');
        // @ts-expect-error a bulk command's answer has items only once it ran
        assert.equal(refused.items, undefined);
        const unknownAction = /** @type {any} */ ({ action: 'shred', noteIds: ['a'] });
        const invalid = await kernel.execute(cmd('runBulkAction', unknownAction));
        assertRejected(invalid, 'validation', 'invalid-command');
        assert.ok(!('items' in invalid) && !('committedIds' in invalid), JSON.stringify(invalid));
        assert.deepEqual(await idsIn('active'), ['a']);
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

      it(
        'on a database without folders, a move finds no folder and a new one fails to store, as Storage does',
        { skip: fixture.startWithout ? false : 'only a database an older 1.x profile left can lack stores' },
        async () => {
          const startWithout = /** @type {NonNullable<ContractFixture['startWithout']>} */ (fixture.startWithout);
          const other = await startWithout(['folders']);
          try {
            const tab = other.kernel();
            /** @param {CommandType} type @param {any} fields */
            const send = (type, fields) => tab.execute(newCommand(other.ids, type, fields));
            assertRejected(
              await send('moveFolder', { folderId: 'f1', parentId: null }),
              'not-found',
              'folder-not-found',
            );
            assertRejected(
              await send('createNote', { noteId: 'n1', name: 'Filed', folderId: 'f1' }),
              'not-found',
              'folder-not-found',
            );
            const created = await send('createFolder', { folderId: 'f1', name: 'Work', parentId: null });
            assert.deepEqual(
              created.kind === 'unavailable' && [created.cause, created.code],
              ['storage', 'store-unavailable'],
              JSON.stringify(created),
            );
            assert.equal((await tab.query({ type: 'listFolders' })).kind, 'empty');
          } finally {
            await other.close();
          }
        },
      );
    });

    describe('filing, templates, and the trash (#12 slice 5)', () => {
      /**
       * @param {string} folderId
       * @param {string | null} parentId
       */
      const folder = (folderId, parentId) => run(cmd('createFolder', { folderId, name: folderId, parentId }));

      /** @returns {Promise<Record<string, FolderRecord>>} */
      const foldersById = async () => {
        const state = await kernel.query({ type: 'listFolders' });
        return state.kind === 'ready' ? Object.fromEntries(state.data.map(f => [f.id, f])) : {};
      };

      /**
       * A note with one block, in the trash since `trashedAt`
       * @param {string} noteId
       * @param {number} trashedAt
       */
      const trashedNote = async (noteId, trashedAt) => {
        await createNote({ noteId, name: noteId, blocks: someBlocks(noteId, 1) });
        await seed('notes', [{ ...(await noteOf(noteId)), id: noteId, trashed: true, trashedAt }]);
      };

      it('renameFolder and setFolderCollapsed write their field and updatedAt, and both land when sent at once', async () => {
        await folder('f1', null);
        ctx.clock.advance();
        const [renamed, collapsed] = await Promise.all([
          kernel.execute(cmd('renameFolder', { folderId: 'f1', name: 'Work' })),
          kernel.execute(cmd('setFolderCollapsed', { folderId: 'f1', collapsed: true })),
        ]);
        assert.deepEqual(
          [committedOf(renamed).code, committedOf(collapsed).code],
          ['folder-renamed', 'folder-collapsed'],
        );
        assert.deepEqual((await foldersById()).f1, {
          id: 'f1',
          name: 'Work',
          parentId: null,
          createdAt: NOW,
          updatedAt: NOW + 1000,
          color: null,
          collapsed: true,
        });
        assert.equal(
          (await run(cmd('setFolderCollapsed', { folderId: 'f1', collapsed: false }))).code,
          'folder-expanded',
        );
        for (const command of [
          cmd('renameFolder', { folderId: 'gone', name: 'X' }),
          cmd('setFolderCollapsed', { folderId: 'gone', collapsed: true }),
          cmd('deleteFolder', { folderId: 'gone' }),
        ]) {
          assertRejected(await kernel.execute(command), 'not-found', 'folder-not-found');
        }
      });

      it('deleteFolder deletes the folders inside it as committed and files every note in them at the root, trashed notes and templates included', async () => {
        await folder('a', null);
        await folder('b', 'a');
        await folder('c', 'b');
        await folder('other', null);
        await createNote({ noteId: 'inA', name: 'In A', folderId: 'a' });
        await createNote({ noteId: 'inC', name: 'In C', folderId: 'c' });
        await createNote({ noteId: 'archived', name: 'Archived', folderId: 'b' });
        await createNote({ noteId: 'trashed', name: 'Trashed', folderId: 'c' });
        await createNote({ noteId: 'template', name: 'Template', folderId: 'b' });
        await createNote({ noteId: 'elsewhere', name: 'Elsewhere', folderId: 'other' });
        await run(cmd('archiveNote', { noteId: 'archived' }));
        await run(cmd('trashNote', { noteId: 'trashed' }));
        await seed('notes', [{ ...(await noteOf('template')), id: 'template', isTemplate: true }]);
        ctx.clock.advance();
        const outcome = await run(cmd('deleteFolder', { folderId: 'a' }));
        assert.deepEqual(
          [outcome.code, [...outcome.changedIds].sort()],
          ['folder-deleted', ['a', 'archived', 'b', 'c', 'inA', 'inC', 'template', 'trashed']],
        );
        assert.deepEqual(Object.keys(await foldersById()), ['other']);
        /** @type {Record<string, unknown>} */
        const filed = {};
        for (const noteId of ['inA', 'inC', 'archived', 'trashed', 'template', 'elsewhere']) {
          const note = await noteOf(noteId);
          filed[noteId] = [note?.folderId, note?.updatedAt === NOW + 1000];
        }
        // Storage.deleteFolder moved only what getAllNotes(true) lists, so a trashed note restored
        // later pointed at a folder that was gone, and no list showed it. Every note moves now.
        assert.deepEqual(filed, {
          inA: [null, true],
          inC: [null, true],
          archived: [null, true],
          trashed: [null, true],
          template: [null, true],
          elsewhere: ['other', false],
        });
        assert.equal((await noteOf('trashed'))?.trashed, true, 'and it stays in the trash');
      });

      it('moveNoteToFolder files a note and unfiles it, writing folderId and updatedAt, and refuses a folder that is gone', async () => {
        await folder('f1', null);
        await createNote({ noteId: 'n1', name: 'Plan', blocks: someBlocks('n1', 2) });
        const before = await noteOf('n1');
        ctx.clock.advance();
        const moved = await run(cmd('moveNoteToFolder', { noteId: 'n1', folderId: 'f1' }));
        assert.deepEqual([moved.code, moved.changedIds], ['note-moved', ['n1']]);
        assert.deepEqual(await noteOf('n1'), { ...before, folderId: 'f1', updatedAt: NOW + 1000 });
        // Already there: it commits naming nothing, and writes nothing
        ctx.clock.advance();
        const again = await run(cmd('moveNoteToFolder', { noteId: 'n1', folderId: 'f1' }));
        assert.deepEqual([again.code, again.changedIds], ['note-moved', []]);
        assert.equal((await noteOf('n1'))?.updatedAt, NOW + 1000);
        assertRejected(
          await kernel.execute(cmd('moveNoteToFolder', { noteId: 'n1', folderId: 'gone' })),
          'not-found',
          'folder-not-found',
        );
        assertRejected(
          await kernel.execute(cmd('moveNoteToFolder', { noteId: 'gone', folderId: 'f1' })),
          'not-found',
          'note-not-found',
        );
        assert.equal((await noteOf('n1'))?.folderId, 'f1');
        await run(cmd('moveNoteToFolder', { noteId: 'n1', folderId: null }));
        assert.equal((await noteOf('n1'))?.folderId, null);
        assert.equal((await blocksOf('n1')).length, 2);
      });

      it("a folder move with the note open survives the editor's next save", async () => {
        await folder('f1', null);
        await createNote({ noteId: 'n1', name: 'Plan', blocks: someBlocks('n1', 1) });
        // The editor loaded the note before the move, and saves after it
        await run(cmd('moveNoteToFolder', { noteId: 'n1', folderId: 'f1' }));
        await run(cmd('saveNoteContent', { noteId: 'n1', blocks: someBlocks('n1', 2), preview: 'Line 0' }));
        const note = await noteOf('n1');
        assert.deepEqual([note?.folderId, note?.preview, (await blocksOf('n1')).length], ['f1', 'Line 0', 2]);
      });

      it('convertNoteToTemplate and convertTemplateToNote change where the note is listed and never its content', async () => {
        await folder('f1', null);
        await createNote({ noteId: 'n1', name: 'Plan', folderId: 'f1', blocks: someBlocks('n1', 2) });
        const before = await noteOf('n1');
        const blocks = await blocksOf('n1');
        ctx.clock.advance();
        assert.equal((await run(cmd('convertNoteToTemplate', { noteId: 'n1' }))).code, 'note-made-template');
        assert.deepEqual(await noteOf('n1'), { ...before, isTemplate: true, folderId: null, updatedAt: NOW + 1000 });
        assert.deepEqual([await idsIn('active'), await idsIn('templates')], [[], ['n1']]);
        ctx.clock.advance();
        assert.equal((await run(cmd('convertTemplateToNote', { noteId: 'n1' }))).code, 'template-made-note');
        assert.deepEqual(await noteOf('n1'), { ...before, isTemplate: false, folderId: null, updatedAt: NOW + 2000 });
        assert.deepEqual([await idsIn('active'), await idsIn('templates')], [['n1'], []]);
        assert.deepEqual(await blocksOf('n1'), blocks);
        for (const type of /** @type {const} */ (['convertNoteToTemplate', 'convertTemplateToNote'])) {
          assertRejected(await kernel.execute(cmd(type, { noteId: 'gone' })), 'not-found', 'note-not-found');
        }
      });

      it("convert-to-template with the note open survives the editor's next save", async () => {
        await createNote({ noteId: 'n1', name: 'Plan', blocks: someBlocks('n1', 1) });
        await run(cmd('convertNoteToTemplate', { noteId: 'n1' }));
        await run(cmd('saveNoteContent', { noteId: 'n1', blocks: someBlocks('n1', 3), name: 'Plan v2' }));
        const note = await noteOf('n1');
        assert.deepEqual([note?.isTemplate, note?.name, (await blocksOf('n1')).length], [true, 'Plan v2', 3]);
        assert.deepEqual(await idsIn('templates'), ['n1']);
      });

      it("deleteNotePermanently deletes a trashed note with what Storage.permanentlyDeleteNote deleted, its search entry and links too, and refuses one that isn't in the trash", async () => {
        await createNote({ noteId: 'n1', name: 'Plan', blocks: someBlocks('n1', 2) });
        await createNote({ noteId: 'kept', name: 'Kept', blocks: someBlocks('kept', 1) });
        await seed('media', [
          { id: 'm1', canvasId: 'n1' },
          { id: 'm-kept', canvasId: 'kept' },
        ]);
        await seed('vectors', [{ id: 'n1' }, { id: 'kept' }]);
        await seed('snapshots', [
          { id: 's1', noteId: 'n1', timestamp: NOW },
          { id: 's-kept', noteId: 'kept', timestamp: NOW },
        ]);
        await seed('links', [{ id: 'l1', fromNoteId: 'n1', toNoteId: 'kept', createdAt: NOW }]);
        // Not in the trash, as committed: a note restored since the trash view showed it stays
        assertRejected(
          await kernel.execute(cmd('deleteNotePermanently', { noteId: 'n1' })),
          'validation',
          'note-not-trashed',
        );
        assert.equal((await blocksOf('n1')).length, 2);
        await run(cmd('trashNote', { noteId: 'n1' }));
        const deleted = await run(cmd('deleteNotePermanently', { noteId: 'n1' }));
        assert.deepEqual([deleted.code, deleted.changedIds], ['note-deleted', ['n1']]);
        assert.deepEqual([await noteOf('n1'), await blocksOf('n1')], [undefined, []]);
        assert.deepEqual(
          [await idsInStore('media'), await idsInStore('vectors'), await idsInStore('snapshots')],
          [['m-kept'], ['kept'], ['s-kept']],
        );
        // Its link and search entry go too since #17 PR 2b, which Storage.permanentlyDeleteNote left
        const links = await ctx.adapter.read(['links'], tx => tx.getAll('links'));
        assert.deepEqual(links, []);
        assert.equal(await searchEntryOf('n1'), undefined);
        assert.ok(await searchEntryOf('kept'));
        assertRejected(
          await kernel.execute(cmd('deleteNotePermanently', { noteId: 'n1' })),
          'not-found',
          'note-not-found',
        );
      });

      it('emptyTrash deletes every note in the trash as committed, blocks included, and names them', async () => {
        await trashedNote('t1', NOW - 5000);
        await trashedNote('t2', NOW - 1000);
        await createNote({ noteId: 'active', name: 'Active', blocks: someBlocks('active', 1) });
        await seed('media', [{ id: 'm1', canvasId: 't1' }]);
        const emptied = await run(cmd('emptyTrash', {}));
        assert.deepEqual([emptied.code, [...emptied.changedIds].sort()], ['trash-emptied', ['t1', 't2']]);
        assert.deepEqual([await idsIn('trashed'), await idsIn('active')], [[], ['active']]);
        assert.deepEqual([await blocksOf('t1'), await blocksOf('t2'), await idsInStore('media')], [[], [], []]);
        assert.equal((await blocksOf('active')).length, 1);
        const again = await run(cmd('emptyTrash', {}));
        assert.deepEqual([again.code, again.changedIds], ['trash-emptied', []]);
      });

      it('emptyTrash that fails to store deletes nothing, on every adapter', async () => {
        await trashedNote('t1', NOW - 5000);
        await trashedNote('t2', NOW - 1000);
        ctx.failNextWrite('notes');
        const outcome = await kernel.execute(cmd('emptyTrash', {}));
        assert.equal(outcome.kind, 'unavailable', JSON.stringify(outcome));
        assert.deepEqual(await idsIn('trashed'), ['t2', 't1']);
        assert.deepEqual([(await blocksOf('t1')).length, (await blocksOf('t2')).length], [1, 1]);
      });

      it('runTrashCleanup deletes the notes in the trash longer than trashRetention keeps them, 30 days unless set', async () => {
        const DAY = 24 * 60 * 60 * 1000;
        await trashedNote('old', NOW - 31 * DAY);
        await trashedNote('week', NOW - 8 * DAY);
        await trashedNote('new', NOW - DAY);
        await createNote({ noteId: 'active', name: 'Active' });
        const cleaned = await run(cmd('runTrashCleanup', {}));
        assert.deepEqual([cleaned.code, cleaned.changedIds], ['trash-cleaned', ['old']]);
        assert.deepEqual([await idsIn('trashed'), await blocksOf('old')], [['new', 'week'], []]);
        await run(cmd('setPreferences', { values: { trashRetention: 7 } }));
        assert.deepEqual((await run(cmd('runTrashCleanup', {}))).changedIds, ['week']);
        // 0 keeps the trash for good
        await run(cmd('setPreferences', { values: { trashRetention: 0 } }));
        await trashedNote('ancient', NOW - 400 * DAY);
        const kept = await run(cmd('runTrashCleanup', {}));
        assert.deepEqual([kept.code, kept.changedIds], ['trash-kept', []]);
        assert.deepEqual(await idsIn('trashed'), ['new', 'ancient']);
        assert.deepEqual(await idsIn('active'), ['active']);
      });

      it('a bulk delete deletes each trashed note and refuses the ones that are not in the trash', async () => {
        await trashedNote('t1', NOW - 1000);
        await trashedNote('t2', NOW - 2000);
        await createNote({ noteId: 'active', name: 'Active' });
        const result = bulkOf(
          await kernel.execute(cmd('runBulkAction', { action: 'delete', noteIds: ['t1', 'active', 't2'] })),
        );
        assert.deepEqual(
          result.items.map(({ id, outcome }) => [id, outcome.kind, outcome.code]),
          [
            ['t1', 'committed', 'note-deleted'],
            ['active', 'rejected', 'note-not-trashed'],
            ['t2', 'committed', 'note-deleted'],
          ],
        );
        assert.deepEqual([result.committedIds, result.messageKey], [['t1', 't2'], 'bulk.delete']);
        assert.deepEqual([await idsIn('trashed'), await idsIn('active')], [[], ['active']]);
      });

      it('runs from the new tab only', async () => {
        await trashedNote('t1', NOW - 1000);
        for (const caller of [CALLERS.popup, CALLERS.sidepanel, CALLERS['worker-internal']]) {
          const other = ctx.kernel(caller);
          for (const command of [
            cmd('moveNoteToFolder', { noteId: 't1', folderId: null }),
            cmd('renameFolder', { folderId: 'f1', name: 'X' }),
            cmd('setFolderCollapsed', { folderId: 'f1', collapsed: true }),
            cmd('deleteFolder', { folderId: 'f1' }),
            cmd('convertNoteToTemplate', { noteId: 't1' }),
            cmd('convertTemplateToNote', { noteId: 't1' }),
            cmd('deleteNotePermanently', { noteId: 't1' }),
            cmd('emptyTrash', {}),
            cmd('runTrashCleanup', {}),
          ]) {
            assertRejected(await other.execute(command), 'policy', 'not-on-surface');
          }
        }
        assert.deepEqual(await idsIn('trashed'), ['t1']);
      });
    });

    describe('deletion for good leaves tombstones (#17 PR 2b)', () => {
      /** @returns {Promise<Array<Record<string, unknown>>>} */
      const tombstones = () => ctx.adapter.read(['tombstones'], tx => tx.getAll('tombstones'));

      /**
       * A tombstone as this adapter keeps it: on one with revisions, with the note's last
       * content revision and the commit's change-log seq (null without a log)
       * @param {Record<string, unknown>} fields
       * @param {number} [lastRevision]
       */
      const tombstoneOf = (fields, lastRevision) => ({
        purge: 'pending',
        ...fields,
        ...(flags.revisions ? { lastRevision, seq: null } : {}),
      });

      /**
       * The tombstones, with each seq read as null, so one adapter's log and another's lack of
       * one compare alike; each seq that's there is checked to be a count first
       */
      const storedTombstones = async () =>
        (await tombstones()).map(tombstone => {
          if (!flags.revisions) return tombstone;
          assert.ok(tombstone.seq === null || Number.isSafeInteger(tombstone.seq), JSON.stringify(tombstone));
          return { ...tombstone, seq: null };
        });

      /**
       * @param {string} noteId
       * @param {number} trashedAt
       */
      const inTrash = async (noteId, trashedAt) => {
        await createNote({ noteId, name: noteId, blocks: someBlocks(noteId, 1) });
        await seed('notes', [{ ...(await noteOf(noteId)), id: noteId, trashed: true, trashedAt }]);
      };

      it('a note deleted for good takes every row it owns, its links both ways, and leaves its tombstone', async () => {
        await createNote({ noteId: 'n1', name: 'Plan', blocks: someBlocks('n1', 2) });
        await createNote({ noteId: 'kept', name: 'Kept', blocks: someBlocks('kept', 1) });
        await createNote({ noteId: 'other', name: 'Other' });
        await seed('media', [
          { id: 'm1', canvasId: 'n1' },
          { id: 'm-kept', canvasId: 'kept' },
        ]);
        await seed('vectors', [{ id: 'n1' }, { id: 'kept' }]);
        await seed('snapshots', [
          { id: 's1', noteId: 'n1', timestamp: NOW },
          { id: 's-kept', noteId: 'kept', timestamp: NOW },
        ]);
        await seed('links', [
          { id: 'from-n1', fromNoteId: 'n1', toNoteId: 'kept', createdAt: NOW },
          { id: 'to-n1', fromNoteId: 'kept', toNoteId: 'n1', createdAt: NOW },
          { id: 'kept-other', fromNoteId: 'kept', toNoteId: 'other', createdAt: NOW },
        ]);
        await run(cmd('trashNote', { noteId: 'n1' }));
        ctx.clock.advance();
        assert.equal((await run(cmd('deleteNotePermanently', { noteId: 'n1' }))).code, 'note-deleted');
        assert.deepEqual(
          [await noteOf('n1'), await blocksOf('n1'), await searchEntryOf('n1')],
          [undefined, [], undefined],
        );
        assert.deepEqual(
          [await idsInStore('media'), await idsInStore('vectors'), await idsInStore('snapshots')],
          [['m-kept'], ['kept'], ['s-kept']],
        );
        const links = await ctx.adapter.read(['links'], tx => tx.getAll('links'));
        assert.deepEqual(
          links.map(link => link.id),
          ['kept-other'],
        );
        assert.ok(await searchEntryOf('kept'));
        assert.equal((await blocksOf('kept')).length, 1);
        assert.deepEqual(await storedTombstones(), [
          tombstoneOf({ entityType: 'note', id: 'n1', deletedAt: NOW + 1000, reason: 'deleted' }, 1),
        ]);
      });

      it('each way of deleting a note for good gives its tombstone its reason', async () => {
        const DAY = 24 * 60 * 60 * 1000;
        await createNote({ noteId: 'empty' });
        await inTrash('emptied', NOW - DAY);
        assert.equal((await run(cmd('trashNote', { noteId: 'empty' }))).code, 'note-deleted');
        assert.deepEqual((await run(cmd('emptyTrash', {}))).changedIds, ['emptied']);
        await inTrash('expired', NOW - 31 * DAY);
        assert.deepEqual((await run(cmd('runTrashCleanup', {}))).changedIds, ['expired']);
        await inTrash('bulk', NOW - DAY);
        const bulk = bulkOf(await kernel.execute(cmd('runBulkAction', { action: 'delete', noteIds: ['bulk'] })));
        assert.deepEqual(bulk.committedIds, ['bulk']);
        const byId = Object.fromEntries((await storedTombstones()).map(tombstone => [tombstone.id, tombstone]));
        assert.deepEqual(byId, {
          empty: tombstoneOf({ entityType: 'note', id: 'empty', deletedAt: NOW, reason: 'empty-note' }, 1),
          emptied: tombstoneOf({ entityType: 'note', id: 'emptied', deletedAt: NOW, reason: 'trash-emptied' }, 1),
          expired: tombstoneOf({ entityType: 'note', id: 'expired', deletedAt: NOW, reason: 'trash-expired' }, 1),
          bulk: tombstoneOf({ entityType: 'note', id: 'bulk', deletedAt: NOW, reason: 'deleted' }, 1),
        });
      });

      it('a delete that fails to store leaves no tombstone, and a trash leaves none', async () => {
        await inTrash('t1', NOW - 1000);
        ctx.failNextWrite('notes');
        assert.equal((await kernel.execute(cmd('emptyTrash', {}))).kind, 'unavailable');
        await createNote({ noteId: 'n1', name: 'Plan' });
        await run(cmd('trashNote', { noteId: 'n1' }));
        await run(cmd('archiveNote', { noteId: 't1' }));
        assert.deepEqual(await tombstones(), []);
      });

      it('deleteFolder leaves a tombstone for each folder it deletes, and none for the notes it files', async () => {
        await run(cmd('createFolder', { folderId: 'a', name: 'A', parentId: null }));
        await run(cmd('createFolder', { folderId: 'b', name: 'B', parentId: 'a' }));
        await run(cmd('createFolder', { folderId: 'kept', name: 'Kept', parentId: null }));
        await createNote({ noteId: 'filed', name: 'Filed', folderId: 'b' });
        ctx.clock.advance();
        assert.equal((await run(cmd('deleteFolder', { folderId: 'a' }))).code, 'folder-deleted');
        // A folder has no revision, and its tombstone's seq is the commit's where there's a log
        const stored = (await tombstones()).map(tombstone => {
          const rest = { ...tombstone };
          delete rest.seq;
          return rest;
        });
        assert.deepEqual(
          stored.sort((x, y) => (String(x.id) < String(y.id) ? -1 : 1)),
          ['a', 'b'].map(id => ({
            entityType: 'folder',
            id,
            deletedAt: NOW + 1000,
            reason: 'deleted',
            purge: 'pending',
          })),
        );
        assert.equal((await noteOf('filed'))?.folderId, null);
      });

      it(
        'deleting a note drops the conflict records of saves that lost to it, whose text they keep',
        { skip: flags.revisions ? false : 'only an adapter with revisions keeps conflicts' },
        async () => {
          await createNote({ noteId: 'n1', name: 'Plan', blocks: someBlocks('n1', 1) });
          await createNote({ noteId: 'kept', name: 'Kept', blocks: someBlocks('kept', 1) });
          for (const noteId of ['n1', 'kept']) {
            const stale = await kernel.execute(
              cmd('saveNoteContent', { noteId, blocks: someBlocks(noteId, 2), expectedRevision: 0 }),
            );
            assert.equal(stale.kind, 'conflict', JSON.stringify(stale));
          }
          assert.ok(ctx.conflicts);
          assert.equal((await ctx.conflicts()).length, 2);
          await run(cmd('trashNote', { noteId: 'n1' }));
          await run(cmd('deleteNotePermanently', { noteId: 'n1' }));
          const left = /** @type {Array<{commandId: string, command: Command}>} */ (await ctx.conflicts());
          assert.deepEqual(
            left.map(kept => /** @type {{noteId?: string}} */ (kept.command).noteId),
            ['kept'],
          );
        },
      );

      it(
        'a database below version 10 has no tombstones, and a delete there commits without one',
        { skip: fixture.startWithout ? false : 'only a database an older 1.x profile left can lack stores' },
        async () => {
          await ctx.close();
          ctx = await /** @type {NonNullable<ContractFixture['startWithout']>} */ (fixture.startWithout)([
            'tombstones',
          ]);
          kernel = ctx.kernel();
          await createNote({ noteId: 'n1', name: 'Plan', blocks: someBlocks('n1', 1) });
          await run(cmd('trashNote', { noteId: 'n1' }));
          assert.equal((await run(cmd('deleteNotePermanently', { noteId: 'n1' }))).code, 'note-deleted');
          await run(cmd('createFolder', { folderId: 'f1', name: 'F', parentId: null }));
          assert.equal((await run(cmd('deleteFolder', { folderId: 'f1' }))).code, 'folder-deleted');
          assert.deepEqual([await noteOf('n1'), await tombstones()], [undefined, []]);
        },
      );
    });

    describe('preferences, session, and startup maintenance', () => {
      it('setPreferences stores known preferences and refuses any other key', async () => {
        const outcome = await run(cmd('setPreferences', { values: { theme: 'dark', sidebarWidth: 300 } }));
        assert.deepEqual(outcome.changedIds, ['theme', 'sidebarWidth']);
        const state = await kernel.query({ type: 'getPreferences', keys: ['theme', 'sidebarWidth', 'font'] });
        assert.deepEqual(state.kind === 'ready' && state.data, { theme: 'dark', sidebarWidth: 300 });
        assertRejected(
          await kernel.execute(cmd('setPreferences', { values: /** @type {any} */ ({ llmApiKey: 'x' }) })),
          'validation',
          'unknown-preference',
        );
        assert.equal((await kernel.query({ type: 'getPreferences', keys: ['llmApiKey'] })).kind, 'failed');
      });

      it('setPreferences leaves out a value that is undefined, in-process as through the codec', async () => {
        await run(cmd('setPreferences', { values: { theme: 'dark', font: 'sans' } }));
        const inProcess = cmd('setPreferences', { values: /** @type {any} */ ({ theme: undefined, font: 'serif' }) });
        assert.deepEqual((await run(inProcess)).changedIds, ['font']);
        // The router hands the kernel what the codec decodes, which has no theme
        const sent = cmd('setPreferences', { values: /** @type {any} */ ({ theme: undefined, font: 'mono' }) });
        assert.deepEqual((await run(/** @type {Command} */ (decode(encode(sent))))).changedIds, ['font']);
        const state = await kernel.query({ type: 'getPreferences', keys: ['theme', 'font'] });
        assert.deepEqual(state.kind === 'ready' && state.data, { theme: 'dark', font: 'mono' });
        // With nothing left there's nothing to set, either way
        const nothing = cmd('setPreferences', { values: /** @type {any} */ ({ theme: undefined }) });
        assertRejected(await kernel.execute(nothing), 'validation', 'invalid-command');
        assertRejected(
          await kernel.execute(/** @type {Command} */ (decode(encode(nothing)))),
          'validation',
          'invalid-command',
        );
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

      it('saveWorkspaceSession leaves out a key that is undefined, in-process as through the codec', async () => {
        const session = /** @type {any} */ ({ openTabs: [{ noteId: 'n1' }], activeTabIndex: undefined });
        assert.deepEqual((await run(cmd('saveWorkspaceSession', { session }))).changedIds, ['openTabs']);
        const sent = cmd('saveWorkspaceSession', { session: { ...session, openTabs: [{ noteId: 'n2' }] } });
        assert.deepEqual((await run(/** @type {Command} */ (decode(encode(sent))))).changedIds, ['openTabs']);
        const state = await kernel.query({ type: 'getWorkspaceSession' });
        assert.deepEqual(state.kind === 'ready' && state.data, { openTabs: [{ noteId: 'n2' }] });
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

      it('runStartupMaintenance writes the session defaults Storage writes on first run, and keeps a stored session', async () => {
        assert.equal((await kernel.query({ type: 'getWorkspaceSession' })).kind, 'empty');
        await run(cmd('runStartupMaintenance', {}));
        const defaults = await kernel.query({ type: 'getWorkspaceSession' });
        assert.deepEqual(defaults.kind === 'ready' && defaults.data, STORAGE_DEFAULT_SESSION);
        const session = { openTabs: [{ noteId: 'n1' }], activeTabIndex: 0, splitViewEnabled: true };
        await run(cmd('saveWorkspaceSession', { session }));
        committedOf(await ctx.kernel(CALLERS['worker-internal']).execute(cmd('runStartupMaintenance', {})));
        const kept = await kernel.query({ type: 'getWorkspaceSession' });
        assert.deepEqual(kept.kind === 'ready' && kept.data, session);
      });

      it("runIntegrityCheck is the service worker's alone, and commits having changed nothing (#35)", async () => {
        const noteId = await createNote({ name: 'Plan' });
        const before = await noteOf(noteId);
        assertRejected(await kernel.execute(cmd('runIntegrityCheck', {})), 'policy', 'not-on-surface');
        const checked = committedOf(await ctx.kernel(CALLERS['worker-internal']).execute(cmd('runIntegrityCheck', {})));
        assert.deepEqual([checked.code, checked.changedIds], ['integrity-checked', []]);
        assert.deepEqual(await noteOf(noteId), before);
        // First-run settings are runStartupMaintenance's
        assert.equal((await kernel.query({ type: 'getPreferences' })).kind, 'empty');
      });

      /**
       * A kernel the way the new-tab and service-worker roots build it: startup maintenance
       * runs once `ready` settles, before any command or query
       * @param {PromiseLike<unknown>} ready
       */
      const maintainingRoot = ready =>
        createKernel({
          adapter: ctx.adapter,
          policy: createBaselinePolicy(),
          caller: CALLERS.newtab,
          ids: ctx.ids,
          clock: ctx.clock,
          ready,
          maintainOnOpen: true,
        });

      it("on a root that maintains as it opens, what's set once it's ready survives the next maintenance", async () => {
        const root = maintainingRoot(Promise.resolve());
        committedOf(await root.execute(cmd('setPreferences', { values: { theme: 'dark', sidebarWidth: 300 } })));
        committedOf(
          await root.execute(cmd('saveWorkspaceSession', { session: { activeTabIndex: 2, lastOpenedNoteId: 'n1' } })),
        );
        committedOf(await ctx.kernel(CALLERS['worker-internal']).execute(cmd('runStartupMaintenance', {})));
        const preferences = await root.query({ type: 'getPreferences', keys: ['theme', 'sidebarWidth', 'font'] });
        assert.deepEqual(preferences.kind === 'ready' && preferences.data, {
          theme: 'dark',
          sidebarWidth: 300,
          font: 'default',
        });
        const session = await root.query({ type: 'getWorkspaceSession' });
        assert.deepEqual(session.kind === 'ready' && [session.data.activeTabIndex, session.data.lastOpenedNoteId], [
          2,
          'n1',
        ]);
      });

      it('on a root that maintains as it opens, a command sent before ready waits, then commits over the defaults', async () => {
        /** @type {() => void} */
        let open = () => {};
        const root = maintainingRoot(
          new Promise(resolve => {
            open = () => resolve(undefined);
          }),
        );
        let settled = false;
        const setting = root.execute(cmd('setPreferences', { values: { theme: 'dark' } })).then(outcome => {
          settled = true;
          return outcome;
        });
        assert.deepEqual(await root.query({ type: 'getPreferences' }), { kind: 'loading' });
        await new Promise(resolve => setImmediate(resolve));
        assert.equal(settled, false);
        assert.equal((await kernel.query({ type: 'getPreferences' })).kind, 'empty');
        open();
        committedOf(await setting);
        const preferences = await root.query({ type: 'getPreferences' });
        assert.deepEqual(preferences.kind === 'ready' && preferences.data, {
          ...STORAGE_DEFAULT_PREFERENCES,
          theme: 'dark',
        });
      });
    });

    describe('chat history, themes, onboarding, and backups (#12 slice 6)', () => {
      /**
       * @param {import('../../js/kernel/core/ports/repository.js').SettingsArea} area
       * @param {string[]} keys
       */
      const settingsIn = (area, keys) => ctx.adapter.readSettings(area, keys);

      /** @param {string} themeId */
      const themeOf = themeId => ctx.adapter.read(['themes'], tx => tx.get('themes', themeId));

      it('saveChatHistory writes a conversation, its history and messages together, under 1.4.x keys', async () => {
        const history = [{ role: 'user', content: 'Plan the week' }];
        const messages = [{ type: 'user', content: 'Plan the week', timestamp: 1 }];
        const outcome = await run(cmd('saveChatHistory', { chat: 'note', history, messages }));
        assert.deepEqual(outcome.changedIds, ['aiChatHistory', 'noteChatMessages']);
        assert.ok(!JSON.stringify(outcome).includes('Plan the week'), 'the outcome carries no chat text');
        await run(cmd('saveChatHistory', { chat: 'global', history: [], messages: [] }));
        assert.deepEqual(
          await settingsIn('chat', ['aiChatHistory', 'noteChatMessages', 'globalChatHistory', 'globalChatMessages']),
          { aiChatHistory: history, noteChatMessages: messages, globalChatHistory: [], globalChatMessages: [] },
        );
        assertRejected(
          await kernel.execute(
            cmd('saveChatHistory', /** @type {any} */ ({ chat: 'side', history: [], messages: [] })),
          ),
          'validation',
          'invalid-command',
        );
      });

      it('savePromptTemplates writes the templates, and a chat write that fails is unavailable', async () => {
        const templates = [{ id: 't1', label: 'Sum', prompt: 'Summarize', scope: 'note' }];
        assert.deepEqual((await run(cmd('savePromptTemplates', { templates }))).changedIds, ['aiPromptTemplates']);
        assert.deepEqual(await settingsIn('chat', ['aiPromptTemplates']), { aiPromptTemplates: templates });
        ctx.failNextWrite('chat');
        const failed = await kernel.execute(cmd('savePromptTemplates', { templates: [] }));
        assert.equal(failed.kind, 'unavailable', JSON.stringify(failed));
        assert.deepEqual(await settingsIn('chat', ['aiPromptTemplates']), { aiPromptTemplates: templates });
      });

      it('saveTheme makes a theme, then a save of it replaces its name and properties and keeps the rest', async () => {
        const made = await run(
          cmd('saveTheme', { themeId: 'th1', name: 'Dusk', properties: { '--bg-primary': '#101010' } }),
        );
        assert.deepEqual(made.changedIds, ['th1']);
        assert.ok(!JSON.stringify(made).includes('Dusk'), 'the outcome carries no theme name');
        assert.deepEqual(await themeOf('th1'), {
          id: 'th1',
          name: 'Dusk',
          properties: { '--bg-primary': '#101010' },
          updatedAt: NOW,
        });
        ctx.clock.advance(1000);
        await run(cmd('saveTheme', { themeId: 'th1', name: 'Dawn', properties: { '--bg-primary': '#fafafa' } }));
        assert.deepEqual(await themeOf('th1'), {
          id: 'th1',
          name: 'Dawn',
          properties: { '--bg-primary': '#fafafa' },
          updatedAt: NOW + 1000,
        });
        assertRejected(
          await kernel.execute(
            cmd('saveTheme', /** @type {any} */ ({ themeId: 'th2', name: 'Bad', properties: { color: 'red' } })),
          ),
          'validation',
          'invalid-command',
        );
        assert.equal(await themeOf('th2'), undefined);
      });

      it('completeOnboarding, recordBackup, and recordExportNotice write their keys, stamped by the kernel clock', async () => {
        assert.deepEqual((await run(cmd('completeOnboarding', {}))).changedIds, ['hasCompletedOnboarding']);
        assert.deepEqual(await settingsIn('onboarding', ['hasCompletedOnboarding']), { hasCompletedOnboarding: true });

        // Export JSON: the receipt and the backup time, in one write
        assert.deepEqual((await run(cmd('recordBackup', { fullExport: true, backup: true }))).changedIds, [
          'lastFullExportAt',
          'lastBackupAt',
        ]);
        ctx.clock.advance(500);
        // The Markdown ZIP: the backup time only
        await run(cmd('recordBackup', { fullExport: false, backup: true }));
        assert.deepEqual(await settingsIn('backup', ['lastFullExportAt', 'lastBackupAt']), {
          lastFullExportAt: NOW,
          lastBackupAt: NOW + 500,
        });
        assertRejected(
          await kernel.execute(cmd('recordBackup', { fullExport: false, backup: false })),
          'validation',
          'invalid-command',
        );

        await run(cmd('recordExportNotice', { version: 1, outcome: 'dismissed' }));
        assert.deepEqual(await settingsIn('backup', ['preMigrationNotice']), {
          preMigrationNotice: { version: 1, outcome: 'dismissed', at: NOW + 500 },
        });
      });

      it("snoozeSpaceNotice puts the space notice off from the kernel clock's now, and getWorkspaceData reads it back (#17 PR 1b)", async () => {
        assert.deepEqual((await run(cmd('snoozeSpaceNotice', {}))).changedIds, ['spaceNoticeSnoozedAt']);
        assert.deepEqual(await settingsIn('upgrade', ['spaceNoticeSnoozedAt']), { spaceNoticeSnoozedAt: NOW });
        const read = await kernel.query({ type: 'getWorkspaceData', keys: ['spaceNoticeSnoozedAt', 'storageUpgrade'] });
        assert.equal(read.kind, 'ready');
        assert.deepEqual(/** @type {any} */ (read).data, { spaceNoticeSnoozedAt: NOW });
      });

      it(
        flags.backups
          ? "backups: createAutoBackup and importBackup run 1.4.x's Storage code, and an import counts only what committed"
          : 'no backups: createAutoBackup and importBackup are unavailable and write nothing',
        async () => {
          const backup = {
            version: 1,
            exportedAt: 1,
            canvases: [{ id: 'p1', name: 'From the file', createdAt: 1, updatedAt: 1 }],
            elements: [{ id: 'pb1', canvasId: 'p1', type: 'text', content: 'Line', order: 0 }],
            folders: [{ id: 'pf1', name: 'Filed', parentId: null }],
          };
          const before = await idsIn('active');
          const auto = await kernel.execute(cmd('createAutoBackup', {}));
          const imported = await kernel.execute(cmd('importBackup', { mode: 'merge', backup }));
          if (!flags.backups) {
            for (const outcome of [auto, imported]) {
              assert.deepEqual(
                outcome.kind === 'unavailable' && [outcome.cause, outcome.code, outcome.retryable],
                ['adapter', 'backups-need-legacy-storage', false],
                JSON.stringify(outcome),
              );
            }
            assert.deepEqual(await idsIn('active'), before);
            assert.deepEqual(await settingsIn('backup', ['lastBackupAt']), {});
            return;
          }
          assert.deepEqual(committedOf(auto).changedIds, ['lastBackupAt']);
          assert.equal(typeof (await settingsIn('backup', ['lastBackupAt'])).lastBackupAt, 'number');
          // The note it added, under a new id, then the folder it added
          const [noteId, folderId, ...rest] = committedOf(imported).changedIds;
          assert.deepEqual([folderId, rest], ['pf1', []]);
          assert.notEqual(noteId, 'p1');
          assert.equal((await noteOf(noteId))?.name, 'From the file');
          assert.deepEqual(
            (await blocksOf(noteId)).map(block => block.content),
            ['Line'],
          );
          assert.ok(!JSON.stringify(imported).includes('From the file'), 'the outcome carries no note text');

          // A file 1.4.x's import refuses is a rejection, and nothing is added
          const listed = await idsIn('active');
          assertRejected(
            await kernel.execute(cmd('importBackup', { mode: 'replace', backup: { ...backup, version: 2 } })),
            'validation',
            'import-invalid',
          );
          assert.deepEqual(await idsIn('active'), listed);
        },
      );

      it('runs from the new tab only', async () => {
        const popup = ctx.kernel(CALLERS.popup);
        for (const command of [
          cmd('saveChatHistory', { chat: 'note', history: [], messages: [] }),
          cmd('savePromptTemplates', { templates: [] }),
          cmd('saveTheme', { themeId: 'th1', name: 'Dusk', properties: {} }),
          cmd('completeOnboarding', {}),
          cmd('recordBackup', { fullExport: true, backup: true }),
          cmd('recordExportNotice', { version: 1, outcome: 'exported' }),
          cmd('createAutoBackup', {}),
          cmd('importBackup', { mode: 'merge', backup: { version: 1, canvases: [], elements: [] } }),
        ]) {
          assert.equal((await popup.execute(command)).kind, 'rejected', command.type);
        }
        assert.deepEqual(await settingsIn('onboarding', ['hasCompletedOnboarding']), {});
      });
    });

    describe("the reads the new tab's controllers make in place of Storage (#12 slice 7)", () => {
      it("getWorkspaceData reads each key from the area its command writes, and leaves out what isn't stored", async () => {
        assert.equal((await kernel.query({ type: 'getWorkspaceData' })).kind, 'empty');
        const history = [{ role: 'user', content: 'Plan the week' }];
        const templates = [{ id: 't1', label: 'Sum', prompt: 'Summarize', scope: 'note' }];
        await run(cmd('saveChatHistory', { chat: 'note', history, messages: [] }));
        await run(cmd('savePromptTemplates', { templates }));
        await run(cmd('completeOnboarding', {}));
        await run(cmd('recordBackup', { fullExport: false, backup: true }));
        await run(cmd('recordExportNotice', { version: 1, outcome: 'dismissed' }));
        const some = await kernel.query({
          type: 'getWorkspaceData',
          keys: [
            'aiChatHistory',
            'globalChatHistory',
            'aiPromptTemplates',
            'hasCompletedOnboarding',
            'lastFullExportAt',
            'lastBackupAt',
            'preMigrationNotice',
          ],
        });
        assert.deepEqual(some.kind === 'ready' && some.data, {
          aiChatHistory: history,
          aiPromptTemplates: templates,
          hasCompletedOnboarding: true,
          lastBackupAt: NOW,
          preMigrationNotice: { version: 1, outcome: 'dismissed', at: NOW },
        });
        const all = await kernel.query({ type: 'getWorkspaceData' });
        assert.deepEqual(all.kind === 'ready' && Object.keys(all.data).sort(), [
          'aiChatHistory',
          'aiPromptTemplates',
          'hasCompletedOnboarding',
          'lastBackupAt',
          'noteChatMessages',
          'preMigrationNotice',
        ]);
        assert.deepEqual(await kernel.query({ type: 'getWorkspaceData', keys: [/** @type {any} */ ('theme')] }), {
          kind: 'failed',
          cause: 'validation',
          code: 'unknown-workspace-data',
        });
      });

      it('listThemes lists the custom themes, the last saved first', async () => {
        assert.equal((await kernel.query({ type: 'listThemes' })).kind, 'empty');
        await run(cmd('saveTheme', { themeId: 'th1', name: 'Dusk', properties: { '--bg-primary': '#101010' } }));
        ctx.clock.advance(1000);
        await run(cmd('saveTheme', { themeId: 'th2', name: 'Dawn', properties: {} }));
        ctx.clock.advance(1000);
        // A save of Dusk makes it the last saved again
        await run(cmd('saveTheme', { themeId: 'th1', name: 'Dusk', properties: { '--bg-primary': '#202020' } }));
        const state = await kernel.query({ type: 'listThemes' });
        assert.deepEqual(state.kind === 'ready' && state.data.map(theme => [theme.id, theme.name, theme.updatedAt]), [
          ['th1', 'Dusk', NOW + 2000],
          ['th2', 'Dawn', NOW + 1000],
        ]);
      });

      it(
        flags.backups
          ? "exportBackup makes 1.4.x's export file, with Create Backup's fields when it asks for them"
          : 'no backups: exportBackup is failed',
        async () => {
          const noteId = await createNote({ name: 'Plan', blocks: [{ id: 'b1', type: 'text', content: 'Line' }] });
          const plain = await kernel.query({ type: 'exportBackup', backup: false });
          if (!flags.backups) {
            assert.deepEqual(plain, { kind: 'failed', cause: 'adapter', code: 'backups-need-legacy-storage' });
            return;
          }
          assert.equal(plain.kind, 'ready', JSON.stringify(plain));
          const file = JSON.parse(await /** @type {Blob} */ (plain.kind === 'ready' && plain.data).text());
          assert.deepEqual(Object.keys(file), ['version', 'exportedAt', 'canvases', 'elements', 'media', 'folders']);
          assert.deepEqual(
            file.canvases.map(/** @param {NoteRecord} note */ note => note.id),
            [noteId],
          );
          assert.deepEqual(
            file.elements.map(/** @param {BlockRecord} block */ block => block.content),
            ['Line'],
          );
          const backup = await kernel.query({ type: 'exportBackup', backup: true });
          const backupFile = JSON.parse(await /** @type {Blob} */ (backup.kind === 'ready' && backup.data).text());
          assert.deepEqual(Object.keys(backupFile).slice(-3), ['backupType', 'backupCreatedAt', 'backupVersion']);
          assert.deepEqual(
            [backupFile.backupType, backupFile.backupCreatedAt, backupFile.backupVersion],
            ['full-backup', new Date(NOW).toISOString(), 1],
          );
        },
      );

      it('profileHoldsContent is false until a note outside trash has a title or a block that holds something', async () => {
        const holds = async () => {
          const state = await kernel.query({ type: 'profileHoldsContent' });
          assert.equal(state.kind, 'ready', JSON.stringify(state));
          return state.kind === 'ready' && state.data;
        };
        assert.equal(await holds(), false);
        await createNote({ name: 'Untitled 2', blocks: [{ id: 'b0', type: 'text', content: '<br>&nbsp; ' }] });
        assert.equal(await holds(), false, 'an untitled note of empty text blocks holds nothing');
        const titled = await createNote({ name: 'Plan' });
        assert.equal(await holds(), true);
        await run(cmd('trashNote', { noteId: titled }));
        assert.equal(await holds(), false, 'a note in trash is not exported');
        const divider = await createNote({ name: '', blocks: [{ id: 'b1', type: 'divider' }] });
        assert.equal(await holds(), true, 'a block that is not text holds something');
        await run(cmd('trashNote', { noteId: divider }));
        const template = await createNote({ name: 'Weekly' });
        await run(cmd('convertNoteToTemplate', { noteId: template }));
        assert.equal(await holds(), true, 'a template is exported too');
      });

      it('runs from the new tab only', async () => {
        for (const surface of /** @type {const} */ (['popup', 'sidepanel'])) {
          const reader = ctx.kernel(CALLERS[surface]);
          for (const query of /** @type {any[]} */ ([
            { type: 'getWorkspaceData' },
            { type: 'listThemes' },
            { type: 'exportBackup', backup: false },
            { type: 'profileHoldsContent' },
          ])) {
            assert.deepEqual(
              await reader.query(query),
              { kind: 'failed', cause: 'policy', code: 'not-on-surface' },
              surface + ' ' + query.type,
            );
          }
        }
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

      it("lists Popup's view by archivedAt and trashedAt, templates included, and Side Panel's with every note", async () => {
        await createNote({ noteId: 'kept', name: 'Kept' });
        ctx.clock.advance();
        await createNote({ noteId: 'arch', name: 'Archived' });
        await run(cmd('archiveNote', { noteId: 'arch' }));
        ctx.clock.advance();
        await createNote({ noteId: 'gone', name: 'Trashed' });
        await run(cmd('trashNote', { noteId: 'gone' }));
        ctx.clock.advance();
        await seed('notes', [
          { ...storageNote('template', 'Template', ctx.clock.now()), isTemplate: true },
          { ...storageNote('flags', 'Flags only', ctx.clock.advance()), archived: true, trashed: true },
        ]);
        assert.deepEqual(await idsIn('popup'), ['flags', 'template', 'kept']);
        assert.deepEqual(await idsIn('sidePanel'), ['flags', 'template', 'gone', 'arch', 'kept']);
        for (const caller of [CALLERS.popup, CALLERS.sidepanel]) {
          const state = await ctx.kernel(caller).query({ type: 'listNotes', view: 'popup' });
          assert.equal(state.kind, 'ready');
        }
      });

      it("answers Popup's insightsEnabled from IndexedDB's settings store, and only to Popup", async () => {
        const popup = ctx.kernel(CALLERS.popup);
        const unset = { kind: 'ready', asOf: NOW, data: { insightsEnabled: false } };
        assert.deepEqual(await popup.query({ type: 'getPopupInsightsEnabled' }), unset);
        // The setting the new tab saves lives with the preferences, which this doesn't read
        committedOf(await run(cmd('setPreferences', { values: { insightsEnabled: true } })));
        assert.deepEqual(await popup.query({ type: 'getPopupInsightsEnabled' }), unset);
        for (const caller of [CALLERS.newtab, CALLERS.sidepanel]) {
          assert.deepEqual(await ctx.kernel(caller).query({ type: 'getPopupInsightsEnabled' }), {
            kind: 'failed',
            cause: 'policy',
            code: 'not-on-surface',
          });
        }
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

      it('getBacklinks lists the notes that link to a note, in the order the links are stored, whatever list they are in', async () => {
        await createNote({ noteId: 'target', name: 'Target' });
        for (const noteId of ['plain', 'archived', 'trashed']) {
          await createNote({ noteId, name: `Links from ${noteId}` });
          await run(
            cmd('saveNoteContent', { noteId, blocks: someBlocks(noteId, 1), linkedNames: ['target', 'Elsewhere'] }),
          );
        }
        await run(cmd('archiveNote', { noteId: 'archived' }));
        await run(cmd('trashNote', { noteId: 'trashed' }));
        // A link from a note deleted since, and one that names no note, are left out
        await seed('links', [
          { id: 'from-gone', fromNoteId: 'gone', toNoteId: 'target', createdAt: NOW },
          { id: 'from-nothing', toNoteId: 'target', createdAt: NOW },
        ]);
        const state = await kernel.query({ type: 'getBacklinks', noteId: 'target' });
        assert.equal(state.kind, 'ready', JSON.stringify(state));
        const links = await ctx.adapter.read(['links'], tx => tx.getAllByIndex('links', 'toNoteId', 'target'));
        const inLinkOrder = links
          .map(link => link.fromNoteId)
          .filter(/** @returns {id is string} */ id => typeof id === 'string' && id !== 'gone');
        assert.deepEqual(state.kind === 'ready' && state.data.map(note => note.id), inLinkOrder);
        assert.deepEqual([...inLinkOrder].sort(), ['archived', 'plain', 'trashed']);
        assert.deepEqual(state.kind === 'ready' && state.data[0], await storedNoteOf(inLinkOrder[0]));
        assert.deepEqual(await kernel.query({ type: 'getBacklinks', noteId: 'plain' }), { kind: 'empty', asOf: NOW });
        assert.deepEqual(await kernel.query(/** @type {any} */ ({ type: 'getBacklinks', noteId: '' })), {
          kind: 'failed',
          cause: 'validation',
          code: 'invalid-query',
        });
      });

      it('getNoteList reads every note, folder, and search entry, whatever list each note is in', async () => {
        assert.deepEqual(await kernel.query({ type: 'getNoteList' }), { kind: 'empty', asOf: NOW });
        await run(cmd('createFolder', { folderId: 'f1', name: 'Work', parentId: null }));
        for (const noteId of ['plain', 'archived', 'trashed']) await createNote({ noteId, name: `Note ${noteId}` });
        await run(cmd('archiveNote', { noteId: 'archived' }));
        await run(cmd('trashNote', { noteId: 'trashed' }));
        // A template, which no command makes yet, and a note with no search entry
        await seed('notes', [{ ...storageNote('template', 'Template', NOW), isTemplate: true }]);
        const state = await kernel.query({ type: 'getNoteList' });
        assert.equal(state.kind, 'ready', JSON.stringify(state));
        const list = state.kind === 'ready' ? state.data : { notes: [], folders: [], searchEntries: [] };
        assert.deepEqual(Object.keys(list).sort(), ['folders', 'notes', 'searchEntries']);
        const byId = (/** @type {Array<{id: string}>} */ records) =>
          [...records].sort((a, b) => a.id.localeCompare(b.id));
        assert.deepEqual(
          byId(list.notes),
          byId(
            await Promise.all(
              ['archived', 'plain', 'template', 'trashed'].map(
                async id => /** @type {NoteRecord} */ (await storedNoteOf(id)),
              ),
            ),
          ),
        );
        assert.deepEqual(list.folders, await ctx.adapter.read(['folders'], tx => tx.getAll('folders')));
        assert.deepEqual(list.searchEntries.map(entry => entry.noteId).sort(), ['archived', 'plain', 'trashed']);
        assert.deepEqual(
          list.searchEntries.find(entry => entry.noteId === 'plain'),
          await searchEntryOf('plain'),
        );
      });

      it('getNotesByIds reads the stored notes it names and their search entries, and leaves out the gone ones', async () => {
        for (const noteId of ['n1', 'n2', 'n3']) await createNote({ noteId, name: `Note ${noteId}` });
        await run(cmd('trashNote', { noteId: 'n3' }));
        await seed('notes', [storageNote('no-entry', 'No entry', NOW)]);
        const state = await kernel.query({ type: 'getNotesByIds', noteIds: ['n2', 'gone', 'n3', 'no-entry', 'n2'] });
        assert.equal(state.kind, 'ready', JSON.stringify(state));
        const found = state.kind === 'ready' ? state.data : { notes: [], searchEntries: [] };
        assert.deepEqual(
          found.notes.map(note => note.id),
          ['n2', 'n3', 'no-entry'],
        );
        assert.deepEqual(found.notes[0], await storedNoteOf('n2'));
        assert.deepEqual(found.searchEntries, [await searchEntryOf('n2'), await searchEntryOf('n3')]);
        assert.deepEqual(await kernel.query({ type: 'getNotesByIds', noteIds: ['gone'] }), {
          kind: 'empty',
          asOf: NOW,
        });
        for (const noteIds of [[], [''], 'n1', null]) {
          assert.deepEqual(
            await kernel.query(/** @type {any} */ ({ type: 'getNotesByIds', noteIds })),
            { kind: 'failed', cause: 'validation', code: 'invalid-query' },
            JSON.stringify(noteIds),
          );
        }
      });

      it('listSearchEntries reads every search entry and no note', async () => {
        assert.deepEqual(await kernel.query({ type: 'listSearchEntries' }), { kind: 'empty', asOf: NOW });
        for (const noteId of ['n1', 'n2']) await createNote({ noteId, name: `Note ${noteId}` });
        await seed('notes', [storageNote('no-entry', 'No entry', NOW)]);
        const state = await kernel.query({ type: 'listSearchEntries' });
        assert.equal(state.kind, 'ready', JSON.stringify(state));
        const entries = state.kind === 'ready' ? state.data : [];
        assert.deepEqual(
          [...entries].sort((a, b) => a.noteId.localeCompare(b.noteId)),
          [await searchEntryOf('n1'), await searchEntryOf('n2')],
        );
      });

      it('getNoteList, getNotesByIds, and listSearchEntries answer only the new tab', async () => {
        await createNote({ noteId: 'n1' });
        for (const caller of [CALLERS.popup, CALLERS.sidepanel]) {
          const other = ctx.kernel(caller);
          /** @type {Array<import('../../js/kernel/core/contracts/queries.js').QueryOf<'getNoteList' | 'getNotesByIds' | 'listSearchEntries'>>} */
          const queries = [
            { type: 'getNoteList' },
            { type: 'getNotesByIds', noteIds: ['n1'] },
            { type: 'listSearchEntries' },
          ];
          for (const query of queries) {
            const state = await other.query(query);
            assert.equal(state.kind, 'failed', `${caller.surface} ${query.type}`);
            assert.equal(state.kind === 'failed' && state.cause, 'policy');
          }
        }
      });

      it(
        'getNoteList reads a store an older profile lacks as empty',
        { skip: fixture.startWithout ? false : 'only a database an older 1.x profile left can lack stores' },
        async () => {
          const startWithout = /** @type {NonNullable<ContractFixture['startWithout']>} */ (fixture.startWithout);
          const other = await startWithout(['folders', 'searchIndex']);
          try {
            const tab = other.kernel();
            committedOf(await tab.execute(newCommand(other.ids, 'createNote', { noteId: 'n1', name: 'Plan' })));
            const state = await tab.query({ type: 'getNoteList' });
            assert.equal(state.kind, 'ready', JSON.stringify(state));
            const list = state.kind === 'ready' ? state.data : { notes: [], folders: [], searchEntries: [] };
            assert.deepEqual([list.notes.map(note => note.id), list.folders, list.searchEntries], [['n1'], [], []]);
            const byIds = await tab.query({ type: 'getNotesByIds', noteIds: ['n1'] });
            assert.deepEqual(byIds.kind === 'ready' && byIds.data.searchEntries, []);
          } finally {
            await other.close();
          }
        },
      );

      it('refuses an index read by anything but an id, since IndexedDB reads null as every record', async () => {
        await createNote({ noteId: 'n1', blocks: someBlocks('n1', 2) });
        await createNote({ noteId: 'n2', blocks: someBlocks('n2', 1) });
        for (const value of [null, undefined, '', 0, true, {}]) {
          for (const read of /** @type {const} */ (['getAllByIndex', 'getKeysByIndex'])) {
            await assert.rejects(
              ctx.adapter.read(['blocks'], tx => /** @type {any} */ (tx)[read]('blocks', 'canvasId', value)),
              error => {
                const { unavailableCause, code, retryable } = /** @type {any} */ (error);
                return unavailableCause === 'adapter' && code === 'invalid-key' && retryable === false;
              },
              `${read}(${JSON.stringify(value)})`,
            );
          }
        }
        const keys = await ctx.adapter.read(['blocks'], tx => tx.getKeysByIndex('blocks', 'canvasId', 'n1'));
        assert.equal(keys.length, 2);
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
        await run(cmd('setInsightsPending', { noteId: 'n1', pending: true }));
        await new Promise(resolve => setImmediate(resolve));
        assert.deepEqual(
          seen.map(({ event }) => ({ ...event, ids: [...event.ids] })),
          [
            { aggregate: 'note', ids: ['n1'] },
            { aggregate: 'note', ids: ['n1'] },
            { aggregate: 'preferences', ids: ['theme'] },
            // The jobs' bookkeeping has its own aggregate, so a note list ignores it
            { aggregate: 'job', ids: ['n1'] },
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

      it("refuses what #13's JSON codec refuses: Dates, BigInts, and numbers JSON can't hold", async () => {
        for (const name of [new Date(NOW), 10n, NaN, Infinity]) {
          const command = /** @type {any} */ (cmd('createNote', { noteId: 'n1' }));
          command.name = name;
          assertRejected(await kernel.execute(command), 'validation', 'not-cloneable');
        }
        assert.equal(await noteOf('n1'), undefined);
      });

      it('keeps an own __proto__ key from JSON.parse as data, so the command commits as sent', async () => {
        const sent = '{"openTabs":[{"__proto__":{"pinned":true},"noteId":"n1"}],"activeTabIndex":0}';
        const session = JSON.parse(sent);
        committedOf(await kernel.execute(cmd('saveWorkspaceSession', { session })));
        const state = await kernel.query({ type: 'getWorkspaceSession' });
        assert.equal(JSON.stringify(state.kind === 'ready' && state.data), sent);
      });

      it('every catalog command is one this suite runs', () => {
        assert.deepEqual([...COMMAND_TYPES].sort(), [
          'applyDerivedTitle',
          'archiveNote',
          'attachInsights',
          'captureToDailyNote',
          'completeOnboarding',
          'convertNoteToTemplate',
          'convertTemplateToNote',
          'createAutoBackup',
          'createFolder',
          'createNote',
          'deleteBlocks',
          'deleteFolder',
          'deleteNotePermanently',
          'emptyTrash',
          'ensureDailyNote',
          'importBackup',
          'insertBlocks',
          'moveFolder',
          'moveNoteToFolder',
          'recordBackup',
          'recordExportNotice',
          'recordJobRun',
          'renameFolder',
          'renameNote',
          'restoreNote',
          'restoreSnapshot',
          'runBulkAction',
          'runIntegrityCheck',
          'runStartupMaintenance',
          'runTrashCleanup',
          'saveChatHistory',
          'saveNoteContent',
          'savePromptTemplates',
          'saveSnapshot',
          'saveTheme',
          'saveWorkspaceSession',
          'setFolderCollapsed',
          'setInsightsPending',
          'setPinned',
          'setPreferences',
          'snoozeSpaceNotice',
          'trashNote',
          'unarchiveNote',
        ]);
      });
    });

    describe('write scopes (#17: content, placement, derived)', () => {
      /** @typedef {import('../../js/kernel/core/ports/repository.js').WriteScope} WriteScope */
      /** @typedef {import('../../js/kernel/core/ports/repository.js').Tx} Tx */
      /** @typedef {import('../../js/kernel/core/ports/repository.js').Unit} Unit */

      /**
       * Commits one unit straight to the adapter as a command of `scope` would, with `noteId`
       * as the record its outcome reports
       * @param {WriteScope} scope
       * @param {string} noteId
       * @param {(tx: Tx) => Promise<void>} run
       * @param {{revised?: () => boolean}} [options]
       */
      const commitScoped = async (scope, noteId, run, { revised } = {}) => {
        const command = /** @type {Command} */ ({ type: 'attachInsights', commandId: ctx.ids.next(), noteId });
        /** @type {Unit} */
        const unit = { stores: ['notes', 'blocks'], run };
        const work = unitsWork(command, [unit], () => committed('scoped', [noteId]), {
          scope,
          primary: () => ({ store: 'notes', key: noteId }),
          ...(revised ? { revised } : {}),
        });
        return (await ctx.adapter.commit(work)).outcome;
      };

      /** @param {Outcome} outcome */
      const assertOutsideScope = outcome => {
        assert.deepEqual(
          outcome.kind === 'unavailable' && [outcome.cause, outcome.code, outcome.retryable],
          ['adapter', 'write-outside-scope', false],
          JSON.stringify(outcome),
        );
      };

      it("a derived write can't change a note's name, placement, lifecycle, or updatedAt, and writes nothing when it tries", async () => {
        await createNote({ noteId: 'n1', name: 'Plan', blocks: someBlocks('n1', 1) });
        const before = await noteOf('n1');
        for (const change of [
          { name: 'Renamed' },
          { titleManuallySet: true },
          { pinned: true },
          { folderId: 'f1' },
          { isTemplate: true },
          { isDaily: true, dateStr: '2026-10-20' },
          { archived: true, archivedAt: NOW },
          { trashed: true, trashedAt: NOW },
          { updatedAt: NOW + 5000 },
        ]) {
          const outcome = await commitScoped('derived', 'n1', async tx => {
            const note = await tx.get('notes', 'n1');
            if (note) tx.put('notes', { ...note, insights: { todos: ['Call'] }, ...change });
          });
          assertOutsideScope(outcome);
          assert.deepEqual(await noteOf('n1'), before, JSON.stringify(change));
        }
      });

      it("a derived write can't change a field by changing the record it read in place", async () => {
        await createNote({ noteId: 'n1', name: 'Plan' });
        const before = await noteOf('n1');
        assert.ok(before && typeof before.viewport === 'object' && typeof before.settings === 'object');
        /** @type {Array<[string, (note: Record<string, any>) => void]>} */
        const changes = [
          ['viewport', note => (note.viewport.scale = 9)],
          ['settings', note => (note.settings.gridType = 'none')],
          ['name', note => (note.name = 'Renamed')],
        ];
        for (const [field, change] of changes) {
          const outcome = await commitScoped('derived', 'n1', async tx => {
            const note = await tx.get('notes', 'n1');
            if (!note) return;
            change(note);
            tx.put('notes', { ...note, preview: 'P' });
          });
          assertOutsideScope(outcome);
          assert.deepEqual(await noteOf('n1'), before, field);
        }
      });

      it('a derived write changes the derived fields it carries, and nothing else it may touch', async () => {
        await createNote({ noteId: 'n1', name: 'Plan', blocks: someBlocks('n1', 1) });
        const before = await noteOf('n1');
        const derived = {
          insights: { todos: ['Call'] },
          lastInsightsExtractedAt: NOW,
          lastInsightsContentHash: 'h1',
          preview: 'Line 0',
          todoProgress: { completed: 0, total: 1 },
        };
        committedOf(
          await commitScoped('derived', 'n1', async tx => {
            const note = await tx.get('notes', 'n1');
            if (note) tx.put('notes', { ...note, ...derived });
          }),
        );
        assert.deepEqual(await noteOf('n1'), { ...before, ...derived });
        // A block is content, and deleting the note is its lifecycle
        assertOutsideScope(
          await commitScoped('derived', 'n1', async tx => {
            await tx.get('notes', 'n1');
            tx.put('blocks', { ...someBlocks('n1', 1)[0], content: 'Rewritten' });
          }),
        );
        assertOutsideScope(
          await commitScoped('derived', 'n1', async tx => {
            await tx.get('notes', 'n1');
            tx.delete('notes', 'n1');
          }),
        );
        // A note it didn't read in its own transaction can't be checked, so it's refused
        assertOutsideScope(
          await commitScoped('derived', 'n1', async tx => {
            tx.put('notes', { ...before, id: 'n1', insights: null });
          }),
        );
        assert.deepEqual(await noteOf('n1'), { ...before, ...derived });
        assert.equal((await blocksOf('n1'))[0].content, 'Line 0');
      });

      it(
        flags.revisions
          ? 'revisions: placement and derived writes leave the content revision where it was, even when they say they changed it'
          : 'no revisions: placement and derived writes report no revision',
        async () => {
          const created = await run(cmd('createNote', { noteId: 'n1', name: 'Plan' }));
          const revised = () => true;
          for (const scope of /** @type {const} */ (['placement', 'derived'])) {
            const outcome = committedOf(
              await commitScoped(
                scope,
                'n1',
                async tx => {
                  const note = await tx.get('notes', 'n1');
                  if (note)
                    tx.put('notes', scope === 'placement' ? { ...note, pinned: true } : { ...note, preview: 'P' });
                },
                { revised },
              ),
            );
            assert.equal(outcome.revision, created.revision, scope);
          }
          const folder = await run(cmd('createFolder', { folderId: 'f1', name: 'Work', parentId: null }));
          await run(cmd('createFolder', { folderId: 'f2', name: 'Home', parentId: null }));
          // Filing a folder is placement too
          const moved = await run(cmd('moveFolder', { folderId: 'f1', parentId: 'f2' }));
          assert.equal(moved.revision, folder.revision);
        },
      );

      it('folders carry no versions: no folder command reports a revision, on any adapter (#17 PR 2a)', async () => {
        const outcomes = [
          await run(cmd('createFolder', { folderId: 'f1', name: 'Work', parentId: null })),
          await run(cmd('renameFolder', { folderId: 'f1', name: 'Work 2' })),
          await run(cmd('createFolder', { folderId: 'f2', name: 'Home', parentId: null })),
          await run(cmd('moveFolder', { folderId: 'f1', parentId: 'f2' })),
          await run(cmd('setFolderCollapsed', { folderId: 'f1', collapsed: true })),
          await run(cmd('deleteFolder', { folderId: 'f2' })),
        ];
        assert.deepEqual(
          outcomes.map(outcome => [outcome.code, outcome.revision]),
          [
            ['folder-created', undefined],
            ['folder-renamed', undefined],
            ['folder-created', undefined],
            ['folder-moved', undefined],
            ['folder-collapsed', undefined],
            ['folder-deleted', undefined],
          ],
        );
      });
    });

    describe(`adapter flags: ${JSON.stringify(flags)}`, () => {
      it('the adapter reports the flags its fixture documents', () => {
        assert.deepEqual({ ...kernel.flags }, { ...flags });
      });

      it(
        flags.revisions
          ? 'revisions: committed outcomes report the revision, and a stale expectedRevision is a conflict that changes nothing in the note or its blocks'
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
          // A note deleted and made again under its id carries on past its last revision, as
          // #17's tombstone keeps it, so a save loaded before the delete is a conflict
          const before = await revisionAfter(cmd('createNote', { noteId: 'n2' }));
          assert.equal((await run(cmd('trashNote', { noteId: 'n2' }))).code, 'note-deleted');
          const again = await revisionAfter(cmd('createNote', { noteId: 'n2', blocks: someBlocks('n2', 1) }));
          const stale = await kernel.execute(
            cmd('saveNoteContent', {
              noteId: 'n2',
              blocks: [{ ...someBlocks('n2', 1)[0], content: 'Loaded before the delete' }],
              expectedRevision: before ?? 1,
            }),
          );
          if (flags.revisions) {
            assert.ok(typeof before === 'number' && typeof again === 'number' && again > before, `${before}, ${again}`);
            assert.equal(stale.kind, 'conflict', JSON.stringify(stale));
            assert.equal((await blocksOf('n2'))[0].content, 'Line 0');
          } else {
            assert.deepEqual([before, again], [undefined, undefined]);
            committedOf(stale);
          }
        },
      );

      it(
        flags.revisions
          ? 'revisions: a title set to the one it has leaves the revision where it was, so the next save commits'
          : 'no revisions: a title set to the one it has commits, with no revision',
        async () => {
          const created = await run(cmd('createNote', { noteId: 'n1', name: 'Plan' }));
          const renamed = await run(cmd('renameNote', { noteId: 'n1', name: 'Plan' }));
          const derived = await run(cmd('applyDerivedTitle', { noteId: 'n1', name: 'Plan' }));
          assert.deepEqual([renamed.revision, derived.revision], [created.revision, created.revision]);
          const save = await kernel.execute(
            cmd('saveNoteContent', {
              noteId: 'n1',
              blocks: someBlocks('n1', 1),
              expectedRevision: created.revision ?? 1,
            }),
          );
          committedOf(save);
        },
      );

      it(
        flags.revisions
          ? 'revisions: each command that takes an expected version is a conflict when the note has moved past it, and changes nothing'
          : 'no revisions: a command sent with an expected version the note moved past commits (the last write wins)',
        async () => {
          await createNote({ noteId: 'n1', name: 'Plan', blocks: someBlocks('n1', 2) });
          const loaded = await kernel.query({ type: 'getNote', noteId: 'n1' });
          const { revision, placementVersion } =
            loaded.kind === 'ready' ? loaded.data : { revision: undefined, placementVersion: undefined };
          if (flags.revisions) assert.deepEqual([revision, placementVersion], [1, 0]);
          else assert.deepEqual([revision, placementVersion], [undefined, undefined]);
          // Another context renames it and pins it, so both its versions move past what was loaded
          await run(cmd('renameNote', { noteId: 'n1', name: 'Renamed' }));
          await run(cmd('setPinned', { noteId: 'n1', pinned: true }));
          const before = await noteOf('n1');
          const stale = /** @type {Command[]} */ ([
            cmd('renameNote', { noteId: 'n1', name: 'Mine', expectedRevision: 1 }),
            cmd('deleteBlocks', { noteId: 'n1', blockIds: ['n1-block-0'], expectedRevision: 1 }),
            cmd('saveNoteContent', { noteId: 'n1', blocks: someBlocks('n1', 1), expectedRevision: 1 }),
            cmd('setPinned', { noteId: 'n1', pinned: false, expectedPlacementVersion: 0 }),
            cmd('archiveNote', { noteId: 'n1', expectedPlacementVersion: 0 }),
            cmd('trashNote', { noteId: 'n1', expectedPlacementVersion: 0 }),
            cmd('moveNoteToFolder', { noteId: 'n1', folderId: null, expectedPlacementVersion: 0 }),
            cmd('convertNoteToTemplate', { noteId: 'n1', expectedPlacementVersion: 0 }),
          ]);
          if (!flags.revisions) {
            for (const command of stale) committedOf(await kernel.execute(command));
            return;
          }
          for (const command of stale) {
            const outcome = await kernel.execute(command);
            const content = 'expectedRevision' in command;
            assert.deepEqual(
              outcome.kind === 'conflict' && [outcome.code, outcome.currentRevision],
              content ? ['revision-conflict', 2] : ['placement-conflict', 1],
              `${command.type}: ${JSON.stringify(outcome)}`,
            );
          }
          assert.deepEqual(await noteOf('n1'), before);
          assert.equal((await blocksOf('n1')).length, 2);
          assert.ok(ctx.conflicts);
          assert.deepEqual(
            (await ctx.conflicts()).map(kept => kept.commandId).sort(),
            stale.map(command => command.commandId).sort(),
          );
          // Sent with the versions it has now, each commits
          committedOf(await kernel.execute(cmd('renameNote', { noteId: 'n1', name: 'Mine', expectedRevision: 2 })));
          committedOf(await kernel.execute(cmd('archiveNote', { noteId: 'n1', expectedPlacementVersion: 1 })));
        },
      );

      it(
        flags.revisions
          ? 'revisions: a note no command moved has versions 0, and placement commands move only the placement version'
          : 'no revisions: getNote reports no versions',
        async () => {
          // A note as 1.4.x stored it, which no command of this adapter wrote
          await seed('notes', [storageNote('kept', 'Kept', NOW)]);
          const read = async () => {
            const state = await kernel.query({ type: 'getNote', noteId: 'kept' });
            return state.kind === 'ready' ? [state.data.revision, state.data.placementVersion] : null;
          };
          assert.deepEqual(await read(), flags.revisions ? [0, 0] : [undefined, undefined]);
          await run(cmd('setPinned', { noteId: 'kept', pinned: true }));
          await run(cmd('archiveNote', { noteId: 'kept' }));
          assert.deepEqual(await read(), flags.revisions ? [0, 2] : [undefined, undefined]);
          const saved = await run(
            cmd('saveNoteContent', { noteId: 'kept', blocks: someBlocks('kept', 1), expectedRevision: 0 }),
          );
          assert.equal(saved.revision, flags.revisions ? 1 : undefined);
          assert.deepEqual(await read(), flags.revisions ? [1, 2] : [undefined, undefined]);
        },
      );

      it(
        flags.revisions
          ? 'revisions: insights from a revision older than the ones the note has are dropped as insights-stale, and newer ones land'
          : 'no revisions: insights land whatever revision they say they came from',
        async () => {
          await createNote({ noteId: 'n1', name: 'Plan' });
          await run(cmd('saveNoteContent', { noteId: 'n1', blocks: someBlocks('n1', 1) }));
          const fresh = await run(
            cmd('attachInsights', { noteId: 'n1', insights: { todos: ['New'] }, sourceRevision: 2 }),
          );
          assert.deepEqual([fresh.code, fresh.changedIds], ['insights-attached', ['n1']]);
          const old = await run(
            cmd('attachInsights', { noteId: 'n1', insights: { todos: ['Old'] }, sourceRevision: 1 }),
          );
          if (flags.revisions) {
            assert.deepEqual([old.code, old.changedIds, old.severity], ['insights-stale', [], 'info']);
            assert.deepEqual((await noteOf('n1'))?.insights, { todos: ['New'] });
          } else {
            assert.equal(old.code, 'insights-attached');
            assert.deepEqual((await noteOf('n1'))?.insights, { todos: ['Old'] });
          }
          // Ones made from the same revision, or with none given, land, each on its own
          const again = await run(
            cmd('attachInsights', { noteId: 'n1', insights: { todos: ['Again'] }, sourceRevision: 2 }),
          );
          assert.deepEqual([again.code, again.changedIds], ['insights-attached', ['n1']]);
          assert.deepEqual((await noteOf('n1'))?.insights, { todos: ['Again'] });
          const any = await run(cmd('attachInsights', { noteId: 'n1', insights: { todos: ['Any'] } }));
          assert.deepEqual([any.code, any.changedIds], ['insights-attached', ['n1']]);
          assert.deepEqual((await noteOf('n1'))?.insights, { todos: ['Any'] });
          for (const sourceRevision of [-1, 1.5, '2']) {
            assertRejected(
              await kernel.execute(
                cmd('attachInsights', /** @type {any} */ ({ noteId: 'n1', insights: null, sourceRevision })),
              ),
              'validation',
              'invalid-command',
            );
          }
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
        // Nor does it hold its commandId: the same id with another command runs
        const orphan = cmd('createFolder', { folderId: 'orphan', name: 'Orphan', parentId: 'missing' });
        assertRejected(await kernel.execute(orphan), 'not-found', 'parent-not-found');
        assert.equal(committedOf(await kernel.execute({ ...orphan, parentId: null })).code, 'folder-created');
      });

      it('a bulk command refused for its action or its notes leaves no record, so the corrected one runs', async () => {
        await createNote({ noteId: 'a', name: 'A' });
        const typo = cmd('runBulkAction', /** @type {any} */ ({ action: 'archiv', noteIds: ['a'] }));
        assertRejected(await kernel.execute(typo), 'validation', 'invalid-command');
        const archived = await kernel.execute({ ...typo, action: 'archive' });
        assert.deepEqual(archived.kind === 'bulk' && archived.committedIds, ['a']);
        const noNotes = cmd('runBulkAction', /** @type {any} */ ({ action: 'unarchive', noteIds: 'a' }));
        assertRejected(await kernel.execute(noNotes), 'validation', 'invalid-command');
        const unarchived = await kernel.execute({ ...noNotes, noteIds: ['a'] });
        assert.deepEqual(unarchived.kind === 'bulk' && unarchived.committedIds, ['a']);
      });

      it('a bulk command none of whose notes committed runs them again when resent, so one that can commit now does', async () => {
        const archive = cmd('runBulkAction', { action: 'archive', noteIds: ['a'] });
        const first = await kernel.execute(archive);
        assert.deepEqual(first.kind === 'bulk' && first.committedIds, []);
        await createNote({ noteId: 'a', name: 'A' });
        const again = await kernel.execute(archive);
        assert.deepEqual(again.kind === 'bulk' && again.committedIds, ['a']);
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
        flags.idempotency
          ? 'idempotency: a resend with its keys in another order is the same command, so it replays'
          : 'no idempotency: a resend with its keys in another order runs again',
        async () => {
          const create = cmd('createNote', { noteId: 'n1', name: 'Plan', blocks: someBlocks('n1', 1) });
          const first = await run(create);
          /** @param {Record<string, unknown>} value */
          const reversed = value => Object.fromEntries(Object.entries(value).reverse());
          const reordered = reversed({ ...create, blocks: (create.blocks ?? []).map(reversed) });
          assert.notDeepEqual(Object.keys(reordered), Object.keys(create));
          const again = await kernel.execute(/** @type {Command} */ (reordered));
          if (flags.idempotency) assert.deepEqual(again, first);
          else assertRejected(again, 'validation', 'note-exists');
        },
      );

      it(
        flags.revisions && flags.idempotency
          ? 'idempotency: a resent conflict gets the same conflict, runs nothing, and keeps one conflict record'
          : flags.revisions
            ? 'no idempotency: a resent conflict runs again and keeps a second conflict record'
            : 'no revisions: a resent stale save commits again, or replays with idempotency',
        async () => {
          await createNote({ noteId: 'n1', blocks: someBlocks('n1', 1) });
          await run(cmd('saveNoteContent', { noteId: 'n1', blocks: someBlocks('n1', 1), preview: 'Newer' }));
          const stale = cmd('saveNoteContent', {
            noteId: 'n1',
            blocks: someBlocks('n1', 2),
            preview: 'Stale',
            expectedRevision: 1,
          });
          const first = await kernel.execute(stale);
          const again = await kernel.execute(stale);
          if (flags.revisions) {
            assert.equal(first.kind, 'conflict', JSON.stringify(first));
            assert.deepEqual(again, first);
            assert.ok(ctx.conflicts);
            const kept = (await ctx.conflicts()).filter(conflict => conflict.commandId === stale.commandId);
            assert.equal(kept.length, flags.idempotency ? 1 : 2);
            assert.equal((await noteOf('n1'))?.preview, 'Newer');
          } else {
            committedOf(first);
            if (flags.idempotency) assert.deepEqual(again, first);
            else committedOf(again);
          }
        },
      );

      it(
        flags.idempotency
          ? 'idempotency: a resent bulk command gets the same items, writes nothing, and publishes nothing'
          : 'no idempotency: a resent bulk command runs each note command again',
        async () => {
          await createNote({ noteId: 'a', name: 'A' });
          await createNote({ noteId: 'b', name: 'B' });
          const archive = cmd('runBulkAction', { action: 'archive', noteIds: ['a', 'gone', 'b'] });
          const first = await kernel.execute(archive);
          assert.deepEqual(first.kind === 'bulk' && first.committedIds, ['a', 'b']);
          await run(cmd('unarchiveNote', { noteId: 'a' }));
          /** @type {string[]} */
          const published = [];
          kernel.subscribe(event => {
            published.push(...event.ids);
          });
          const again = await kernel.execute(archive);
          if (flags.idempotency) {
            assert.deepEqual(again, first);
            assert.deepEqual(published, []);
            assert.equal((await noteOf('a'))?.archived, false);
          } else {
            assert.deepEqual(again.kind === 'bulk' && again.committedIds, ['a', 'b']);
            assert.deepEqual(published, ['a', 'b']);
            assert.equal((await noteOf('a'))?.archived, true);
          }
        },
      );

      it(
        flags.idempotency
          ? 'idempotency: two sends of one bulk command at once commit and publish each note once'
          : 'no idempotency: two sends of one bulk command at once both run every note command',
        async () => {
          await createNote({ noteId: 'a', name: 'A' });
          await createNote({ noteId: 'b', name: 'B' });
          /** @type {string[]} */
          const published = [];
          kernel.subscribe(event => {
            published.push(...event.ids);
          });
          const archive = cmd('runBulkAction', { action: 'archive', noteIds: ['a', 'b'] });
          const [first, second] = await Promise.all([kernel.execute(archive), kernel.execute(archive)]);
          assert.deepEqual(first.kind === 'bulk' && first.committedIds, ['a', 'b']);
          assert.deepEqual(second, first);
          assert.deepEqual(published.sort(), flags.idempotency ? ['a', 'b'] : ['a', 'a', 'b', 'b']);
        },
      );

      it(
        flags.idempotency
          ? 'idempotency: a bulk commandId sent again with another selection is key reuse, and nothing runs'
          : 'no idempotency: a bulk commandId sent again with another selection runs it',
        async () => {
          for (const noteId of ['a', 'b', 'c']) await createNote({ noteId, name: noteId });
          const first = cmd('runBulkAction', { action: 'archive', noteIds: ['a', 'gone'] });
          assert.deepEqual((await kernel.execute(first)).kind, 'bulk');
          const other = await kernel.execute({ ...first, noteIds: ['b', 'c'] });
          if (flags.idempotency) {
            assertRejected(other, 'validation', 'idempotency-key-reuse');
            assert.deepEqual(await idsIn('archived'), ['a']);
          } else {
            assert.deepEqual(other.kind === 'bulk' && other.committedIds, ['b', 'c']);
          }
        },
      );

      it(
        flags.idempotency
          ? 'idempotency: one bulk commandId sent at once with two selections runs one and refuses the other before it writes'
          : 'no idempotency: one bulk commandId sent at once with two selections runs both',
        async () => {
          for (const noteId of ['a', 'b', 'c']) await createNote({ noteId, name: noteId });
          /** @type {string[]} */
          const published = [];
          kernel.subscribe(event => {
            published.push(...event.ids);
          });
          const first = cmd('runBulkAction', { action: 'archive', noteIds: ['a'] });
          const [one, two] = await Promise.all([
            kernel.execute(first),
            kernel.execute({ ...first, noteIds: ['b', 'c'] }),
          ]);
          assert.deepEqual(one.kind === 'bulk' && one.committedIds, ['a']);
          if (flags.idempotency) {
            assertRejected(two, 'validation', 'idempotency-key-reuse');
            assert.deepEqual([await idsIn('archived'), published], [['a'], ['a']]);
          } else {
            assert.deepEqual(two.kind === 'bulk' && two.committedIds, ['b', 'c']);
            assert.deepEqual(await idsIn('archived'), ['a', 'b', 'c']);
          }
        },
      );

      it(
        flags.idempotency
          ? "idempotency: a resent bulk command runs again each note that didn't commit, and replays the ones that did"
          : 'no idempotency: a resent bulk command runs every note command again',
        async () => {
          await createNote({ noteId: 'a', name: 'A' });
          await createNote({ noteId: 'b', name: 'B' });
          const archive = cmd('runBulkAction', { action: 'archive', noteIds: ['a', 'b'] });
          ctx.failNextWrite('notes');
          const first = await kernel.execute(archive);
          assert.deepEqual(first.kind === 'bulk' && first.items.map(item => [item.id, item.outcome.kind]), [
            ['a', 'unavailable'],
            ['b', 'committed'],
          ]);
          /** @type {string[]} */
          const published = [];
          kernel.subscribe(event => {
            published.push(...event.ids);
          });
          // Storage recovered, and the same command goes again
          const again = await kernel.execute(archive);
          assert.deepEqual(again.kind === 'bulk' && again.committedIds, ['a', 'b']);
          assert.equal((await noteOf('a'))?.archived, true);
          assert.deepEqual(published, flags.idempotency ? ['a'] : ['a', 'b']);
        },
      );

      it("two sends of one bulk command at once, one of whose notes fails, answer a later resend with every note's commit", async () => {
        await createNote({ noteId: 'a', name: 'A' });
        await createNote({ noteId: 'b', name: 'B' });
        const archive = cmd('runBulkAction', { action: 'archive', noteIds: ['a', 'b'] });
        // The first send's write of a fails, and the second send's commits
        ctx.failNextWrite('notes');
        const [one, two] = await Promise.all([kernel.execute(archive), kernel.execute(archive)]);
        assert.deepEqual(one.kind === 'bulk' && one.items[0].outcome.kind, 'unavailable');
        assert.deepEqual(two.kind === 'bulk' && two.committedIds, ['a', 'b']);
        const later = await kernel.execute(archive);
        assert.deepEqual(later.kind === 'bulk' && later.committedIds, ['a', 'b']);
        assert.deepEqual(await idsIn('archived'), ['a', 'b']);
      });

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
