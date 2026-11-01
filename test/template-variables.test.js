'use strict';

// A template's variables are plain text. Where a block's rich content holds one, its value goes
// in escaped, so it reads as typed in the text and in an attribute's value, quoted either way;
// a table's cells hold plain text and take the value as it is. Inserting a template in the
// editor and making a note from one both follow the rule.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { createLegacyEnv, makeEditor, plain } = require('./helpers/legacy-env');

const FILES = ['js/utils.js', 'js/core/storage-error.js', 'js/storage.js', 'js/sidebar-utils.js', 'js/blocks.js', 'js/shortcut-utils.js', 'js/editor.js'];

/** A note title with every markup character in it */
const TITLE = 'Q3 <b>plan</b> & "notes" \'v2\'';
/** TITLE escaped for text and for an attribute's value */
const ESCAPED = 'Q3 &lt;b&gt;plan&lt;/b&gt; &amp; &quot;notes&quot; &#39;v2&#39;';

/** A template block's rich content with the title in the text and in both kinds of quoted attribute */
const CONTENT = 'Notes for {{title}}: <span title="{{title}}">one</span> <span title=\'{{title}}\'>two</span>';
const EXPECTED = `Notes for ${ESCAPED}: <span title="${ESCAPED}">one</span> <span title='${ESCAPED}'>two</span>`;

/** The template's blocks: one of rich text, one table */
const TEMPLATE_BLOCKS = [
  { id: 'tpl-text', type: 'text', content: CONTENT, canvasId: 'tpl', order: 0 },
  { id: 'tpl-table', type: 'table', content: '', tableData: [['{{title}}', 'Owner'], ['Due', 'Friday']], rows: 2, cols: 2, canvasId: 'tpl', order: 1 },
];

async function started() {
  const env = createLegacyEnv();
  env.load(...FILES);
  const Storage = env.get('Storage');
  await Storage.init();
  for (const record of TEMPLATE_BLOCKS) await Storage.saveElement({ ...record });
  return { env, Storage };
}

/**
 * The editor on a note named `name`, with one block whose text is "/template" and the caret in
 * it, as the template picker leaves it
 */
function editorWithCaret(env, name) {
  const editor = makeEditor(env);
  const Block = env.get('Block');
  editor.noteId = 'n1';
  editor.noteData = { id: 'n1', name };
  editor.blocks = [new Block({ id: 'b1', type: 'text', content: '/template', canvasId: 'n1', order: 0 })];
  const blockEl = editor.container.appendChild(env.document.createElement('div'));
  blockEl.className = 'block';
  blockEl.dataset.id = 'b1';
  const contentEl = blockEl.appendChild(env.document.createElement('div'));
  contentEl.className = 'block-content';
  contentEl.textContent = '/template';
  env.window.getSelection = () => ({ rangeCount: 1, getRangeAt: () => ({ startContainer: { parentElement: contentEl } }) });
  Object.assign(editor, { scheduleSave: () => {}, focusBlock: () => {} });
  return editor;
}

/** The block of `type` the template put after the caret's block */
function inserted(editor, type) {
  const found = editor.blocks.slice(1).filter(block => block.type === type);
  assert.equal(found.length, 1, `one ${type} block inserted`);
  return found[0];
}

describe('a template places plain text as text', () => {
  it("the note's title reads as typed in a block's text and in its attribute values", async () => {
    const { env } = await started();
    const editor = editorWithCaret(env, TITLE);
    await editor.selectTemplateItem('tpl');
    assert.equal(inserted(editor, 'text').content, EXPECTED);
  });

  it("a table's cells take the title as typed", async () => {
    const { env } = await started();
    const editor = editorWithCaret(env, TITLE);
    await editor.selectTemplateItem('tpl');
    assert.deepEqual(plain(inserted(editor, 'table').tableData), [[TITLE, 'Owner'], ['Due', 'Friday']]);
  });

  it('a title with no markup characters goes in as it was', async () => {
    const { env } = await started();
    const editor = editorWithCaret(env, 'Weekly review');
    await editor.selectTemplateItem('tpl');
    assert.equal(inserted(editor, 'text').content, CONTENT.split('{{title}}').join('Weekly review'));
  });

  it('a note made from a template follows the same rule', async () => {
    const { Storage } = await started();
    const note = await Storage.createNote(TITLE);
    await Storage.applyTemplateToNote(note.id, 'tpl');
    const made = await Storage.getElementsByNote(note.id);
    assert.equal(made.length, 2);
    assert.equal(made.find(block => block.type === 'text').content, EXPECTED);
    assert.deepEqual(plain(made.find(block => block.type === 'table').tableData), [[TITLE, 'Owner'], ['Due', 'Friday']]);
  });
});
