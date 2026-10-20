'use strict';

// NTN-33 follow-up: a note that leaves the active set (trash, archive, delete,
// Empty trash) leaves every pane and tab, in this new tab and the others, and
// the two panes never end up on one note. Edits typed into it land first. A
// pane whose note was deleted with edits it couldn't save keeps them on
// screen, says so, and offers "Save as a new note".

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  createLegacyEnv, createDatabase, dumpDatabase, recordsOf, settle, waitFor, plain, note, block, runUntil, bootNewTab,
  shownTabs,
} = require('./helpers/legacy-env');

const NAMES = { A: 'Alpha', B: 'Beta', C: 'Gamma', D: 'Delta' };

/** Active notes, newest first, and a note in trash. */
async function createProfile(factory, active = ['A', 'B', 'C', 'D']) {
  await createDatabase(factory, {
    records: {
      canvases: [
        ...active.map((id, i) => note(id, { name: NAMES[id], updatedAt: 1700000000900 - i * 100 })),
        note('TR', { name: 'In trash', trashed: true, trashedAt: 6 }),
      ],
      elements: [
        ...active.map((id) => block(`${id.toLowerCase()}1`, id, 0, `${NAMES[id]} body`)),
        block('tr1', 'TR', 0, 'trashed body'),
      ],
    },
  });
}

/**
 * A new tab with `open` in tabs (the last one shown), and the split view when
 * `split`. With `ready: false` it is still starting up (see bootNewTab).
 */
async function openPage(env, { open = ['A'], split = false, ready = true } = {}) {
  const page = await bootNewTab(env, { ready });
  for (const noteId of open) await page.tabs.openNoteInNewTab(noteId);
  if (split) await page.tabs.toggleSplitView();
  page.toasts = [];
  env.get('Utils').showToast = (message, kind) => { page.toasts.push({ message, kind }); };
  return page;
}

const controllers = {
  notes: (env, Storage) => new (env.get('NotesManager'))({ storage: Storage, eventBus: null, domRefs: null, logger: null, llm: null }),
  sidebar: (env, Storage) => new (env.get('SidebarController'))({ storage: Storage, eventBus: null, domRefs: null, logger: null }),
  settings: (env, Storage) => new (env.get('SettingsController'))({ storage: Storage, eventBus: null, domRefs: null, logger: null }),
};

/** The sidebar, with its list refresh reduced to the reads emptyTrash needs. */
function sidebarOf(env, page) {
  const sidebar = page.wire(controllers.sidebar(env, page.Storage));
  sidebar.refreshNotesList = async () => {
    sidebar.trashedNotes = await page.Storage.getTrashedNotes();
  };
  return sidebar;
}

function type(editor, text) {
  editor.blocks[0].content = text;
  editor.scheduleSave();
}

const overlay = (env, title) => env.document.querySelectorAll('.confirm-dialog-overlay')
  .find((o) => o.getAttribute('aria-label') === title) || null;
const confirmIn = async (env, title) => {
  const dialog = await waitFor(() => overlay(env, title), { message: `dialog ${title}` });
  dialog.querySelector('.confirm-dialog-confirm').click();
};

const tabIds = (tabs) => plain(tabs.openTabs.map((tab) => tab.noteId));
const stored = async (env) => {
  const db = await dumpDatabase(env.indexedDB);
  return { notes: recordsOf(db, 'canvases'), elements: Object.values(recordsOf(db, 'elements')) };
};

