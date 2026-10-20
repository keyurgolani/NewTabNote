// Races on the legacy adapter (#12, "Test plan"), over production js/storage.js. Commands
// start together and aren't awaited one by one, from one tab or from two tabs of one
// profile. Each race has to converge with no lost update.

import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { adapterFor, closeAll, kernelFor, legacyContext } from './legacy-fixture.mjs';
import { CALLERS, testClock, testIds } from './support.mjs';

/** @typedef {import('./legacy-fixture.mjs').LegacyContext} LegacyContext */
/** @typedef {import('../../js/kernel/core/application/kernel.js').Kernel} Kernel */
/** @typedef {import('../../js/kernel/core/contracts/outcomes.js').Outcome} Outcome */
/** @typedef {import('../../js/kernel/core/contracts/outcomes.js').BulkOutcome} BulkOutcome */
/** @typedef {import('../../js/kernel/core/domain/note.js').NoteRecord} NoteRecord */

/** @type {LegacyContext[]} */
const opened = [];
after(() => closeAll(opened));

/**
 * Two tabs of one profile, each with its own legacy adapter and kernel
 * @returns {Promise<{tabA: Kernel, tabB: Kernel, first: LegacyContext}>}
 */
async function twoTabs() {
  const first = legacyContext();
  const second = legacyContext(first.env);
  opened.push(first, second);
  const runtime = { ids: testIds(), clock: testClock() };
  const adapterA = adapterFor(first);
  const adapterB = adapterFor(second);
  await adapterA.open();
  await adapterB.open();
  return {
    tabA: kernelFor(adapterA, runtime, CALLERS.newtab),
    tabB: kernelFor(adapterB, runtime, { surface: 'newtab', contextId: 'newtab-2' }),
    first,
  };
}

/** @param {Outcome | BulkOutcome} outcome */
const kindOf = outcome => outcome.kind;

/**
 * @param {Kernel} kernel
 * @param {string} noteId
 * @returns {Promise<NoteRecord | undefined>}
 */
async function noteOf(kernel, noteId) {
  const state = await kernel.query({ type: 'getNote', noteId });
  return state.kind === 'ready' ? state.data.note : undefined;
}

/**
 * @param {Kernel} kernel
 * @param {import('../../js/kernel/core/domain/note.js').NoteView} view
 */
async function namesIn(kernel, view) {
  const state = await kernel.query({ type: 'listNotes', view });
  return state.kind === 'ready' ? state.data.map(note => note.name) : [];
}

