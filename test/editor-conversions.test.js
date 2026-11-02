'use strict';

// #14 slice 3, lossless conversions with a confirmation for structural loss, in the legacy
// editor. Turn into keeps what it can as the new block's text. Where it would remove a table's
// grid, an image, a video, an attached file or a toggle's arrow, it asks first, in the editor's
// own document, and a yes is one undo entry. The block menu's Turn into, the selection's, the
// Alt+1/2/3 shortcut and Backspace at a block's start all ask. Delete at a block's end leaves a
// following toggle with hidden content alone. Elements are compared by small fields only.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  createLegacyEnv, createDatabase, dumpDatabase, recordsOf, plain, note, block, startEditorClient, makeEditor, runUntil, FakeDocument,
} = require('./helpers/legacy-env');

const FILES = [
  'js/utils.js', 'js/core/storage-error.js', 'js/ui/confirm-dialog.js', 'js/shortcut-utils.js', 'js/storage.js', 'js/sidebar-utils.js',
  'js/blocks.js', 'js/ai-response-utils.js', 'js/editor.js',
];
const OPTIONS = { timeout: 30_000 };

const TABLE = { ...block('t1', 'N', 1, ''), type: 'table', rows: 2, cols: 2, tableData: [['Item', 'Cost'], ['Tiles', '$640']], hasHeaderRow: true };
const IMAGE = { ...block('m1', 'N', 1, ''), type: 'image', imageUrl: 'data:image/png;base64,iVBORw0KGgo=' };
const TOGGLE = { ...block('g1', 'N', 1, 'Heading'), type: 'toggle', collapsed: true, children: 'Inside <i>it</i>' };
const BOOKMARK = { ...block('b1', 'N', 1, ''), type: 'bookmark', url: 'https://a.test/page', title: 'Page', description: 'About it', favicon: '' };
const EQUATION = { ...block('e1', 'N', 1, ''), type: 'equation', equation: 'E = mc^2' };
const FILE = { ...block('f1', 'N', 1, ''), type: 'file', fileName: 'notes.txt', fileSize: 5, fileData: 'data:text/plain;base64,aGVsbG8=' };
const VIDEO = { ...block('v1', 'N', 1, ''), type: 'video', videoUrl: 'https://www.youtube.com/watch?v=abcdefghijk' };

/** Give a fake document what a block's element and its re-render need */
function shim(doc) {
  const create = doc.createElement.bind(doc);
  doc.createElement = tag => {
    const el = create(tag);
    el.style.setProperty = (name, value) => { el.style[name] = String(value); };
    el.replaceWith = other => {
      const parent = el.parentNode;
      if (!parent) return;
      if (other.parentNode) other.parentNode.removeChild(other);
      parent.children.splice(parent.children.indexOf(el), 1, other);
      other.parentNode = parent;
      el.parentNode = null;
    };
    return el;
  };
}

/** An editor on note N, holding `records`, rendering into `doc` (the page's unless given) */
async function openNote(records, { pip = false } = {}) {
  const env = createLegacyEnv();
  await createDatabase(env.indexedDB, { records: { canvases: [note('N', { name: 'Plan' })], elements: records } });
  env.load(...FILES);
  env.global.URL = URL;
  env.global.navigator.platform = 'MacIntel';
  shim(env.document);
  await startEditorClient(env);
  let doc = env.document;
  if (pip) {
    doc = new FakeDocument();
    doc.defaultView = env.document.defaultView;
  }
  const editor = makeEditor(env, doc);
  delete editor.renderBlocks;
  Object.assign(editor, { updateAddBlockHint() {}, observeImages() {}, updateWideContentCentering() {}, focusBlock() {} });
  await runUntil(env, editor.loadNote('N'));
  return { env, editor, doc };
}

