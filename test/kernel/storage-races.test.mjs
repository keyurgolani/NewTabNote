// Races on #17's adapter (#12, "Test plan"), which legacy-races.test.mjs ran on the legacy
// adapter until #17 PR 4a deleted it. Commands start together and aren't awaited one by one,
// from one tab or from two tabs of one profile, each tab with an adapter of its own. Each race
// has to converge with no lost update.

import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

import { createIndexedDbAdapter } from '../../js/kernel/adapters/indexeddb/adapter.js';
import { faultyFactory } from './storage-faults.mjs';
import { KeyRange, closeAll, kernelOn, profile } from './storage-fixture.mjs';
import { CALLERS, testClock, testIds } from './support.mjs';

/** @typedef {import('./storage-fixture.mjs').Profile} Profile */
/** @typedef {import('./storage-faults.mjs').Faults} Faults */
/** @typedef {import('../../js/kernel/core/application/kernel.js').Kernel} Kernel */
/** @typedef {import('../../js/kernel/core/contracts/outcomes.js').Outcome} Outcome */
/** @typedef {import('../../js/kernel/core/contracts/outcomes.js').BulkOutcome} BulkOutcome */
/** @typedef {import('../../js/kernel/core/domain/note.js').NoteRecord} NoteRecord */

/** @type {{IDBDatabase: typeof IDBDatabase}} */
const { IDBDatabase: FakeDatabase } = createRequire(import.meta.url)('fake-indexeddb');

/** @type {Profile[]} */
const profiles = [];
after(() => profiles.forEach(closeAll));

/**
 * Two tabs of one profile, each with its own adapter, over a fault wrapper of its own, and its
 * own kernel. Tab A's database is made as the worker's open makes it, at this build's version.
 * @returns {Promise<{tabA: Kernel, tabB: Kernel, faultsA: Faults}>}
 */
async function twoTabs() {
  const of = profile();
  profiles.push(of);
  const runtime = { ids: testIds(), clock: testClock() };
  /** @param {Faults} faults */
  const adapterOver = faults => {
    const adapter = createIndexedDbAdapter({
      indexedDB: faults.factory,
      settings: of.chrome.api.storage.local,
      keyRange: KeyRange,
      clock: runtime.clock,
    });
    of.adapters.push(adapter);
    return adapter;
  };
  const adapterA = adapterOver(of.faults);
  await adapterA.open();
  const adapterB = adapterOver(faultyFactory(of.real));
  await adapterB.open();
  return {
    tabA: kernelOn(adapterA, runtime, CALLERS.newtab),
    tabB: kernelOn(adapterB, runtime, { surface: 'newtab', contextId: 'newtab-2' }),
    faultsA: of.faults,
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

describe("races on #17's adapter", () => {
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
    const { tabA, tabB, faultsA } = await twoTabs();
    for (const noteId of ['n1', 'n2', 'n3']) {
      await tabA.execute({ type: 'createNote', commandId: `create-${noteId}`, noteId, name: noteId });
    }
    // Tab A's first note write fails as one the browser refuses at once, which no run of it
    // gets past
    faultsA.throwOnNextWrite('canvases', 'DataError');
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

    // Tab B's save starts as soon as tab A's first transaction over the blocks commits. The
    // trash decides and deletes in that one transaction, so the save finds the note gone.
    const { tabA, tabB } = await twoTabs();
    await tabA.execute({ type: 'createNote', commandId: 'create-late', noteId: 'late' });
    /** @type {Promise<Outcome | BulkOutcome> | undefined} */
    let saving;
    const { transaction } = FakeDatabase.prototype;
    /**
     * @this {IDBDatabase}
     * @param {string | string[]} names
     * @param {IDBTransactionMode} [mode]
     * @param {IDBTransactionOptions} [options]
     */
    FakeDatabase.prototype.transaction = function watched(names, mode, options) {
      const tx = transaction.call(this, names, mode, options);
      if (!saving && mode === 'readwrite' && [names].flat().includes('elements')) {
        tx.addEventListener('complete', () => {
          saving = tabB.execute(save('late'));
        });
      }
      return tx;
    };
    let trashedLate;
    try {
      trashedLate = await tabA.execute(trash('late'));
    } finally {
      FakeDatabase.prototype.transaction = transaction;
    }
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
