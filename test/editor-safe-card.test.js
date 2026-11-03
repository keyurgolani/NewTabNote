'use strict';

// #14 slice 3, per-block render isolation with a minimal read-only safe card. A block this build
// doesn't fully read (from a newer version, of a type it doesn't have, or with stored data it
// can't read), and a block whose type throws while drawing it, shows a card naming its type, in
// its place, with nothing in it to type in. Every other block of the note renders, edits and
// saves as usual. The editor leaves a card alone: no block menu, no Turn into, no block for the
// sidebar from its drag, and deleting it asks first. Elements are compared by small fields only.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  createLegacyEnv, createDatabase, dumpDatabase, recordsOf, plain, note, block, startEditorClient, makeEditor, runUntil,
} = require('./helpers/legacy-env');

const FILES = ['js/utils.js', 'js/core/storage-error.js', 'js/ui/confirm-dialog.js', 'js/storage.js', 'js/sidebar-utils.js', 'js/blocks.js', 'js/editor.js'];
const T = 1700000000000;
const OPTIONS = { timeout: 30_000 };

const KANBAN = { id: 'k1', type: 'kanban', columns: [{ name: 'To do' }], content: '<b>board</b>', canvasId: 'N', order: 1, createdAt: T, updatedAt: T };
const NEWER = { ...block('n1', 'N', 1, 'Newer'), type: 'table', schemaVersion: 2, grid: { rows: [] } };
const INVALID = { ...block('i1', 'N', 1, ''), type: 'table', rows: 1, cols: 2, tableData: 'Name,Age', hasHeaderRow: true };
const RELATIVE = { ...block('r1', 'N', 1, ''), type: 'bookmark', url: '/relative/page', title: 'Relative', description: '', favicon: '' };

