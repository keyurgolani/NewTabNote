'use strict';

// #14 slice 4's keys in the editor, after #202's review, in the repo's vm env with the editor's own
// scripts: Mod+/ is the character '/', wherever a layout types it; '/' typed with AltGr still opens
// the slash menu; a key an IME composes with is the IME's; a press on a divider's or an image's
// stop leaves it unfocused; a question's Cancel gives focus back to a stop; a key's delete puts
// focus on the block before when that block takes focus, and else on the block now in the deleted
// one's place, at its start; and Mod+/ and a click on the handle close the editor's other menus
// before the block's opens.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { createLegacyEnv, createDatabase, note, block, startEditorClient, makeEditor, runUntil } = require('./helpers/legacy-env');

const FILES = ['js/utils.js', 'js/core/storage-error.js', 'js/ui/confirm-dialog.js', 'js/storage.js', 'js/sidebar-utils.js', 'js/blocks.js', 'js/editor.js', 'js/shortcut-utils.js'];
const OPTIONS = { timeout: 30_000 };
const DIVIDER = (id, order) => ({ ...block(id, 'N', order, ''), type: 'divider' });
const IMAGE = (id, order) => ({ ...block(id, 'N', order, ''), type: 'image', imageUrl: 'data:image/png;base64,AAAA' });
const TABLE = (id, order) => ({ ...block(id, 'N', order, ''), type: 'table', rows: 1, cols: 2, tableData: [['A', 'B']], hasHeaderRow: true });

/** An editor on note N, holding `records`, that renders, on Windows unless `platform` says otherwise */
async function openNote(records, platform = 'Win32') {
  const env = createLegacyEnv();
  await createDatabase(env.indexedDB, { records: { canvases: [note('N', { name: 'Plan' })], elements: records } });
  env.load(...FILES);
  env.global.URL = URL;
  // The fake DOM has no style.setProperty, which a block's element sets its indent with
  const create = env.document.createElement.bind(env.document);
  env.document.createElement = tag => {
    const el = create(tag);
    el.style.setProperty = (name, value) => { el.style[name] = String(value); };
    return el;
  };
  await startEditorClient(env);
  const editor = makeEditor(env);
  delete editor.renderBlocks;
  Object.assign(editor, { updateAddBlockHint() {}, observeImages() {}, updateWideContentCentering() {} });
  await runUntil(env, editor.loadNote('N'));
  env.global.navigator.platform = platform;
  return { env, editor };
}

const elementOf = (editor, id) => editor.container.querySelector(`[data-id="${id}"]`);

/** A keydown at `target`, through the block's handler */
function press(editor, target, key, more = {}) {
  const event = {
    key, code: '', target, ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, isComposing: false, repeat: false,
    defaultPrevented: false, ...more,
    preventDefault() { this.defaultPrevented = true; },
    stopPropagation() {},
  };
  editor.onBlockKeyDown(event);
  return event;
}

/** A click at `target`, through the editor's click handler */
function click(editor, target) {
  editor.onBlockClick({ target, shiftKey: false, metaKey: false, ctrlKey: false, altKey: false, preventDefault() {}, stopPropagation() {} });
}

describe("the block menu's key, by its character (#202's review)", () => {
  it("Ctrl and the key that types '-' on a German layout opens nothing and keeps the browser's zoom out, and Ctrl+Shift+7, which types '/' there, opens the block's menu", OPTIONS, async () => {
    const { editor } = await openNote([block('a1', 'N', 0, 'Some text')]);
    const opened = [];
    editor.showBlockActionMenu = id => opened.push(id);
    const content = elementOf(editor, 'a1').querySelector('.block-content');
    const minus = press(editor, content, '-', { code: 'Slash', ctrlKey: true });
    assert.deepEqual([opened.length, minus.defaultPrevented], [0, false], "Ctrl and the US '/' key typing '-' stays the browser's");
    const slash = press(editor, content, '/', { code: 'Digit7', ctrlKey: true, shiftKey: true });
    assert.deepEqual([opened, slash.defaultPrevented], [['a1'], true], "Ctrl+Shift+7 typing '/' opens the block's menu");
  });

  it("'/' typed with AltGr, which Windows reports as Ctrl and Alt, opens the slash menu in an empty block, and not the block's menu", OPTIONS, async () => {
    const { editor } = await openNote([block('e1', 'N', 0, '')]);
    const opened = [];
    editor.showSlashMenu = () => opened.push('slash menu');
    editor.showBlockActionMenu = () => opened.push('block menu');
    const content = elementOf(editor, 'e1').querySelector('.block-content');
    const event = press(editor, content, '/', { code: 'KeyQ', ctrlKey: true, altKey: true });
    assert.deepEqual([opened, event.defaultPrevented], [['slash menu'], true]);
  });
});

