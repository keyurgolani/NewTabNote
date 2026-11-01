'use strict';

// Type anywhere (#1 AC2's rule, NTN-18 slice 0 item 9): when focus isn't in a
// text control, no modal, menu, listbox, or dialog has it, and none is open, a
// printable key goes to the note, except Space on a button, which presses it,
// or on a link, which keeps the browser's default. Both panes' editors listen
// on one document, and exactly one of them acts on each key, for typing, undo,
// redo, and deleting a block selection alike: a key pressed in a pane is that
// pane's, any other is the active pane's while it shows.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  createLegacyEnv, FakeDocument, createDatabase, dumpDatabase, recordsOf, settle, note, block, startEditorClient, quietNavigation,
} = require('./helpers/legacy-env');

const FILES = ['js/utils.js', 'js/core/storage-error.js', 'js/storage.js', 'js/sidebar-utils.js', 'js/blocks.js', 'js/shortcut-utils.js', 'js/editor.js'];

/** The modals newtab.html has, each closed, with its dialog box inside */
const MODALS = ['settings-modal', 'shortcuts-modal', 'theme-builder-modal', 'command-palette-modal', 'ai-insert-preview-modal'];

/** Add a `tag` element with `attributes` (`class` as the class name) to `parent` */
function add(parent, tag, attributes = {}) {
  const element = parent.ownerDocument.createElement(tag);
  for (const [name, value] of Object.entries(attributes)) {
    if (name === 'class') element.className = value; else element.setAttribute(name, value);
  }
  parent.appendChild(element);
  return element;
}

/**
 * An editor on `root` in `doc` whose focusBlock, addBlockAtEnd, undo, redo, and
 * deleteSelectedBlocks only record, in `reached`, that the key went to its note
 */
function stubEditor(env, doc, root, noteBlocks, reached) {
  const instance = Object.create(env.get('BlockEditor').prototype);
  Object.assign(instance, {
    root,
    doc,
    blocks: noteBlocks.slice(),
    selectedBlockIds: new Set(),
    focusBlock: (id, atEnd) => reached.push(['focusBlock', id, atEnd]),
    addBlockAtEnd: () => reached.push(['addBlockAtEnd']),
    undo: () => reached.push(['undo']),
    redo: () => reached.push(['redo']),
    deleteSelectedBlocks: () => reached.push(['deleteSelectedBlocks']),
  });
  return instance;
}

/** A keydown at `target` */
function keydown(target, key, modifiers = {}) {
  const event = {
    type: 'keydown', key, target, ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, ...modifiers,
  };
  if (!event.preventDefault) event.preventDefault = () => { event.defaultPrevented = true; };
  return event;
}

/**
 * A page with a header, the left pane (title, the export notice, a block), split
 * view's right pane, the sidebar, the modals and the note menu (closed, as
 * newtab.html has them), and an editor for each pane. `split` is 'closed' (the
 * right pane hidden), 'left', or 'right' (open, with that pane active).
 */
