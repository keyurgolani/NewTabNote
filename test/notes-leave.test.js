'use strict';

// NTN-33 follow-up: a note that leaves the active set (trash, archive, delete,
// Empty trash) leaves every pane and tab, in this new tab and the others, and
// the two panes never end up on one note. Edits typed into it land first. A
// pane whose note was deleted with edits it couldn't save keeps them on
// screen, says so, and offers "Save as a new note".

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  createLegacyEnv, createDatabase, dumpDatabase, recordsOf, waitFor, plain, note, block, runUntil, bootNewTab, shownTabs,
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

/** A new tab with `open` in tabs (the last one shown), and the split view when `split`. */
async function openPage(env, { open = ['A'], split = false } = {}) {
  const page = await bootNewTab(env);
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
    assert.equal(env.chrome.local.setting_splitViewEnabled, false);
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
