'use strict';

// NTN-33 follow-up: startup never reopens a note in trash. Restoring the saved
// workspace skips tabs and a split note whose notes are in trash or gone, keeps
// the active tab on its note when that note survives, and falls back to the
// note 1.4.0 opens when nothing valid is saved. The two panes never show the
// same note, and split view needs a second note. A note opened from the Trash
// view still opens, and doesn't come back at the next startup.

const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { createLegacyEnv, createDatabase, plain, note, block, makeEditor, startEditorClient } = require('./helpers/legacy-env');

const FILES = [
  'js/utils.js',
  'js/core/storage-error.js',
  'js/storage.js',
  'js/sidebar-utils.js',
  'js/blocks.js',
  'js/editor.js',
  'js/controllers/tab-controller.js',
];

/** Active A (newest) and B (and C when asked), an archived note, a template, and a note in trash. */
async function createProfile(factory, { active = ['A', 'B'] } = {}) {
  const all = [
    note('A', { name: 'Alpha', updatedAt: 1700000000300 }),
    note('B', { name: 'Beta', updatedAt: 1700000000200 }),
    note('C', { name: 'Gamma', updatedAt: 1700000000100 }),
    note('AR', { name: 'Archived', archived: true, archivedAt: 5 }),
    note('T', { name: 'Template', isTemplate: true }),
    note('TR', { name: 'In trash', trashed: true, trashedAt: 6 }),
  ];
  await createDatabase(factory, {
    records: {
      canvases: all.filter((n) => active.includes(n.id) || !['A', 'B', 'C'].includes(n.id)),
      elements: [
        block('a1', 'A', 0, 'alpha'),
        block('b1', 'B', 0, 'beta'),
        block('tr1', 'TR', 0, 'trashed body'),
      ].filter((el) => active.includes(el.canvasId) || el.canvasId === 'TR'),
    },
  });
}

/**
 * The keys TabController.saveTabs and cacheLastOpenedNoteId write, on a profile
 * whose default settings are already written (or Storage.init resets openTabs).
 * A string in `tabs` is a tab for that note ID; anything else is saved as given.
 */
function saveWorkspace(env, { tabs, active = 0, split = false, secondary = null, lastOpened = null }) {
  const tab = (saved) => (typeof saved === 'string' ? { noteId: saved, name: `Tab ${saved}` } : saved);
  Object.assign(env.chrome.local, {
    setting_storageInitialized: true,
    setting_openTabs: Array.isArray(tabs) ? tabs.map(tab) : tabs,
    setting_activeTabIndex: active,
    setting_splitViewEnabled: split,
  });
  if (secondary) env.chrome.local.setting_secondaryNoteId = secondary;
  if (lastOpened) env.chrome.local.lastOpenedNoteId = lastOpened;
}

/** A new tab starting up: Storage, the tab bar and split-view elements, and a TabController with both editors. */
async function start(env) {
  env.load(...FILES);
  const Storage = env.get('Storage');
  await Storage.init();
  await startEditorClient(env);
  const panes = env.document.stub(['note-tabs', 'workspace-container', 'editor-container', 'secondary-editor-container', 'split-view-toggle']);
  panes['editor-container'].className = 'editor-pane active';
  panes['secondary-editor-container'].className = 'editor-pane secondary hidden';
  const TabController = env.get('TabController');
  const tabs = new TabController({ storage: Storage, domRefs: null, logger: null });
  tabs.editor = makeEditor(env, env.document, { root: panes['editor-container'] });
  tabs.secondaryEditor = makeEditor(env, env.document, { root: panes['secondary-editor-container'] });
  // App passes the tab's note list, which has read every list once its kernel was ready
  await env.noteList.settled();
  tabs.noteList = env.noteList;
  const toasts = [];
  env.get('Utils').showToast = (message, kind) => { toasts.push({ message, kind }); };
  return { Storage, tabs, toasts };
}

/** Record the note IDs an editor is asked to load. */
function watchLoads(editor) {
  const loads = [];
  const real = editor.loadNote.bind(editor);
  editor.loadNote = (noteId) => {
    loads.push(noteId);
    return real(noteId);
  };
  return loads;
}

const tabIds = (tabs) => plain(tabs.openTabs.map((tab) => tab.noteId));

