// The rules the kernel copies from production code (#12, "Data and migration"), each run
// both ways from the same records: production js/storage.js, background.js, or the
// controller that applies the rule, in one profile, and the kernel over the legacy adapter
// in another. Each pair has to leave the same records. Two rules the kernel changes on
// purpose are left out, as #12 has them: attachInsights writes only insight fields, and
// applyDerivedTitle drops its title once the user set one.

import { createRequire } from 'node:module';
import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';

import { createsCycle } from '../../js/kernel/core/domain/folder.js';
import { adapterFor, closeAll, kernelFor, legacyContext, legacyEnv } from './legacy-fixture.mjs';
import { testIds } from './support.mjs';

// #34's worker harness is CommonJS, and starts background.js as the module worker it is,
// which takes vm.SourceTextModule: npm test starts node with --experimental-vm-modules
/** @type {any} */
const workerHarness = createRequire(import.meta.url)('../helpers/load-background.js');
const RUNS_MODULES = typeof (/** @type {any} */ (vm).SourceTextModule) === 'function';

/** @typedef {import('./legacy-fixture.mjs').LegacyContext} LegacyContext */
/** @typedef {import('../../js/kernel/core/application/kernel.js').Kernel} Kernel */
/** @typedef {import('../../js/kernel/core/contracts/outcomes.js').Outcome} Outcome */
/** @typedef {import('../../js/kernel/core/contracts/outcomes.js').BulkOutcome} BulkOutcome */
/** @typedef {import('../../js/kernel/core/domain/note.js').NoteView} NoteView */

/** The time legacyEnv.note and legacyEnv.block give the records they make */
const SEEDED_AT = 1700000000000;

/** The fields a write stamps with the time it ran */
const TIME_FIELDS = new Set(['createdAt', 'updatedAt', 'archivedAt', 'trashedAt', 'lastAutoTitleAt']);

/** What the editor loads before it can open a note, past what every legacy context loads */
const EDITOR_FILES = ['js/core/storage-error.js', 'js/sidebar-utils.js', 'js/blocks.js', 'js/editor.js'];

/** @type {LegacyContext[]} */
const opened = [];
after(() => closeAll(opened));

/**
 * `value` with each time a write stamped, any after the seeded ones, read as 'written', so
 * Storage's Date.now() and the kernel's clock compare equal
 * @param {unknown} value
 * @returns {any}
 */
function stamped(value) {
  if (Array.isArray(value)) return value.map(stamped);
  if (value === null || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, field]) => [
      key,
      TIME_FIELDS.has(key) && typeof field === 'number' && field > SEEDED_AT ? 'written' : stamped(field),
    ]),
  );
}

/**
 * Two profiles that start from the same records: `viaStorage` for production code, and
 * `viaKernel` for the kernel, whose clock is the real one, as Storage's is
 * @param {Record<string, unknown[]>} [records] - rows per IndexedDB store
 * @returns {Promise<{viaStorage: LegacyContext, viaKernel: LegacyContext, kernel: Kernel}>}
 */
async function twin(records = {}) {
  const viaStorage = legacyContext();
  const viaKernel = legacyContext();
  opened.push(viaStorage, viaKernel);
  for (const { env } of [viaStorage, viaKernel]) await legacyEnv.createDatabase(env.indexedDB, { records });
  await viaStorage.storage.open();
  const adapter = adapterFor(viaKernel);
  await adapter.open();
  return { viaStorage, viaKernel, kernel: kernelFor(adapter, { ids: testIds('k'), clock: { now: () => Date.now() } }) };
}

/**
 * A profile's records in the IndexedDB stores `names`, by key, with written times as 'written'
 * @param {LegacyContext} context
 * @param {string[]} names
 * @returns {Promise<any>}
 */
async function recordsIn(context, names) {
  const dump = await legacyEnv.dumpDatabase(context.env.indexedDB);
  return stamped(Object.fromEntries(names.map(name => [name, legacyEnv.recordsOf(dump, name)])));
}

/**
 * Each search entry's name. Storage.updateNote stamps the entry again on every note write,
 * and the kernel only on a rename, which #12 has as the one command that updates the search
 * index, so a command that isn't a rename leaves the entry's time out of the comparison.
 * @param {LegacyContext} context
 * @returns {Promise<Record<string, unknown>>}
 */
async function searchNames(context) {
  const { search_index: entries } = await recordsIn(context, ['search_index']);
  return Object.fromEntries(Object.entries(entries).map(([key, entry]) => [key, entry.name]));
}