describe('a note leaving the active set, in this new tab', () => {
  it('trashing the open note writes its pending edit first, then its tab and pane go to the next note', async () => {
    const env = createLegacyEnv();
    await createProfile(env.indexedDB);
    const page = await openPage(env);
    const notes = page.wire(controllers.notes(env, page.Storage));

    type(page.tabs.editor, 'typed before trashing');
    await runUntil(env, notes.trashNoteById('A'));

    const { notes: records, elements } = await stored(env);
    assert.equal(records.A.trashed, true);
    assert.ok(elements.some((el) => el.id === 'a1' && el.content === 'typed before trashing'), 'the edit landed in A first');
    assert.deepEqual(tabIds(page.tabs), ['B']);
    assert.equal(page.tabs.editor.noteId, 'B');
    assert.deepEqual(shownTabs(env), ['Beta']);
    assert.deepEqual(env.chrome.local.setting_openTabs.map((tab) => tab.noteId), ['B']);
    assert.equal(env.chrome.local.lastOpenedNoteId, 'B');
  });

  it('trashing a new note right after typing in it keeps the text, in trash', async () => {
    const env = createLegacyEnv();
    await createProfile(env.indexedDB);
    const page = await openPage(env);
    const notes = page.wire(controllers.notes(env, page.Storage));
    const untitled = await page.Storage.createNote('Untitled');
    await page.tabs.openNoteInNewTab(untitled.id);

    type(page.tabs.editor, 'typed into a new note');
    await runUntil(env, notes.trashNoteById(untitled.id));

    const { notes: records, elements } = await stored(env);
    assert.ok(records[untitled.id], 'the note is not deleted for being empty');
    assert.equal(records[untitled.id].trashed, true);
    assert.ok(elements.some((el) => el.canvasId === untitled.id && el.content === 'typed into a new note'));
    assert.deepEqual(page.toasts, [{ message: 'Note moved to trash', kind: 'success' }]);
  });

  it('trashing the split note moves the right pane to a note the left pane does not show', async () => {
    const env = createLegacyEnv();
    await createProfile(env.indexedDB);
    const page = await openPage(env, { split: true });
    assert.equal(page.tabs.secondaryEditor.noteId, 'B');
    const notes = page.wire(controllers.notes(env, page.Storage));

    await runUntil(env, notes.trashNoteById('B'));

    assert.deepEqual(tabIds(page.tabs), ['A']);
    assert.equal(page.tabs.editor.noteId, 'A');
    assert.equal(page.tabs.secondaryEditor.noteId, 'C');
    assert.equal(env.chrome.local.setting_secondaryNoteId, 'C');
  });

  it('with no other note for the right pane, split view closes', async () => {
    const env = createLegacyEnv();
    await createProfile(env.indexedDB, ['A', 'B']);
    const page = await openPage(env, { split: true });
    page.tabs.setActiveEditorSide('right');
    const notes = page.wire(controllers.notes(env, page.Storage));

    await runUntil(env, notes.trashNoteById('B'));

    assert.equal(page.tabs.splitViewEnabled, false);
    assert.equal(page.tabs.activeEditorSide, 'left');
    assert.equal(page.tabs.editor.noteId, 'A');
    assert.equal(page.tabs.secondaryEditor.noteId, null, 'the hidden pane keeps no note');
    assert.equal(env.chrome.local.setting_splitViewEnabled, false);
  });

  it("when split view closes onto the right pane's note, the hidden pane keeps no copy to save over it", async () => {
    const env = createLegacyEnv();
    await createProfile(env.indexedDB, ['A', 'B']);
    env.global.navigator.platform = 'MacIntel';
    const page = await openPage(env, { split: true });
    const { editor: left, secondaryEditor: right } = page.tabs;
    // An edit in the right pane, with its undo entry, already saved
    const before = right.snapshotBlock(right.blocks[0]);
    right.blocks[0].content = 'Beta edited on the right';
    right.pushUndo({ type: 'content', blockId: 'b1', before, after: right.snapshotBlock(right.blocks[0]) });
    right.scheduleSave();
    await runUntil(env, right.flushSave());
    const notes = page.wire(controllers.notes(env, page.Storage));

    await runUntil(env, notes.trashNoteById('A'));
    assert.equal(page.tabs.splitViewEnabled, false);
    assert.equal(left.noteId, 'B');
    assert.equal(right.noteId, null, 'the hidden pane shows no note');
    assert.equal(right.blocks.length, 0);
    assert.equal(right.undoStack.length, 0);

    // Typing on the left, then Cmd+Z: the document runs both panes' listeners
    type(left, 'typed on the left');
    const undo = { type: 'keydown', key: 'z', metaKey: true, target: left.container, preventDefault() {} };
    for (const editor of [left, right]) editor.onGlobalKeyDown(undo);
    env.clock.tick(500);
    await runUntil(env, Promise.all([left.flushSave(), right.flushSave()]));
    assert.equal((await stored(env)).elements.find((el) => el.id === 'b1').content, 'typed on the left');
  });

  it("an edit in the right pane's debounce goes with its note when split view closes onto it", async () => {
    const env = createLegacyEnv();
    await createProfile(env.indexedDB, ['A', 'B']);
    const page = await openPage(env, { split: true });
    const { editor: left, secondaryEditor: right } = page.tabs;
    type(right, 'typed on the right');
    const notes = page.wire(controllers.notes(env, page.Storage));

    await runUntil(env, notes.trashNoteById('A'));
    assert.equal(left.noteId, 'B');
    assert.equal(left.blocks[0].content, 'typed on the right', 'the left pane read the note with the edit');

    type(left, `${left.blocks[0].content}, then on the left`);
    env.clock.tick(500);
    await runUntil(env, Promise.all([left.flushSave(), right.flushSave()]));
    assert.equal((await stored(env)).elements.find((el) => el.id === 'b1').content, 'typed on the right, then on the left');
  });

  it('keys and pastes on the shared document reach one pane: the one they came from, else the active one', async () => {
    const env = createLegacyEnv();
    await createProfile(env.indexedDB);
    env.global.navigator.platform = 'MacIntel';
    const page = await openPage(env, { split: true });
    const { editor: left, secondaryEditor: right } = page.tabs;
    const handled = [];
    for (const [name, editor] of [['left', left], ['right', right]]) {
      editor.undo = () => handled.push(`${name} undo`);
      editor.handleFiles = () => handled.push(`${name} paste`);
    }
    const press = (target) => {
      const event = { type: 'keydown', key: 'z', metaKey: true, target, preventDefault() {} };
      for (const editor of [left, right]) editor.onGlobalKeyDown(event);
    };
    const paste = (target) => {
      const image = { type: 'image/png', getAsFile: () => ({ name: 'shot.png' }) };
      const event = { type: 'paste', target, clipboardData: { items: [image], getData: () => '' }, preventDefault() {} };
      for (const editor of [left, right]) editor.onPaste(event);
    };

    press(right.container);
    paste(right.container);
    press(env.document.body); // outside both panes: the active pane, the left one
    page.tabs.setActiveEditorSide('right');
    paste(env.document.body);
    await page.tabs.toggleSplitView(); // split view off: the left pane is active, the right one hidden
    press(env.document.body);
    assert.deepEqual(handled, ['right undo', 'right paste', 'left undo', 'right paste', 'left undo']);
  });

  it('archiving the open note: the left pane takes a note the right pane does not show, and the right pane stays', async () => {
    const env = createLegacyEnv();
    await createProfile(env.indexedDB);
    const page = await openPage(env, { split: true });
    const notes = page.wire(controllers.notes(env, page.Storage));

    await runUntil(env, notes.archiveNote('A'));

    assert.equal((await stored(env)).notes.A.archived, true);
    // B, the next note, is on the right
    assert.equal(page.tabs.editor.noteId, 'C');
    assert.equal(page.tabs.secondaryEditor.noteId, 'B');
    assert.deepEqual(tabIds(page.tabs), ['C']);
  });

  it('with the right pane in use, trashing its note moves only that pane', async () => {
    const env = createLegacyEnv();
    await createProfile(env.indexedDB);
    const page = await openPage(env, { open: ['A', 'D'], split: true });
    // Clicking into the right pane leaves the active tab on the left pane's note
    page.tabs.setActiveEditorSide('right');
    assert.equal(page.tabs.secondaryEditor.noteId, 'A');
    const notes = page.wire(controllers.notes(env, page.Storage));

    await runUntil(env, notes.trashNoteById('A'));

    assert.equal(page.tabs.editor.noteId, 'D', 'the left pane stays');
    assert.equal(page.tabs.secondaryEditor.noteId, 'B', 'the right pane takes a note the left does not show');
    assert.deepEqual(tabIds(page.tabs), ['D']);
  });

  it("with the right pane in use, trashing the left pane's note moves only the left pane", async () => {
    const env = createLegacyEnv();
    await createProfile(env.indexedDB);
    const page = await openPage(env, { open: ['A'], split: true });
    page.tabs.setActiveEditorSide('right');
    const notes = page.wire(controllers.notes(env, page.Storage));

    await runUntil(env, notes.trashNoteById('A'));

    assert.equal(page.tabs.secondaryEditor.noteId, 'B', 'the right pane stays');
    assert.equal(page.tabs.editor.noteId, 'C');
    assert.deepEqual(tabIds(page.tabs), ['B'], 'the tab bar keeps a tab for the note in use');
  });

  for (const [action, check] of [
    ['trash', (record) => assert.equal(record.trashed, true)],
    ['archive', (record) => assert.equal(record.archived, true)],
    ['delete', (record) => assert.equal(record, undefined)],
  ]) {
    it(`bulk ${action} of the open note and the split note moves both panes`, async () => {
      const env = createLegacyEnv();
      await createProfile(env.indexedDB);
      const page = await openPage(env, { open: ['A', 'B'], split: true });
      assert.equal(page.tabs.editor.noteId, 'B');
      assert.equal(page.tabs.secondaryEditor.noteId, 'A');
      const sidebar = sidebarOf(env, page);
      sidebar.selectedNoteIds = new Set(['A', 'B']);

      const done = sidebar.performBulkAction(action);
      await confirmIn(env, 'Confirm');
      await runUntil(env, done);

      const { notes: records } = await stored(env);
      check(records.A);
      check(records.B);
      assert.deepEqual(tabIds(page.tabs), ['C']);
      assert.equal(page.tabs.editor.noteId, 'C');
      assert.equal(page.tabs.secondaryEditor.noteId, 'D');
    });
  }

  it('deleting a note for good from the Trash view moves its pane to the surviving tab', async () => {
    const env = createLegacyEnv();
    await createProfile(env.indexedDB);
    const page = await openPage(env, { open: ['A', 'TR'] });
    assert.equal(page.tabs.editor.noteId, 'TR', 'a note in trash opens when picked');
    const notes = page.wire(controllers.notes(env, page.Storage));

    const done = notes.permanentlyDeleteNoteById('TR');
    await confirmIn(env, 'Delete Permanently');
    await runUntil(env, done);

    assert.equal((await stored(env)).notes.TR, undefined);
    assert.deepEqual(tabIds(page.tabs), ['A']);
    assert.equal(page.tabs.editor.noteId, 'A');
  });

  it("Trash Note in settings moves the pane off the note it trashed", async () => {
    const env = createLegacyEnv();
    await createProfile(env.indexedDB);
    const page = await openPage(env, { open: ['B', 'A'] });
    const settings = page.wire(controllers.settings(env, page.Storage));

    const done = settings.deleteCurrentNote();
    await confirmIn(env, 'Trash Note');
    await runUntil(env, done);

    assert.equal((await stored(env)).notes.A.trashed, true);
    assert.deepEqual(tabIds(page.tabs), ['B']);
    assert.equal(page.tabs.editor.noteId, 'B');
  });

  it('notes that leave one right after another, as two messages do, end with one tab for the note on screen', async () => {
    const env = createLegacyEnv();
    await createProfile(env.indexedDB);
    const page = await openPage(env);
    await page.Storage.trashNote('A');
    await page.Storage.trashNote('B');

    await runUntil(env, Promise.all([page.tabs.forgetNotes(['A']), page.tabs.forgetNotes(['B'])]));

    assert.equal(page.tabs.editor.noteId, 'C');
    assert.deepEqual(tabIds(page.tabs), ['C']);
    assert.deepEqual(env.chrome.local.setting_openTabs.map((tab) => tab.noteId), ['C']);
  });

  for (const [label, noticedFirst] of [['right after typing there', false], ['with its notice already showing', true]]) {
    it(`turning split view off ${label}, with the right pane's note deleted, keeps split view, the text, and the notice in view`, async () => {
      const env = createLegacyEnv();
      await createProfile(env.indexedDB);
      const page = await openPage(env, { split: true });
      const right = page.tabs.secondaryEditor;
      type(right, 'typed into B');
      await page.Storage.permanentlyDeleteNote('B'); // another tab, before its message arrives
      if (noticedFirst) await runUntil(env, right.flushSave());

      await runUntil(env, page.tabs.toggleSplitView());

      assert.equal(page.tabs.splitViewEnabled, true);
      assert.equal(env.document.getElementById('secondary-editor-container').classList.contains('hidden'), false);
      assert.equal(right.noteId, 'B');
      assert.equal(right.noteGone, true);
      assert.equal(right.blocks[0].content, 'typed into B');
      assert.ok(right.root.querySelector('.note-gone-notice'), 'the notice shows');
      assert.deepEqual(page.toasts, [{ message: "Split view stays open while the right pane has a deleted note's unsaved text.", kind: 'info' }]);
    });
  }

  it('closing the tab of a note deleted with unsaved edits keeps the tab bar on it, and closing another tab loads nothing', async () => {
    const env = createLegacyEnv();
    await createProfile(env.indexedDB);
    const page = await openPage(env, { open: ['A', 'B', 'C'] });
    await runUntil(env, page.tabs.switchToTab(1));
    const editor = page.tabs.editor;
    type(editor, 'typed into B');
    await page.Storage.permanentlyDeleteNote('B'); // another tab, before its message arrives

    await runUntil(env, page.tabs.closeTab(1));
    assert.equal(editor.noteId, 'B', 'the text stays on screen');
    assert.equal(editor.noteGone, true);
    assert.deepEqual(tabIds(page.tabs), ['A', 'B', 'C']);
    assert.equal(page.tabs.activeTabIndex, 1);
    assert.deepEqual(env.chrome.local.setting_openTabs.map((tab) => tab.noteId), ['A', 'B', 'C']);
    page.tabs.updateCurrentTabName('Beta, renamed');
    assert.deepEqual(shownTabs(env), ['Alpha', 'Beta, renamed', 'Gamma'], "a title edit renames B's tab");

    await runUntil(env, page.tabs.closeTab(0));
    assert.equal(editor.noteId, 'B');
    assert.equal(editor.blocks[0].content, 'typed into B', 'still there');
    assert.deepEqual(tabIds(page.tabs), ['B', 'C']);
    assert.equal(page.tabs.activeTabIndex, 0);
  });

  it("leaving a deleted note's notice for another tab takes that note's tab away", async () => {
    const env = createLegacyEnv();
    await createProfile(env.indexedDB);
    const page = await openPage(env, { open: ['A', 'B'] });
    const editor = page.tabs.editor;
    type(editor, 'typed into B');
    await page.Storage.permanentlyDeleteNote('B'); // another tab
    await runUntil(env, page.tabs.forgetNotes(['B'])); // its message
    assert.equal(editor.noteGone, true);
    assert.deepEqual(tabIds(page.tabs), ['A', 'B'], 'B keeps its tab while its notice shows');

    await runUntil(env, page.tabs.switchToTab(0));
    assert.equal(editor.noteId, 'A');
    assert.deepEqual(tabIds(page.tabs), ['A']);
    assert.equal(page.tabs.activeTabIndex, 0);
    assert.deepEqual(env.chrome.local.setting_openTabs.map((tab) => tab.noteId), ['A']);
  });

  it("archiving the hidden right pane's note lets go of it, so turning split view on shows an active note", async () => {
    const env = createLegacyEnv();
    await createProfile(env.indexedDB);
    const page = await openPage(env, { split: true });
    assert.equal(page.tabs.secondaryEditor.noteId, 'B');
    await runUntil(env, page.tabs.toggleSplitView()); // off: the hidden right pane has B
    const notes = page.wire(controllers.notes(env, page.Storage));

    await runUntil(env, notes.archiveNote('B'));
    assert.equal(page.tabs.secondaryEditor.noteId, null);

    await runUntil(env, page.tabs.toggleSplitView());
    const right = page.tabs.secondaryEditor.noteId;
    assert.ok(right && right !== 'B' && right !== page.tabs.editor.noteId, `the right pane shows ${right}`);
    assert.equal((await stored(env)).notes[right].archived, false);
    assert.deepEqual(tabIds(page.tabs), ['A']);
  });

  it('"Save as a new note" keeps the folder and the pin, and writes the text under new block IDs', async () => {
    const env = createLegacyEnv();
    await createProfile(env.indexedDB);
    const page = await bootNewTab(env);
    const folder = await page.Storage.createFolder('Work');
    await page.Storage.updateNote({ ...(await page.Storage.getNote('B')), folderId: folder.id, pinned: true });
    await runUntil(env, page.tabs.openNoteInNewTab('B'));
    const editor = page.tabs.editor;
    type(editor, 'typed into B');
    await page.Storage.permanentlyDeleteNote('B'); // another tab
    await runUntil(env, editor.flushSave());
    assert.equal(editor.noteGone, true);

    await runUntil(env, editor.saveAsNewNote());
    const { notes: records, elements } = await stored(env);
    const saved = records[editor.noteId];
    assert.equal(saved.name, 'Beta');
    assert.equal(saved.folderId, folder.id);
    assert.equal(saved.pinned, true);
    const blocks = elements.filter((el) => el.canvasId === editor.noteId);
    assert.deepEqual(blocks.map((el) => el.content), ['typed into B']);
    assert.ok(blocks.every((el) => el.id !== 'b1'), 'not the deleted note\'s block ID');
  });

  it('"Save as a new note" puts the note at the top of the list when its folder went too', async () => {
    const env = createLegacyEnv();
    await createProfile(env.indexedDB);
    const page = await bootNewTab(env);
    const folder = await page.Storage.createFolder('Work');
    await page.Storage.updateNote({ ...(await page.Storage.getNote('B')), folderId: folder.id });
    await runUntil(env, page.tabs.openNoteInNewTab('B'));
    const editor = page.tabs.editor;
    type(editor, 'typed into B');
    // Another tab takes the note and its folder, as Replace all does
    await page.Storage.permanentlyDeleteNote('B');
    await page.Storage.deleteFolder(folder.id);
    await runUntil(env, editor.flushSave());
    assert.equal(editor.noteGone, true);

    await runUntil(env, editor.saveAsNewNote());
    const saved = (await stored(env)).notes[editor.noteId];
    assert.equal(saved.folderId, null, 'a note in a missing folder would show nowhere in the sidebar');
  });

  it('a hidden pane takes no key or paste from outside the panes, whatever it was last', async () => {
    const env = createLegacyEnv();
    await createProfile(env.indexedDB);
    const page = await openPage(env, { split: true });
    page.tabs.setActiveEditorSide('right');
    const right = page.tabs.secondaryEditor;
    const outside = { target: env.document.body };
    assert.equal(right._ownsDocumentEvent(outside), true, 'the active right pane takes them');
    // Hidden while still marked active, as nothing else would leave it
    right.root.classList.add('hidden');
    assert.equal(right._ownsDocumentEvent(outside), false);
    assert.equal(page.tabs.editor._ownsDocumentEvent(outside), false, 'nor the inactive left pane');
  });

  for (const [label, pick] of [
    ['a click on another tab', (tabs) => tabs.switchToTab(0)],
    ['a note opened in a new tab', (tabs) => tabs.openNoteInNewTab('C')],
    ['a note opened in this tab', (tabs) => tabs.openNoteWithModifier('C', null)],
  ]) {
    it(`${label} that the editor refuses leaves the tab bar and the saved tabs on the note on screen`, async () => {
      const env = createLegacyEnv();
      await createProfile(env.indexedDB);
      const page = await openPage(env, { open: ['A', 'B'] });
      const editor = page.tabs.editor;
      type(editor, 'typed into B');
      await page.Storage.permanentlyDeleteNote('B'); // another tab, before its message arrives

      await runUntil(env, pick(page.tabs));

      assert.equal(editor.noteId, 'B', 'the text stays on screen');
      assert.equal(editor.noteGone, true);
      assert.deepEqual(tabIds(page.tabs), ['A', 'B']);
      assert.equal(page.tabs.activeTabIndex, 1);
      assert.deepEqual(env.chrome.local.setting_openTabs.map((tab) => tab.noteId), ['A', 'B']);
      assert.equal(env.chrome.local.setting_activeTabIndex, 1);
      assert.equal(env.chrome.local.lastOpenedNoteId, 'B');
    });
  }

  it('typing in the right pane after its note was trashed, then emptying trash, loses nothing', async () => {
    const env = createLegacyEnv();
    await createProfile(env.indexedDB);
    const page = await openPage(env, { split: true });
    const notes = page.wire(controllers.notes(env, page.Storage));
    const sidebar = sidebarOf(env, page);

    await runUntil(env, notes.trashNoteById('B'));
    const right = page.tabs.secondaryEditor;
    type(right, 'typed after the trash');
    await sidebar.refreshNotesList();
    const emptied = sidebar.emptyTrash();
    await confirmIn(env, 'Empty Trash');
    await runUntil(env, emptied);
    await runUntil(env, right.flushSave());

    const { notes: records, elements } = await stored(env);
    assert.equal(records.B, undefined, 'B is deleted');
    assert.equal(right.noteId, 'C');
    assert.equal(right.noteGone, false);
    assert.ok(elements.some((el) => el.canvasId === 'C' && el.content === 'typed after the trash'), 'the typing is in C');
  });
});

