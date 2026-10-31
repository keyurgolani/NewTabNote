'use strict';

// NTN-33 follow-up: a note that leaves the active set (trash, archive, delete,
// Empty trash) leaves every pane and tab in this new tab, and the two panes
// never end up on one note. Edits typed into it land first. The other new tabs
// refresh their lists and keep their panes and tabs, as 1.4.0 did: their saves
// keep a note's trash and archive state. A pane whose note was deleted with
// edits it couldn't save keeps them on screen, says so, and offers "Save as a
// new note".

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

// Each with what App gives it of the page (bootNewTab's wire adds the rest)
const controllers = {
  notes: (env, Storage) => new (env.get('NotesManager'))({ storage: Storage, domRefs: null, logger: null, llm: null }),
  sidebar: (env) => new (env.get('SidebarController'))({
    settings: env.settingsClient,
    storageState: env.storageState,
    domRefs: null,
    logger: null,
  }),
  settings: (env) => new (env.get('SettingsController'))({
    settings: env.settingsClient,
    validateBackup: env.validateBackup,
    domRefs: null,
    logger: null,
  }),
};

/** The sidebar over the page's note list, with the view tab and the list it renders into. */
function sidebarOf(env, page) {
  if (!env.document.getElementById('sidebar-tab-notes')) env.document.stub(['sidebar-tab-notes', 'sidebar-notes-list']);
  return page.wire(controllers.sidebar(env, page.Storage));
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

  for (const [action, check, trashedFirst] of [
    ['trash', (record) => assert.equal(record.trashed, true), false],
    ['archive', (record) => assert.equal(record.archived, true), false],
    // Delete takes only notes in the trash (deleteNotePermanently), so these were trashed in another tab
    ['delete', (record) => assert.equal(record, undefined), true],
  ]) {
    it(`bulk ${action} of the open note and the split note moves both panes`, async () => {
      const env = createLegacyEnv();
      await createProfile(env.indexedDB);
      const page = await openPage(env, { open: ['A', 'B'], split: true });
      assert.equal(page.tabs.editor.noteId, 'B');
      assert.equal(page.tabs.secondaryEditor.noteId, 'A');
      if (trashedFirst) {
        await page.Storage.trashNote('A');
        await page.Storage.trashNote('B');
        await page.page.noteList.reload();
      }
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

  it("two notes leaving at once, one in each pane, are handled one after the other, so the panes end on two active notes", async () => {
    const env = createLegacyEnv();
    await createProfile(env.indexedDB);
    const page = await openPage(env, { split: true });
    assert.deepEqual([page.tabs.editor.noteId, page.tabs.secondaryEditor.noteId], ['A', 'B']);
    await page.Storage.trashNote('A');
    await page.Storage.trashNote('B');

    await runUntil(env, Promise.all([page.tabs.forgetNotes(['A']), page.tabs.forgetNotes(['B'])]));

    const panes = [page.tabs.editor.noteId, page.tabs.secondaryEditor.noteId];
    assert.equal(page.tabs.splitViewEnabled, true);
    assert.notEqual(panes[0], panes[1], `the panes show ${panes.join(' and ')}`);
    assert.deepEqual([...panes].sort(), ['C', 'D']);
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

  it("trashing the open note next to a template's tab still opens the template, as before", async () => {
    const env = createLegacyEnv();
    await createProfile(env.indexedDB);
    const page = await openPage(env, { open: ['B', 'A'] });
    await page.Storage.updateNote({ ...(await page.Storage.getNote('B')), isTemplate: true });

    await runUntil(env, page.wire(controllers.notes(env, page.Storage)).trashNoteById('A'));

    assert.equal(page.tabs.editor.noteId, 'B');
    assert.deepEqual(tabIds(page.tabs), ['B']);
  });

  it("with the right pane on a deleted note's notice and the left pane on the only active note, trashing that note moves the left pane to a new note", async () => {
    const env = createLegacyEnv();
    await createProfile(env.indexedDB, ['A', 'B']);
    const page = await openPage(env, { split: true });
    page.tabs.setActiveEditorSide('right');
    const right = page.tabs.secondaryEditor;
    type(right, 'typed into B');
    await page.Storage.permanentlyDeleteNote('B'); // another tab
    await runUntil(env, right.flushSave());
    assert.equal(right.noteGone, true);
    const notes = page.wire(controllers.notes(env, page.Storage));

    await runUntil(env, notes.trashNoteById('A'));

    const left = page.tabs.editor;
    assert.notEqual(left.noteId, 'A', 'the left pane leaves the trashed note');
    const shown = (await stored(env)).notes[left.noteId];
    assert.ok(shown && !shown.trashed && !shown.archived, 'for an active note');
    assert.equal(page.tabs.splitViewEnabled, true, "split view stays for the deleted note's text");
    assert.equal(right.noteGone, true);
    assert.equal(right.blocks[0].content, 'typed into B');
  });

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
  /** Two new tabs on one profile, sharing IndexedDB, chrome.storage, and the BroadcastChannel unless `channel` is false */
  async function twoPages({ channel = true } = {}) {
    const first = createLegacyEnv();
    await createProfile(first.indexedDB);
    const second = createLegacyEnv({ indexedDB: first.indexedDB, chrome: first.chrome, ...(channel ? { channels: first.channels } : {}) });
    return { first, second };
  }

  /** Type into `page`'s pane and wait for its save */
  async function typeAndSave(env, editor, text) {
    type(editor, text);
    env.clock.tick(500);
    await runUntil(env, editor.flushSave());
  }

  const savedTabs = (env) => env.chrome.local.setting_openTabs.map((tab) => tab.noteId);
  const blocksOf = async (env, noteId) => (await stored(env)).elements.filter((el) => el.canvasId === noteId).map((el) => el.content);

  /** Ways another tab moves Alpha out of the active set while keeping it, and the flag Alpha's saves then keep */
  const KEPT = [
    ['trashes it', 'trashed', (one, first) => one.wire(controllers.notes(first, one.Storage)).trashNoteById('A')],
    ['archives it', 'archived', (one, first) => one.wire(controllers.notes(first, one.Storage)).archiveNote('A')],
    ['runs Replace all', 'trashed', async (one, first) => {
      const backup = { version: 1, exportedAt: 1, canvases: [note('R', { name: 'Imported' })], elements: [block('r1', 'R', 0, 'imported')] };
      await one.tabs.flushEditorsForImport();
      // As the page runs it since #17 PR 4a: the importBackup command on #17's adapter
      const result = await first.settingsClient.importBackup(backup, 'replace', first.validateBackup(backup).counts);
      await one.tabs.reloadEditorsAfterImport(result.trashedIds, null);
    }],
  ];

  for (const [what, flag, act] of KEPT) {
    it(`when another tab ${what}, this one keeps its pane and tabs on it, refreshes its lists, and its saves keep it ${flag}`, async () => {
      const { first, second } = await twoPages();
      const two = await openPage(second, { open: ['C', 'A'] }); // Alpha on screen
      const one = await openPage(first, { open: ['B'] }); // the tab in use, saved last

      await runUntil(first, act(one, first));
      await runUntil(second, waitFor(() => two.page.refreshes === 1, { message: 'the lists to refresh' }));
      assert.equal(two.tabs.editor.noteId, 'A', 'the pane stays, as 1.4.0 did');
      assert.deepEqual(tabIds(two.tabs), ['C', 'A']);
      assert.equal(two.tabs.activeTabIndex, 1);
      assert.equal(two.page.refreshes, 1, 'the lists read again once, and nothing else moved');
      assert.ok(!two.page.notes.some((n) => n.id === 'A'), 'the list no longer shows Alpha');
      const workspace = savedTabs(first);
      assert.ok(!workspace.includes('C'), "the saved workspace is the first tab's");

      await typeAndSave(second, two.tabs.editor, 'typed after it left');
      const { notes: records } = await stored(first);
      assert.equal(records.A[flag], true, `Alpha stays ${flag}`);
      assert.deepEqual(await blocksOf(first, 'A'), ['typed after it left']);
      assert.deepEqual(savedTabs(first), workspace, 'and this tab wrote no workspace');
    });
  }

  /** Ways another tab deletes the note in trash (TR) for good */
  const DELETED = [
    ['empties trash', async (one, first) => {
      const sidebar = sidebarOf(first, one);
      await sidebar.refreshNotesList();
      const emptied = sidebar.emptyTrash();
      await confirmIn(first, 'Empty Trash');
      await emptied;
    }],
    ['deletes it for good', async (one, first) => {
      const deleted = one.wire(controllers.notes(first, one.Storage)).permanentlyDeleteNoteById('TR');
      await confirmIn(first, 'Delete Permanently');
      await deleted;
    }],
    ['runs trash retention', async (one, first) => {
      const sidebar = one.wire(controllers.sidebar(first, one.Storage));
      sidebar.logger = { info() {} };
      sidebar.refreshNotesList = async () => {};
      await sidebar.runTrashCleanup();
    }],
  ];

  for (const [what, act] of DELETED) {
    it(`when another tab ${what}, this one keeps its pane on the deleted note, and typing there shows the notice and keeps the text`, async () => {
      const { first, second } = await twoPages();
      const two = await openPage(second, { open: ['A', 'TR'] }); // opened from the Trash view
      const one = await openPage(first, { open: ['C'] });

      await runUntil(first, act(one, first));
      assert.equal((await stored(first)).notes.TR, undefined, 'deleted');
      await runUntil(second, waitFor(() => two.page.refreshes === 1, { message: 'the lists to refresh' }));
      const editor = two.tabs.editor;
      assert.equal(editor.noteId, 'TR', 'the pane stays');
      assert.deepEqual(tabIds(two.tabs), ['A', 'TR']);
      assert.equal(editor.noteGone, false, 'no notice until it saves');

      await typeAndSave(second, editor, 'typed after it was deleted');
      assert.equal(editor.noteGone, true);
      assert.equal(editor.noteId, 'TR');
      assert.equal(editor.blocks[0].content, 'typed after it was deleted');
      const notice = editor.root.querySelector('.note-gone-notice');
      assert.equal(notice.querySelector('.note-gone-text').textContent, "This note was deleted, so these changes aren't saved.");
      assert.equal((await stored(first)).notes.TR, undefined, 'and stays deleted');
    });
  }

  it('Empty trash right after trash, with typing still unsaved there: the text stays, and "Save as a new note" keeps it', async () => {
    const { first, second } = await twoPages();
    const one = await openPage(first, { open: ['A'] });
    const two = await openPage(second, { open: ['C', 'B'] });
    const editor = two.tabs.editor;
    type(editor, 'typed in the other tab');
    const notes = one.wire(controllers.notes(first, one.Storage));
    const sidebar = sidebarOf(first, one);

    // The first tab trashes B and empties trash before the second one saves
    await runUntil(first, notes.trashNoteById('B'));
    await sidebar.refreshNotesList();
    const emptied = sidebar.emptyTrash();
    await confirmIn(first, 'Empty Trash');
    await runUntil(first, emptied);
    assert.equal((await stored(first)).notes.B, undefined, 'B is deleted');

    // The second tab's save finds B deleted, and the text stays on screen
    second.clock.tick(500);
    await runUntil(second, waitFor(() => editor.noteGone, { message: 'the notice' }));
    assert.equal(editor.noteId, 'B');
    assert.equal(editor.blocks[0].content, 'typed in the other tab');
    assert.deepEqual(tabIds(two.tabs), ['C', 'B'], 'its tab stays');
    assert.deepEqual(two.toasts, []);

    editor.root.querySelector('.note-gone-notice').querySelector('.note-gone-btn').click();
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

  it('with no message between the tabs at all, a save keeps the trash flag, and a note deleted for good shows the notice', async () => {
    const { first, second } = await twoPages({ channel: false });
    const two = await openPage(second, { open: ['A'], split: true }); // Alpha left, Beta right
    const one = await openPage(first, { open: ['C'] });
    const notes = one.wire(controllers.notes(first, one.Storage));

    await runUntil(first, notes.trashNoteById('A'));
    await one.Storage.permanentlyDeleteNote('B');
    await runUntil(second, settle(40));
    assert.equal(first.channels.sent.length, 1, 'the first tab posts');
    assert.equal(two.page.refreshes, 0, 'and the second never hears');

    await typeAndSave(second, two.tabs.editor, 'left pane, after the trash');
    assert.equal((await stored(first)).notes.A.trashed, true);
    assert.deepEqual(await blocksOf(first, 'A'), ['left pane, after the trash']);

    const right = two.tabs.secondaryEditor;
    await typeAndSave(second, right, 'right pane, after the delete');
    assert.equal(right.noteGone, true);
    assert.equal(right.blocks[0].content, 'right pane, after the delete');
    assert.ok(right.root.querySelector('.note-gone-notice'));
  });

  it("clicking the tab of a note deleted in another tab drops that tab with a toast and keeps the pane", async () => {
    const { first, second } = await twoPages();
    const two = await openPage(second, { open: ['A', 'B', 'C'] }); // Gamma on screen
    const one = await openPage(first, { open: ['D'] });
    const editor = two.tabs.editor;
    const gamma = (await stored(first)).notes.C;
    await one.Storage.permanentlyDeleteNote('A');

    await runUntil(second, two.tabs.switchToTab(0));
    assert.equal(editor.noteId, 'C', 'the pane stays');
    assert.deepEqual(tabIds(two.tabs), ['B', 'C']);
    assert.equal(two.tabs.activeTabIndex, 1);
    assert.deepEqual(shownTabs(second), ['Beta', 'Gamma']);
    assert.deepEqual(two.toasts, [{ message: 'That note was deleted, so its tab closed.', kind: 'info' }]);
    assert.deepEqual((await stored(first)).notes.C, gamma, 'Gamma is not written');

    await runUntil(second, two.tabs.switchToTab(0));
    assert.equal(editor.noteId, 'B', 'a tab whose note exists opens as before');
  });

  for (const [what, act, kept] of [
    ['trashed', (one, first) => one.wire(controllers.notes(first, one.Storage)).trashNoteById('A'), ['A', 'B']],
    ['archived', (one, first) => one.wire(controllers.notes(first, one.Storage)).archiveNote('A'), ['A', 'B']],
    ['deleted for good', (one) => one.Storage.permanentlyDeleteNote('A'), ['B']],
  ]) {
    it(`trashing the open note never moves the pane onto the tab of a note another tab ${what}: it goes to the newest active note`, async () => {
      const { first, second } = await twoPages();
      const two = await openPage(second, { open: ['A', 'C'] }); // Gamma on screen, next to Alpha's tab
      const one = await openPage(first, { open: ['D'] });
      await runUntil(first, act(one, first));
      await runUntil(second, settle(40)); // its message, if any, reaches this tab

      await runUntil(second, two.wire(controllers.notes(second, two.Storage)).trashNoteById('C'));

      const editor = two.tabs.editor;
      assert.equal(editor.noteId, 'B', 'Beta, the newest active note');
      assert.deepEqual(tabIds(two.tabs), kept, `Alpha's tab ${what === 'deleted for good' ? 'goes' : 'stays'}`);
      assert.equal(two.tabs.openTabs[two.tabs.activeTabIndex].noteId, 'B');
      await typeAndSave(second, editor, 'typed into B');
      assert.deepEqual(await blocksOf(first, 'B'), ['typed into B']);
    });
  }

  it('closing the active tab next to a tab whose note another tab deleted drops that tab with a toast and opens the one after it', async () => {
    const { first, second } = await twoPages();
    const two = await openPage(second, { open: ['A', 'B', 'C'] });
    await runUntil(second, two.tabs.switchToTab(0)); // Alpha on screen, Beta's tab next to it
    const one = await openPage(first, { open: ['D'] });
    await one.Storage.permanentlyDeleteNote('B');

    await runUntil(second, two.tabs.closeTab(0));

    assert.equal(two.tabs.editor.noteId, 'C');
    assert.deepEqual(tabIds(two.tabs), ['C']);
    assert.deepEqual(savedTabs(first), ['C']);
    assert.deepEqual(two.toasts, [{ message: 'That note was deleted, so its tab closed.', kind: 'info' }]);
  });

  it("clicking the tab of a note trashed or archived in another tab opens it, as 1.4.0 did, and its saves keep that", async () => {
    const { first, second } = await twoPages();
    const two = await openPage(second, { open: ['A', 'B', 'C'] }); // Gamma on screen
    const one = await openPage(first, { open: ['D'] });
    const notes = one.wire(controllers.notes(first, one.Storage));
    await runUntil(first, notes.trashNoteById('A'));
    await runUntil(first, notes.archiveNote('B'));
    await runUntil(second, waitFor(() => two.page.refreshes === 2, { message: 'both refreshes' }));
    assert.deepEqual(tabIds(two.tabs), ['A', 'B', 'C']);

    for (const [index, noteId, flag] of [[0, 'A', 'trashed'], [1, 'B', 'archived']]) {
      await runUntil(second, two.tabs.switchToTab(index));
      assert.equal(two.tabs.editor.noteId, noteId);
      await typeAndSave(second, two.tabs.editor, `typed into ${noteId}`);
      const record = (await stored(first)).notes[noteId];
      assert.equal(record[flag], true, `${noteId} stays ${flag}`);
      assert.deepEqual(await blocksOf(first, noteId), [`typed into ${noteId}`]);
    }
    assert.deepEqual(two.toasts, []);
  });

  it('a tab that shows none of the notes leaves the saved workspace alone', async () => {
    const { first, second } = await twoPages();
    const two = await openPage(second, { open: ['C'] });
    const one = await openPage(first, { open: ['A', 'B'] }); // the tab in use, saved last
    const notes = one.wire(controllers.notes(first, one.Storage));

    await runUntil(first, notes.trashNoteById('D'));
    await runUntil(second, waitFor(() => two.page.refreshes === 1, { message: 'the other tab to hear of it' }));

    assert.deepEqual(savedTabs(first), ['A', 'B']);
    assert.equal(first.chrome.local.setting_activeTabIndex, 1);
    assert.equal(first.chrome.local.lastOpenedNoteId, 'B');
    assert.deepEqual(tabIds(two.tabs), ['C']);
  });

  it('a tab still starting up refreshes its lists once it is ready for a message that came meanwhile, and starts on the notes as they are stored', async () => {
    const { first, second } = await twoPages();
    const one = await openPage(first, { open: ['A', 'B'] });
    const two = await bootNewTab(second, { ready: false });
    const notes = one.wire(controllers.notes(first, one.Storage));

    await runUntil(first, notes.trashNoteById('B'));
    await runUntil(second, settle(40)); // the message reaches the second tab
    assert.equal(first.channels.sent.length, 1);
    assert.equal(two.page.refreshes, 0, 'nothing refreshes while it starts');

    await runUntil(second, two.tabs.loadSavedTabs());
    assert.deepEqual(tabIds(two.tabs), ['A'], 'Beta, in trash, stays closed at startup');
    assert.equal(two.tabs.editor.noteId, 'A');

    // It read its lists before the message came, so they refresh once, as it gets its workspace
    two.tabs.workspaceReady();
    await runUntil(second, waitFor(() => two.page.refreshes === 1, { message: 'the refresh for the message' }));
    two.tabs.workspaceReady();
    await runUntil(second, settle(20));
    assert.equal(two.page.refreshes, 1, 'once');
  });
});
