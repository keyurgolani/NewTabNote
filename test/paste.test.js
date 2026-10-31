'use strict';

// A paste follows the rules keys do (test/type-anywhere.test.js): one pane takes it, a text
// field or editable area outside the note keeps it, and while a modal, menu, or dialog is
// open only a paste with focus in the note's own pane reaches the note. Every kind of paste
// the editor handles is tried: fenced code, a URL, CSV, Markdown, an image, and plain text.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  createLegacyEnv, FakeDocument, createDatabase, dumpDatabase, recordsOf, settle, note, block, startEditorClient, quietNavigation,
} = require('./helpers/legacy-env');

const FILES = [
  'js/utils.js', 'js/core/storage-error.js', 'js/storage.js', 'js/sidebar-utils.js', 'js/blocks.js',
  'js/ai-response-utils.js', 'js/editor.js',
];

/** Add a `tag` element with `attributes` (`class` as the class name) to `parent` */
function add(parent, tag, attributes = {}) {
  const element = parent.ownerDocument.createElement(tag);
  for (const [name, value] of Object.entries(attributes)) {
    if (name === 'class') element.className = value; else element.setAttribute(name, value);
  }
  parent.appendChild(element);
  return element;
}

const NOTE = [{ type: 'text', content: 'eggs' }, { type: 'text', content: 'milk' }];

/**
 * Each kind of paste: what is on the clipboard, and what it does in the note, as before:
 * the blocks it adds after the last one, an image it uploads, and whether it keeps the
 * browser from pasting too. Plain text is the browser's to paste.
 */
const PASTES = [
  ['fenced code', { text: '```\nconst a = 1;\n```' }, { added: [{ type: 'code', content: 'const a = 1;' }], prevented: true }],
  ['a URL', { text: 'https://example.test/page' }, { added: [{ type: 'bookmark', content: '' }], prevented: true }],
  ['CSV', { text: 'a,b\n1,2' }, { added: [{ type: 'table', content: '' }], prevented: true }],
  ['Markdown', { text: '# Heading\n- item' }, { added: [{ type: 'h1', content: 'Heading' }, { type: 'bullet', content: 'item' }], prevented: true }],
  ['an image', { image: 'shot.png' }, { uploaded: ['shot.png'], prevented: true }],
  ['plain text', { text: 'just words' }, { prevented: false }],
];

/**
 * A new tab with one real editor on note N (eggs, milk), stored, in the left pane with
 * its title and blocks, a header, the sidebar's search box and the AI chat input, an
 * editable area outside the note, and Settings, closed, with a button and a text field
 */
async function page() {
  const env = createLegacyEnv({ document: new FakeDocument() });
  await createDatabase(env.indexedDB, {
    records: { canvases: [note('N', { name: 'Groceries' })], elements: [block('n1', 'N', 0, 'eggs'), block('n2', 'N', 1, 'milk')] },
  });
  env.load(...FILES);
  // The editor's URL check, as a page has it
  env.global.URL = URL;
  await env.get('Storage').init();
  const documentClient = await startEditorClient(env);
  const doc = env.document;
  const pane = add(doc.body, 'div', { id: 'editor-container', class: 'editor-pane active' });
  const column = add(pane, 'div', { id: 'editor', class: 'editor' });
  const blocksContainer = add(column, 'div', { id: 'blocks-container', class: 'blocks-container' });
  const blockText = (id) => add(add(blocksContainer, 'div', { class: 'block', 'data-id': id }), 'div', { class: 'block-content', contenteditable: 'true' });
  const settings = add(doc.body, 'div', { id: 'settings-modal', class: 'modal hidden' });
  const dialogBox = add(settings, 'div', { class: 'modal-content', role: 'dialog', 'aria-modal': 'true' });
  const at = {
    body: doc.body,
    headerButton: add(add(doc.body, 'header'), 'button', { id: 'settings-btn' }),
    title: add(column, 'div', { id: 'page-title', contenteditable: 'true' }),
    eggs: blockText('n1'),
    milk: blockText('n2'),
    search: add(add(doc.body, 'aside', { id: 'sidebar', class: 'sidebar' }), 'input', { id: 'sidebar-search' }),
    chatInput: add(doc.body, 'textarea', { id: 'ai-chat-input' }),
    otherEditable: add(doc.body, 'div', { contenteditable: 'true' }),
    settingsButton: add(dialogBox, 'button', { class: 'primary-btn' }),
    settingsField: add(dialogBox, 'input', { id: 'settings-search', type: 'text' }),
  };

  // A BlockEditor without its DOM constructor, as test/editor-save.test.js builds one: real
  // saves and paste handling, rendering stubbed, and an upload that only records the file
  const uploaded = [];
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
    insertBlockDOM: noop, rerenderBlock: noop, focusBlock: noop, fetchLinkPreview: async () => {},
    uploadImageAndCreateBlock: async (file) => { uploaded.push(file.name); },
  });
  await editor.loadNote('N');

  /** The note's blocks as stored, once the editor has written what it has pending */
  const saved = async () => {
    env.clock.tick(500);
    env.frames();
    await editor.flushSave();
    await settle();
    const rows = Object.values(recordsOf(await dumpDatabase(env.indexedDB), 'elements'));
    return rows.sort((a, b) => a.order - b.order).map((row) => ({ type: row.type, content: row.content }));
  };
  const shown = () => editor.blocks.map((b) => ({ type: b.type, content: b.content }));

  /**
   * Paste `clipboard` with focus on `focus`. Its target is where the text would go: what has
   * focus, or a block where text is selected, wherever focus went.
   */
  const paste = (clipboard, { focus, target = focus }) => {
    focus.focus();
    const items = clipboard.image ? [{ type: 'image/png', getAsFile: () => ({ name: clipboard.image, type: 'image/png' }) }] : [];
    const event = {
      type: 'paste', target, clipboardData: { items, getData: (type) => (type === 'text/plain' ? clipboard.text || '' : '') },
    };
    event.preventDefault = () => { event.defaultPrevented = true; };
    editor.onPaste(event);
    return Boolean(event.defaultPrevented);
  };
  const openSettings = () => settings.classList.remove('hidden');
  // Typing "/" in a block opens it there, and focus stays in the block
  const openSlashMenu = () => add(column, 'div', { id: 'slash-menu', class: 'slash-menu' });
  return { editor, at, paste, saved, shown, uploaded, openSettings, openSlashMenu };
}

