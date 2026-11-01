'use strict';

// A block dropped on the sidebar keeps its rich content only when this page's editor started
// the drag. The editor puts a fresh token in each block drag it starts; a drop that carries the
// token of the drag in progress stores the block's rich content, and any other drop stores its
// plain text, escaped, so it shows as typed. A token holds for one drop at most: the drop that
// reads it uses it up, and a drop on the editor, a new dragstart and the dragend clear it.
// Either way the block's type is one the editor knows, or text.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { webcrypto } = require('node:crypto');
const { createLegacyEnv, makeEditor } = require('./helpers/legacy-env');

const FILES = [
  'js/utils.js', 'js/core/storage-error.js', 'js/storage.js', 'js/sidebar-utils.js', 'js/blocks.js',
  'js/shortcut-utils.js', 'js/editor.js', 'js/controllers/sidebar-controller.js',
];

/** A drag's data store, as DataTransfer has it */
function dataTransfer(entries = {}) {
  const data = new Map(Object.entries(entries));
  return {
    effectAllowed: 'uninitialized',
    dropEffect: 'none',
    get types() { return [...data.keys()]; },
    setData(type, value) { data.set(type, String(value)); },
    getData(type) { return data.has(type) ? data.get(type) : ''; },
  };
}

/** A drag with the editor's three data types that the page's editor didn't start */
const otherDrag = (fields = {}) => dataTransfer({
  'application/x-block-content': 'Milk <b>and</b> eggs',
  'application/x-block-type': 'text',
  'application/x-block-html': '<b>Milk</b> and eggs',
  ...fields,
});

/** The new tab's editor and sidebar on one page, with the sidebar's note list */
async function newTab() {
  const env = createLegacyEnv();
  env.global.crypto = webcrypto;
  env.load(...FILES);
  const Storage = env.get('Storage');
  await Storage.init();
  const editor = makeEditor(env);
  editor.noteId = 'n1';
  editor.noteData = { id: 'n1', name: 'Groceries' };
  const sidebar = Object.create(env.get('SidebarController').prototype);
  sidebar.storage = Storage;
  sidebar.refreshNotesList = async () => {};
  const list = env.document.body.appendChild(env.document.createElement('div'));
  list.id = 'sidebar-notes-list';
  const Block = env.get('Block');
  /** Put a block in the editor; returns its element */
  const addBlock = (fields) => {
    const block = new Block({ canvasId: 'n1', order: editor.blocks.length, ...fields });
    editor.blocks.push(block);
    const blockEl = editor.container.appendChild(env.document.createElement('div'));
    blockEl.className = 'block';
    blockEl.dataset.id = block.id;
    return blockEl;
  };
  /** Put a block in the editor and start dragging it; returns the drag's data store */
  const dragBlock = (fields) => {
    const transfer = dataTransfer();
    editor.onDragStart({ target: addBlock(fields), dataTransfer: transfer });
    return transfer;
  };
  /** Drop on `target` (the list itself makes a new note) */
  const drop = (transfer, target = list) => sidebar._onSidebarDrop({
    dataTransfer: transfer, target, preventDefault() {}, stopPropagation() {},
  });
  /** The blocks of the note the last drop made */
  const madeBlocks = async () => {
    const notes = await Storage.getAllNotes();
    assert.equal(notes.length, 1, 'the drop made one note');
    return Storage.getElementsByNote(notes[0].id);
  };
  return { env, Storage, editor, sidebar, list, addBlock, dragBlock, drop, madeBlocks };
}

const shape = (blocks) => blocks.map(block => ({ type: block.type, content: block.content }));