/** An editor on note N, holding `records`, that renders: makeEditor stubs rendering out, and only the page chrome is stubbed here */
async function openNote(records) {
  const env = createLegacyEnv();
  await createDatabase(env.indexedDB, { records: { canvases: [note('N', { name: 'Plan' })], elements: records } });
  env.load(...FILES);
  env.global.URL = URL;
  // The fake DOM has no style.setProperty, which a block's element sets its indent with, and no
  // replaceWith, which a block's re-render takes its old element's place with
  const create = env.document.createElement.bind(env.document);
  env.document.createElement = tag => {
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
  await startEditorClient(env);
  const editor = makeEditor(env);
  delete editor.renderBlocks;
  Object.assign(editor, { updateAddBlockHint() {}, observeImages() {}, updateWideContentCentering() {}, focusBlock() {} });
  const loaded = await runUntil(env, editor.loadNote('N').catch(error => ({ threw: error && error.name })));
  return { env, editor, loaded };
}

const shownIds = editor => editor.container.querySelectorAll('.block').map(el => el.dataset.id);
const elementOf = (editor, id) => editor.container.querySelector(`[data-id="${id}"]`);
const cardWords = el => [el.querySelector('.block-safe-title')?.textContent, el.querySelector('.block-safe-detail')?.textContent];
const stored = async env => recordsOf(await dumpDatabase(env.indexedDB), 'elements');

/** Whether an element holds anything a user could type into */
function editable(el) {
  if (el.contentEditable === true || el.contentEditable === 'true') return true;
  if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') return true;
  return el.children.some(editable);
}

describe('a block in a safe state shows a read-only card in its place (#14 slice 3)', () => {
  it('a block whose view throws leaves every other block of the note on screen, with a card in its place', OPTIONS, async () => {
    const { editor, loaded } = await openNote([block('a1', 'N', 0, 'Before'), RELATIVE, block('a3', 'N', 2, 'After')]);
    assert.equal(loaded && loaded.threw, undefined, 'the load finishes');
    assert.deepEqual(shownIds(editor), ['a1', 'r1', 'a3']);
    const card = elementOf(editor, 'r1');
    assert.ok(card.classList.contains('block-safe'));
    assert.deepEqual(cardWords(card), ["This bookmark block can't be shown", 'Something in it stops it from showing. Its content is kept as it is.']);
    assert.equal(editable(card), false);
    assert.equal(elementOf(editor, 'a3').querySelector('.block-content').textContent, 'After');
  });

  it("a block of a type this build lacks shows a card naming its type, with nothing to type in and no type's styles", OPTIONS, async () => {
    const { editor } = await openNote([block('a1', 'N', 0, 'Before'), KANBAN]);
    const card = elementOf(editor, 'k1');
    assert.deepEqual(cardWords(card), [
      "This “kanban” block can't be shown",
      "This version of NewTabNote doesn't have this kind of block. Its content is kept as it is.",
    ]);
    assert.ok(card.querySelector('.block-content') === null, 'no editable content');
    assert.equal(editable(card), false);
    assert.equal(card.getAttribute('data-type'), null, "no type's styles or numbering apply");
    assert.ok(card.querySelector('.block-handle') !== null, 'its handle, to move and select it');
  });

  it('a block from a newer version, and one whose stored data its type can\'t read, show a card each', OPTIONS, async () => {
    const { editor } = await openNote([block('a1', 'N', 0, 'Before'), NEWER, { ...INVALID, order: 2 }]);
    assert.deepEqual(cardWords(elementOf(editor, 'n1')), [
      "This table block can't be shown",
      'It was saved by a newer version of NewTabNote. Its content is kept as it is.',
    ]);
    assert.deepEqual(cardWords(elementOf(editor, 'i1')), [
      "This table block can't be shown",
      "Its saved data isn't in a form this version can read. Its content is kept as it is.",
    ]);
  });

  it('a record with no type shows a card that names none, and an unknown id shows as text, cut at 40 characters', OPTIONS, async () => {
    const typeless = block('t1', 'N', 0, 'No type');
    delete typeless.type;
    const long = { ...KANBAN, id: 'l1', order: 1, type: `<b>${'x'.repeat(60)}</b>` };
    const { editor } = await openNote([typeless, long]);
    assert.deepEqual(cardWords(elementOf(editor, 't1')), [
      "This block can't be shown",
      "Its saved data isn't in a form this version can read. Its content is kept as it is.",
    ]);
    const [title] = cardWords(elementOf(editor, 'l1'));
    assert.equal(title, `This “<b>${'x'.repeat(37)}…” block can't be shown`);
    assert.equal(elementOf(editor, 'l1').querySelector('.block-safe-title').children.length, 0, 'set as text');
  });

  it('the rest of the note edits and saves as usual, and a save leaves each card, and each block it didn\'t change, as stored', OPTIONS, async () => {
    const { env, editor, loaded } = await openNote([block('a1', 'N', 0, 'Before'), KANBAN, { ...RELATIVE, order: 2 }, block('a4', 'N', 3, 'After')]);
    assert.equal(loaded && loaded.threw, undefined, 'the load finishes');
    assert.equal(elementOf(editor, 'a4').querySelector('.block-content').textContent, 'After');
    editor.getBlockById('a4').content = 'After, edited';
    await runUntil(env, editor.save());
    const after = await stored(env);
    assert.equal(after.a4.content, 'After, edited');
    assert.equal(after.a4.schemaVersion, 1, 'the block the save writes says its version');
    assert.deepEqual(plain(after.k1), plain(KANBAN));
    // A known block whose view threw is like any other: left alone, it isn't rewritten, so it
    // stays as stored, with no version
    assert.deepEqual(plain(after.r1), plain({ ...RELATIVE, order: 2 }));
  });

  it("a note holding a block whose text can't be read opens and saves", OPTIONS, async () => {
    const rows = { ...INVALID, tableData: ['a', 'b'] };
    const { env, editor, loaded } = await openNote([block('a1', 'N', 0, 'Before'), rows]);
    assert.equal(loaded && loaded.threw, undefined, 'the load finishes');
    editor.getBlockById('a1').content = 'Before, edited';
    await runUntil(env, editor.save());
    const after = await stored(env);
    assert.equal(after.a1.content, 'Before, edited');
    assert.deepEqual(plain(after.i1.tableData), ['a', 'b']);
  });
});

describe('the editor leaves a card alone (#14 slice 3)', () => {
  it("a card's block menu doesn't open, so it offers no Turn into and no AI action", OPTIONS, async () => {
    const { env, editor } = await openNote([block('a1', 'N', 0, 'Before'), KANBAN]);
    const handle = elementOf(editor, 'k1').querySelector('.block-handle');
    handle.getBoundingClientRect = () => ({ left: 0, top: 0, right: 24, bottom: 24, width: 24, height: 24 });
    editor.showBlockActionMenu('k1', handle);
    assert.equal(env.document.querySelectorAll('.block-action-menu').length, 0);
  });

  it('Turn into leaves a card as it was', OPTIONS, async () => {
    const { env, editor } = await openNote([block('a1', 'N', 0, 'Before'), NEWER]);
    editor.changeBlockType('n1', 'text');
    assert.equal(editor.getBlockById('n1').type, 'table');
    await runUntil(env, editor.save());
    assert.deepEqual(plain((await stored(env)).n1), plain(NEWER));
  });

  it("a card's drag moves it within the note and carries no block for the sidebar", OPTIONS, async () => {
    const { editor } = await openNote([block('a1', 'N', 0, 'Before'), KANBAN]);
    const data = {};
    const dataTransfer = { setData: (type, value) => { data[type] = value; }, effectAllowed: '' };
    editor.onDragStart({ target: elementOf(editor, 'k1'), dataTransfer });
    assert.deepEqual(Object.keys(data), ['text/plain']);
    assert.equal(data['text/plain'], 'k1');
  });
});

describe('deleting a selection that holds a card asks first (#14 slice 3)', () => {
  const overlay = env => env.document.querySelector('.confirm-dialog-overlay');
  const press = (env, label) => overlay(env).querySelectorAll('button').find(button => button.textContent === label).click();
  const words = env => [overlay(env).querySelector('.confirm-dialog-title').textContent, overlay(env).querySelector('.confirm-dialog-message').textContent];

  it('asks about one card, and Cancel keeps it', OPTIONS, async () => {
    const { env, editor } = await openNote([block('a1', 'N', 0, 'Before'), KANBAN]);
    editor.selectedBlockIds = new Set(['k1']);
    const deleting = editor.deleteSelectedBlocks();
    assert.deepEqual(words(env), [
      'Delete this block?',
      "This version of NewTabNote can't show what's in it, so you can't see what you'd delete. Undo brings it back.",
    ]);
    press(env, 'Cancel');
    await runUntil(env, deleting);
    assert.deepEqual(editor.blocks.map(b => b.id), ['a1', 'k1']);
    await runUntil(env, editor.save());
    assert.deepEqual(plain((await stored(env)).k1), plain(KANBAN));
  });

  it('deletes it on a yes, and Undo brings it back as it was loaded', OPTIONS, async () => {
    const { env, editor } = await openNote([block('a1', 'N', 0, 'Before'), KANBAN]);
    editor.selectedBlockIds = new Set(['k1']);
    const deleting = editor.deleteSelectedBlocks();
    press(env, 'Delete');
    await runUntil(env, deleting);
    await runUntil(env, editor.save());
    assert.equal((await stored(env)).k1, undefined, 'deleted');

    editor.undo();
    await runUntil(env, editor.save());
    assert.deepEqual(plain((await stored(env)).k1), plain(KANBAN));
  });

  for (const [what, ids, message] of [
    ['one of several', ['a1', 'k1', 'a3'], 'one'],
    ['two of three', ['k1', 'n1', 'a3'], '2'],
    ['all', ['k1', 'n1'], 'all'],
  ]) {
    it(`asks about a selection where ${what} can't be shown`, OPTIONS, async () => {
      const { env, editor } = await openNote([block('a1', 'N', 0, 'Before'), KANBAN, { ...NEWER, order: 2 }, block('a3', 'N', 3, 'After')]);
      editor.selectedBlockIds = new Set(ids);
      const deleting = editor.deleteSelectedBlocks();
      assert.deepEqual(words(env), [
        `Delete ${ids.length} blocks?`,
        `This version of NewTabNote can't show what's in ${message} of them, so you can't see everything you'd delete. Undo brings them back.`,
      ]);
      press(env, 'Cancel');
      await runUntil(env, deleting);
    });
  }

  it('deletes a selection holding cards on a yes, and one Undo brings every block back where it was, as it was loaded', OPTIONS, async () => {
    const newer = { ...NEWER, order: 2 };
    const { env, editor } = await openNote([block('a1', 'N', 0, 'Before'), KANBAN, newer, block('a3', 'N', 3, 'After')]);
    editor.selectedBlockIds = new Set(['k1', 'n1', 'a3']);
    const deleting = editor.deleteSelectedBlocks();
    press(env, 'Delete');
    await runUntil(env, deleting);
    assert.deepEqual(editor.blocks.map(b => b.id), ['a1']);

    editor.undo();
    assert.deepEqual(editor.blocks.map(b => b.id), ['a1', 'k1', 'n1', 'a3']);
    await runUntil(env, editor.save());
    const after = await stored(env);
    assert.deepEqual(plain(after.k1), plain(KANBAN));
    assert.deepEqual(plain(after.n1), plain(newer));
    assert.equal(after.a3.content, 'After');
  });

  it('Cancel puts focus back where it was in the note, or in the first selected block that takes it, and keeps the selection', OPTIONS, async () => {
    const { env, editor } = await openNote([block('a1', 'N', 0, 'Before'), KANBAN, block('a3', 'N', 2, 'After')]);
    delete editor.clearBlockSelection;
    const text = id => elementOf(editor, id).querySelector('.block-content');
    for (const [from, to] of [[() => text('a1'), () => text('a1')], [() => env.document.body, () => text('a3')]]) {
      editor.selectedBlockIds = new Set(['k1', 'a3']);
      from().focus();
      const deleting = editor.deleteSelectedBlocks();
      press(env, 'Cancel');
      await runUntil(env, deleting);
      assert.ok(env.document.activeElement === to(), 'focus');
      assert.deepEqual([...editor.selectedBlockIds], ['k1', 'a3'], 'the selection stays');
    }
  });

  it("deletes a selection with no card in it without asking, as before", OPTIONS, async () => {
    const { env, editor } = await openNote([block('a1', 'N', 0, 'Before'), block('a2', 'N', 1, 'Gone')]);
    editor.selectedBlockIds = new Set(['a2']);
    await runUntil(env, Promise.resolve(editor.deleteSelectedBlocks()));
    assert.equal(overlay(env), null);
    assert.deepEqual(editor.blocks.map(b => b.id), ['a1']);
  });
});