function setup({ split = 'closed', blocks = [{ id: 'b1' }, { id: 'b2' }], rightBlocks = [{ id: 'r1' }] } = {}) {
  const env = createLegacyEnv({ document: new FakeDocument() });
  env.load(...FILES);
  env.global.navigator.platform = 'MacIntel';
  const doc = env.document;
  const header = add(doc.body, 'header');
  const leftPane = add(doc.body, 'div', { id: 'editor-container', class: `editor-pane${split === 'right' ? '' : ' active'}` });
  const editorColumn = add(leftPane, 'div', { id: 'editor', class: 'editor' });
  const notice = add(editorColumn, 'section', { id: 'export-notice', class: 'export-notice is-shown' });
  // The right pane's column isn't #editor
  const rightPane = add(doc.body, 'div', {
    id: 'secondary-editor-container',
    class: `editor-pane secondary${split === 'closed' ? ' hidden' : ''}${split === 'right' ? ' active' : ''}`,
  });
  const rightColumn = add(add(rightPane, 'div', { class: 'editor' }), 'div', { class: 'blocks-container' });
  const sidebar = add(doc.body, 'aside', { id: 'sidebar', class: 'sidebar' });
  const modals = Object.fromEntries(MODALS.map((id) => [id, add(doc.body, 'div', { id, class: 'modal hidden' })]));
  const dialogBoxes = Object.fromEntries(MODALS.map((id) => [id, add(modals[id], 'div', { class: 'modal-content', role: 'dialog', 'aria-modal': 'true' })]));
  const noteMenu = add(doc.body, 'div', { id: 'note-context-menu', class: 'context-menu hidden', role: 'menu' });
  const dialog = add(doc.body, 'div', { role: 'dialog', class: 'hidden' });
  const reply = add(doc.body, 'div', { class: 'ai-message-content' });
  const at = {
    body: doc.body,
    headerButton: add(header, 'button', { id: 'settings-btn', class: 'icon-btn' }),
    headerLink: add(header, 'a', { href: '#editor-container' }),
    noticeButton: add(notice, 'button', { class: 'primary-btn export-notice-btn' }),
    roleButton: add(editorColumn, 'div', { role: 'button', tabindex: '0' }),
    title: add(editorColumn, 'div', { id: 'page-title', contenteditable: 'true' }),
    blockText: add(add(editorColumn, 'div', { class: 'block' }), 'div', { class: 'block-content', contenteditable: 'true' }),
    rightButton: add(rightPane, 'button', { class: 'icon-btn' }),
    rightBlockText: add(add(rightColumn, 'div', { class: 'block' }), 'div', { class: 'block-content', contenteditable: 'true' }),
    input: add(sidebar, 'input', { id: 'sidebar-search' }),
    textarea: add(doc.body, 'textarea', { id: 'ai-chat-input' }),
    select: add(doc.body, 'select'),
    sidebarButton: add(sidebar, 'button', { id: 'sidebar-tab-archive', role: 'tab' }),
    sidebarCheckbox: add(sidebar, 'input', { type: 'checkbox' }),
    settingsButton: add(dialogBoxes['settings-modal'], 'button'),
    settingsField: add(dialogBoxes['settings-modal'], 'input', { id: 'settings-search', type: 'text' }),
    settingsSelect: add(dialogBoxes['settings-modal'], 'select', { id: 'theme-select' }),
    paletteInput: add(dialogBoxes['command-palette-modal'], 'input', { id: 'command-palette-input', type: 'text' }),
    blockUrlInput: add(add(editorColumn, 'div', { class: 'block' }), 'input', { type: 'url', class: 'bookmark-input' }),
    otherEditable: add(doc.body, 'div', { contenteditable: 'true' }),
    menuItem: add(noteMenu, 'button', { role: 'menuitem' }),
    listboxOption: add(add(doc.body, 'div', { role: 'listbox' }), 'div', { role: 'option', tabindex: '0' }),
    dialogButton: add(dialog, 'button'),
    summary: add(add(reply, 'details'), 'summary'),
    video: add(reply, 'video', { controls: '' }),
  };

  // The two editors App builds, listening in the order it builds them
  const reached = { left: [], right: [] };
  const editors = [
    stubEditor(env, doc, leftPane, blocks, reached.left),
    stubEditor(env, doc, rightPane, rightBlocks, reached.right),
  ];

  /** Press `key` with focus at `target`: what reached each note, and whether the default was prevented */
  const press = (target, key, modifiers = {}) => {
    reached.left.length = 0;
    reached.right.length = 0;
    const event = keydown(target, key, modifiers);
    editors.forEach((instance) => instance.onGlobalKeyDown(event));
    return { left: reached.left.slice(), right: reached.right.slice(), prevented: Boolean(event.defaultPrevented) };
  };
  const show = (element) => {
    element.classList.remove('hidden');
    return () => element.classList.add('hidden');
  };
  const page = { body: doc.body, leftPane, modals, noteMenu, dialog, show };
  return { env, doc, at, press, editors, page };
}

const TO_LEFT = { left: [['focusBlock', 'b2', true]], right: [], prevented: false };
const TO_RIGHT = { left: [], right: [['focusBlock', 'r1', true]], prevented: false };
const NOWHERE = { left: [], right: [], prevented: false };
const label = (target) => target.id || target.className || target.getAttribute('role') || target.tagName;

/** An overlay added to the page open; close() takes it away */
const added = (parent, tag, attributes) => {
  const element = add(parent, tag, attributes);
  return () => element.remove();
};

/**
 * Each overlay the new tab opens, opened. The modals leave focus on the button
 * that opened them, and a right-click on a note leaves it where it was.
 */
