'use strict';

// Trash deletes an untitled note for good only when it holds nothing (NTN-18
// slice 0 review; 1.4.0 has the bug too). Nothing means every block is an empty
// text block, the rule the export notice counts notes by: an image, a table, or
// a divider holds something, and so does a text block with a pasted image.
// trashNote is the one place a note is deleted for being empty: Trash in the
// sidebar and the note menu, the bulk action, and Settings' Trash Note all go
// through it, and nothing deletes an empty note on a switch, a close, or a start.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { createLegacyEnv, createDatabase, dumpDatabase, recordsOf, note, block } = require('./helpers/legacy-env');

const FILES = ['js/utils.js', 'js/core/storage-error.js', 'js/storage.js', 'js/controllers/notes-manager.js'];

const IMAGE = 'data:image/png;base64,iVBORw0KGgo=';

/** An untitled note's only blocks that hold something */
const HOLDING = [
  ['a pasted image in a text block', [block('n1', 'N', 0, `<img src="${IMAGE}">`)]],
  ['an image', [block('n1', 'N', 0, '', { type: 'image', imageUrl: IMAGE })]],
  ['a new table, its cells still "Header 1" and empty', [block('n1', 'N', 0, '', {
    type: 'table', rows: 2, cols: 2, hasHeaderRow: true, tableData: [['Header 1', 'Header 2'], ['', '']],
  })]],
  ['a divider', [block('n1', 'N', 0, '', { type: 'divider' })]],
  ['a divider under an empty text block', [block('n1', 'N', 0, ''), block('n2', 'N', 1, '', { type: 'divider' })]],
];

/** An untitled note's only blocks that hold nothing, which trash deleted for good before too */
const EMPTY = [
  ['no blocks', []],
  ['an empty text block', [block('n1', 'N', 0, '')]],
  ['a line break', [block('n1', 'N', 0, '<br>')]],
  ['spaces', [block('n1', 'N', 0, '   '), block('n2', 'N', 1, '<br/>')]],
];

/** Non-breaking spaces hold nothing too, as the export notice counts them, where trash used to keep them */
const NBSP = [block('n1', 'N', 0, ' &nbsp; '), block('n2', 'N', 1, '<br>&nbsp;')];

async function setup(blocks, fields = {}) {
  const env = createLegacyEnv();
  await createDatabase(env.indexedDB, {
    records: {
      canvases: [note('N', { name: 'Untitled', ...fields }), note('K', { name: 'Kept' })],
      elements: [...blocks, block('k1', 'K', 0, 'kept')],
    },
  });
  env.load(...FILES);
  const Storage = env.get('Storage');
  await Storage.init();
  const toasts = [];
  env.get('Utils').showToast = (message, kind) => { toasts.push({ message, kind }); };
  const stored = async () => {
    const db = await dumpDatabase(env.indexedDB);
    return {
      note: recordsOf(db, 'canvases').N,
      blocks: Object.values(recordsOf(db, 'elements')).filter((element) => element.canvasId === 'N').map((element) => element.id).sort(),
    };
  };
  return { env, Storage, toasts, stored };
}

describe('trashing an untitled note', () => {
  for (const [what, blocks] of HOLDING) {
    it(`with only ${what} moves it to trash, blocks and all`, async () => {
      const { Storage, stored } = await setup(blocks);
      assert.equal(await Storage.isNoteEmpty('N'), false);

      const result = await Storage.trashNote('N');

      assert.notEqual(result && result.permanentlyDeleted, true, 'not deleted for good');
      const { note: kept, blocks: ids } = await stored();
      assert.equal(kept.trashed, true, 'in trash, where it can be restored');
      assert.deepEqual(ids, blocks.map((b) => b.id).sort());
    });
  }

  it('from the sidebar or the note menu says it moved to trash', async () => {
    const { env, Storage, toasts, stored } = await setup(HOLDING[0][1]);
    const notes = new (env.get('NotesManager'))({ storage: Storage, domRefs: null, logger: null, llm: null });

    await notes.trashNoteById('N');

    assert.deepEqual(toasts, [{ message: 'Note moved to trash', kind: 'success' }]);
    assert.equal((await stored()).note.trashed, true);
  });

  it('with the bulk action, moves each one that holds something to trash and deletes only the empty one', async () => {
    const env = createLegacyEnv();
    const holding = HOLDING.map(([, blocks], i) => blocks.map((b) => ({ ...b, id: `${b.id}-${i}`, canvasId: `H${i}` })));
    await createDatabase(env.indexedDB, {
      records: {
        canvases: [...HOLDING.map((_, i) => note(`H${i}`, { name: 'Untitled' })), note('E', { name: 'Untitled' })],
        elements: [...holding.flat(), block('e1', 'E', 0, '<br>')],
      },
    });
    env.load(...FILES);
    const Storage = env.get('Storage');
    await Storage.init();

    await Storage.bulkNoteAction([...HOLDING.map((_, i) => `H${i}`), 'E'], 'trash');

    const notes = recordsOf(await dumpDatabase(env.indexedDB), 'canvases');
    for (const [i, [what]] of HOLDING.entries()) assert.equal(notes[`H${i}`].trashed, true, what);
    assert.equal(notes.E, undefined, 'the empty one is deleted, as before');
  });

  for (const [what, blocks] of EMPTY) {
    it(`with ${what} still deletes it for good, as before`, async () => {
      const { Storage, stored } = await setup(blocks);
      assert.equal(await Storage.isNoteEmpty('N'), true);

      const result = await Storage.trashNote('N');

      assert.deepEqual(JSON.parse(JSON.stringify(result)), { permanentlyDeleted: true });
      const { note: gone, blocks: ids } = await stored();
      assert.equal(gone, undefined);
      assert.deepEqual(ids, []);
    });
  }

  it('with only non-breaking spaces and line breaks deletes it for good, as it does a line break', async () => {
    const { Storage, stored } = await setup(NBSP);
    assert.equal(await Storage.isNoteEmpty('N'), true);
    assert.deepEqual(JSON.parse(JSON.stringify(await Storage.trashNote('N'))), { permanentlyDeleted: true });
    assert.equal((await stored()).note, undefined);
  });

  it('that holds nothing, from the sidebar, says the empty note was deleted, as before', async () => {
    const { env, Storage, toasts } = await setup([]);
    const notes = new (env.get('NotesManager'))({ storage: Storage, domRefs: null, logger: null, llm: null });
    await notes.trashNoteById('N');
    assert.deepEqual(toasts, [{ message: 'Empty note deleted', kind: 'success' }]);
  });

  it('a titled note that holds nothing still goes to trash, as before', async () => {
    const { Storage, stored } = await setup([block('n1', 'N', 0, '')], { name: 'Groceries' });
    await Storage.trashNote('N');
    assert.equal((await stored()).note.trashed, true);
  });
});

describe('Storage.isEmptyTextBlock, the one rule for an empty block', () => {
  it('only a text block with nothing but spaces, line breaks, and non-breaking spaces is empty', async () => {
    const { Storage } = await setup([]);
    for (const b of [...EMPTY.flatMap(([, blocks]) => blocks), ...NBSP]) {
      assert.equal(Storage.isEmptyTextBlock(b), true, JSON.stringify(b.content));
    }
    assert.equal(Storage.isEmptyTextBlock({ content: '' }), true, 'a block with no type is a text block');
    for (const [what, blocks] of HOLDING) {
      assert.equal(blocks.every((b) => Storage.isEmptyTextBlock(b)), false, what);
    }
    assert.equal(Storage.isEmptyTextBlock(block('t', 'N', 0, '<b></b>')), false, 'any other markup counts');
  });
});