const overlay = doc => doc.querySelector('.confirm-dialog-overlay');
const words = doc => [overlay(doc).querySelector('.confirm-dialog-title').textContent, overlay(doc).querySelector('.confirm-dialog-message').textContent];
/** The question's title, its message and its yes button's words */
const question = doc => [...words(doc), overlay(doc).querySelector('.confirm-dialog-confirm').textContent];
const press = (doc, label) => overlay(doc).querySelectorAll('button').find(button => button.textContent === label).click();
const typesOf = editor => editor.blocks.map(b => b.type);
const stored = async env => recordsOf(await dumpDatabase(env.indexedDB), 'elements');
const contentEl = (editor, id) => editor.container.querySelector(`[data-id="${id}"]`).querySelector('.block-content');
/** `record` without the fields `names` */
const without = (record, ...names) => Object.fromEntries(Object.entries(record).filter(([name]) => !names.includes(name)));

describe('Turn into keeps what it can as text (#14 slice 3)', () => {
  it("keeps a bookmark's link, an equation's source, a file's name and a video's link as text", OPTIONS, async () => {
    const kept = {};
    for (const record of [BOOKMARK, EQUATION, FILE, VIDEO]) {
      const { editor, doc } = await openNote([block('a1', 'N', 0, 'Before'), record]);
      const turning = editor.turnInto(record.id, 'text');
      // The file's data and the video's embed go, so those two ask first
      if (overlay(doc)) press(doc, 'Turn into Text');
      await turning;
      kept[record.type] = editor.getBlockById(record.id).content;
    }
    assert.deepEqual(kept, {
      bookmark: '<a href="https://a.test/page">Page</a><br>About it',
      equation: 'E = mc^2',
      file: 'notes.txt',
      video: '<a href="https://www.youtube.com/watch?v=abcdefghijk">https://www.youtube.com/watch?v=abcdefghijk</a>',
    });
  });

  it('a conversion that removes nothing turns at once, without asking', OPTIONS, async () => {
    const { editor, doc } = await openNote([{ ...block('h1', 'N', 0, 'Title'), type: 'h1' }, BOOKMARK]);
    assert.equal(await editor.turnInto('h1', 'text'), true);
    assert.equal(await editor.turnInto('b1', 'h2'), true);
    assert.ok(overlay(doc) === null, 'no question');
    assert.deepEqual(typesOf(editor), ['text', 'h2']);
  });
});