const OVERLAYS = [
  ['Settings', (page) => page.show(page.modals['settings-modal'])],
  ['Keyboard Shortcuts', (page) => page.show(page.modals['shortcuts-modal'])],
  ['Theme Builder', (page) => page.show(page.modals['theme-builder-modal'])],
  ['the command palette', (page) => page.show(page.modals['command-palette-modal'])],
  ['the AI insert preview', (page) => page.show(page.modals['ai-insert-preview-modal'])],
  ["a snapshot's preview", (page) => added(page.body, 'div', { class: 'modal' })],
  ["a note's menu", (page) => page.show(page.noteMenu)],
  ["a folder's menu", (page) => added(page.body, 'div', { class: 'context-menu' })],
  ['the slash menu', (page) => added(page.leftPane, 'div', { id: 'slash-menu', class: 'slash-menu' })],
  ['the link menu', (page) => added(page.leftPane, 'div', { id: 'wiki-menu', class: 'slash-menu' })],
  ['the template menu', (page) => added(page.leftPane, 'div', { id: 'template-menu', class: 'slash-menu' })],
  ["a block's menu", (page) => added(page.body, 'div', { class: 'block-action-menu' })],
  ['Turn into', (page) => added(page.body, 'div', { class: 'turn-into-menu' })],
  ["a table's menu", (page) => added(page.body, 'div', { class: 'table-context-menu' })],
  ['a confirm dialog', (page) => added(page.body, 'div', { class: 'confirm-dialog-overlay', role: 'dialog', 'aria-modal': 'true' })],
  ['onboarding', (page) => {
    const closeOverlay = added(page.body, 'div', { class: 'onboarding-overlay' });
    const closeTooltip = added(page.body, 'div', { class: 'onboarding-tooltip', role: 'dialog' });
    return () => { closeOverlay(); closeTooltip(); };
  }],
  ['a <dialog>', (page) => added(page.body, 'dialog', { open: '' })],
  ['any other dialog', (page) => page.show(page.dialog)],
  ['an alert dialog', (page) => added(page.body, 'div', { role: 'alertdialog' })],
  ['anything aria-modal', (page) => added(page.body, 'div', { 'aria-modal': 'true' })],
  ['any other menu', (page) => added(page.body, 'div', { role: 'menu' })],
];