describe('a block dropped on the sidebar', () => {
  it("keeps its rich content when this page's editor started the drag", async () => {
    const tab = await newTab();
    await tab.drop(tab.dragBlock({ id: 'b1', type: 'quote', content: '<b>Milk</b> and eggs' }));
    assert.deepEqual(shape(await tab.madeBlocks()), [{ type: 'quote', content: '<b>Milk</b> and eggs' }]);
  });

  it("is stored as its text when the page's editor didn't start the drag", async () => {
    const tab = await newTab();
    await tab.drop(otherDrag());
    assert.deepEqual(shape(await tab.madeBlocks()), [{ type: 'text', content: 'Milk &lt;b&gt;and&lt;/b&gt; eggs' }]);
  });

  it('is stored as its text when its token is not the token of the drag in progress', async () => {
    const tab = await newTab();
    tab.dragBlock({ id: 'b1', type: 'text', content: '<i>Bread</i>' });
    await tab.drop(otherDrag({ 'application/x-block-token': 'a'.repeat(32) }));
    assert.deepEqual(shape(await tab.madeBlocks()), [{ type: 'text', content: 'Milk &lt;b&gt;and&lt;/b&gt; eggs' }]);
  });

  it("is stored as its text when the drag it carries the token of has ended", async () => {
    const tab = await newTab();
    const transfer = tab.dragBlock({ id: 'b1', type: 'text', content: '<b>Milk</b> and eggs' });
    tab.editor.onDragEnd({});
    await tab.drop(transfer);
    assert.deepEqual(shape(await tab.madeBlocks()), [{ type: 'text', content: 'Milk and eggs' }]);
  });

  it('holds for one drop: the same drag dropped again is stored as its text', async () => {
    const tab = await newTab();
    const transfer = tab.dragBlock({ id: 'b1', type: 'quote', content: '<b>Milk</b> and eggs' });
    await tab.drop(transfer);
    await tab.drop(transfer);
    const stored = [];
    for (const note of await tab.Storage.getAllNotes()) {
      for (const block of await tab.Storage.getElementsByNote(note.id)) stored.push(block.content);
    }
    assert.deepEqual(stored.sort(), ['<b>Milk</b> and eggs', 'Milk and eggs']);
  });

  it('is stored as its text after a reorder in the editor, which leaves no token', async () => {
    const tab = await newTab();
    tab.editor.scheduleSave = () => {};
    const target = tab.addBlock({ id: 'b2', type: 'text', content: 'Bread' });
    const transfer = tab.dragBlock({ id: 'b1', type: 'quote', content: '<b>Milk</b> and eggs' });
    // The reorder renders the blocks again, so the dragend after it never reaches the editor
    tab.editor.onDrop({ target, dataTransfer: transfer, preventDefault() {} });
    assert.deepEqual(tab.editor.blocks.map(block => block.id), ['b1', 'b2']);
    await tab.drop(transfer);
    assert.deepEqual(shape(await tab.madeBlocks()), [{ type: 'quote', content: 'Milk and eggs' }]);
  });

  it("from this page's editor with no rich content, stores its text escaped", async () => {
    const tab = await newTab();
    await tab.drop(tab.dragBlock({ id: 't1', type: 'table', tableData: [['Q3 <b>plan</b>', '&']] }));
    assert.deepEqual(shape(await tab.madeBlocks()), [{ type: 'table', content: 'Q3 &lt;b&gt;plan&lt;/b&gt; &amp;' }]);
  });

  it('takes a type the editor knows, and text for any other', async () => {
    const known = await newTab();
    await known.drop(otherDrag({ 'application/x-block-type': 'h2' }));
    assert.deepEqual((await known.madeBlocks()).map(block => block.type), ['h2']);
    const unknown = await newTab();
    await unknown.drop(otherDrag({ 'application/x-block-type': 'not-a-block-type' }));
    assert.deepEqual((await unknown.madeBlocks()).map(block => block.type), ['text']);
  });

  it('appended to a note in the list follows the same rule', async () => {
    const tab = await newTab();
    const note = await tab.Storage.createNote('Shopping');
    const item = tab.list.appendChild(tab.env.document.createElement('div'));
    item.className = 'sidebar-note-item';
    item.dataset.id = note.id;
    await tab.drop(otherDrag({ 'application/x-block-type': 'not-a-block-type' }), item);
    await tab.drop(tab.dragBlock({ id: 'b1', type: 'quote', content: '<b>Milk</b> and eggs' }), item);
    const blocks = (await tab.Storage.getElementsByNote(note.id)).sort((a, b) => a.order - b.order);
    assert.deepEqual(shape(blocks), [
      { type: 'text', content: 'Milk &lt;b&gt;and&lt;/b&gt; eggs' },
      { type: 'quote', content: '<b>Milk</b> and eggs' },
    ]);
  });
});