describe('a conversion that removes structure asks first (#14 slice 3)', () => {
  it("turning a table into text asks first, Cancel leaves the table, and a yes keeps its cells a row per line", OPTIONS, async () => {
    const { env, editor, doc } = await openNote([block('a1', 'N', 0, 'Before'), TABLE]);
    let turning = editor.turnInto('t1', 'text');
    assert.deepEqual(question(doc), ['Turn into Text?', "The table's grid is removed. Its cells are kept as text, one row per line.", 'Turn into Text']);
    assert.equal(doc.activeElement.textContent, 'Cancel', 'Cancel takes focus');
    assert.ok(overlay(doc).querySelector('.confirm-dialog-danger') === null, 'Undo reverses it, so its yes is no danger button');
    press(doc, 'Cancel');
    assert.equal(await turning, false);
    assert.equal(editor.getBlockById('t1').type, 'table');

    turning = editor.turnInto('t1', 'text');
    press(doc, 'Turn into Text');
    assert.equal(await turning, true);
    const turned = editor.getBlockById('t1');
    assert.equal(turned.type, 'text');
    assert.equal(turned.content, 'Item Cost<br>Tiles $640');
    await runUntil(env, editor.save());
    assert.equal((await stored(env)).t1.tableData, undefined, 'no grid kept out of sight');
  });

  it('each kind of structure says what goes and what stays', OPTIONS, async () => {
    const said = {};
    for (const [record, target] of [[IMAGE, 'text'], [VIDEO, 'quote'], [FILE, 'h3'], [TOGGLE, 'h1']]) {
      const { editor, doc } = await openNote([block('a1', 'N', 0, 'Before'), record]);
      const turning = editor.turnInto(record.id, target);
      said[record.type] = question(doc);
      press(doc, 'Cancel');
      assert.equal(await turning, false);
      assert.equal(editor.getBlockById(record.id).type, record.type, `${record.type} as it was`);
    }
    assert.deepEqual(said, {
      image: ['Turn into Text?', 'The image is removed. Undo brings it back.', 'Turn into Text'],
      video: ['Turn into Quote?', 'The video is removed. Its link is kept as text.', 'Turn into Quote'],
      file: ['Turn into Heading 3?', 'The attached file is removed. Its name is kept as text.', 'Turn into Heading 3'],
      toggle: ['Turn into Heading 1?', "The toggle's arrow is removed. Its hidden content moves to a new block below it.", 'Turn into Heading 1'],
    });
  });

  it('turning a toggle with hidden content into a heading moves that content to a new text block below it', OPTIONS, async () => {
    const { env, editor, doc } = await openNote([block('a1', 'N', 0, 'Before'), TOGGLE, block('a3', 'N', 2, 'After')]);
    const turning = editor.turnInto('g1', 'h1');
    press(doc, 'Turn into Heading 1');
    await turning;
    assert.deepEqual(typesOf(editor), ['text', 'h1', 'text', 'text']);
    assert.deepEqual(editor.blocks.map(b => b.content), ['Before', 'Heading', 'Inside <i>it</i>', 'After']);
    assert.equal(editor.blocks[1].id, 'g1', 'the toggle keeps its id');
    await runUntil(env, editor.save());
    const after = await stored(env);
    assert.equal(after.g1.children, undefined, 'its hidden content moved, not kept out of sight');
    assert.equal(after[editor.blocks[2].id].content, 'Inside <i>it</i>');
  });

  it('a yes is one undo entry: Undo brings back the table, the image, and the toggle with its hidden content', OPTIONS, async () => {
    for (const record of [TABLE, IMAGE, TOGGLE]) {
      const { env, editor, doc } = await openNote([block('a1', 'N', 0, 'Before'), record]);
      const entries = editor.undoStack.length;
      const turning = editor.turnInto(record.id, 'text');
      press(doc, 'Turn into Text');
      await turning;
      assert.equal(editor.undoStack.length, entries + 1, `${record.type}: one entry`);

      editor.undo();
      assert.deepEqual(typesOf(editor), ['text', record.type], record.type);
      await runUntil(env, editor.save());
      const back = plain((await stored(env))[record.id]);
      assert.deepEqual(without(back, 'order', 'schemaVersion'), without(record, 'order'), `${record.type} as it was`);

      editor.redo();
      assert.deepEqual(typesOf(editor), record.type === 'toggle' ? ['text', 'text', 'text'] : ['text', 'text'], `${record.type} redone`);
    }
  });

  it('Turn into on a selection asks once for all of it, and one Undo brings it all back', OPTIONS, async () => {
    const heading = { ...block('h1', 'N', 3, 'Title'), type: 'h1' };
    const { editor, doc } = await openNote([block('a1', 'N', 0, 'Before'), TABLE, { ...IMAGE, order: 2 }, heading]);
    const turning = editor.turnSelectionInto(['t1', 'm1', 'h1'], 'text');
    assert.deepEqual(question(doc), [
      'Turn 3 blocks into Text?',
      'Tables lose their grid, and their cells are kept as text, one row per line. Images are removed. Undo brings them back.',
      'Turn into Text',
    ]);
    press(doc, 'Turn into Text');
    await turning;
    assert.deepEqual(typesOf(editor), ['text', 'text', 'text', 'text']);
    editor.undo();
    assert.deepEqual(typesOf(editor), ['text', 'table', 'image', 'h1']);
    assert.deepEqual(plain(editor.getBlockById('t1').tableData), TABLE.tableData);
    assert.equal(editor.getBlockById('m1').imageUrl, IMAGE.imageUrl);
  });

  it("a selection's toggles lose their arrow, and their hidden content moves below each one", OPTIONS, async () => {
    const second = { ...TOGGLE, id: 'g2', order: 2, content: 'Second', children: 'More' };
    const { editor, doc } = await openNote([block('a1', 'N', 0, 'Before'), TOGGLE, second]);
    const turning = editor.turnSelectionInto(['g1', 'g2'], 'text');
    assert.deepEqual(words(doc), [
      'Turn 2 blocks into Text?',
      'Toggles lose their arrow, and their hidden content moves to a new block below each one.',
    ]);
    press(doc, 'Turn into Text');
    await turning;
    assert.deepEqual(editor.blocks.map(b => b.content), ['Before', 'Heading', 'Inside <i>it</i>', 'Second', 'More']);
  });

  it("changeBlockType alone never removes structure: without a yes it changes nothing", OPTIONS, async () => {
    const { editor } = await openNote([block('a1', 'N', 0, 'Before'), TABLE]);
    assert.equal(editor.changeBlockType('t1', 'text'), false);
    assert.equal(editor.getBlockById('t1').type, 'table');
  });

  it('Backspace at the start of a toggle with hidden content asks first', OPTIONS, async () => {
    const { editor, doc } = await openNote([block('a1', 'N', 0, 'Before'), TOGGLE]);
    editor.isCaretAtStart = () => true;
    doc.defaultView.getSelection = () => ({ isCollapsed: true, rangeCount: 1 });
    editor.onBlockKeyDown({ key: 'Backspace', target: contentEl(editor, 'g1'), preventDefault() {} });
    assert.deepEqual(words(doc), ['Turn into Text?', "The toggle's arrow is removed. Its hidden content moves to a new block below it."]);
    press(doc, 'Cancel');
  });

  it('Cancel puts focus back where it was, so typing goes on in the block', OPTIONS, async () => {
    const { env, editor, doc } = await openNote([block('a1', 'N', 0, 'Before'), TOGGLE]);
    editor.isCaretAtStart = () => true;
    doc.defaultView.getSelection = () => ({ isCollapsed: true, rangeCount: 1 });
    const heading = contentEl(editor, 'g1');
    heading.focus();
    editor.onBlockKeyDown({ key: 'Backspace', target: heading, preventDefault() {} });
    assert.ok(doc.activeElement !== heading, 'the question takes focus');
    press(doc, 'Cancel');
    await runUntil(env, Promise.resolve());
    assert.ok(doc.activeElement === heading, 'focus is back in the toggle');
  });

  it("Cancel with focus outside the note, as the block menu leaves it, puts focus in the block: its text, or a table's first cell", OPTIONS, async () => {
    const { env, editor, doc } = await openNote([block('a1', 'N', 0, 'Before'), TOGGLE, { ...TABLE, order: 2 }]);
    for (const [id, target, into] of [['g1', 'h1', () => contentEl(editor, 'g1')], ['t1', 'text', () => editor.container.querySelector('[data-id="t1"]').querySelector('td, th')]]) {
      doc.body.focus();
      const turning = editor.turnInto(id, target);
      press(doc, 'Cancel');
      await runUntil(env, turning);
      assert.ok(doc.activeElement === into(), `focus is in ${id}`);
    }
  });

  it("Cancel on a selection's Turn into keeps the selection, and a yes clears it", OPTIONS, async () => {
    const { env, editor, doc } = await openNote([block('a1', 'N', 0, 'Before'), TABLE, { ...IMAGE, order: 2 }]);
    delete editor.clearBlockSelection;
    const anchor = doc.body.appendChild(doc.createElement('button'));
    const choose = () => {
      editor.showSelectionTurnIntoMenu(anchor);
      doc.querySelector('.turn-into-menu').querySelectorAll('.context-menu-item').find(item => item.textContent === 'TText').click();
    };
    editor.selectedBlockIds = new Set(['t1', 'm1']);
    choose();
    press(doc, 'Cancel');
    await runUntil(env, Promise.resolve());
    assert.deepEqual([...editor.selectedBlockIds], ['t1', 'm1'], 'kept after Cancel');
    choose();
    press(doc, 'Turn into Text');
    await runUntil(env, Promise.resolve());
    assert.equal(editor.selectedBlockIds.size, 0, 'cleared after a yes');
    assert.deepEqual(typesOf(editor), ['text', 'text', 'text']);
  });

  it('with blocks selected, Backspace and Delete in a block are the selection\'s, and the block leaves them alone', OPTIONS, async () => {
    const { editor, doc } = await openNote([block('a1', 'N', 0, 'Before'), TOGGLE, block('a3', 'N', 2, 'After')]);
    doc.defaultView.getSelection = () => ({ isCollapsed: true, rangeCount: 1 });
    editor.isCaretAtStart = () => true;
    editor.isCaretAtEnd = () => true;
    editor.selectedBlockIds = new Set(['a3']);
    editor.onBlockKeyDown({ key: 'Backspace', target: contentEl(editor, 'g1'), preventDefault() {} });
    editor.onBlockKeyDown({ key: 'Delete', target: contentEl(editor, 'a1'), preventDefault() {} });
    assert.ok(overlay(doc) === null, 'no Turn into question');
    assert.deepEqual(editor.blocks.map(b => [b.id, b.type, b.content]), [['a1', 'text', 'Before'], ['g1', 'toggle', 'Heading'], ['a3', 'text', 'After']]);
  });

  it('the Alt+1 shortcut on a table asks first', OPTIONS, async () => {
    const { editor, doc } = await openNote([block('a1', 'N', 0, 'Before'), TABLE]);
    const cell = editor.container.querySelector('[data-id="t1"]').querySelector('td');
    editor.onBlockKeyDown({ key: '1', code: 'Digit1', altKey: true, metaKey: false, ctrlKey: false, shiftKey: false, target: cell, preventDefault() {} });
    assert.deepEqual(words(doc), ['Turn into Heading 1?', "The table's grid is removed. Its cells are kept as text, one row per line."]);
    press(doc, 'Cancel');
  });

  it("a pop-out editor asks in its own window", OPTIONS, async () => {
    const { env, editor, doc } = await openNote([block('a1', 'N', 0, 'Before'), TABLE], { pip: true });
    const turning = editor.turnInto('t1', 'text');
    assert.ok(overlay(env.document) === null, 'not in the page behind it');
    assert.deepEqual(words(doc)[0], 'Turn into Text?');
    press(doc, 'Cancel');
    await turning;
  });
});