describe('type anywhere', () => {
  it('Space on a button presses it, and on a link keeps the browser default; neither types into the note', () => {
    const { at, press } = setup();
    for (const target of [at.headerButton, at.headerLink, at.noticeButton, at.roleButton, at.sidebarButton]) {
      assert.deepEqual(press(target, ' '), NOWHERE, label(target));
    }
  });

  it('letters typed with a button or link focused, the notice\'s included, go to the end of the note', () => {
    const { at, press } = setup();
    for (const target of [at.headerButton, at.headerLink, at.noticeButton, at.roleButton, at.sidebarButton]) {
      assert.deepEqual(press(target, 'a'), TO_LEFT, label(target));
      assert.deepEqual(press(target, 'Z', { shiftKey: true }), TO_LEFT);
    }
  });

  it('with nothing focused, any printable key goes to the note, Space included', () => {
    const { at, press } = setup();
    for (const key of ['a', ' ', '7']) assert.deepEqual(press(at.body, key), TO_LEFT, JSON.stringify(key));
  });

  it('a note with no blocks gets a new one for the key', () => {
    const { at, press } = setup({ blocks: [] });
    assert.deepEqual(press(at.headerButton, 'a'), { left: [['addBlockAtEnd']], right: [], prevented: false });
  });

  it('text controls keep their keys: inputs, textareas, selects, the title, and blocks in either pane', () => {
    const { at, press } = setup({ split: 'left' });
    for (const target of [at.input, at.textarea, at.select, at.title, at.blockText, at.rightBlockText]) {
      assert.deepEqual(press(target, 'a'), NOWHERE, label(target));
      assert.deepEqual(press(target, ' '), NOWHERE);
    }
  });

  it('a summary, a details block, or media controls keep their keys, as in an AI reply', () => {
    const { at, press } = setup();
    for (const target of [at.summary, at.video]) {
      assert.deepEqual(press(target, 'a'), NOWHERE, label(target));
      assert.deepEqual(press(target, ' '), NOWHERE);
    }
  });

  it('a modal, menu, listbox, or dialog with focus in it keeps its keys', () => {
    const { at, press, page } = setup();
    page.show(page.modals['settings-modal']);
    page.show(page.noteMenu);
    page.show(page.dialog);
    for (const target of [at.settingsButton, at.menuItem, at.listboxOption, at.dialogButton]) {
      assert.deepEqual(press(target, 'a'), NOWHERE, label(target));
      assert.deepEqual(press(target, ' '), NOWHERE);
    }
  });

  for (const [name, open] of OVERLAYS) {
    it(`while ${name} is open, letters typed with focus outside it stay out of the note`, () => {
      const { at, press, page } = setup();
      const close = open(page);
      for (const target of [at.headerButton, at.sidebarButton, at.noticeButton, at.body]) {
        assert.deepEqual(press(target, 'a'), NOWHERE, label(target));
        assert.deepEqual(press(target, ' '), NOWHERE, `${label(target)}, Space`);
      }
      close();
      assert.deepEqual(press(at.headerButton, 'a'), TO_LEFT, 'once it closes');
    });
  }

  it('closed overlays hold nothing: the modals\' dialog boxes, a menu or dialog with hidden, and a <dialog> without open', () => {
    const { at, press, page } = setup();
    add(page.body, 'dialog');
    add(page.body, 'div', { class: 'context-menu hidden' });
    add(page.body, 'div', { class: 'slash-menu hidden' });
    for (const target of [at.headerButton, at.sidebarButton, at.body]) {
      assert.deepEqual(press(target, 'a'), TO_LEFT, label(target));
    }
  });

  it('a key something already handled stays where it is', () => {
    const { at, press } = setup();
    assert.deepEqual(press(at.headerButton, 'a', { defaultPrevented: true, preventDefault() {} }),
      { left: [], right: [], prevented: true });
  });

  it('? stays out of the note wherever it is not typed into text, since the app opens Keyboard Shortcuts on it', () => {
    const { at, press } = setup();
    for (const target of [at.headerButton, at.headerLink, at.noticeButton, at.roleButton, at.sidebarButton, at.body]) {
      assert.deepEqual(press(target, '?', { shiftKey: true }), NOWHERE, label(target));
    }
    // In a block it's typed there
    assert.deepEqual(press(at.blockText, '?', { shiftKey: true }), NOWHERE);
  });

  it('Enter, other named keys, and shortcuts never go to the note', () => {
    const { at, press } = setup();
    for (const key of ['Enter', 'Tab', 'Escape', 'ArrowDown']) {
      assert.deepEqual(press(at.headerButton, key), NOWHERE, key);
    }
    for (const modifier of ['metaKey', 'ctrlKey', 'altKey']) {
      assert.deepEqual(press(at.body, 'k', { [modifier]: true }), NOWHERE, modifier);
    }
  });

  describe('with both panes listening on one document', () => {
    it('split view closed: only the left pane\'s editor takes the key; the hidden right one never adds or focuses a block', () => {
      const { at, press } = setup({ split: 'closed', rightBlocks: [] });
      for (const target of [at.headerButton, at.sidebarButton, at.noticeButton, at.body]) {
        assert.deepEqual(press(target, 'a'), TO_LEFT, label(target));
        assert.deepEqual(press(target, 'b'), TO_LEFT, `${label(target)}, a second time`);
      }
    });

    it('split view open: a key from outside the panes goes to the active pane\'s note', () => {
      for (const [split, expected] of [['left', TO_LEFT], ['right', TO_RIGHT]]) {
        const { at, press } = setup({ split });
        for (const target of [at.headerButton, at.sidebarButton, at.body]) {
          assert.deepEqual(press(target, 'a'), expected, `${split} active, ${label(target)}`);
        }
      }
    });

    it('split view open: a key typed on a button inside a pane goes to that pane\'s note, active or not', () => {
      for (const split of ['left', 'right']) {
        const { at, press } = setup({ split });
        assert.deepEqual(press(at.noticeButton, 'a'), TO_LEFT, `${split} active, the notice's button`);
        assert.deepEqual(press(at.rightButton, 'a'), TO_RIGHT, `${split} active, a button in the right pane`);
      }
    });
  });
});