describe('startup: restoring the saved workspace', () => {
  let env;

  beforeEach(async () => {
    env = createLegacyEnv();
    await createProfile(env.indexedDB);
  });

  it('skips saved tabs whose notes are in trash or gone, and stays on the active tab', async () => {
    saveWorkspace(env, { tabs: ['TR', 'B', 'GONE', 'AR', 'T'], active: 1 });
    const { tabs } = await start(env);
    await tabs.loadSavedTabs();

    assert.deepEqual(tabIds(tabs), ['B', 'AR', 'T'], 'archived notes and templates still restore');
    assert.equal(tabs.activeTabIndex, 0);
    assert.equal(tabs.editor.noteId, 'B');
    assert.deepEqual(env.chrome.local.setting_openTabs.map((tab) => tab.noteId), ['B', 'AR', 'T']);
    assert.equal(env.chrome.local.lastOpenedNoteId, 'B');
  });

  it('when the active tab is in trash, the next saved tab opens', async () => {
    saveWorkspace(env, { tabs: ['A', 'TR', 'B'], active: 1, lastOpened: 'TR' });
    const { tabs } = await start(env);
    await tabs.loadSavedTabs();

    assert.deepEqual(tabIds(tabs), ['A', 'B']);
    assert.equal(tabs.activeTabIndex, 1);
    assert.equal(tabs.editor.noteId, 'B');
    assert.equal(env.chrome.local.lastOpenedNoteId, 'B');
  });

  it('a skipped tab before the active one leaves the active tab on its note', async () => {
    saveWorkspace(env, { tabs: ['GONE', 'A', 'B', 'AR'], active: 2 });
    const { tabs } = await start(env);
    await tabs.loadSavedTabs();

    assert.deepEqual(tabIds(tabs), ['A', 'B', 'AR']);
    assert.equal(tabs.editor.noteId, 'B');
    assert.equal(tabs.activeTabIndex, 1);
  });

  it('when every saved tab is in trash or gone, it opens what 1.4.0 opens with nothing saved', async () => {
    const nothingSaved = await start(env);
    await nothingSaved.tabs.loadSavedTabs();
    assert.deepEqual(tabIds(nothingSaved.tabs), ['A'], 'with nothing saved: the newest active note');
    assert.equal(nothingSaved.tabs.editor.noteId, 'A');

    const other = createLegacyEnv();
    await createProfile(other.indexedDB);
    saveWorkspace(other, { tabs: ['TR', 'GONE'], active: 0, lastOpened: 'TR' });
    const { tabs } = await start(other);
    await tabs.loadSavedTabs();
    assert.deepEqual(tabIds(tabs), ['A']);
    assert.equal(tabs.editor.noteId, 'A');
  });

  it('saved tabs that are not note IDs are skipped, and so is a saved tab list that is not a list', async () => {
    saveWorkspace(env, {
      tabs: [{ noteId: '' }, { noteId: 7 }, { noteId: { id: 'A' } }, null, { name: 'no ID' }, { noteId: 'B', name: 'Beta' }],
    });
    const { tabs } = await start(env);
    await tabs.loadSavedTabs();
    assert.deepEqual(tabIds(tabs), ['B']);
    assert.equal(tabs.editor.noteId, 'B');

    const other = createLegacyEnv();
    await createProfile(other.indexedDB);
    saveWorkspace(other, { tabs: 'A' });
    const second = await start(other);
    await second.tabs.loadSavedTabs();
    assert.deepEqual(tabIds(second.tabs), ['A'], 'as with nothing saved');
  });

  for (const [label, secondary] of [['in trash', 'TR'], ['gone', 'GONE'], ['not a note ID', { id: 'TR' }]]) {
    it(`does not restore a split note that is ${label}, and never asks for it`, async () => {
      saveWorkspace(env, { tabs: ['A'], split: true, secondary });
      const { tabs } = await start(env);
      const loads = watchLoads(tabs.secondaryEditor);
      await tabs.loadSavedTabs();

      assert.equal(tabs.splitViewEnabled, true);
      assert.equal(tabs.editor.noteId, 'A');
      // As with no split note saved: the first other active note, and only that one
      assert.deepEqual(loads, ['B']);
      assert.equal(tabs.secondaryEditor.noteId, 'B');
    });
  }

  it('doesn\'t bring an archived split note back: the right pane gets an active note', async () => {
    saveWorkspace(env, { tabs: ['A'], split: true, secondary: 'AR' });
    const { tabs } = await start(env);
    await tabs.loadSavedTabs();
    assert.equal(tabs.splitViewEnabled, true);
    assert.equal(tabs.secondaryEditor.noteId, 'B');
  });

  it('a split note that is the active tab\'s note opens another note on the right', async () => {
    saveWorkspace(env, { tabs: ['A', 'B'], active: 0, split: true, secondary: 'A' });
    const { tabs } = await start(env);
    await tabs.loadSavedTabs();

    assert.equal(tabs.editor.noteId, 'A');
    assert.equal(tabs.secondaryEditor.noteId, 'B');
    assert.equal(env.chrome.local.setting_secondaryNoteId, 'B');
  });

  it('a note opened from the Trash view still opens, in a tab of its own', async () => {
    saveWorkspace(env, { tabs: ['A'] });
    const { tabs } = await start(env);
    await tabs.loadSavedTabs();

    await tabs.openNoteInNewTab('TR');
    assert.deepEqual(tabIds(tabs), ['A', 'TR']);
    assert.equal(tabs.activeTabIndex, 1);
    assert.equal(tabs.editor.noteId, 'TR');
    assert.equal(tabs.editor.noteData.trashed, true);
  });

  it('a note opened from the Trash view in the right pane does not come back at the next startup', async () => {
    saveWorkspace(env, { tabs: ['A'], split: true, secondary: 'B' });
    const first = await start(env);
    await first.tabs.loadSavedTabs();
    first.tabs.setActiveEditorSide('right');
    await first.tabs.openNoteInNewTab('TR');
    assert.equal(first.tabs.secondaryEditor.noteId, 'TR', 'it opens');

    // The next new tab on this profile
    const next = createLegacyEnv({ indexedDB: env.indexedDB, chrome: env.chrome });
    const { tabs } = await start(next);
    await tabs.loadSavedTabs();
    assert.deepEqual(tabIds(tabs), ['A']);
    assert.equal(tabs.editor.noteId, 'A');
    assert.equal(tabs.splitViewEnabled, true);
    assert.equal(tabs.secondaryEditor.noteId, 'B');
  });
});

