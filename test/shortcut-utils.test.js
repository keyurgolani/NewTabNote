const test = require('node:test');
const assert = require('node:assert/strict');

const {
  clampIndentLevel,
  getAppShortcutAction,
  getEditorShortcutAction,
  moveItemInArray,
} = require('../js/shortcut-utils.js');

test('app-level shortcut resolves Mod+Shift+N to a new-note action', () => {
  assert.equal(getAppShortcutAction({
    code: 'KeyN',
    key: 'N',
    modKey: true,
    shiftKey: true,
    altKey: false,
    isInput: false,
  }), 'new-note');
});

test('app-level shortcut resolves Mod+Shift+E and Mod+Shift+F11 actions', () => {
  assert.equal(getAppShortcutAction({
    code: 'KeyE',
    key: 'E',
    modKey: true,
    shiftKey: true,
    altKey: false,
    isInput: false,
  }), 'toggle-sidebar');

  assert.equal(getAppShortcutAction({
    code: 'F11',
    key: 'F11',
    modKey: true,
    shiftKey: true,
    altKey: false,
    isInput: false,
  }), 'toggle-focus-mode');

  assert.equal(getAppShortcutAction({
    code: 'KeyA',
    key: 'A',
    modKey: true,
    shiftKey: true,
    altKey: false,
    isInput: false,
  }), 'command-palette');
});

test('editor shortcut resolves insert-below, move-block, and heading conversion actions', () => {
  assert.deepEqual(getEditorShortcutAction({
    code: 'Enter',
    key: 'Enter',
    modKey: true,
    shiftKey: false,
    altKey: false,
    blockType: 'text',
  }), { type: 'insert-below' });

  assert.deepEqual(getEditorShortcutAction({
    code: 'ArrowUp',
    key: 'ArrowUp',
    modKey: true,
    shiftKey: true,
    altKey: false,
    blockType: 'text',
  }), { type: 'move-block', direction: -1 });

  assert.deepEqual(getEditorShortcutAction({
    code: 'Digit2',
    key: '2',
    modKey: false,
    shiftKey: false,
    altKey: true,
    blockType: 'text',
  }), { type: 'convert-block', blockType: 'h2' });
});

test('editor shortcut resolves list indentation only for list-like blocks', () => {
  assert.deepEqual(getEditorShortcutAction({
    code: 'Tab',
    key: 'Tab',
    modKey: false,
    shiftKey: false,
    altKey: false,
    blockType: 'bullet',
  }), { type: 'indent-block', delta: 1 });

  assert.deepEqual(getEditorShortcutAction({
    code: 'Tab',
    key: 'Tab',
    modKey: false,
    shiftKey: true,
    altKey: false,
    blockType: 'todo',
  }), { type: 'indent-block', delta: -1 });

  assert.equal(getEditorShortcutAction({
    code: 'Tab',
    key: 'Tab',
    modKey: false,
    shiftKey: false,
    altKey: false,
    blockType: 'text',
  }), null);
});

test("editor shortcut resolves Mod+/ to the block's menu, with no Shift or Alt, and no app shortcut takes it (#14 slice 4)", () => {
  const press = (more) => getEditorShortcutAction({ code: 'Slash', key: '/', modKey: true, shiftKey: false, altKey: false, blockType: 'text', ...more });
  assert.deepEqual(press({}), { type: 'block-menu' });
  assert.deepEqual(press({ blockType: 'divider' }), { type: 'block-menu' });
  for (const more of [{ modKey: false }, { shiftKey: true, key: '?' }, { altKey: true }]) {
    assert.equal(press(more), null, JSON.stringify(more));
  }
  for (const isInput of [false, true]) {
    assert.equal(getAppShortcutAction({ code: 'Slash', key: '/', modKey: true, shiftKey: false, altKey: false, isInput }), null);
  }
});

test("Mod+/ is the character, wherever a layout puts it: Mod and the key that types '-' there is the browser's zoom out, and Mod+Shift+7 typing '/' opens the menu (#202's review)", () => {
  const press = (more) => getEditorShortcutAction({ modKey: true, shiftKey: false, altKey: false, blockType: 'text', ...more });
  // German, Nordic, Spanish, Italian and Swiss layouts type '-' at the US '/' key, and '/' as Shift+7
  assert.equal(press({ code: 'Slash', key: '-' }), null, "Mod and the US '/' key typing '-' stays the browser's");
  assert.deepEqual(press({ code: 'Digit7', key: '/', shiftKey: true }), { type: 'block-menu' }, "Mod+Shift+7 typing '/' opens the block's menu");
  assert.equal(press({ code: 'Slash', key: '?', shiftKey: true }), null, "Mod+? on a US layout isn't it");
});

test('clampIndentLevel keeps indentation between zero and four', () => {
  assert.equal(clampIndentLevel(0, -1), 0);
  assert.equal(clampIndentLevel(2, 1), 3);
  assert.equal(clampIndentLevel(4, 1), 4);
});

test('moveItemInArray reorders a block collection without mutating the input array', () => {
  const original = ['a', 'b', 'c'];
  const moved = moveItemInArray(original, 0, 2);

  assert.deepEqual(moved, ['b', 'c', 'a']);
  assert.deepEqual(original, ['a', 'b', 'c']);
});

test('app-level shortcut resolves Alt+D to daily-note action', () => {
  assert.equal(getAppShortcutAction({
    code: 'KeyD',
    key: 'd',
    modKey: false,
    shiftKey: false,
    altKey: true,
    isInput: false,
  }), 'daily-note');
});

test('app-level shortcut resolves Ctrl+Tab to next-tab and Ctrl+Shift+Tab to prev-tab', () => {
  assert.equal(getAppShortcutAction({
    code: 'Tab',
    key: 'Tab',
    modKey: true,
    shiftKey: false,
    altKey: false,
    isInput: false,
  }), 'next-tab');

  assert.equal(getAppShortcutAction({
    code: 'Tab',
    key: 'Tab',
    modKey: true,
    shiftKey: true,
    altKey: false,
    isInput: false,
  }), 'prev-tab');
});

test('app-level shortcut resolves Ctrl+W to close-tab action', () => {
  assert.equal(getAppShortcutAction({
    code: 'KeyW',
    key: 'w',
    modKey: true,
    shiftKey: false,
    altKey: false,
    isInput: false,
  }), 'close-tab');
});