describe('one editor acts on each key', () => {
  const UNDO = { metaKey: true };
  const REDO = { metaKey: true, shiftKey: true };

  it('undo and redo act in the pane they are pressed in, and from outside both panes in the active one', () => {
    for (const [split, outside] of [['left', 'left'], ['right', 'right']]) {
      const { at, press } = setup({ split });
      for (const [key, modifiers, action] of [['z', UNDO, 'undo'], ['Z', REDO, 'redo']]) {
        const only = (side) => ({ left: side === 'left' ? [[action]] : [], right: side === 'right' ? [[action]] : [], prevented: true });
        assert.deepEqual(press(at.blockText, key, modifiers), only('left'), `${split} active, ${action} in a left block`);
        assert.deepEqual(press(at.title, key, modifiers), only('left'), `${split} active, ${action} in the left title`);
        assert.deepEqual(press(at.rightBlockText, key, modifiers), only('right'), `${split} active, ${action} in a right block`);
        for (const target of [at.headerButton, at.body]) {
          assert.deepEqual(press(target, key, modifiers), only(outside), `${split} active, ${action} at ${label(target)}`);
        }
      }
    }
  });

  it('split view closed: undo and redo act in the left pane only, wherever they are pressed', () => {
    const { at, press } = setup({ split: 'closed' });
    for (const target of [at.blockText, at.title, at.headerButton, at.sidebarButton, at.body]) {
      assert.deepEqual(press(target, 'z', UNDO), { left: [['undo']], right: [], prevented: true }, label(target));
      assert.deepEqual(press(target, 'Z', REDO), { left: [['redo']], right: [], prevented: true }, label(target));
    }
  });

  it('Backspace or Delete deletes a block selection only in the pane it is pressed in', () => {
    const { at, press, editors } = setup({ split: 'left' });
    editors[1].selectedBlockIds.add('r1'); // Cmd-clicked in the right pane
    for (const key of ['Backspace', 'Delete']) {
      // In a left block the key edits the text there, and the right pane's selection stays
      assert.deepEqual(press(at.blockText, key), NOWHERE, `${key} in a left block`);
      assert.deepEqual(press(at.headerButton, key), NOWHERE, `${key} outside both, the left pane active`);
      assert.deepEqual(press(at.rightBlockText, key), { left: [], right: [['deleteSelectedBlocks']], prevented: true }, `${key} in a right block`);
    }
    editors[0].selectedBlockIds.add('b1');
    assert.deepEqual(press(at.blockText, 'Backspace'), { left: [['deleteSelectedBlocks']], right: [], prevented: true });
  });

  it('with the right pane active, Backspace outside both panes deletes its selection, not the left one\'s', () => {
    const { at, press, editors } = setup({ split: 'right' });
    editors[0].selectedBlockIds.add('b1');
    editors[1].selectedBlockIds.add('r1');
    assert.deepEqual(press(at.body, 'Backspace'), { left: [], right: [['deleteSelectedBlocks']], prevented: true });
  });

  it('split view closed: a selection left in the hidden right pane is never deleted', () => {
    const { at, press, editors } = setup({ split: 'closed' });
    editors[1].selectedBlockIds.add('r1');
    for (const target of [at.blockText, at.headerButton, at.body]) {
      assert.deepEqual(press(target, 'Backspace'), NOWHERE, label(target));
    }
  });

  /** Text fields that handle their own keys, each with the modal it's in open */
  const FIELDS = [
    ['the sidebar search box', (at) => at.input],
    ['a Settings field', (at, page) => { page.show(page.modals['settings-modal']); return at.settingsField; }],
    ['a Settings select', (at, page) => { page.show(page.modals['settings-modal']); return at.settingsSelect; }],
    ['the AI chat input', (at) => at.textarea],
    ['the command palette input', (at, page) => { page.show(page.modals['command-palette-modal']); return at.paletteInput; }],
    ["a bookmark block's URL input", (at) => at.blockUrlInput],
    ['editable text outside the panes', (at) => at.otherEditable],
  ];

  for (const [name, focus] of FIELDS) {
    it(`in ${name}, Backspace, Delete, undo, and redo are the field's, with blocks selected in both panes`, () => {
      const { at, press, editors, page } = setup({ split: 'left' });
      editors[0].selectedBlockIds.add('b1');
      editors[1].selectedBlockIds.add('r1');
      const target = focus(at, page);
      for (const [key, modifiers, what] of [['Backspace', {}, 'Backspace'], ['Delete', {}, 'Delete'], ['z', UNDO, 'undo'], ['Z', REDO, 'redo']]) {
        assert.deepEqual(press(target, key, modifiers), NOWHERE, what);
      }
    });
  }

  it('a checkbox or a button isn\'t a text field: undo with one focused still acts on the active pane', () => {
    const { at, press } = setup({ split: 'left' });
    for (const target of [at.sidebarCheckbox, at.headerButton]) {
      assert.deepEqual(press(target, 'z', UNDO), { left: [['undo']], right: [], prevented: true }, label(target));
    }
  });

  it('in the note, Backspace on a block selection, undo, and redo still work, in a block, in the title, and with nothing focused', () => {
    const { at, press, editors } = setup({ split: 'closed' });
    for (const target of [at.blockText, at.title, at.body]) {
      editors[0].selectedBlockIds.add('b1');
      assert.deepEqual(press(target, 'Backspace'), { left: [['deleteSelectedBlocks']], right: [], prevented: true }, label(target));
      assert.deepEqual(press(target, 'z', UNDO), { left: [['undo']], right: [], prevented: true }, label(target));
      assert.deepEqual(press(target, 'Z', REDO), { left: [['redo']], right: [], prevented: true }, label(target));
    }
  });

  it('Picture-in-Picture\'s editor takes every key in its own window, whatever the new tab has open', () => {
    const { env, page } = setup();
    page.show(page.modals['settings-modal']); // in the new tab, not the PiP window
    const pipDoc = new FakeDocument();
    const root = add(pipDoc.body, 'div', { class: 'pip-editor-wrapper editor-pane active' });
    const blockText = add(add(root, 'div', { class: 'block' }), 'div', { class: 'block-content', contenteditable: 'true' });
    const reached = [];
    const pip = stubEditor(env, pipDoc, root, [{ id: 'p1' }], reached);
    const press = (target, key, modifiers) => {
      reached.length = 0;
      pip.onGlobalKeyDown(keydown(target, key, modifiers));
      return reached.slice();
    };
    for (const target of [blockText, pipDoc.body]) {
      assert.deepEqual(press(target, 'z', UNDO), [['undo']], `undo at ${label(target)}`);
      assert.deepEqual(press(target, 'Z', REDO), [['redo']], `redo at ${label(target)}`);
    }
    assert.deepEqual(press(pipDoc.body, 'a'), [['focusBlock', 'p1', true]]);
    pip.selectedBlockIds.add('p1');
    assert.deepEqual(press(pipDoc.body, 'Backspace'), [['deleteSelectedBlocks']]);
  });

  it('in Picture-in-Picture, ? from outside the note goes to it, since only the new tab opens Keyboard Shortcuts', () => {
    const { env } = setup();
    const pipDoc = new FakeDocument();
    const root = add(pipDoc.body, 'div', { class: 'pip-editor-wrapper editor-pane active' });
    const reached = [];
    const pip = stubEditor(env, pipDoc, root, [{ id: 'p1' }], reached);
    pip.onGlobalKeyDown(keydown(pipDoc.body, '?', { shiftKey: true }));
    assert.deepEqual(reached, [['focusBlock', 'p1', true]]);
  });

  /** The note's keys onGlobalKeyDown handles besides typing */
  const NOTE_KEYS = [['z', UNDO, 'undo'], ['Z', REDO, 'redo'], ['Backspace', {}, 'Backspace'], ['Delete', {}, 'Delete']];
  /** No pane acts, and the browser's own undo, redo, and delete, which would edit a note through its caret, don't run */
  const HELD = { left: [], right: [], prevented: true };

  for (const [name, open] of OVERLAYS) {
    it(`while ${name} is open, undo, redo, Backspace, and Delete from outside the note leave both panes alone`, () => {
      const { at, press, editors, page } = setup({ split: 'left' });
      editors[0].selectedBlockIds.add('b1');
      editors[1].selectedBlockIds.add('r1');
      open(page);
      for (const target of [at.headerButton, at.sidebarCheckbox, at.body]) {
        for (const [key, modifiers, what] of NOTE_KEYS) {
          assert.deepEqual(press(target, key, modifiers), HELD, `${what} at ${label(target)}`);
        }
        assert.deepEqual(press(target, 'y', { ctrlKey: true }), NOWHERE, 'Ctrl+Y is no redo on a Mac');
      }
    });
  }

  it('while a modal is open, Ctrl+Y outside the note is held too where it redoes, off a Mac', () => {
    const { env, at, press, page } = setup({ split: 'left' });
    env.global.navigator.platform = 'Win32';
    page.show(page.modals['settings-modal']);
    assert.deepEqual(press(at.headerButton, 'y', { ctrlKey: true }), HELD);
    assert.deepEqual(press(at.headerButton, 'z', { ctrlKey: true }), HELD);
  });

  it('while a modal is open, the same keys in a pane\'s own editor still act there', () => {
    const { at, press, editors, page } = setup({ split: 'left' });
    page.show(page.modals['settings-modal']);
    editors[0].selectedBlockIds.add('b1');
    editors[1].selectedBlockIds.add('r1');
    for (const target of [at.blockText, at.title]) {
      assert.deepEqual(press(target, 'z', UNDO), { left: [['undo']], right: [], prevented: true }, `undo at ${label(target)}`);
      assert.deepEqual(press(target, 'Z', REDO), { left: [['redo']], right: [], prevented: true }, `redo at ${label(target)}`);
      assert.deepEqual(press(target, 'Backspace'), { left: [['deleteSelectedBlocks']], right: [], prevented: true }, `Backspace at ${label(target)}`);
    }
    assert.deepEqual(press(at.rightBlockText, 'Delete'), { left: [], right: [['deleteSelectedBlocks']], prevented: true });
  });

  it('in Picture-in-Picture, a menu open in its window keeps keys from outside its editor off the note, and its blocks still take them', () => {
    const { env } = setup();
    const pipDoc = new FakeDocument();
    const root = add(pipDoc.body, 'div', { class: 'pip-editor-wrapper editor-pane active' });
    const blockText = add(add(root, 'div', { class: 'block' }), 'div', { class: 'block-content', contenteditable: 'true' });
    add(root, 'div', { class: 'slash-menu' }); // open
    const reached = [];
    const pip = stubEditor(env, pipDoc, root, [{ id: 'p1' }], reached);
    pip.selectedBlockIds.add('p1');
    const press = (target, key, modifiers) => {
      reached.length = 0;
      const event = keydown(target, key, modifiers);
      pip.onGlobalKeyDown(event);
      return reached.length > 0 ? reached.slice() : { held: Boolean(event.defaultPrevented) };
    };
    for (const [key, modifiers, what] of NOTE_KEYS) {
      assert.deepEqual(press(pipDoc.body, key, modifiers), { held: true }, `${what} at the PiP window's page`);
    }
    assert.deepEqual(press(blockText, 'z', UNDO), [['undo']]);
    assert.deepEqual(press(blockText, 'Backspace'), [['deleteSelectedBlocks']]);
  });
});