/** Assert that a paste left the note and what is stored alone */
async function assertUntouched({ saved, shown, uploaded }, label) {
  assert.deepEqual(shown(), NOTE, `${label}: the note`);
  assert.deepEqual(await saved(), NOTE, `${label}: what is stored`);
  assert.deepEqual(uploaded, [], `${label}: no image uploaded`);
}

describe('pastes follow the rules keys do', () => {
  describe('with Settings open, a paste with focus outside the note leaves it and what is stored alone', () => {
    const WHERE = [
      ['focus on a button in Settings', (at) => ({ focus: at.settingsButton })],
      ['focus on the header button that opened it', (at) => ({ focus: at.headerButton })],
      ['focus on the page', (at) => ({ focus: at.body })],
      // The target is the block where text is selected, wherever focus went
      ['focus on the header button and text selected in a block', (at) => ({ focus: at.headerButton, target: at.milk })],
    ];
    for (const [kind, clipboard] of PASTES) {
      it(kind, async () => {
        for (const [where, pick] of WHERE) {
          const tab = await page();
          tab.openSettings();
          tab.paste(clipboard, pick(tab.at));
          await assertUntouched(tab, `${kind} with ${where}`);
        }
      });
    }
  });

  describe('with focus in a text field or editable area outside the note, the field keeps the paste', () => {
    const FIELDS = [
      ['the sidebar search box', (at) => at.search],
      ['the AI chat input', (at) => at.chatInput],
      ['an editable area outside the note', (at) => at.otherEditable],
      ['the search field in Settings, open', (at) => at.settingsField],
    ];
    for (const [kind, clipboard] of PASTES) {
      it(kind, async () => {
        for (const [where, pick] of FIELDS) {
          const tab = await page();
          if (where.includes('Settings')) tab.openSettings();
          const prevented = tab.paste(clipboard, { focus: pick(tab.at) });
          await assertUntouched(tab, `${kind} in ${where}`);
          assert.equal(prevented, false, `${kind} in ${where}: the browser pastes into the field`);
        }
      });
    }
  });

  describe('in the note, every paste works as before, with a menu open there or not', () => {
    const WHERE = [
      ['in a block', (at) => at.milk, false],
      ['in the title', (at) => at.title, false],
      ['in a block, with the slash menu open', (at) => at.milk, true],
    ];
    for (const [kind, clipboard, does] of PASTES) {
      it(kind, async () => {
        for (const [where, pick, menuOpen] of WHERE) {
          const tab = await page();
          if (menuOpen) tab.openSlashMenu();
          const prevented = tab.paste(clipboard, { focus: pick(tab.at) });
          const label = `${kind} ${where}`;
          const expected = [...NOTE, ...(does.added || [])];
          assert.deepEqual(tab.shown(), expected, `${label}: the note`);
          assert.deepEqual(await tab.saved(), expected, `${label}: what is stored`);
          assert.deepEqual(tab.uploaded, does.uploaded || [], `${label}: the image uploaded`);
          assert.equal(prevented, does.prevented, `${label}: ${does.prevented ? 'the editor pastes it' : 'the browser pastes it'}`);
        }
      });
    }
  });
});
