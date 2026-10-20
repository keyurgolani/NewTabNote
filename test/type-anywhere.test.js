'use strict';

// Type anywhere (#1 AC2's rule, NTN-18 slice 0 item 9): when focus isn't in a
// text control and no modal, menu, listbox, or dialog has it, a printable key
// goes to the note, except Space on a button, which presses it, or on a link,
// which keeps the browser's default. Both panes' editors listen on one
// document: a key typed in a pane goes to that pane's note, any other to the
// active pane's while it shows.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { createLegacyEnv, FakeDocument } = require('./helpers/legacy-env');

const FILES = ['js/utils.js', 'js/core/storage-error.js', 'js/storage.js', 'js/sidebar-utils.js', 'js/blocks.js', 'js/editor.js'];

/**
 * A page with a header, the left pane (title, the export notice, a block), split
 * view's right pane, the sidebar, Settings, and a menu, and an editor for each
 * pane whose focusBlock and addBlockAtEnd only record that the key went to its
 * note. `split` is 'closed' (the right pane hidden), 'left', or 'right' (open,
 * with that pane active).
 */
function setup({ split = 'closed', blocks = [{ id: 'b1' }, { id: 'b2' }], rightBlocks = [{ id: 'r1' }] } = {}) {
  const env = createLegacyEnv({ document: new FakeDocument() });
  env.load(...FILES);
  env.global.navigator.platform = 'MacIntel';
  const doc = env.document;
  const add = (parent, tag, attributes = {}) => {
    const element = doc.createElement(tag);
    for (const [name, value] of Object.entries(attributes)) {
      if (name === 'class') element.className = value; else element.setAttribute(name, value);
    }
    parent.appendChild(element);
    return element;
  };
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
  const settings = add(doc.body, 'div', { id: 'settings-modal', class: 'modal' });
  const menu = add(doc.body, 'div', { id: 'note-context-menu', class: 'context-menu', role: 'menu' });
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
    settingsButton: add(settings, 'button'),
    menuItem: add(menu, 'button', { role: 'menuitem' }),
    listboxOption: add(add(doc.body, 'div', { role: 'listbox' }), 'div', { role: 'option', tabindex: '0' }),
    dialogButton: add(add(doc.body, 'div', { role: 'dialog' }), 'button'),
    summary: add(add(reply, 'details'), 'summary'),
    video: add(reply, 'video', { controls: '' }),
  };

  // The two editors App builds, listening in the order it builds them
  const BlockEditor = env.get('BlockEditor');
  const reached = { left: [], right: [] };
  const editor = (side, root, noteBlocks) => {
    const instance = Object.create(BlockEditor.prototype);
    Object.assign(instance, {
      root,
      doc,
      blocks: noteBlocks.slice(),
      selectedBlockIds: new Set(),
      focusBlock: (id, atEnd) => reached[side].push(['focusBlock', id, atEnd]),
      addBlockAtEnd: () => reached[side].push(['addBlockAtEnd']),
      undo: () => reached[side].push(['undo']),
      redo: () => reached[side].push(['redo']),
    });
    return instance;
  };
  const editors = [editor('left', leftPane, blocks), editor('right', rightPane, rightBlocks)];

  /** Press `key` with focus at `target`: what reached each note, and whether the default was prevented */
  const press = (target, key, modifiers = {}) => {
    reached.left = [];
    reached.right = [];
    const event = {
      type: 'keydown', key, target, ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, ...modifiers,
    };
    if (!event.preventDefault) event.preventDefault = () => { event.defaultPrevented = true; };
    editors.forEach((instance) => instance.onGlobalKeyDown(event));
    return { left: reached.left, right: reached.right, prevented: Boolean(event.defaultPrevented) };
  };
  return { env, at, press, editors };
}

const TO_LEFT = { left: [['focusBlock', 'b2', true]], right: [], prevented: false };
const TO_RIGHT = { left: [], right: [['focusBlock', 'r1', true]], prevented: false };
const NOWHERE = { left: [], right: [], prevented: false };
const label = (target) => target.id || target.className || target.getAttribute('role') || target.tagName;

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

  it('a modal, menu, listbox, or dialog keeps its keys', () => {
    const { at, press } = setup();
    for (const target of [at.settingsButton, at.menuItem, at.listboxOption, at.dialogButton]) {
      assert.deepEqual(press(target, 'a'), NOWHERE, label(target));
      assert.deepEqual(press(target, ' '), NOWHERE);
    }
  });

  it('a key something already handled stays where it is', () => {
    const { at, press } = setup();
    assert.deepEqual(press(at.headerButton, 'a', { defaultPrevented: true, preventDefault() {} }),
      { left: [], right: [], prevented: true });
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
    assert.equal(doc.activeElement, content);
    assert.deepEqual(carets, [content]);
  });

  it('leaves the caret alone when the block couldn\'t take focus, as in a hidden pane', () => {
    const { instance, content, carets, doc } = blockEditor(false);
    instance.focusBlock('b1', true);
    assert.notEqual(doc.activeElement, content);
    assert.deepEqual(carets, []);
  });
});
