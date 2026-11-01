'use strict';

// Turn into keeps a table's cells as text. A table's cells hold plain text, so when the table
// turns into a text block, their text goes into the block's rich content escaped and shows as
// typed.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { createLegacyEnv, makeEditor } = require('./helpers/legacy-env');

const FILES = ['js/utils.js', 'js/core/storage-error.js', 'js/storage.js', 'js/sidebar-utils.js', 'js/blocks.js', 'js/shortcut-utils.js', 'js/editor.js'];

/** An editor holding one table with `tableData` */
async function editorWithTable(tableData) {
  const env = createLegacyEnv();
  env.load(...FILES);
  await env.get('Storage').init();
  const editor = makeEditor(env);
  const Block = env.get('Block');
  editor.noteId = 'n1';
  editor.noteData = { id: 'n1', name: 'Groceries' };
  editor.blocks = [new Block({ id: 't1', type: 'table', tableData, rows: tableData.length, cols: tableData[0].length, canvasId: 'n1', order: 0 })];
  editor.scheduleSave = () => {};
  return editor;
}

describe('Turn into keeps a table\'s cells as text', () => {
  it("a table turned into a text block shows its cells' text as typed", async () => {
    const editor = await editorWithTable([['Q3 <b>plan</b>', '&'], ['"notes"', 'v2']]);
    editor.changeBlockType('t1', 'text');
    assert.equal(editor.blocks[0].type, 'text');
    assert.equal(editor.blocks[0].content, 'Q3 &lt;b&gt;plan&lt;/b&gt; &amp; "notes" v2');
  });

  it('a table of plain words turns into the same words', async () => {
    const editor = await editorWithTable([['Milk', 'Eggs'], ['Bread', 'Jam']]);
    editor.changeBlockType('t1', 'quote');
    assert.equal(editor.blocks[0].type, 'quote');
    assert.equal(editor.blocks[0].content, 'Milk Eggs Bread Jam');
  });
});
