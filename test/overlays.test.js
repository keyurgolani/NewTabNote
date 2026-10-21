'use strict';

// While a modal, menu, or dialog is open, keys from outside the note stay out of it
// (test/type-anywhere.test.js), so every one of them has to close, and stop counting as
// open once it has. Escape (App.closeAllModals) closes the editors' menus in both panes
// along with a block's menu, Turn into, and a table's menu; a click outside closes the
// link and template menus as it does the slash menu; Keyboard Shortcuts takes focus when
// it opens and gives it back when it closes, unless something moved it out; and a note
// that loads closes the menus left on the note before and focuses its first block, unless
// focus is in an open overlay, as on onboarding's walkthrough over the welcome note.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { createLegacyEnv, FakeDocument, createDatabase, note, block } = require('./helpers/legacy-env');

const FILES = [
  'js/utils.js', 'js/core/storage-error.js', 'js/storage.js', 'js/sidebar-utils.js', 'js/blocks.js',
  'js/shortcut-utils.js', 'js/editor.js', 'js/controllers/settings-controller.js', 'js/app.js',
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

/** An element by its id or class, for messages that read */
const which = (element) => (element ? element.id || element.className || element.tagName : String(element));

function environment() {
  const env = createLegacyEnv({ document: new FakeDocument() });
  env.load(...FILES);
  // The editor watches images scroll into view
  env.global.IntersectionObserver = class { observe() {} unobserve() {} disconnect() {} };
  return env;
}

/**
 * A new tab's two panes as newtab.html has them, each with its title, blocks, and slash,
 * link, and template menus (the left pane's found by id, the right pane's by class), a real
 * editor on each, and a header button outside both
 */
function twoPanes() {
  const env = environment();
  const doc = env.document;
  const headerButton = add(add(doc.body, 'header'), 'button', { id: 'settings-btn' });
  const pane = (attributes, menus) => {
    const root = add(doc.body, 'div', attributes);
    const column = add(root, 'div', { class: 'editor' });
    add(column, 'div', { class: 'page-title', contenteditable: 'true' });
    add(column, 'div', { class: 'blocks-container' });
    for (const menu of menus) add(add(column, 'div', menu), 'div', { class: 'slash-menu-items' });
    return root;
  };
  const leftPane = pane({ id: 'editor-container', class: 'editor-pane active' }, [
    { id: 'slash-menu', class: 'slash-menu hidden' }, { id: 'wiki-menu', class: 'slash-menu hidden' }, { id: 'template-menu', class: 'slash-menu hidden' },
  ]);
  const rightPane = pane({ id: 'secondary-editor-container', class: 'editor-pane secondary' }, [
    { class: 'slash-menu hidden' }, { class: 'wiki-menu slash-menu hidden' }, { class: 'template-menu slash-menu hidden' },
  ]);
  const BlockEditor = env.get('BlockEditor');
  const left = new BlockEditor({ root: leftPane });
  const right = new BlockEditor({ root: rightPane });
  return { env, doc, left, right, headerButton };
}

/** Open an editor's slash, link, or template menu, as typing /, [[, or /template in a block does */
function openMenu(editor, which) {
  const menu = { slash: editor.slashMenu, link: editor.wikiMenu, template: editor.templateMenu }[which];
  menu.classList.remove('hidden');
  editor[{ slash: 'slashMenuVisible', link: 'wikiMenuVisible', template: 'templateMenuVisible' }[which]] = true;
  return menu;
}

describe('Escape (App.closeAllModals) closes every menu the editors opened', () => {
  it("closes both panes' slash, link, and template menus, with either pane active", () => {
    for (const active of ['left', 'right']) {
      const { env, left, right } = twoPanes();
      const editors = { left, right };
      const menus = [];
      for (const editor of [left, right]) for (const which of ['slash', 'link', 'template']) menus.push(openMenu(editor, which));
      assert.equal(left._overlayOpen(), true);

      const app = { editor: left, secondaryEditor: right, getEditor: () => editors[active] };
      env.get('App').prototype.closeAllModals.call(app);
      assert.deepEqual(menus.filter((menu) => !menu.classList.contains('hidden')).map(which), [], `with the ${active} pane active`);
      assert.equal(left.slashMenuVisible || left.wikiMenuVisible || left.templateMenuVisible, false);
      assert.equal(right.slashMenuVisible || right.wikiMenuVisible || right.templateMenuVisible, false);
      assert.equal(left._overlayOpen(), false, `nothing counts as open with the ${active} pane active`);
    }
  });

  it("removes a block's menu, Turn into, and a table's menu", () => {
    const { env, doc, left, right } = twoPanes();
    for (const name of ['block-action-menu', 'turn-into-menu', 'table-context-menu']) add(doc.body, 'div', { class: name });
    assert.equal(left._overlayOpen(), true);

    env.get('App').prototype.closeAllModals.call({ editor: left, secondaryEditor: right, getEditor: () => left });
    assert.equal(doc.querySelectorAll('.block-action-menu, .turn-into-menu, .table-context-menu').length, 0);
    assert.equal(left._overlayOpen(), false);
  });
});

describe('a click outside the slash, link, or template menu closes it', () => {
  it('closes each menu a click lands outside of, and keeps the one it lands in', () => {
    const { doc, left, headerButton } = twoPanes();
    for (const which of ['slash', 'link', 'template']) openMenu(left, which);
    doc.fire('click', { target: headerButton });
    assert.deepEqual([left.slashMenuVisible, left.wikiMenuVisible, left.templateMenuVisible], [false, false, false]);
    assert.equal(left._overlayOpen(), false);

    for (const which of ['slash', 'link', 'template']) {
      const menus = ['slash', 'link', 'template'].map((name) => openMenu(left, name));
      const inside = menus[['slash', 'link', 'template'].indexOf(which)];
      doc.fire('click', { target: add(inside, 'div', { class: 'slash-menu-item' }) });
      assert.deepEqual(menus.map((menu) => !menu.classList.contains('hidden')), ['slash', 'link', 'template'].map((name) => name === which), `a click in the ${which} menu`);
      left.hideSlashMenu();
      left.hideWikiMenu();
      left.hideTemplateMenu();
    }
  });
});

describe('Keyboard Shortcuts takes focus when it opens and gives it back when it closes', () => {
  /** The modal as newtab.html has it, closed, the sidebar's button that opens it, focused, and Settings' controller */
  function shortcuts() {
    const env = environment();
    const doc = env.document;
    const opener = add(add(doc.body, 'aside', { id: 'sidebar' }), 'button', { id: 'shortcuts-btn' });
    const modal = add(doc.body, 'div', { id: 'shortcuts-modal', class: 'modal hidden' });
    const dialog = add(modal, 'div', { class: 'modal-content shortcuts-content', role: 'dialog', 'aria-modal': 'true' });
    const close = add(add(dialog, 'div', { class: 'modal-header' }), 'button', { class: 'close-btn', 'aria-label': 'Close modal' });
    const controller = Object.create(env.get('SettingsController').prototype);
    opener.focus();
    return { env, doc, opener, modal, close, controller };
  }

  it('moves focus to its close button, so keys pressed while it is open are its own, and back on closing', () => {
    const { doc, opener, modal, close, controller } = shortcuts();
    controller.toggleShortcutsModal();
    assert.equal(modal.classList.contains('hidden'), false);
    assert.equal(which(doc.activeElement), which(close));
    controller.toggleShortcutsModal();
    assert.equal(modal.classList.contains('hidden'), true);
    assert.equal(which(doc.activeElement), which(opener));
  });

  it('gives focus back when Escape closes it', () => {
    const { env, doc, opener, modal, close, controller } = shortcuts();
    controller.toggleShortcutsModal(true);
    assert.equal(which(doc.activeElement), which(close));
    env.get('App').prototype.closeAllModals.call({ settingsController: controller, editor: null, secondaryEditor: null, getEditor: () => null });
    assert.equal(modal.classList.contains('hidden'), true);
    assert.equal(which(doc.activeElement), which(opener));
  });

  it('leaves focus where a shortcut moved it, as Mod+K does to the search box', () => {
    const { env, doc, controller } = shortcuts();
    const search = add(doc.getElementById('sidebar'), 'input', { id: 'sidebar-search' });
    controller.toggleShortcutsModal(true);
    search.focus();
    env.get('App').prototype.closeAllModals.call({ settingsController: controller, editor: null, secondaryEditor: null, getEditor: () => null });
    assert.equal(which(doc.activeElement), which(search));
  });

  it('opened with nothing focused, takes focus off its hidden close button when it closes', () => {
    const { doc, modal, close, controller } = shortcuts();
    doc.body.focus();
    controller.toggleShortcutsModal(true);
    assert.equal(which(doc.activeElement), which(close));
    controller.toggleShortcutsModal(false);
    assert.equal(modal.contains(doc.activeElement), false, `focus is on ${which(doc.activeElement)}`);
  });
});

describe('a note that loads focuses its first block, unless focus is in an open overlay', () => {
  /**
   * A BlockEditor without its DOM constructor, as test/editor-save.test.js builds one, on
   * note N, stored, whose first block is in its pane; rendering is stubbed
   */
  async function loading() {
    const env = createLegacyEnv({ document: new FakeDocument() });
    await createDatabase(env.indexedDB, { records: { canvases: [note('N', { name: 'Welcome' })], elements: [block('n1', 'N', 0, 'Welcome')] } });
    env.load(...FILES);
    await env.get('Storage').init();
    const doc = env.document;
    const pane = add(doc.body, 'div', { id: 'editor-container', class: 'editor-pane active' });
    const container = add(pane, 'div', { class: 'blocks-container' });
    const firstBlock = add(add(container, 'div', { class: 'block' }), 'div', { class: 'block-content', contenteditable: 'true' });
    const editor = Object.create(env.get('BlockEditor').prototype);
    const noop = () => {};
    Object.assign(editor, {
      root: pane, doc, container, noteId: null, noteData: null, blocks: [], titleEl: { textContent: '' }, insightsPollingId: null,
      undoStack: [], redoStack: [], _contentUndoPending: {}, selectedBlockIds: new Set(), _snapshotDirty: false,
      _snapshotInterval: null, hasReceivedFirstContent: false, pendingAutoTitle: false,
    });
    editor._initPersistenceState();
    Object.assign(editor, {
      renderBlocks: noop, renderBacklinks: noop, updateTimestampDisplay: noop, updateSaveStatus: noop, clearBlockSelection: noop,
      placeCaretAtEnd: noop, renderInsights: async () => {}, startInsightsPollingIfNeeded: async () => {},
      stripHtmlTags: (html) => String(html || '').replace(/<[^>]*>/g, ''),
    });
    return { env, doc, editor, firstBlock };
  }

  it("keeps focus on the walkthrough's button while the welcome note loads under it", async () => {
    const { env, doc, editor } = await loading();
    add(doc.body, 'div', { class: 'onboarding-overlay' });
    const next = add(add(doc.body, 'div', { class: 'onboarding-tooltip', role: 'dialog' }), 'button', { class: 'onboarding-btn onboarding-btn-next' });
    next.focus();
    await editor.loadNote('N');
    env.clock.tick(50);
    assert.equal(which(doc.activeElement), which(next));
  });

  it('with nothing open, focuses the first block as before', async () => {
    const { env, doc, editor, firstBlock } = await loading();
    await editor.loadNote('N');
    env.clock.tick(50);
    assert.equal(which(doc.activeElement), which(firstBlock));
  });

  it("closes the menus left open on the note it leaves, and focuses the new note's first block", async () => {
    const { env, doc, editor, firstBlock } = await loading();
    const slash = add(editor.root, 'div', { id: 'slash-menu', class: 'slash-menu' });
    const link = add(editor.root, 'div', { id: 'wiki-menu', class: 'slash-menu' });
    Object.assign(editor, { slashMenu: slash, slashMenuVisible: true, wikiMenu: link, wikiMenuVisible: true });
    await editor.loadNote('N');
    env.clock.tick(50);
    assert.deepEqual([slash, link].map((menu) => menu.classList.contains('hidden')), [true, true]);
    assert.equal(which(doc.activeElement), which(firstBlock));
  });

  it("with a menu open outside the note but focus on the page, as when Alt+D opens the day's note, focuses its first block", async () => {
    const { env, doc, editor, firstBlock } = await loading();
    add(doc.body, 'div', { id: 'note-context-menu', class: 'context-menu', role: 'menu' });
    doc.body.focus();
    await editor.loadNote('N');
    env.clock.tick(50);
    assert.equal(which(doc.activeElement), which(firstBlock));
  });
});