describe('with Settings open, keys pressed outside the note leave it and what is stored alone', () => {
  /**
   * A new tab with one real editor on note N (eggs, milk), stored, with an edit
   * it can undo (milk to "milk and bread"), one it can redo (eggs to "eggs and
   * ham"), both blocks selected, and Settings open from the header, where focus
   * stays
   */
  async function realPage() {
    const env = createLegacyEnv({ document: new FakeDocument() });
    await createDatabase(env.indexedDB, {
      records: { canvases: [note('N', { name: 'Groceries' })], elements: [block('n1', 'N', 0, 'eggs'), block('n2', 'N', 1, 'milk')] },
    });
    env.load(...FILES);
    env.global.navigator.platform = 'MacIntel';
    await env.get('Storage').init();
    const documentClient = await startEditorClient(env);
    const doc = env.document;
    const at = { body: doc.body, headerButton: add(add(doc.body, 'header'), 'button', { id: 'settings-btn' }) };
    const pane = add(doc.body, 'div', { id: 'editor-container', class: 'editor-pane active' });
    at.blockText = add(add(pane, 'div', { class: 'block' }), 'div', { class: 'block-content', contenteditable: 'true' });
    const settings = add(doc.body, 'div', { id: 'settings-modal', class: 'modal hidden' });
    at.checkbox = add(add(settings, 'div', { class: 'modal-content', role: 'dialog', 'aria-modal': 'true' }), 'input', { type: 'checkbox' });

    // A BlockEditor without its DOM constructor, as test/editor-save.test.js builds one: real saves, rendering stubbed
    const editor = Object.create(env.get('BlockEditor').prototype);
    const noop = () => {};
    Object.assign(editor, {
      root: pane, doc, documentClient, navigation: quietNavigation(), noteId: null, noteData: null, blocks: [], titleEl: { textContent: '' },
      container: { querySelector: () => null, querySelectorAll: () => [] }, insightsPollingId: null,
      undoStack: [], redoStack: [], _contentUndoPending: {}, selectedBlockIds: new Set(), _snapshotDirty: false,
      _snapshotInterval: null, hasReceivedFirstContent: false, pendingAutoTitle: false,
    });
    editor._initPersistenceState();
    Object.assign(editor, {
      renderBlocks: noop, renderBacklinks: noop, updateTimestampDisplay: noop, updateSaveStatus: noop, clearBlockSelection: noop,
      placeCaretAtEnd: noop, renderInsights: async () => {}, startInsightsPollingIfNeeded: async () => {},
    });
    await editor.loadNote('N');

    const saved = async () => {
      env.clock.tick(500);
      env.frames();
      await editor.flushSave();
      await settle();
      const rows = recordsOf(await dumpDatabase(env.indexedDB), 'elements');
      return Object.fromEntries(Object.entries(rows).map(([id, row]) => [id, row.content]));
    };
    const [eggs, milk] = editor.blocks;
    const before = editor.snapshotBlock(milk);
    milk.content = 'milk and bread';
    editor.pushUndo({ type: 'content', blockId: milk.id, before, after: editor.snapshotBlock(milk) });
    editor.scheduleSave();
    assert.deepEqual(await saved(), { n1: 'eggs', n2: 'milk and bread' });
    editor.redoStack.push({ type: 'content', blockId: eggs.id, before: editor.snapshotBlock(eggs), after: { ...editor.snapshotBlock(eggs), content: 'eggs and ham' } });
    editor.selectedBlockIds.add('n1');
    editor.selectedBlockIds.add('n2');
    settings.classList.remove('hidden');

    const press = (target, key, modifiers = {}) => {
      const event = keydown(target, key, modifiers);
      editor.onGlobalKeyDown(event);
      return Boolean(event.defaultPrevented);
    };
    return { editor, at, press, saved };
  }

  it('Cmd+Z, Cmd+Shift+Z, Backspace, and Delete with focus on a Settings checkbox, the header button that opened it, or the page', async () => {
    const { editor, at, press, saved } = await realPage();
    const passed = [];
    for (const target of [at.checkbox, at.headerButton, at.body]) {
      for (const [key, modifiers] of [['z', { metaKey: true }], ['Z', { metaKey: true, shiftKey: true }], ['Backspace'], ['Delete']]) {
        if (!press(target, key, modifiers)) passed.push(`${key} at ${label(target)}`);
      }
    }
    assert.deepEqual(editor.blocks.map((b) => b.content), ['eggs', 'milk and bread']);
    assert.deepEqual(await saved(), { n1: 'eggs', n2: 'milk and bread' }, 'what is stored');
    assert.equal(editor.selectedBlockIds.size, 2, 'both blocks still selected');
    assert.equal(editor.undoStack.length, 1);
    assert.equal(editor.redoStack.length, 1);
    // The browser's own undo and delete would edit the note through the caret it left there
    assert.deepEqual(passed, [], 'no key reaches the browser either');
  });

  it('Cmd+Z in the note itself still undoes there, and saves', async () => {
    const { editor, at, press, saved } = await realPage();
    assert.equal(press(at.blockText, 'z', { metaKey: true }), true);
    assert.deepEqual(editor.blocks.map((b) => b.content), ['eggs', 'milk']);
    assert.deepEqual(await saved(), { n1: 'eggs', n2: 'milk' });
  });
});