describe('races on the legacy adapter', () => {
  it('moving two folders into each other from two tabs at once commits one move and refuses the other', async () => {
    const { tabA, tabB } = await twoTabs();
    for (const folderId of ['a', 'b']) {
      await tabA.execute({
        type: 'createFolder',
        commandId: `create-${folderId}`,
        folderId,
        name: folderId,
        parentId: null,
      });
    }
    // Each tab's view still has both folders at the root
    const outcomes = await Promise.all([
      tabA.execute({ type: 'moveFolder', commandId: 'a-into-b', folderId: 'a', parentId: 'b' }),
      tabB.execute({ type: 'moveFolder', commandId: 'b-into-a', folderId: 'b', parentId: 'a' }),
    ]);
    assert.deepEqual(outcomes.map(kindOf).sort(), ['committed', 'rejected']);
    const refused = outcomes.find(outcome => outcome.kind === 'rejected');
    assert.equal(refused && refused.kind === 'rejected' && refused.code, 'folder-into-itself');
    const state = await tabB.query({ type: 'listFolders' });
    const parents = state.kind === 'ready' ? state.data.map(folder => folder.parentId) : [];
    assert.ok(parents.includes(null), `one folder stays at the root: ${JSON.stringify(parents)}`);
  });

  it('moving a folder into a descendant from a stale view is refused', async () => {
    const { tabA, tabB } = await twoTabs();
    for (const [folderId, parentId] of /** @type {const} */ ([
      ['a', null],
      ['b', null],
      ['c', 'b'],
    ])) {
      await tabA.execute({ type: 'createFolder', commandId: `create-${folderId}`, folderId, name: folderId, parentId });
    }
    const staleView = await tabA.query({ type: 'listFolders' });
    await tabB.execute({ type: 'moveFolder', commandId: 'b-into-a', folderId: 'b', parentId: 'a' });
    assert.equal(staleView.kind === 'ready' && staleView.data.find(folder => folder.id === 'b')?.parentId, null);
    const outcome = await tabA.execute({ type: 'moveFolder', commandId: 'a-into-c', folderId: 'a', parentId: 'c' });
    assert.equal(outcome.kind === 'rejected' && outcome.code, 'folder-into-itself');
  });

  it('a bulk trash where one note fails trashes the others, while another tab renames one of them', async () => {
    const { tabA, tabB, first } = await twoTabs();
    for (const noteId of ['n1', 'n2', 'n3']) {
      await tabA.execute({ type: 'createNote', commandId: `create-${noteId}`, noteId, name: noteId });
    }
    first.failing.push('notes');
    const [bulk, renamed] = await Promise.all([
      tabA.execute({ type: 'runBulkAction', commandId: 'trash', action: 'trash', noteIds: ['n1', 'n2', 'n3'] }),
      tabB.execute({ type: 'renameNote', commandId: 'rename', noteId: 'n3', name: 'Renamed' }),
    ]);
    assert.equal(renamed.kind, 'committed');
    assert.deepEqual(bulk.kind === 'bulk' && bulk.items.map(item => [item.id, item.outcome.kind]), [
      ['n1', 'unavailable'],
      ['n2', 'committed'],
      ['n3', 'committed'],
    ]);
    const n3 = await noteOf(tabB, 'n3');
    assert.deepEqual([n3?.name, n3?.trashed], ['Renamed', true]);
    assert.deepEqual(await namesIn(tabB, 'active'), ['n1']);
  });

  it('trashing an empty untitled note while another tab saves into it never deletes the saved note or orphans its blocks', async () => {
    /** @param {string} noteId */
    const save = noteId => ({
      type: /** @type {const} */ ('saveNoteContent'),
      commandId: `save-${noteId}`,
      noteId,
      blocks: [{ id: `typed-${noteId}`, type: 'text', content: '<p>Milk</p>' }],
    });
    /** @param {string} noteId */
    const trash = noteId => ({ type: /** @type {const} */ ('trashNote'), commandId: `trash-${noteId}`, noteId });
    /**
     * @param {Kernel} kernel
     * @param {string} noteId
     */
    const blockIdsOf = async (kernel, noteId) => {
      const state = await kernel.query({ type: 'getNoteBlocks', noteId });
      return state.kind === 'ready' ? state.data.map(block => block.id) : [];
    };

    // Tab B's save lands just after tab A's first transaction over the blocks commits. A trash
    // that decided in one transaction and deleted the note in a later one left B's block there.
    const { tabA, tabB, first } = await twoTabs();
    await tabA.execute({ type: 'createNote', commandId: 'create-late', noteId: 'late' });
    /** @type {Promise<Outcome | BulkOutcome> | undefined} */
    let saving;
    const { transaction } = first.storage;
    first.storage.transaction = (/** @type {string | string[]} */ names, /** @type {IDBTransactionMode} */ mode) => {
      const tx = transaction(names, mode);
      if (!saving && mode === 'readwrite' && [names].flat().includes('elements')) {
        tx.addEventListener('complete', () => {
          saving = tabB.execute(save('late'));
        });
      }
      return tx;
    };
    const trashedLate = await tabA.execute(trash('late'));
    first.storage.transaction = transaction;
    const savedLate = await saving;
    assert.deepEqual(
      [
        trashedLate.kind === 'committed' && trashedLate.code,
        savedLate && savedLate.kind === 'rejected' && savedLate.code,
      ],
      ['note-deleted', 'note-not-found'],
    );
    assert.deepEqual([await noteOf(tabB, 'late'), await blockIdsOf(tabB, 'late')], [undefined, []]);

    // Saved first, the note has content, so the trash keeps it in the trash instead
    await tabA.execute({ type: 'createNote', commandId: 'create-early', noteId: 'early' });
    const [savedEarly, trashedEarly] = await Promise.all([tabB.execute(save('early')), tabA.execute(trash('early'))]);
    assert.deepEqual(
      [savedEarly.kind, trashedEarly.kind === 'committed' && trashedEarly.code],
      ['committed', 'note-trashed'],
    );
    assert.deepEqual(
      [(await noteOf(tabA, 'early'))?.trashed, await blockIdsOf(tabA, 'early')],
      [true, ['typed-early']],
    );
  });

  it('pinning a note open in an editor survives that editor saving at the same moment, in one tab or two', async () => {
    const { tabA, tabB } = await twoTabs();
    for (const [noteId, sidebar] of /** @type {const} */ ([
      ['same-tab', 'A'],
      ['other-tab', 'B'],
    ])) {
      await tabA.execute({ type: 'createNote', commandId: `create-${noteId}`, noteId });
      const pin = sidebar === 'A' ? tabA : tabB;
      const outcomes = await Promise.all([
        tabA.execute({
          type: 'saveNoteContent',
          commandId: `save-${noteId}`,
          noteId,
          blocks: [{ id: `${noteId}-b1`, type: 'text', content: 'Typed' }],
          preview: 'Typed',
        }),
        pin.execute({ type: 'setPinned', commandId: `pin-${noteId}`, noteId, pinned: true }),
      ]);
      assert.deepEqual(outcomes.map(kindOf), ['committed', 'committed']);
      const note = await noteOf(tabB, noteId);
      assert.deepEqual([note?.pinned, note?.preview], [true, 'Typed'], noteId);
    }
  });

  it('after a bulk action every list that follows the commit feed, the command palette too, drops the notes', async () => {
    const { tabA } = await twoTabs();
    for (const noteId of ['n1', 'n2', 'n3']) {
      await tabA.execute({ type: 'createNote', commandId: `create-${noteId}`, noteId, name: noteId });
    }
    /** @type {Record<string, unknown[]>} */
    const lists = { sidebar: [], palette: [] };
    /** @type {Promise<unknown>[]} */
    const reloads = [];
    for (const name of Object.keys(lists)) {
      tabA.subscribe(event => {
        if (event.aggregate !== 'note') return;
        reloads.push(namesIn(tabA, 'active').then(names => (lists[name] = names)));
      });
    }
    await tabA.execute({ type: 'runBulkAction', commandId: 'archive', action: 'archive', noteIds: ['n1', 'n2'] });
    await Promise.all(reloads);
    assert.deepEqual(lists, { sidebar: ['n3'], palette: ['n3'] });
  });

  it('a derived title and insights that land while the user types lose none of it, and a hand-set title stays', async () => {
    const { tabA } = await twoTabs();
    await tabA.execute({ type: 'createNote', commandId: 'create', noteId: 'n1' });
    await tabA.execute({ type: 'createNote', commandId: 'create-mine', noteId: 'n2', name: 'Untitled' });
    await tabA.execute({ type: 'renameNote', commandId: 'mine', noteId: 'n2', name: 'Mine' });
    const outcomes = await Promise.all([
      tabA.execute({
        type: 'saveNoteContent',
        commandId: 'save',
        noteId: 'n1',
        blocks: [{ id: 'b1', type: 'text', content: 'Milk, eggs' }],
        preview: 'Milk, eggs',
      }),
      tabA.execute({ type: 'applyDerivedTitle', commandId: 'title', noteId: 'n1', name: 'Groceries' }),
      tabA.execute({ type: 'attachInsights', commandId: 'insights', noteId: 'n1', insights: { todos: ['Buy milk'] } }),
      tabA.execute({ type: 'applyDerivedTitle', commandId: 'title-2', noteId: 'n2', name: 'Derived' }),
      tabA.execute({
        type: 'saveNoteContent',
        commandId: 'save-2',
        noteId: 'n2',
        blocks: [{ id: 'b2', type: 'text', content: 'Notes' }],
        preview: 'Notes',
      }),
    ]);
    assert.deepEqual(outcomes.map(kindOf), ['committed', 'committed', 'committed', 'committed', 'committed']);
    const n1 = await noteOf(tabA, 'n1');
    assert.deepEqual([n1?.preview, n1?.name, n1?.insights], ['Milk, eggs', 'Groceries', { todos: ['Buy milk'] }]);
    const n2 = await noteOf(tabA, 'n2');
    assert.deepEqual([n2?.name, n2?.preview], ['Mine', 'Notes']);
  });
});