/** @param {Outcome | BulkOutcome} outcome */
function assertCommitted(outcome) {
  assert.equal(outcome.kind, 'committed', JSON.stringify(outcome));
}

/**
 * A folder record as Storage.createFolder writes one
 * @param {string} id
 * @param {string | null} parentId
 */
const folder = (id, parentId) => ({
  id,
  name: id,
  parentId,
  createdAt: SEEDED_AT,
  updatedAt: SEEDED_AT,
  color: null,
  collapsed: false,
});

describe("the kernel's copies of production rules, run both ways", () => {
  it('createNote writes the note and the search entry Storage.createNote writes', async () => {
    const { viaStorage, viaKernel, kernel } = await twin();
    const made = legacyEnv.plain(await viaStorage.storage.createNote('Plan'));
    assertCommitted(await kernel.execute({ type: 'createNote', commandId: 'c1', noteId: made.id, name: 'Plan' }));
    const stores = ['canvases', 'search_index'];
    assert.deepEqual(await recordsIn(viaKernel, stores), await recordsIn(viaStorage, stores));
  });

  it('createNote with a pin, a folder, and a hand-set title, then a save, leave what Storage did for a note saved as a new one', async () => {
    const { viaStorage, viaKernel, kernel } = await twin({ folders: [folder('f1', null)] });
    // "Save as a new note": Storage.createNote made the record, the editor set the deleted
    // note's pin, folder, and title flag on it, and its save wrote the record with the blocks
    const made = await viaStorage.storage.createNote('Plan');
    Object.assign(made, { titleManuallySet: true, folderId: 'f1', pinned: true, preview: 'Milk', todoProgress: null });
    const blocks = [legacyEnv.block('b1', made.id, 0, 'Milk')];
    await viaStorage.storage.saveNoteWithBlocks(made, blocks);
    await viaStorage.storage.updateNoteNameInSearchIndex(made.id, 'Plan');
    const noteId = made.id;
    assertCommitted(
      await kernel.execute({
        type: 'createNote',
        commandId: 'c1',
        noteId,
        name: 'Plan',
        folderId: 'f1',
        pinned: true,
        titleManuallySet: true,
      }),
    );
    assertCommitted(
      await kernel.execute({
        type: 'saveNoteContent',
        commandId: 'c2',
        noteId,
        blocks,
        preview: 'Milk',
        todoProgress: null,
      }),
    );
    const stores = ['canvases', 'elements'];
    assert.deepEqual(await recordsIn(viaKernel, stores), await recordsIn(viaStorage, stores));
    assert.deepEqual(await searchNames(viaKernel), await searchNames(viaStorage));
  });

  it('createFolder writes the folder Storage.createFolder writes', async () => {
    const { viaStorage, viaKernel, kernel } = await twin({ folders: [folder('f0', null)] });
    const made = legacyEnv.plain(await viaStorage.storage.createFolder('Work', 'f0'));
    assertCommitted(
      await kernel.execute({ type: 'createFolder', commandId: 'c1', folderId: made.id, name: 'Work', parentId: 'f0' }),
    );
    assert.deepEqual(await recordsIn(viaKernel, ['folders']), await recordsIn(viaStorage, ['folders']));
  });

  it("a capture's new Daily Note is the note, search entry, and template blocks Storage.ensureDailyNote makes", async () => {
    const { viaStorage, viaKernel, kernel } = await twin({
      canvases: [legacyEnv.note('t1', { name: 'Daily template', isTemplate: true })],
      elements: [
        legacyEnv.block('t1-a', 't1', 0, '<p>{{title}}: plan</p>'),
        legacyEnv.block('t1-b', 't1', 1, '', {
          type: 'table',
          tableData: [
            ['{{title}}', 'Done'],
            ['', 'x'],
          ],
        }),
      ],
    });
    for (const { storage } of [viaStorage, viaKernel]) await storage.setSetting('dailyNoteTemplate', 't1');
    const daily = legacyEnv.plain(await viaStorage.storage.ensureDailyNote());
    assertCommitted(
      await kernel.execute({
        type: 'captureToDailyNote',
        commandId: 'c1',
        noteId: daily.id,
        blockId: 'k-capture',
        capture: { type: 'text', content: 'Quote' },
      }),
    );
    // Template copies line up by order, since each side gives them its own ids, and the
    // capture's own block is left out: Storage.ensureDailyNote makes the note without one
    /** @param {LegacyContext} context */
    const made = async context => {
      const found = await recordsIn(context, ['canvases', 'search_index', 'elements']);
      const copies = Object.values(found.elements)
        .filter(block => block.canvasId === daily.id && block.id !== 'k-capture')
        .sort((a, b) => a.order - b.order)
        .map(({ id, ...copy }) => copy);
      return { notes: found.canvases, search: found.search_index, copies };
    };
    assert.deepEqual(await made(viaKernel), await made(viaStorage));
  });

  it(
    'a capture adds the block background.js adds, for a page and for selected text',
    { skip: !RUNS_MODULES && 'background.js runs as a module worker, which npm test can start' },
    async () => {
      const worker = await workerHarness.loadBackground();
      const { tab } = worker;
      await worker.dispatch('contextMenus.onClicked', { menuItemId: 'capture-page', pageUrl: tab.url }, tab);
      // The listener doesn't wait for its capture, and two at once can each make a Daily Note,
      // so the first lands before the second starts
      await workerHarness.readTodaysDailyNote(worker);
      await worker.dispatch(
        'contextMenus.onClicked',
        { menuItemId: 'capture-selection', selectionText: 'Quoted words' },
        tab,
      );
      const day = await workerHarness.readTodaysDailyNote(worker);

      const { viaKernel, kernel } = await twin();
      /** @type {import('../../js/kernel/core/domain/note.js').Capture[]} */
      const captures = [
        { type: 'bookmark', url: tab.url, title: tab.title },
        { type: 'text', content: 'Quoted words', source: tab.url },
      ];
      for (const [index, capture] of captures.entries()) {
        assertCommitted(
          await kernel.execute({
            type: 'captureToDailyNote',
            commandId: `c${index}`,
            noteId: 'd1',
            blockId: `k${index}`,
            capture,
          }),
        );
      }
      // Each side gives its blocks its own ids and orders them by the time they landed, which
      // two captures in one millisecond share, so they line up by type
      /** @param {any[]} list */
      const blocks = list =>
        list
          .map(({ id, canvasId, order, ...block }) => ({ ...block, ordered: typeof order === 'number' }))
          .sort((a, b) => (a.type < b.type ? -1 : 1));
      const { elements } = await recordsIn(viaKernel, ['elements']);
      assert.equal(day && day.blocks.length, 2);
      assert.deepEqual(blocks(Object.values(elements)), blocks(legacyEnv.plain(day.blocks)));
    },
  );

  it('archiveNote, unarchiveNote, trashNote, and restoreNote leave the note Storage leaves', async () => {
    /** @type {Array<{type: string, fields: Record<string, unknown>, viaStorage: (storage: any) => Promise<unknown>}>} */
    const cases = [
      { type: 'archiveNote', fields: {}, viaStorage: storage => storage.archiveNote('n1') },
      {
        type: 'unarchiveNote',
        fields: { archived: true, archivedAt: SEEDED_AT },
        viaStorage: storage => storage.unarchiveNote('n1'),
      },
      {
        type: 'trashNote',
        fields: { archived: true, archivedAt: SEEDED_AT },
        viaStorage: storage => storage.trashNote('n1'),
      },
      {
        type: 'restoreNote',
        fields: { trashed: true, trashedAt: SEEDED_AT },
        viaStorage: storage => storage.restoreNote('n1'),
      },
    ];
    for (const { type, fields, viaStorage: run } of cases) {
      const { viaStorage, viaKernel, kernel } = await twin({
        canvases: [legacyEnv.note('n1', { name: 'Plan', ...fields })],
        elements: [legacyEnv.block('b1', 'n1', 0, '<p>Milk</p>')],
        search_index: [{ noteId: 'n1', name: 'Plan', content: 'Milk', updatedAt: SEEDED_AT }],
      });
      await run(viaStorage.storage);
      assertCommitted(await kernel.execute(/** @type {any} */ ({ type, commandId: 'c1', noteId: 'n1' })));
      const stores = ['canvases', 'elements'];
      assert.deepEqual(await recordsIn(viaKernel, stores), await recordsIn(viaStorage, stores), type);
      assert.deepEqual(await searchNames(viaKernel), await searchNames(viaStorage), type);
    }
  });

  it('trashNote deletes an untitled empty note with what Storage.trashNote deletes, and trashes the others', async () => {
    const notes = ['u-empty', 'u-markup', 'u-divider', 'kept'].map(id =>
      legacyEnv.note(id, { name: id === 'kept' ? 'Kept' : 'Untitled' }),
    );
    const { viaStorage, viaKernel, kernel } = await twin({
      canvases: notes,
      elements: [
        legacyEnv.block('e1', 'u-empty', 0, ''),
        legacyEnv.block('e2', 'u-empty', 1, ' <br>&nbsp;'),
        legacyEnv.block('m1', 'u-markup', 0, '<p> </p>'),
        legacyEnv.block('d1', 'u-divider', 0, '', { type: 'divider' }),
        legacyEnv.block('k1', 'kept', 0, 'Kept text'),
      ],
      media: [
        { id: 'media-empty', canvasId: 'u-empty' },
        { id: 'media-kept', canvasId: 'kept' },
      ],
      vectors: [{ id: 'u-empty' }, { id: 'kept' }],
      snapshots: [
        { id: 's-empty', noteId: 'u-empty', timestamp: SEEDED_AT },
        { id: 's-kept', noteId: 'kept', timestamp: SEEDED_AT },
      ],
      search_index: notes.map(note => ({ noteId: note.id, name: note.name, content: '', updatedAt: SEEDED_AT })),
    });
    for (const noteId of ['u-empty', 'u-markup', 'u-divider']) {
      await viaStorage.storage.trashNote(noteId);
      assertCommitted(await kernel.execute({ type: 'trashNote', commandId: `c-${noteId}`, noteId }));
    }
    const stores = ['canvases', 'elements', 'media', 'vectors', 'snapshots'];
    assert.deepEqual(await recordsIn(viaKernel, stores), await recordsIn(viaStorage, stores));
    assert.deepEqual(await searchNames(viaKernel), await searchNames(viaStorage));
  });

  it("setPinned leaves the note SidebarController's pin toggle leaves", async () => {
    const { viaStorage, viaKernel, kernel } = await twin({
      canvases: [legacyEnv.note('n1', { name: 'Plan' })],
      search_index: [{ noteId: 'n1', name: 'Plan', content: '', updatedAt: SEEDED_AT }],
    });
    viaStorage.env.load('js/controllers/sidebar-controller.js');
    viaStorage.env.get('Utils').showToast = () => {};
    const sidebar = Object.assign(Object.create(viaStorage.env.get('SidebarController').prototype), {
      storage: viaStorage.storage,
      refreshNotesList: async () => {},
    });
    await sidebar.toggleNotePin('n1');
    assertCommitted(await kernel.execute({ type: 'setPinned', commandId: 'c1', noteId: 'n1', pinned: true }));
    assert.deepEqual(await recordsIn(viaKernel, ['canvases']), await recordsIn(viaStorage, ['canvases']));
  });

  it("renameNote leaves the title the editor's title edit leaves, and a generated one what NotesManager's leaves", async () => {
    const records = () => ({
      canvases: [legacyEnv.note('n1', { name: 'Plan' })],
      elements: [legacyEnv.block('b1', 'n1', 0, 'Milk, eggs, and bread for the week')],
      search_index: [{ noteId: 'n1', name: 'Plan', content: '', updatedAt: SEEDED_AT }],
    });
    /**
     * The fields a rename decides: the title, whether the user set it, when a model did, and
     * the search entry. The editor's save writes the rest of the note too.
     * @param {LegacyContext} context
     */
    const title = async context => {
      const found = await recordsIn(context, ['canvases', 'search_index']);
      const { name, titleManuallySet, lastAutoTitleAt } = found.canvases.n1;
      return { name, titleManuallySet, lastAutoTitleAt, search: found.search_index.n1 };
    };

    const typed = await twin(records());
    // 1.4.x's title edit: onTitleChange set the name and titleManuallySet on the editor's copy,
    // and its save wrote the copy with the blocks, then the search entry's name
    const { storage } = typed.viaStorage;
    const editorCopy = { ...(await storage.getNote('n1')), name: 'Groceries', titleManuallySet: true };
    await storage.saveNoteWithBlocks(editorCopy, await storage.getElementsByNote('n1'));
    await storage.updateNoteNameInSearchIndex('n1', 'Groceries');
    assertCommitted(
      await typed.kernel.execute({ type: 'renameNote', commandId: 'c1', noteId: 'n1', name: 'Groceries' }),
    );
    assert.deepEqual(await title(typed.viaKernel), await title(typed.viaStorage));

    const generated = await twin(records());
    generated.viaStorage.env.load('js/controllers/notes-manager.js');
    generated.viaStorage.env.get('Utils').showToast = () => {};
    const manager = Object.assign(Object.create(generated.viaStorage.env.get('NotesManager').prototype), {
      storage: generated.viaStorage.storage,
      llm: { isConfigured: () => true, generateTitle: async () => 'Groceries' },
      getEditor: () => null,
      getOpenTabs: () => [],
    });
    await manager.generateTitleForNote('n1');
    assertCommitted(
      await generated.kernel.execute({
        type: 'renameNote',
        commandId: 'c1',
        noteId: 'n1',
        name: 'Groceries',
        origin: 'generated',
      }),
    );
    const stores = ['canvases', 'search_index'];
    assert.deepEqual(await recordsIn(generated.viaKernel, stores), await recordsIn(generated.viaStorage, stores));
  });

  it('saveNoteContent leaves what Storage.saveNoteWithBlocks leaves, keeps the trash, and writes nothing to a deleted note', async () => {
    const stored = legacyEnv.note('n1', { name: 'Plan', trashed: true, trashedAt: SEEDED_AT });
    const { viaStorage, viaKernel, kernel } = await twin({
      canvases: [stored],
      elements: [legacyEnv.block('b1', 'n1', 0, 'Milk')],
    });
    const blocks = [legacyEnv.block('b1', 'n1', 0, 'Milk and eggs'), legacyEnv.block('b2', 'n1', 1, 'Bread')];
    const todoProgress = { completed: 1, total: 2 };
    // The editor's copy of the note is from before the trash, and the stored trash state wins
    const editorCopy = { ...stored, trashed: false, trashedAt: null, preview: 'Milk and eggs', todoProgress };
    await viaStorage.storage.saveNoteWithBlocks(editorCopy, blocks);
    assertCommitted(
      await kernel.execute({
        type: 'saveNoteContent',
        commandId: 'c1',
        noteId: 'n1',
        blocks,
        preview: 'Milk and eggs',
        todoProgress,
      }),
    );
    // Deleted after the editor loaded it: neither side writes it back, its blocks included
    const lost = legacyEnv.block('g1', 'gone', 0, 'Lost');
    assert.equal(await viaStorage.storage.saveNoteWithBlocks(legacyEnv.note('gone'), [lost]), null);
    const refused = await kernel.execute({ type: 'saveNoteContent', commandId: 'c2', noteId: 'gone', blocks: [lost] });
    assert.equal(refused.kind, 'rejected');
    const stores = ['canvases', 'elements'];
    assert.deepEqual(await recordsIn(viaKernel, stores), await recordsIn(viaStorage, stores));
  });

  it('saveNoteContent with a typed title leaves the note, blocks, and search entry the editor saved it with', async () => {
    const stored = legacyEnv.note('n1', { name: 'Draft' });
    const { viaStorage, viaKernel, kernel } = await twin({
      canvases: [stored],
      elements: [legacyEnv.block('b1', 'n1', 0, 'Milk')],
      search_index: [{ noteId: 'n1', name: 'Draft', content: 'Milk', updatedAt: SEEDED_AT }],
    });
    const blocks = [legacyEnv.block('b1', 'n1', 0, 'Milk and eggs')];
    // The title edit set the name and titleManuallySet on the editor's copy, its save wrote the
    // copy with the blocks, and then the search entry's name
    const editorCopy = { ...stored, name: 'Groceries', titleManuallySet: true, preview: 'Milk and eggs' };
    await viaStorage.storage.saveNoteWithBlocks(editorCopy, blocks);
    await viaStorage.storage.updateNoteNameInSearchIndex('n1', 'Groceries');
    assertCommitted(
      await kernel.execute({
        type: 'saveNoteContent',
        commandId: 'c1',
        noteId: 'n1',
        blocks,
        preview: 'Milk and eggs',
        name: 'Groceries',
      }),
    );
    const stores = ['canvases', 'elements', 'search_index'];
    assert.deepEqual(await recordsIn(viaKernel, stores), await recordsIn(viaStorage, stores));
  });

  it('saveNoteContent with a generated title leaves what the editor saved after setTitleProgrammatically', async () => {
    const stored = legacyEnv.note('n1', { name: 'Untitled', lastAutoTitleAt: null });
    const { viaStorage, viaKernel, kernel } = await twin({
      canvases: [stored],
      elements: [legacyEnv.block('b1', 'n1', 0, 'Milk')],
      search_index: [{ noteId: 'n1', name: 'Untitled', content: 'Milk', updatedAt: SEEDED_AT }],
    });
    const blocks = [legacyEnv.block('b1', 'n1', 0, 'Milk and eggs')];
    // setTitleProgrammatically set the name and lastAutoTitleAt on the editor's copy, leaving
    // titleManuallySet, and the save wrote the copy with the blocks, then the search entry's name
    const editorCopy = { ...stored, name: 'Groceries', lastAutoTitleAt: Date.now(), preview: 'Milk and eggs' };
    await viaStorage.storage.saveNoteWithBlocks(editorCopy, blocks);
    await viaStorage.storage.updateNoteNameInSearchIndex('n1', 'Groceries');
    assertCommitted(
      await kernel.execute({
        type: 'saveNoteContent',
        commandId: 'c1',
        noteId: 'n1',
        blocks,
        preview: 'Milk and eggs',
        name: 'Groceries',
        titleOrigin: 'generated',
      }),
    );
    const stores = ['canvases', 'elements', 'search_index'];
    assert.deepEqual(await recordsIn(viaKernel, stores), await recordsIn(viaStorage, stores));
  });

  it("saveNoteContent's wiki links are the ones Storage.updateNoteLinks writes after the save", async () => {
    const at = (/** @type {number} */ offset) => SEEDED_AT + offset;
    const { viaStorage, viaKernel, kernel } = await twin({
      canvases: [
        legacyEnv.note('n1', { name: 'Plan', updatedAt: at(1) }),
        legacyEnv.note('old', { name: 'groceries', updatedAt: at(2) }),
        legacyEnv.note('new', { name: 'Groceries', updatedAt: at(3) }),
        legacyEnv.note('archived', { name: 'Archive me', archived: true, archivedAt: at(4) }),
        legacyEnv.note('trashed', { name: 'Trash me', trashed: true, trashedAt: at(5) }),
        legacyEnv.note('template', { name: 'Template', isTemplate: true }),
        legacyEnv.note('n2', { name: 'Linker' }),
      ],
      elements: [legacyEnv.block('b1', 'n1', 0, 'Milk')],
      links: [
        { id: 'l-old', fromNoteId: 'n1', toNoteId: 'old', createdAt: SEEDED_AT },
        { id: 'l-in', fromNoteId: 'n2', toNoteId: 'n1', createdAt: SEEDED_AT },
      ],
    });
    const linkedNames = ['GROCERIES', 'Archive me', 'Trash me', 'Template', 'Plan', 'Nowhere', 'groceries'];
    const blocks = [legacyEnv.block('b1', 'n1', 0, '[[Groceries]] and the rest')];
    const stored = legacyEnv.plain(await viaStorage.storage.getNote('n1'));
    await viaStorage.storage.saveNoteWithBlocks(stored, blocks);
    await viaStorage.storage.updateNoteLinks('n1', linkedNames);
    assertCommitted(
      await kernel.execute({ type: 'saveNoteContent', commandId: 'c1', noteId: 'n1', blocks, linkedNames }),
    );
    // Each side gives its links ids of its own, so they compare by what they link
    /** @param {LegacyContext} context */
    const links = async context =>
      Object.values((await recordsIn(context, ['links'])).links)
        .map(({ id, ...link }) => link)
        .sort((a, b) => `${a.fromNoteId}>${a.toNoteId}`.localeCompare(`${b.fromNoteId}>${b.toNoteId}`));
    assert.deepEqual(await links(viaKernel), await links(viaStorage));
    assert.deepEqual(
      (await links(viaKernel)).map(link => [link.fromNoteId, link.toNoteId]),
      [
        ['n1', 'archived'],
        ['n1', 'new'],
        ['n2', 'n1'],
      ],
    );

    // A save with no links clears them, as Storage.clearLinksFromNote does
    await viaStorage.storage.updateNoteLinks('n1', []);
    assertCommitted(
      await kernel.execute({ type: 'saveNoteContent', commandId: 'c2', noteId: 'n1', blocks, linkedNames: [] }),
    );
    assert.deepEqual(await links(viaKernel), await links(viaStorage));
  });

  it('deleteBlocks leaves the blocks Storage.deleteElement leaves, one call per block', async () => {
    const { viaStorage, viaKernel, kernel } = await twin({
      canvases: [legacyEnv.note('n1'), legacyEnv.note('n2')],
      elements: [
        legacyEnv.block('a', 'n1', 0, 'Kept'),
        legacyEnv.block('b', 'n1', 1, 'Deleted'),
        legacyEnv.block('c', 'n1', 2, 'Deleted too'),
        legacyEnv.block('d', 'n2', 0, 'Another note'),
      ],
    });
    const blockIds = ['b', 'c', 'never-saved'];
    for (const id of blockIds) await viaStorage.storage.deleteElement(id);
    assertCommitted(await kernel.execute({ type: 'deleteBlocks', commandId: 'c1', noteId: 'n1', blockIds }));
    const stores = ['canvases', 'elements'];
    assert.deepEqual(await recordsIn(viaKernel, stores), await recordsIn(viaStorage, stores));
  });

  it('getBacklinks lists the notes Storage.getBacklinks lists, in its order', async () => {
    const { viaStorage, kernel } = await twin({
      canvases: [
        legacyEnv.note('target', { name: 'Target' }),
        legacyEnv.note('plain', { name: 'Plain' }),
        legacyEnv.note('archived', { name: 'Archived', archived: true, archivedAt: SEEDED_AT }),
        legacyEnv.note('trashed', { name: 'Trashed', trashed: true, trashedAt: SEEDED_AT }),
        legacyEnv.note('template', { name: 'Template', isTemplate: true }),
      ],
      links: [
        { id: 'l3', fromNoteId: 'trashed', toNoteId: 'target', createdAt: SEEDED_AT },
        { id: 'l1', fromNoteId: 'plain', toNoteId: 'target', createdAt: SEEDED_AT },
        { id: 'l4', fromNoteId: 'template', toNoteId: 'target', createdAt: SEEDED_AT },
        { id: 'l2', fromNoteId: 'archived', toNoteId: 'target', createdAt: SEEDED_AT },
        { id: 'l5', fromNoteId: 'gone', toNoteId: 'target', createdAt: SEEDED_AT },
        { id: 'l6', fromNoteId: 'target', toNoteId: 'plain', createdAt: SEEDED_AT },
      ],
    });
    for (const noteId of ['target', 'plain', 'nothing']) {
      const state = await kernel.query({ type: 'getBacklinks', noteId });
      assert.deepEqual(
        state.kind === 'ready' ? legacyEnv.plain(state.data) : [],
        legacyEnv.plain(await viaStorage.storage.getBacklinks(noteId)),
        noteId,
      );
    }
  });

  it("moveFolder refuses the moves SidebarController.isChildFolder refuses, and writes what the sidebar's move writes", async () => {
    const folders = [
      folder('f1', null),
      folder('f2', 'f1'),
      folder('f3', 'f2'),
      folder('f4', null),
      folder('f5', 'f4'),
    ];
    const { viaStorage, viaKernel, kernel } = await twin({ folders });
    viaStorage.env.load('js/controllers/sidebar-controller.js');
    const sidebar = Object.assign(Object.create(viaStorage.env.get('SidebarController').prototype), { folders });
    for (const dragged of folders) {
      for (const target of folders) {
        assert.equal(
          createsCycle(folders, dragged.id, target.id),
          sidebar.isChildFolder(dragged.id, target.id),
          `${dragged.id} into ${target.id}`,
        );
      }
    }
    // A drop the sidebar takes sets the dragged folder's parentId and writes it with updateFolder
    await viaStorage.storage.updateFolder({ ...folder('f4', null), parentId: 'f3' });
    assertCommitted(await kernel.execute({ type: 'moveFolder', commandId: 'c1', folderId: 'f4', parentId: 'f3' }));
    assert.deepEqual(await recordsIn(viaKernel, ['folders']), await recordsIn(viaStorage, ['folders']));
  });

  it('listNotes lists each view in the order Storage lists it', async () => {
    const at = (/** @type {number} */ offset) => SEEDED_AT + offset;
    const { viaStorage, kernel } = await twin({
      canvases: [
        legacyEnv.note('a', { updatedAt: at(5) }),
        legacyEnv.note('b', { updatedAt: at(5) }),
        legacyEnv.note('c', { updatedAt: at(9), pinned: true }),
        legacyEnv.note('archived-1', { updatedAt: at(1), archived: true, archivedAt: at(30) }),
        legacyEnv.note('archived-2', { updatedAt: at(7), archived: true, archivedAt: at(20) }),
        legacyEnv.note('archived-3', { updatedAt: at(2), archived: true, archivedAt: null }),
        legacyEnv.note('trashed-1', { updatedAt: at(3), trashed: true, trashedAt: at(10) }),
        legacyEnv.note('trashed-2', { updatedAt: at(4), trashed: true, trashedAt: at(40), archived: true }),
        legacyEnv.note('template-1', { updatedAt: at(6), isTemplate: true }),
        legacyEnv.note('template-2', { updatedAt: at(8), isTemplate: true }),
        legacyEnv.note('template-trashed', { updatedAt: at(11), isTemplate: true, trashed: true, trashedAt: at(1) }),
        legacyEnv.note('no-time', { updatedAt: undefined }),
      ],
    });
    const { storage } = viaStorage;
    /** @type {Array<[NoteView, () => Promise<Array<{id: string}>>]>} */
    const views = [
      ['active', () => storage.getAllNotes()],
      ['withArchived', () => storage.getAllNotes(true)],
      ['archived', () => storage.getArchivedNotes()],
      ['trashed', () => storage.getTrashedNotes()],
      ['templates', () => storage.getTemplates()],
    ];
    for (const [view, read] of views) {
      const state = await kernel.query({ type: 'listNotes', view });
      const ids = state.kind === 'ready' ? state.data.map(note => note.id) : [];
      assert.deepEqual(
        ids,
        legacyEnv.plain(await read()).map((/** @type {{id: string}} */ note) => note.id),
        view,
      );
    }
  });

  it('getNoteBlocks lists blocks in the order the editor loads them', async () => {
    const { viaStorage, kernel } = await twin({
      canvases: [legacyEnv.note('n1')],
      elements: [
        legacyEnv.block('z', 'n1', 1, 'one'),
        legacyEnv.block('y', 'n1', 0, 'zero'),
        legacyEnv.block('x', 'n1', 1, 'one again'),
        legacyEnv.block('w', 'n1', 2, 'two'),
        legacyEnv.block('v', 'n1', undefined, 'no order'),
      ],
    });
    viaStorage.env.load(...EDITOR_FILES);
    // The editor on 1.4.x's reads, Storage.getNote and getElementsByNote, which loadNote sorts
    const { storage } = viaStorage;
    const editor = legacyEnv.makeEditor(viaStorage.env, viaStorage.env.document, {
      documentClient: {
        openNote: async (/** @type {string} */ id) => ({
          note: await storage.getNote(id),
          blocks: await storage.getElementsByNote(id),
        }),
      },
    });
    await legacyEnv.runUntil(viaStorage.env, editor.loadNote('n1'));
    const state = await kernel.query({ type: 'getNoteBlocks', noteId: 'n1' });
    assert.deepEqual(
      state.kind === 'ready' ? state.data.map(block => block.id) : [],
      editor.blocks.map((/** @type {{id: string}} */ block) => block.id),
    );
  });

  it("preferences and the workspace session read back through Storage's settings and TabController, both ways", async () => {
    const { viaKernel, kernel } = await twin();
    const { env, storage } = viaKernel;
    env.load('js/controllers/tab-controller.js');
    const TabController = env.get('TabController');

    // The kernel writes, and Storage and TabController read them the way the new tab does
    assertCommitted(
      await kernel.execute({ type: 'setPreferences', commandId: 'c1', values: { sidebarWidth: 300, theme: 'dark' } }),
    );
    const session = {
      openTabs: [{ noteId: 'n1', name: 'Plan' }],
      activeTabIndex: 0,
      splitViewEnabled: true,
      secondaryNoteId: 'n2',
      lastOpenedNoteId: 'n1',
    };
    assertCommitted(await kernel.execute({ type: 'saveWorkspaceSession', commandId: 'c2', session }));
    assert.deepEqual(
      legacyEnv.plain([
        await storage.getSetting('sidebarWidth'),
        await storage.getSetting('theme'),
        await storage.getSetting('openTabs', null),
        await storage.getSetting('activeTabIndex', 0),
        await storage.getSetting('splitViewEnabled', false),
        await storage.getSetting('secondaryNoteId', null),
        await TabController.getCachedLastOpenedNoteId(),
      ]),
      [300, 'dark', session.openTabs, 0, true, 'n2', 'n1'],
    );

    // Storage and TabController write, and the kernel reads
    await storage.setSetting('font', 'serif');
    const tabs = new TabController({ storage, eventBus: null, domRefs: null, logger: null });
    tabs.openTabs = [
      { noteId: 'n3', name: 'Three' },
      { noteId: 'n4', name: 'Four' },
    ];
    tabs.activeTabIndex = 1;
    tabs.splitViewEnabled = false;
    tabs.secondaryEditor = { noteId: 'n4' };
    await tabs.saveTabs();
    tabs.cacheLastOpenedNoteId('n4');
    await legacyEnv.settle();
    const preferences = await kernel.query({ type: 'getPreferences', keys: ['font'] });
    const saved = await kernel.query({ type: 'getWorkspaceSession' });
    assert.deepEqual(
      legacyEnv.plain([preferences.kind === 'ready' && preferences.data, saved.kind === 'ready' && saved.data]),
      [
        { font: 'serif' },
        {
          openTabs: tabs.openTabs,
          activeTabIndex: 1,
          splitViewEnabled: false,
          secondaryNoteId: 'n4',
          lastOpenedNoteId: 'n4',
        },
      ],
    );
  });
});