describe('BlockEditor.focusBlock', () => {
  /** An editor with one block whose content takes focus only when `takesFocus` */
  function blockEditor(takesFocus) {
    const { env } = setup();
    const doc = env.document;
    const block = doc.createElement('div');
    const content = doc.createElement('div');
    content.className = 'block-content';
    block.appendChild(content);
    doc.body.appendChild(block);
    if (!takesFocus) content.focus = () => {};
    const carets = [];
    const instance = Object.create(env.get('BlockEditor').prototype);
    Object.assign(instance, {
      doc,
      getBlockElement: () => block,
      placeCaretAtEnd: (element) => carets.push(element),
    });
    return { instance, content, carets, doc };
  }

  it('puts the caret at the end of the block it focused', () => {
    const { instance, content, carets, doc } = blockEditor(true);
    instance.focusBlock('b1', true);
    assert.ok(doc.activeElement === content, 'focus is on the block');
    assert.ok(carets.length === 1 && carets[0] === content, 'one caret, at the end of the block');
  });

  it('leaves the caret alone when the block couldn\'t take focus, as in a hidden pane', () => {
    const { instance, content, carets, doc } = blockEditor(false);
    instance.focusBlock('b1', true);
    assert.ok(doc.activeElement !== content, 'focus is not on the block');
    assert.ok(carets.length === 0, 'no caret');
  });
});