describe('a note leaving the active set in another new tab', () => {
  async function twoPages() {
    const first = createLegacyEnv();
    await createProfile(first.indexedDB);
    const second = createLegacyEnv({ indexedDB: first.indexedDB, chrome: first.chrome, channels: first.channels });
    return { first, second };
  }

  for (const [label, leave, comeBack] of [
    ['out of focus', (env) => { env.document.focused = false; }, (env) => { env.document.focused = true; env.window.fire('focus'); }],
    ['hidden', (env) => { env.document.visibilityState = 'hidden'; env.document.focused = false; env.document.fire('visibilitychange'); },
      (env) => { env.document.visibilityState = 'visible'; env.document.focused = true; env.document.fire('visibilitychange'); }],
  ]) {
    it(`a tab ${label} stays where it is, then moves onto the notes as they are once the user is back`, async () => {
      const { first, second } = await twoPages();
      // The background tab has Beta and Alpha open, Alpha on screen
      const two = await openPage(second, { open: ['B', 'A'] });
      leave(second);
      const one = await openPage(first, { open: ['B'] });
      const notes = one.wire(controllers.notes(first, one.Storage));

      await runUntil(first, notes.trashNoteById('A'));
      await runUntil(second, settle(40)); // the message reaches the background tab
      assert.equal(first.channels.sent.length, 1);
      assert.equal(two.tabs.editor.noteId, 'A', 'it stays on Alpha, as 1.4.0 did');
      assert.deepEqual(tabIds(two.tabs), ['B', 'A']);
      assert.deepEqual(first.chrome.local.setting_openTabs.map((tab) => tab.noteId), ['B'], "the saved workspace is the first tab's");

      // The user keeps editing Beta in the first tab
      type(one.tabs.editor, 'Beta, edited in the first tab');
      first.clock.tick(500);
      await runUntil(first, one.tabs.editor.flushSave());

      comeBack(second);
      await runUntil(second, waitFor(() => two.tabs.editor.noteId === 'B', { message: 'the background tab to move' }));
      assert.equal(two.tabs.editor.blocks[0].content, 'Beta, edited in the first tab', 'Beta as it is now');
      assert.deepEqual(tabIds(two.tabs), ['B']);

      // Typing there keeps the first tab's edit
      two.tabs.editor.blocks[0].content += ', and more from the second tab';
      two.tabs.editor.scheduleSave();
      second.clock.tick(500);
      await runUntil(second, two.tabs.editor.flushSave());
      const beta = (await stored(first)).elements.filter((el) => el.canvasId === 'B').map((el) => el.content);
      assert.deepEqual(beta, ['Beta, edited in the first tab, and more from the second tab']);
    });
  }

  it('a tab that shows none of the notes leaves the saved workspace alone', async () => {
    const { first, second } = await twoPages();
    const two = await openPage(second, { open: ['C'] });
    const one = await openPage(first, { open: ['A', 'B'] }); // the tab in use, saved last
    const refreshes = two.page.refreshes;
    const notes = one.wire(controllers.notes(first, one.Storage));

    await runUntil(first, notes.trashNoteById('D'));
    await runUntil(second, waitFor(() => two.page.refreshes > refreshes, { message: 'the other tab to hear of it' }));

    assert.deepEqual(first.chrome.local.setting_openTabs.map((tab) => tab.noteId), ['A', 'B']);
    assert.equal(first.chrome.local.setting_activeTabIndex, 1);
    assert.equal(first.chrome.local.lastOpenedNoteId, 'B');
    assert.deepEqual(tabIds(two.tabs), ['C']);
  });

  it('a tab still starting up holds the messages until it has restored the saved workspace', async () => {
    const { first, second } = await twoPages();
    const one = await openPage(first, { open: ['A', 'B'] });
    const two = await bootNewTab(second, { ready: false });
    const notes = one.wire(controllers.notes(first, one.Storage));

    await runUntil(first, notes.trashNoteById('B'));
    await runUntil(second, settle(40)); // the message reaches the second tab
    assert.equal(first.channels.sent.length, 1);
    assert.deepEqual(first.chrome.local.setting_openTabs.map((tab) => tab.noteId), ['A'], "the saved workspace is the first tab's");

    await runUntil(second, two.tabs.loadSavedTabs());
    assert.deepEqual(tabIds(two.tabs), ['A']);
    assert.equal(two.tabs.editor.noteId, 'A');
    assert.deepEqual(first.chrome.local.setting_openTabs.map((tab) => tab.noteId), ['A']);
  });

  it('trash retention deleting a note tells the other tabs, which move off it', async () => {
    const { first, second } = await twoPages();
    const two = await openPage(second, { open: ['A', 'TR'] }); // opened from the Trash view
    assert.equal(two.tabs.editor.noteId, 'TR');
    const one = await openPage(first, { open: ['C'] });
    const sidebar = one.wire(controllers.sidebar(first, one.Storage));
    sidebar.logger = { info() {} };
    sidebar.refreshNotesList = async () => {};

    // As App.init runs it, after workspaceReady. e2e/notes-leave-across-tabs.spec.js starts a real new tab for that order.
    await runUntil(first, sidebar.runTrashCleanup());
    await runUntil(second, waitFor(() => two.tabs.editor.noteId !== 'TR', { message: 'the other tab to move' }));

    assert.equal((await stored(first)).notes.TR, undefined, 'TR is deleted');
    assert.deepEqual(tabIds(two.tabs), ['A']);
    assert.equal(two.tabs.editor.noteId, 'A');
  });

  it('this tab drops its tab, moves its pane off it, and refreshes the list', async () => {
    const { first, second } = await twoPages();
    const one = await openPage(first, { open: ['C'] });
    const two = await openPage(second, { open: ['A'], split: true });
    assert.equal(two.tabs.secondaryEditor.noteId, 'B');
    const refreshes = two.page.refreshes;
    const notes = one.wire(controllers.notes(first, one.Storage));

    await runUntil(first, notes.trashNoteById('A'));
    await runUntil(second, waitFor(() => two.page.refreshes > refreshes, { message: 'the other tab to refresh' }));

    assert.deepEqual(tabIds(two.tabs), ['C']);
    assert.equal(two.tabs.editor.noteId, 'C', 'not B, which the right pane shows');
    assert.equal(two.tabs.secondaryEditor.noteId, 'B');
    assert.ok(!two.page.notes.some((n) => n.id === 'A'), 'the list no longer shows A');
    assert.deepEqual(tabIds(one.tabs), ['C'], 'the tab that trashed it is unchanged');
  });

  it('Empty trash right after trash, with typing still unsaved there: the text stays, and "Save as a new note" keeps it', async () => {
    const { first, second } = await twoPages();
    const one = await openPage(first, { open: ['A'] });
    const two = await openPage(second, { open: ['C', 'B'] });
    const editor = two.tabs.editor;
    type(editor, 'typed in the other tab');
    const notes = one.wire(controllers.notes(first, one.Storage));
    const sidebar = sidebarOf(first, one);

    // The first tab trashes B and empties trash before the second one paints a frame
    await runUntil(first, notes.trashNoteById('B'));
    await sidebar.refreshNotesList();
    const emptied = sidebar.emptyTrash();
    await confirmIn(first, 'Empty Trash');
    await runUntil(first, emptied);
    assert.equal((await stored(first)).notes.B, undefined, 'B is deleted');

    // The second tab paints: its save finds B deleted, and the text stays on screen
    await runUntil(second, waitFor(() => editor.noteGone, { message: 'the notice' }));
    await runUntil(second, waitFor(() => two.page.refreshes >= 2, { message: 'both messages handled' }));
    assert.equal(editor.noteId, 'B');
    assert.equal(editor.blocks[0].content, 'typed in the other tab');
    const notice = editor.root.querySelector('.note-gone-notice');
    assert.equal(notice.querySelector('.note-gone-text').textContent, "This note was deleted, so these changes aren't saved.");
    assert.deepEqual(tabIds(two.tabs), ['C', 'B'], 'its tab stays');
    assert.deepEqual(two.toasts, []);

    notice.querySelector('.note-gone-btn').click();
    await runUntil(second, waitFor(() => !editor._savingAsNew && editor.noteId !== 'B', { message: 'the new note' }));

    const copyId = editor.noteId;
    const { notes: records, elements } = await stored(second);
    assert.equal(records.B, undefined, 'B stays deleted');
    assert.equal(records[copyId].name, 'Beta');
    assert.ok(!records[copyId].trashed);
    assert.ok(elements.some((el) => el.canvasId === copyId && el.content === 'typed in the other tab'));
    assert.deepEqual(tabIds(two.tabs), ['C', copyId], 'the tab follows the new note');
    assert.equal(two.tabs.activeTabIndex, 1);
    assert.deepEqual(shownTabs(second), ['Gamma', 'Beta']);
    assert.equal(editor.root.querySelector('.note-gone-notice'), null);
  });
});