describe("Delete at a block's end leaves a following toggle's hidden content alone (#14 slice 3)", () => {
  it('a toggle with hidden content after the caret stays as it is', OPTIONS, async () => {
    const { env, editor, doc } = await openNote([block('a1', 'N', 0, 'Before'), TOGGLE]);
    editor.isCaretAtEnd = () => true;
    doc.defaultView.getSelection = () => ({ isCollapsed: true, rangeCount: 1 });
    editor.onBlockKeyDown({ key: 'Delete', target: contentEl(editor, 'a1'), preventDefault() {} });
    assert.deepEqual(typesOf(editor), ['text', 'toggle']);
    assert.equal(editor.getBlockById('g1').children, 'Inside <i>it</i>');
    await runUntil(env, editor.save());
    assert.equal((await stored(env)).g1.children, 'Inside <i>it</i>');
  });

  it("a text block holding a field its type doesn't own stays as it is, after the caret or before it", OPTIONS, async () => {
    const carrying = { ...block('x2', 'N', 1, 'Next'), futureField: 'kept' };
    const { env, editor, doc } = await openNote([block('a1', 'N', 0, 'Before'), carrying]);
    doc.defaultView.getSelection = () => ({ isCollapsed: true, rangeCount: 1 });
    editor.isCaretAtEnd = () => true;
    editor.onBlockKeyDown({ key: 'Delete', target: contentEl(editor, 'a1'), preventDefault() {} });
    assert.deepEqual(editor.blocks.map(b => [b.id, b.content]), [['a1', 'Before'], ['x2', 'Next']], 'Delete');
    editor.isCaretAtEnd = () => false;
    editor.isCaretAtStart = () => true;
    editor.onBlockKeyDown({ key: 'Backspace', target: contentEl(editor, 'x2'), preventDefault() {} });
    assert.deepEqual(editor.blocks.map(b => [b.id, b.content]), [['a1', 'Before'], ['x2', 'Next']], 'Backspace');
    await runUntil(env, editor.save());
    assert.equal((await stored(env)).x2.futureField, 'kept');
  });

  it('a text block whose imageUrl holds an image stays as it is, after the caret or before it', OPTIONS, async () => {
    const holder = { ...block('x2', 'N', 1, 'Next'), imageUrl: 'data:image/png;base64,iVBORw0KGgo=' };
    const { env, editor, doc } = await openNote([block('a1', 'N', 0, 'Before'), holder]);
    doc.defaultView.getSelection = () => ({ isCollapsed: true, rangeCount: 1 });
    editor.isCaretAtEnd = () => true;
    editor.onBlockKeyDown({ key: 'Delete', target: contentEl(editor, 'a1'), preventDefault() {} });
    assert.deepEqual(editor.blocks.map(b => [b.id, b.content]), [['a1', 'Before'], ['x2', 'Next']], 'Delete');
    editor.isCaretAtEnd = () => false;
    editor.isCaretAtStart = () => true;
    editor.onBlockKeyDown({ key: 'Backspace', target: contentEl(editor, 'x2'), preventDefault() {} });
    assert.deepEqual(editor.blocks.map(b => [b.id, b.content]), [['a1', 'Before'], ['x2', 'Next']], 'Backspace');
    await runUntil(env, editor.save());
    assert.equal((await stored(env)).x2.imageUrl, holder.imageUrl);
  });

  it('a toggle with nothing hidden still merges into the block before it, as before', OPTIONS, async () => {
    const { editor, doc } = await openNote([block('a1', 'N', 0, 'Before'), { ...TOGGLE, children: '' }]);
    editor.isCaretAtEnd = () => true;
    doc.defaultView.getSelection = () => ({ isCollapsed: true, rangeCount: 1 });
    editor.onBlockKeyDown({ key: 'Delete', target: contentEl(editor, 'a1'), preventDefault() {} });
    assert.deepEqual(typesOf(editor), ['text']);
    assert.equal(editor.blocks[0].content, 'BeforeHeading');
  });
});