describe('startup with one active note', () => {
  it('a saved split view whose right note is in trash stays closed, with no empty right pane', async () => {
    const env = createLegacyEnv();
    await createProfile(env.indexedDB, { active: ['A'] });
    saveWorkspace(env, { tabs: ['A'], split: true, secondary: 'TR' });
    const { tabs } = await start(env);
    const loads = watchLoads(tabs.secondaryEditor);
    await tabs.loadSavedTabs();

    assert.equal(tabs.editor.noteId, 'A');
    assert.equal(tabs.splitViewEnabled, false);
    assert.equal(env.document.getElementById('workspace-container').classList.contains('split-mode'), false);
    assert.deepEqual(loads, [], 'the right pane loads nothing');
    assert.equal(env.chrome.local.setting_splitViewEnabled, false);
  });
});

describe('split view', () => {
  let env;

  beforeEach(async () => {
    env = createLegacyEnv();
  });

  it('needs a second note: with one active note it stays closed and says so', async () => {
    await createProfile(env.indexedDB, { active: ['A'] });
    saveWorkspace(env, { tabs: ['A'] });
    const { tabs, toasts } = await start(env);
    await tabs.loadSavedTabs();

    await tabs.toggleSplitView();
    assert.equal(tabs.splitViewEnabled, false);
    assert.equal(tabs.secondaryEditor.noteId, null);
    assert.deepEqual(toasts, [{ message: 'Split view needs a second note.', kind: 'info' }]);
  });

  it('never opens the left pane\'s note on the right', async () => {
    await createProfile(env.indexedDB);
    saveWorkspace(env, { tabs: ['A'] });
    const { tabs } = await start(env);
    await tabs.loadSavedTabs();
    // The right pane was last on A, the note the left pane now shows
    await tabs.secondaryEditor.loadNote('A');

    await tabs.toggleSplitView();
    assert.equal(tabs.splitViewEnabled, true);
    assert.equal(tabs.editor.noteId, 'A');
    assert.equal(tabs.secondaryEditor.noteId, 'B');
  });

  it('keeps the right pane\'s own note when it can', async () => {
    await createProfile(env.indexedDB, { active: ['A', 'B', 'C'] });
    saveWorkspace(env, { tabs: ['A'] });
    const { tabs } = await start(env);
    await tabs.loadSavedTabs();
    await tabs.secondaryEditor.loadNote('C');

    await tabs.toggleSplitView();
    assert.equal(tabs.secondaryEditor.noteId, 'C');
    await tabs.toggleSplitView();
    assert.equal(tabs.splitViewEnabled, false);
    assert.equal(tabs.activeEditorSide, 'left');
  });

  it('never brings an archived note back to the right pane', async () => {
    await createProfile(env.indexedDB);
    saveWorkspace(env, { tabs: ['A'] });
    const { tabs } = await start(env);
    await tabs.loadSavedTabs();
    await tabs.secondaryEditor.loadNote('AR');

    await tabs.toggleSplitView();
    assert.equal(tabs.secondaryEditor.noteId, 'B');
  });
});

describe('the cached last-opened note', () => {
  it('reads as null when chrome.storage fails or returns nothing', async () => {
    const env = createLegacyEnv();
    await createProfile(env.indexedDB);
    await start(env);
    const TabController = env.get('TabController');
    const local = env.chrome.api.storage.local;
    const runtime = env.chrome.api.runtime;
    const realGet = local.get;

    env.chrome.local.lastOpenedNoteId = 'A';
    assert.equal(await TabController.getCachedLastOpenedNoteId(), 'A');

    local.get = (keys, callback) => {
      setImmediate(() => {
        runtime.lastError = { message: 'IO error' };
        try { callback(undefined); } finally { runtime.lastError = undefined; }
      });
    };
    assert.equal(await TabController.getCachedLastOpenedNoteId(), null, 'a failed read');

    local.get = (keys, callback) => { setImmediate(() => callback(undefined)); };
    assert.equal(await TabController.getCachedLastOpenedNoteId(), null, 'no result');

    local.get = realGet;
    delete env.chrome.local.lastOpenedNoteId;
    assert.equal(await TabController.getCachedLastOpenedNoteId(), null, 'nothing cached');
  });
});
