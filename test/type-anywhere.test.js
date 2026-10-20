'use strict';

// Type anywhere (#1 AC2's rule, NTN-18 slice 0 item 9): when focus isn't in a
// text control and no modal, menu, listbox, or dialog has it, a printable key
// goes to the note, except Space on a button or link, which presses it.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { createLegacyEnv, FakeDocument } = require('./helpers/legacy-env');

const FILES = ['js/utils.js', 'js/core/storage-error.js', 'js/storage.js', 'js/sidebar-utils.js', 'js/blocks.js', 'js/editor.js'];

/**
 * A page with a header, the note's pane (title, the export notice, a block), the
 * sidebar, Settings, and a menu, and an editor whose focusBlock and addBlockAtEnd
 * only record that the key went to the note.
 */
function setup({ blocks = [{ id: 'b1' }, { id: 'b2' }] } = {}) {
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
  const pane = add(doc.body, 'div', { id: 'editor-container', class: 'editor-pane active' });
  const editorColumn = add(pane, 'div', { id: 'editor', class: 'editor' });
  const notice = add(editorColumn, 'section', { id: 'export-notice', class: 'export-notice is-shown' });
  // Split view's right pane, whose column isn't #editor
  const rightPane = add(doc.body, 'div', { id: 'secondary-editor-container', class: 'editor-pane secondary' });
  const rightBlocks = add(add(rightPane, 'div', { class: 'editor' }), 'div', { class: 'blocks-container' });
  const sidebar = add(doc.body, 'aside', { id: 'sidebar', class: 'sidebar' });
  const settings = add(doc.body, 'div', { id: 'settings-modal', class: 'modal' });
  const menu = add(doc.body, 'div', { id: 'note-context-menu', class: 'context-menu', role: 'menu' });
  const at = {
    body: doc.body,
    headerButton: add(header, 'button', { id: 'settings-btn', class: 'icon-btn' }),
    headerLink: add(header, 'a', { href: '#editor-container' }),
    noticeButton: add(notice, 'button', { class: 'primary-btn export-notice-btn' }),
    roleButton: add(editorColumn, 'div', { role: 'button', tabindex: '0' }),
    title: add(editorColumn, 'div', { id: 'page-title', contenteditable: 'true' }),
    blockText: add(add(editorColumn, 'div', { class: 'block' }), 'div', { class: 'block-content', contenteditable: 'true' }),
    rightBlockText: add(add(rightBlocks, 'div', { class: 'block' }), 'div', { class: 'block-content', contenteditable: 'true' }),
    input: add(sidebar, 'input', { id: 'sidebar-search' }),
    textarea: add(doc.body, 'textarea', { id: 'ai-chat-input' }),
    select: add(doc.body, 'select'),
    sidebarButton: add(sidebar, 'button', { id: 'sidebar-tab-archive', role: 'tab' }),
    settingsButton: add(settings, 'button'),
    menuItem: add(menu, 'button', { role: 'menuitem' }),
    listboxOption: add(add(doc.body, 'div', { role: 'listbox' }), 'div', { role: 'option', tabindex: '0' }),
    dialogButton: add(add(doc.body, 'div', { role: 'dialog' }), 'button'),
  };

  // The left pane's editor
  const BlockEditor = env.get('BlockEditor');
  const editor = Object.create(BlockEditor.prototype);
  const reached = [];
  Object.assign(editor, {
    root: pane,
    doc,
    blocks: blocks.slice(),
    selectedBlockIds: new Set(),
    focusBlock: (id, atEnd) => reached.push(['focusBlock', id, atEnd]),
    addBlockAtEnd: () => reached.push(['addBlockAtEnd']),
    undo: () => reached.push(['undo']),
    redo: () => reached.push(['redo']),
  });

  /** Press `key` with focus at `target`; returns what reached the note, and whether the default was prevented */
  const press = (target, key, modifiers = {}) => {
    reached.length = 0;
    const event = {
      type: 'keydown', key, target, ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, ...modifiers,
    };
    event.preventDefault = () => { event.defaultPrevented = true; };
    editor.onGlobalKeyDown(event);
    return { reached: reached.slice(), prevented: Boolean(event.defaultPrevented) };
  };
  return { at, press };
}

const TO_NOTE = [['focusBlock', 'b2', true]];

describe('type anywhere', () => {
  it('Space on a header button or link presses it, and types nothing into the note', () => {
    const { at, press } = setup();
    for (const target of [at.headerButton, at.headerLink, at.noticeButton, at.roleButton, at.sidebarButton]) {
      assert.deepEqual(press(target, ' '), { reached: [], prevented: false }, target.id || target.className || target.tagName);
    }
  });

  it('letters typed with a button or link focused, the notice\'s included, go to the end of the note', () => {
    const { at, press } = setup();
    for (const target of [at.headerButton, at.headerLink, at.noticeButton, at.roleButton, at.sidebarButton]) {
      assert.deepEqual(press(target, 'a').reached, TO_NOTE, target.id || target.className || target.tagName);
      assert.deepEqual(press(target, 'Z', { shiftKey: true }).reached, TO_NOTE);
    }
  });

  it('with nothing focused, any printable key goes to the note, Space included', () => {
    const { at, press } = setup();
    assert.deepEqual(press(at.body, 'a').reached, TO_NOTE);
    assert.deepEqual(press(at.body, ' ').reached, TO_NOTE);
    assert.deepEqual(press(at.body, '7').reached, TO_NOTE);
  });

  it('a note with no blocks gets a new one for the key', () => {
    const { at, press } = setup({ blocks: [] });
    assert.deepEqual(press(at.headerButton, 'a').reached, [['addBlockAtEnd']]);
  });

  it('text controls keep their keys: inputs, textareas, selects, the title, and blocks in either pane', () => {
    const { at, press } = setup();
    for (const target of [at.input, at.textarea, at.select, at.title, at.blockText]) {
      assert.deepEqual(press(target, 'a').reached, [], target.id || target.className || target.tagName);
      assert.deepEqual(press(target, ' ').reached, []);
    }
  });

  it('text typed in split view\'s right pane stays there instead of going to the left pane\'s note', () => {
    const { at, press } = setup();
    for (const key of ['a', ' ', 'Q']) {
      assert.deepEqual(press(at.rightBlockText, key).reached, [], JSON.stringify(key));
    }
  });

  it('a modal, menu, listbox, or dialog keeps its keys', () => {
    const { at, press } = setup();
    for (const target of [at.settingsButton, at.menuItem, at.listboxOption, at.dialogButton]) {
      assert.deepEqual(press(target, 'a').reached, [], target.getAttribute('role') || target.tagName);
      assert.deepEqual(press(target, ' ').reached, []);
    }
  });

  it('Enter, other named keys, and shortcuts never go to the note', () => {
    const { at, press } = setup();
    for (const key of ['Enter', 'Tab', 'Escape', 'ArrowDown']) {
      assert.deepEqual(press(at.headerButton, key).reached, [], key);
    }
    assert.deepEqual(press(at.body, 'k', { metaKey: true }).reached, []);
    assert.deepEqual(press(at.body, 'k', { ctrlKey: true }).reached, []);
    assert.deepEqual(press(at.body, 'k', { altKey: true }).reached, []);
    assert.deepEqual(press(at.headerButton, 'z', { metaKey: true }), { reached: [['undo']], prevented: true });
  });
});