describe("a paste never puts a block's new type over what it holds (#14 slice 3)", () => {
  const paste = (editor, id, text) => {
    // No caret in the fake window, so a re-render keeps none
    editor.doc.defaultView.getSelection = () => ({ isCollapsed: true, rangeCount: 0 });
    editor.onPaste({ target: contentEl(editor, id), clipboardData: { items: [], getData: () => text }, preventDefault() {} });
  };
  // An empty text block that holds an image, which turning it into another type would remove
  const HOLDER = { ...block('p1', 'N', 0, ''), imageUrl: 'data:image/png;base64,iVBORw0KGgo=' };

  it('fenced code pasted into it goes into a code block after it', OPTIONS, async () => {
    const { editor } = await openNote([HOLDER]);
    paste(editor, 'p1', '```\nconst a = 1;\n```');
    assert.deepEqual(typesOf(editor), ['text', 'code']);
    assert.deepEqual([editor.blocks[0].content, editor.blocks[0].imageUrl], ['', HOLDER.imageUrl]);
  });

  it('Markdown pasted into it goes into blocks after it', OPTIONS, async () => {
    const { editor } = await openNote([HOLDER]);
    paste(editor, 'p1', '# Heading\n\nSome text');
    assert.deepEqual(typesOf(editor), ['text', 'h1', 'text']);
    assert.deepEqual([editor.blocks[0].content, editor.blocks[0].imageUrl], ['', HOLDER.imageUrl]);
  });

  it('into an empty text block holding nothing else, it still turns that block, as before', OPTIONS, async () => {
    const { editor } = await openNote([block('p2', 'N', 0, '')]);
    paste(editor, 'p2', '# Heading\n\nSome text');
    assert.deepEqual(typesOf(editor), ['h1', 'text']);
    assert.equal(editor.blocks[0].id, 'p2');
  });
});