describe("the keys an IME composes with are the IME's (#202's review)", () => {
  it('during a composition, ArrowDown at the end of a line before a divider stays in the line, and Mod+/ opens nothing, each with its default kept', OPTIONS, async () => {
    const { env, editor } = await openNote([block('a1', 'N', 0, 'Some text'), DIVIDER('d1', 1)]);
    const opened = [];
    editor.showBlockActionMenu = id => opened.push(id);
    editor.isCaretAtEnd = () => true;
    const content = elementOf(editor, 'a1').querySelector('.block-content');
    content.focus();
    const down = press(editor, content, 'ArrowDown', { isComposing: true });
    assert.deepEqual([env.document.activeElement === content, down.defaultPrevented], [true, false], 'ArrowDown during a composition is the IME\'s');
    const slash = press(editor, content, '/', { code: 'Slash', ctrlKey: true, isComposing: true });
    assert.deepEqual([opened.length, slash.defaultPrevented], [0, false], 'Mod+/ during a composition is the IME\'s');
  });

  it("in the title too: during a composition, ArrowDown and the Enter that commits the IME's text leave focus in the title, before a first block that's a divider, each with its default kept (#202's delta check)", OPTIONS, async () => {
    const { env, editor } = await openNote([DIVIDER('d1', 0), block('a1', 'N', 1, 'Some text')]);
    editor.titleEl.focus();
    for (const key of ['ArrowDown', 'Enter']) {
      const event = { key, isComposing: true, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; } };
      editor.onTitleKeyDown(event);
      assert.deepEqual([env.document.activeElement === editor.titleEl, event.defaultPrevented], [true, false], `${key} during a composition in the title is the IME's`);
    }
  });
});

describe("focus on and after a stop (#202's review)", () => {
  it("a press on an image leaves no focus on its stop, which the browser gave it, so the stop's keys don't take a typed letter or Backspace", OPTIONS, async () => {
    const { env, editor } = await openNote([block('t1', 'N', 0, 'Before'), IMAGE('i1', 1)]);
    const stop = elementOf(editor, 'i1').querySelector('.block-stop');
    stop.focus();
    click(editor, stop.querySelector('img'));
    assert.ok(env.document.activeElement !== stop, "the image's stop keeps no focus from the press");
  });

  it("and so does a press on an empty image's placeholder, which sits in its stop (#202's delta check)", OPTIONS, async () => {
    const { env, editor } = await openNote([block('t1', 'N', 0, 'Before'), { ...IMAGE('e1', 1), imageUrl: '' }]);
    const stop = elementOf(editor, 'e1').querySelector('.block-stop');
    const placeholder = stop.querySelector('.image-placeholder');
    assert.ok(placeholder, 'the empty image shows its placeholder in its stop');
    stop.focus();
    click(editor, placeholder);
    assert.ok(env.document.activeElement !== stop, "the empty image's stop keeps no focus from the press");
  });

  it("a question's Cancel, when what had focus is gone, gives focus back to the block's stop, as after a Turn into from an image's menu", OPTIONS, async () => {
    const { env, editor } = await openNote([block('t1', 'N', 0, 'Before'), IMAGE('i1', 1)]);
    const gone = env.document.createElement('div');
    editor._focusAfterCancel(gone, ['i1']);
    assert.ok(env.document.activeElement === elementOf(editor, 'i1').querySelector('.block-stop'), "focus is back on the image's stop");
  });

  it("a key's delete puts focus on the block before when it takes focus, and else, after a table or for the first block, on the block now in the deleted one's place, at its start", OPTIONS, async () => {
    const { env, editor } = await openNote([DIVIDER('d0', 0), block('m1', 'N', 1, 'Middle'), TABLE('t1', 2), DIVIDER('d1', 3), block('x1', 'N', 4, 'After')]);
    const ends = [];
    editor.placeCaretAtEnd = el => ends.push(el);
    const deleteByKey = async id => {
      editor.selectedBlockIds = new Set([id]);
      await runUntil(env, editor.deleteSelectedBlocks(true));
    };

    await deleteByKey('d1');
    const after = elementOf(editor, 'x1').querySelector('.block-content');
    assert.deepEqual([env.document.activeElement === after, ends.length], [true, 0], "after a table, which takes no focus, the block in the divider's place has it, at its start");

    await deleteByKey('d0');
    const middle = elementOf(editor, 'm1').querySelector('.block-content');
    assert.deepEqual([env.document.activeElement === middle, ends.length], [true, 0], 'for the first block, the block now first has it, at its start');
  });
});

describe("the block's menu closes the editor's other menus first (#202's review)", () => {
  it("Mod+/ and a click on the handle each close the other menus, the slash menu among them, before the block's opens", OPTIONS, async () => {
    const { editor } = await openNote([block('a1', 'N', 0, 'Some text')]);
    const calls = [];
    editor.hideMenus = () => calls.push('hide the others');
    editor.showBlockActionMenu = () => calls.push('open');
    const el = elementOf(editor, 'a1');
    press(editor, el.querySelector('.block-content'), '/', { code: 'Slash', ctrlKey: true });
    click(editor, el.querySelector('.block-handle'));
    assert.deepEqual(calls, ['hide the others', 'open', 'hide the others', 'open']);
  });
});
