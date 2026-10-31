'use strict';

// NTN-12 slice 5: every path that takes notes out of a new tab's active set goes through one
// removeNotes (js/kernel/composition/removal.js), with #46's order: this tab's panes leave
// first, the kernel writes, then the lists and the other new tabs follow. These run it as App
// wires it, on the page's real Storage, kernel, editors, and tabs: a write that fails leaves
// the panes, tabs, and split view as they were and makes no Untitled note; trash retention
// writes first so a pane's unsaved text survives; a bulk action counts only what committed;
// and filing and template conversion with the note open survive the editor's next save.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  createLegacyEnv, createDatabase, dumpDatabase, recordsOf, waitFor, plain, note, block, runUntil, bootNewTab,
} = require('./helpers/legacy-env');

const NAMES = { A: 'Alpha', B: 'Beta', C: 'Gamma', D: 'Delta' };
const DAY = 24 * 60 * 60 * 1000;

/** Active notes, newest first, a note in the trash since long ago, and folders F and G (G inside F) */
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
      folders: [
        { id: 'F', name: 'Work', parentId: null, createdAt: 1, updatedAt: 1, color: null, collapsed: false },
        { id: 'G', name: 'Projects', parentId: 'F', createdAt: 1, updatedAt: 1, color: null, collapsed: false },
      ],
    },
  });
}

/** A new tab on the profile with `open` in tabs (the last one shown), and split view when `split` */
async function openPage(env, { open = ['A'], split = false } = {}) {
  const page = await bootNewTab(env);
  for (const noteId of open) await page.tabs.openNoteInNewTab(noteId);
  if (split) await page.tabs.toggleSplitView();
  page.toasts = [];
  env.get('Utils').showToast = (message, kind) => { page.toasts.push({ message, kind }); };
  if (!env.document.getElementById('sidebar-tab-notes')) env.document.stub(['sidebar-tab-notes', 'sidebar-notes-list']);
  page.notes = page.wire(new (env.get('NotesManager'))({ storage: page.Storage, domRefs: null, logger: null, llm: null }));
  page.sidebar = page.wire(new (env.get('SidebarController'))({
    settings: env.settingsClient,
    storageState: env.storageState,
    domRefs: null,
    logger: null,
  }));
  page.sidebar.getEditor = () => page.tabs.getEditor();
  page.settings = page.wire(new (env.get('SettingsController'))({
    settings: env.settingsClient,
    validateBackup: env.validateBackup,
    domRefs: null,
    logger: null,
  }));
  return page;
}

/**
 * Make the next write to IndexedDB store `name` that `matches` fail, as a full disk or a
 * broken database does, once
 */
function failNextWrite(Storage, name, matches = () => true) {
  const transaction = Storage.transaction.bind(Storage);
  let armed = true;
  Storage.transaction = (names, mode) => {
    const tx = transaction(names, mode);
    const objectStore = tx.objectStore.bind(tx);
    tx.objectStore = (storeName) => {
      const store = objectStore(storeName);
      if (storeName !== name) return store;
      return new Proxy(store, {
        get(target, property) {
          const value = Reflect.get(target, property, target);
          if (typeof value !== 'function') return value;
          if (property !== 'put' && property !== 'delete') return value.bind(target);
          return (...args) => {
            if (armed && matches(args[0])) {
              armed = false;
              throw new Error('A write the test made fail');
            }
            return value.apply(target, args);
          };
        },
      });
    };
    return tx;
  };
}

const confirmIn = async (env, title) => {
  const overlay = await waitFor(() => env.document.querySelectorAll('.confirm-dialog-overlay')
    .find((o) => o.getAttribute('aria-label') === title) || null, { message: `dialog ${title}` });
  overlay.querySelector('.confirm-dialog-confirm').click();
};

function type(editor, text) {
  editor.blocks[0].content = text;
  editor.scheduleSave();
}

const tabIds = (tabs) => plain(tabs.openTabs.map((tab) => tab.noteId));
const stored = async (env) => {
  const db = await dumpDatabase(env.indexedDB);
  return {
    notes: recordsOf(db, 'canvases'),
    elements: Object.values(recordsOf(db, 'elements')),
    folders: recordsOf(db, 'folders'),
  };
};
/** What a pane, the tabs, and split view show, to compare before and after */
const view = (tabs) => plain({
  tabs: tabIds(tabs),
  active: tabs.activeTabIndex,
  split: tabs.splitViewEnabled,
  side: tabs.activeEditorSide,
  left: tabs.editor.noteId,
  right: tabs.secondaryEditor.noteId,
});

/**
 * What another tab's sidebar wrote for a folder it changed, as Storage.updateFolder wrote it,
 * which had no caller once the new tab wrote through #17's adapter, and went with #17 PR 4a
 */
function otherTabPutsFolder(Storage, folder) {
  return new Promise((resolve, reject) => {
    const request = Storage.getStore('folders', 'readwrite').put({ ...folder, updatedAt: Date.now() });
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
}

/** What another tab wrote restoring a note from the trash, as Storage.restoreNote wrote it */
async function otherTabRestores(Storage, noteId) {
  await Storage.updateNote({ ...(await Storage.getNote(noteId)), trashed: false, trashedAt: null });
}

describe('removeNotes, when the write fails', () => {
  it('a trash that fails to store leaves the panes, tabs, and split view as they were, and says so', async () => {
    const env = createLegacyEnv();
    await createProfile(env.indexedDB);
    const page = await openPage(env, { open: ['C', 'A'], split: true });
    page.tabs.setActiveEditorSide('right');
    const before = view(page.tabs);
    assert.deepEqual([before.left, before.right], ['A', 'B']);
    type(page.tabs.secondaryEditor, 'typed before the trash');
    failNextWrite(page.Storage, 'canvases', (record) => record && record.trashed === true);

    await runUntil(env, page.notes.trashNoteById('B'));

    const { notes, elements } = await stored(env);
    assert.notEqual(notes.B.trashed, true, 'B stays where it was');
    assert.ok(elements.some((el) => el.id === 'b1' && el.content === 'typed before the trash'), 'the typing landed first');
    assert.deepEqual(view(page.tabs), before, 'the panes came back');
    assert.deepEqual(env.chrome.local.setting_openTabs.map((tab) => tab.noteId), before.tabs);
    assert.deepEqual(page.toasts, [{ message: 'Failed to move note to trash. Please try again.', kind: 'error' }]);
    assert.ok(page.page.notes.some((n) => n.id === 'B'), 'the list still shows B');
  });

  it('trashing the only note makes no Untitled note when the write fails, and one once it commits', async () => {
    const env = createLegacyEnv();
    await createProfile(env.indexedDB, ['A']);
    const page = await openPage(env, { open: ['A'] });
    failNextWrite(page.Storage, 'canvases', (record) => record && record.trashed === true);

    await runUntil(env, page.notes.trashNoteById('A'));

    let { notes } = await stored(env);
    assert.deepEqual(Object.keys(notes).sort(), ['A', 'TR'], 'no new note');
    assert.notEqual(notes.A.trashed, true);
    assert.equal(page.tabs.editor.noteId, 'A', 'the pane stayed on it');
    assert.deepEqual(tabIds(page.tabs), ['A']);
    assert.deepEqual(page.toasts, [{ message: 'Failed to move note to trash. Please try again.', kind: 'error' }]);

    page.toasts.length = 0;
    await runUntil(env, page.notes.trashNoteById('A'));
    ({ notes } = await stored(env));
    const made = Object.keys(notes).filter((id) => !['A', 'TR'].includes(id));
    assert.equal(made.length, 1, 'one Untitled note, made after the trash committed');
    assert.equal(notes[made[0]].name, 'Untitled');
    assert.equal(notes.A.trashed, true);
    assert.equal(page.tabs.editor.noteId, made[0]);
    assert.deepEqual(tabIds(page.tabs), [made[0]]);
    assert.ok(page.page.notes.some((n) => n.id === made[0]), 'the list shows it');
    assert.deepEqual(page.toasts, [{ message: 'Note moved to trash', kind: 'success' }]);
  });

  it('Empty trash that fails deletes nothing and leaves a pane on a trashed note where it was', async () => {
    const env = createLegacyEnv();
    await createProfile(env.indexedDB);
    const page = await openPage(env, { open: ['A', 'TR'] }); // opened from the Trash view
    const before = view(page.tabs);
    failNextWrite(page.Storage, 'canvases');

    const emptied = page.sidebar.emptyTrash();
    await confirmIn(env, 'Empty Trash');
    await runUntil(env, emptied);

    const { notes, elements } = await stored(env);
    assert.ok(notes.TR, 'TR is still in the trash');
    assert.ok(elements.some((el) => el.id === 'tr1'), 'with its blocks: one transaction, so nothing half done');
    assert.deepEqual(view(page.tabs), before);
    assert.deepEqual(page.toasts, [{ message: 'Failed to empty trash. Please try again.', kind: 'error' }]);
  });

  it('a bulk trash where one note fails trashes the others, says how many, and keeps that one selected', async () => {
    const env = createLegacyEnv();
    await createProfile(env.indexedDB);
    const page = await openPage(env, { open: ['A'] });
    page.sidebar.selectionMode = true;
    page.sidebar.selectedNoteIds = new Set(['A', 'B', 'C']);
    failNextWrite(page.Storage, 'canvases', (record) => record && record.id === 'A' && record.trashed === true);

    const trashed = page.sidebar.performBulkAction('trash');
    await confirmIn(env, 'Confirm');
    await runUntil(env, trashed);

    const { notes } = await stored(env);
    assert.deepEqual([Boolean(notes.A.trashed), notes.B.trashed, notes.C.trashed], [false, true, true]);
    assert.deepEqual(page.toasts, [{ message: "1 of 3 notes couldn't be moved to Trash. It's still selected.", kind: 'error' }]);
    assert.deepEqual(plain([...page.sidebar.selectedNoteIds]), ['A']);
    assert.deepEqual(plain(page.page.notes.map((n) => n.id)).sort(), ['A', 'D']);
  });
});

describe('removeNotes, when the write commits', () => {
  it('bulk archive, trash, restore, and delete each go through the kernel, and the palette and lists agree', async () => {
    const env = createLegacyEnv();
    await createProfile(env.indexedDB);
    const page = await openPage(env, { open: ['A'] });
    const run = async (action, ids) => {
      page.sidebar.selectionMode = true;
      page.sidebar.selectedNoteIds = new Set(ids);
      const done = page.sidebar.performBulkAction(action);
      if (['trash', 'archive', 'delete'].includes(action)) await confirmIn(env, 'Confirm');
      await runUntil(env, done);
    };
    await run('archive', ['A', 'B']);
    assert.equal(page.tabs.editor.noteId, 'C', 'the pane left A for an active note');
    await run('trash', ['C']);
    await run('restore', ['C', 'TR']);
    await run('trash', ['TR']);
    await run('delete', ['TR']);
    const { notes } = await stored(env);
    assert.deepEqual([notes.A.archived, notes.B.archived, notes.C.trashed, notes.TR], [true, true, false, undefined]);
    assert.deepEqual(page.toasts.map((toast) => toast.message), [
      '2 notes archived', '1 note moved to Trash', '2 notes restored from Trash', '1 note moved to Trash',
      '1 note permanently deleted',
    ]);
    const list = page.page.noteList;
    assert.deepEqual(plain(list.view('active').map((n) => n.id)).sort(), ['C', 'D']);
    assert.deepEqual(plain(list.view('archived').map((n) => n.id)).sort(), ['A', 'B']);
    assert.deepEqual(plain(list.view('trashed')), []);
    assert.equal(page.sidebar.selectionMode, false);
  });

  it('Settings > Trash Note says what happened, as the sidebar does', async () => {
    const env = createLegacyEnv();
    await createProfile(env.indexedDB);
    const page = await openPage(env, { open: ['A'] });
    env.document.stub(['settings-modal']);
    page.settings.getEditor = () => page.tabs.getEditor();

    const done = page.settings.deleteCurrentNote();
    await confirmIn(env, 'Trash Note');
    await runUntil(env, done);

    assert.equal((await stored(env)).notes.A.trashed, true);
    assert.notEqual(page.tabs.editor.noteId, 'A');
    assert.deepEqual(page.toasts, [{ message: 'Note moved to trash', kind: 'success' }]);
  });

  it('trash retention deletes first, so a pane with unsaved text in an expired note keeps it, with the notice', async () => {
    const env = createLegacyEnv();
    await createProfile(env.indexedDB);
    const page = await openPage(env, { open: ['A', 'TR'] }); // opened from the Trash view
    const editor = page.tabs.editor;
    type(editor, 'typed into an expired note');
    page.sidebar.logger = { info() {}, warn() {} };

    await runUntil(env, page.sidebar.runTrashCleanup());

    assert.equal((await stored(env)).notes.TR, undefined, 'deleted, with retention at its 30 days');
    await runUntil(env, waitFor(() => editor.noteGone, { message: 'the notice' }));
    assert.equal(editor.noteId, 'TR', 'the pane keeps the text');
    assert.equal(editor.blocks[0].content, 'typed into an expired note');
    assert.ok(editor.root.querySelector('.note-gone-notice'), '"Save as a new note" is offered');
    assert.deepEqual(tabIds(page.tabs), ['A', 'TR']);
  });

  it('trash retention moves a pane with nothing unsaved off an expired note, and keeps notes trashed since', async () => {
    const env = createLegacyEnv();
    await createProfile(env.indexedDB);
    const page = await openPage(env, { open: ['A', 'TR'] });
    await page.Storage.trashNote('C');
    page.sidebar.logger = { info() {}, warn() {} };

    await runUntil(env, page.sidebar.runTrashCleanup());

    const { notes } = await stored(env);
    assert.equal(notes.TR, undefined);
    assert.equal(notes.C.trashed, true, 'trashed now, so kept for 30 days');
    assert.equal(page.tabs.editor.noteId, 'A');
    assert.deepEqual(tabIds(page.tabs), ['A']);
  });
});

describe('filing and templates with the note open', () => {
  it("a folder move with the note open survives the editor's next save, and a gone folder is refused", async () => {
    const env = createLegacyEnv();
    await createProfile(env.indexedDB);
    const page = await openPage(env, { open: ['A'] });
    const editor = page.tabs.editor;
    type(editor, 'typed before the move');

    await runUntil(env, page.sidebar.moveNoteToFolder('A', 'G'));
    type(editor, 'typed after the move');
    env.clock.tick(500);
    await runUntil(env, editor.flushSave());

    let { notes, elements } = await stored(env);
    assert.equal(notes.A.folderId, 'G');
    assert.ok(elements.some((el) => el.id === 'a1' && el.content === 'typed after the move'));
    assert.deepEqual(page.toasts, []);

    // Dropped on the folder it's in: nothing to write, nothing to say
    const updatedAt = notes.A.updatedAt;
    await runUntil(env, page.sidebar.moveNoteToFolder('A', 'G'));
    assert.equal((await stored(env)).notes.A.updatedAt, updatedAt);
    assert.deepEqual(page.toasts, []);

    // A folder another tab deleted, which this tab still lists
    await page.Storage.deleteFolder('F');
    await runUntil(env, page.sidebar.moveNoteToFolder('B', 'F'));
    ({ notes } = await stored(env));
    assert.equal(notes.B.folderId, null, 'not filed out of sight');
    assert.deepEqual(page.toasts, [{ message: 'Failed to move note: that folder no longer exists.', kind: 'error' }]);
  });

  it("convert to template and back with the note open survive the editor's next save", async () => {
    const env = createLegacyEnv();
    await createProfile(env.indexedDB);
    const page = await openPage(env, { open: ['A'] });
    const editor = page.tabs.editor;
    await runUntil(env, page.sidebar.moveNoteToFolder('A', 'F'));

    await runUntil(env, page.notes.convertNoteToTemplate('A'));
    type(editor, 'typed into the template');
    env.clock.tick(500);
    await runUntil(env, editor.flushSave());
    let { notes } = await stored(env);
    assert.deepEqual([notes.A.isTemplate, notes.A.folderId], [true, null]);
    assert.deepEqual(plain(page.page.noteList.view('templates').map((n) => n.id)), ['A']);

    await runUntil(env, page.notes.convertTemplateToNote('A'));
    type(editor, 'typed into the note again');
    env.clock.tick(500);
    await runUntil(env, editor.flushSave());
    ({ notes } = await stored(env));
    assert.equal(notes.A.isTemplate, false);
    assert.equal((await stored(env)).elements.find((el) => el.id === 'a1').content, 'typed into the note again');
    assert.deepEqual(page.toasts.map((toast) => toast.message), ['Note converted to template', 'Template converted to note']);
  });

  it('moving a folder into a folder inside it, from a view another tab made stale, is refused', async () => {
    const env = createLegacyEnv();
    await createProfile(env.indexedDB);
    const page = await openPage(env, { open: ['A'] });
    // Another tab moved F under a new folder H, and H under G; this tab still lists F at the root
    await page.Storage.createFolder('elsewhere');
    const folders = await page.Storage.getAllFolders();
    const h = folders.find((f) => f.name === 'elsewhere');
    await otherTabPutsFolder(page.Storage, { ...h, parentId: 'G' });
    assert.equal(page.sidebar.isChildFolder(h.id, 'F'), false, 'the stale view allows it');

    await runUntil(env, page.sidebar.moveFolder('F', h.id));

    const { folders: after } = await stored(env);
    assert.equal(after.F.parentId, null, 'F stays at the root');
    assert.deepEqual(page.toasts, [{ message: "Failed to move folder: it can't go inside itself.", kind: 'error' }]);
  });

  it('a folder deleted from the sidebar files its notes at the root, and the list shows them there', async () => {
    const env = createLegacyEnv();
    await createProfile(env.indexedDB);
    const page = await openPage(env, { open: ['A'] });
    await runUntil(env, page.sidebar.moveNoteToFolder('B', 'G'));
    assert.equal(page.page.noteList.note('B').folderId, 'G');

    const outcome = await env.documentClient.deleteFolder('F');
    await page.page.noteList.settled();

    assert.equal(outcome.kind, 'committed');
    assert.equal(page.page.noteList.note('B').folderId, null, 'the commit named B, so the list read it');
    assert.deepEqual(plain(page.page.noteList.folders()), []);
    assert.equal((await stored(env)).notes.B.folderId, null);
  });
});

describe('dragging a note onto a folder', () => {
  it('sets the note id the folder drop reads, and the folder files it', async () => {
    const env = createLegacyEnv();
    await createProfile(env.indexedDB);
    const page = await openPage(env, { open: ['A'] });
    page.sidebar.sidebarView = 'notes';
    await page.sidebar.renderNotesList();
    const list = env.document.getElementById('sidebar-notes-list');
    const item = list.querySelectorAll('.sidebar-note-item').find((el) => el.dataset.id === 'B');
    const header = list.querySelectorAll('.sidebar-folder').find((el) => el.dataset.id === 'F')
      .querySelector('.sidebar-folder-header');
    const data = new Map();
    const dataTransfer = { setData: (k, v) => data.set(k, v), getData: (k) => data.get(k) || '' };
    item.dispatchEvent({ type: 'dragstart', dataTransfer, stopPropagation() {} });
    header.dispatchEvent({ type: 'drop', dataTransfer, preventDefault() {} });
    await runUntil(env, waitFor(async () => (await stored(env)).notes.B.folderId === 'F', { message: 'B filed' }));
    assert.equal(data.get('folderId'), undefined, "the folder's own dragstart didn't take it over");
  });
});

describe('archive through removeNotes', () => {
  it('an archive that fails to store puts the pane back and says so; one that commits moves it', async () => {
    const env = createLegacyEnv();
    await createProfile(env.indexedDB);
    const page = await openPage(env, { open: ['A'] });
    const before = view(page.tabs);
    failNextWrite(page.Storage, 'canvases', (record) => record && record.archived === true);

    await runUntil(env, page.notes.archiveNote('A'));
    assert.notEqual((await stored(env)).notes.A.archived, true);
    assert.deepEqual(view(page.tabs), before);
    assert.deepEqual(page.toasts, [{ message: 'Failed to archive note. Please try again.', kind: 'error' }]);

    page.toasts.length = 0;
    await runUntil(env, page.notes.archiveNote('A'));
    assert.equal((await stored(env)).notes.A.archived, true);
    assert.notEqual(page.tabs.editor.noteId, 'A');
    assert.deepEqual(page.toasts, [{ message: 'Note archived', kind: 'success' }]);
  });
});

describe('removeNotes, when some notes stay or were already gone (R76)', () => {
  it('trashing or deleting a note another tab already deleted says it is done, as 1.4.x did', async () => {
    const env = createLegacyEnv();
    await createProfile(env.indexedDB);
    const page = await openPage(env, { open: ['A'] });
    await page.Storage.permanentlyDeleteNote('B');
    await page.Storage.permanentlyDeleteNote('TR');

    await runUntil(env, page.notes.trashNoteById('B'));
    const deleted = page.notes.permanentlyDeleteNoteById('TR');
    await confirmIn(env, 'Delete Permanently');
    await runUntil(env, deleted);

    assert.deepEqual(page.toasts, [
      { message: 'Note moved to trash', kind: 'success' },
      { message: 'Note permanently deleted', kind: 'success' },
    ]);
  });

  it('a bulk trash where the open note fails puts its pane and tab back, and keeps only it selected', async () => {
    const env = createLegacyEnv();
    await createProfile(env.indexedDB);
    const page = await openPage(env, { open: ['A'] });
    const before = view(page.tabs);
    page.sidebar.selectionMode = true;
    page.sidebar.selectedNoteIds = new Set(['A', 'B']);
    failNextWrite(page.Storage, 'canvases', (record) => record && record.id === 'A' && record.trashed === true);

    const trashed = page.sidebar.performBulkAction('trash');
    await confirmIn(env, 'Confirm');
    await runUntil(env, trashed);

    const { notes } = await stored(env);
    assert.deepEqual([Boolean(notes.A.trashed), notes.B.trashed], [false, true]);
    assert.deepEqual(view(page.tabs), before, 'the pane is back on A');
    assert.deepEqual(plain([...page.sidebar.selectedNoteIds]), ['A']);
    assert.deepEqual(page.toasts, [{ message: "1 of 2 notes couldn't be moved to Trash. It's still selected.", kind: 'error' }]);
  });

  it('a bulk trash counts a note another tab already deleted as done, and drops it from the selection', async () => {
    const env = createLegacyEnv();
    await createProfile(env.indexedDB);
    const page = await openPage(env, { open: ['A'] });
    await page.Storage.permanentlyDeleteNote('C');
    page.sidebar.selectionMode = true;
    page.sidebar.selectedNoteIds = new Set(['B', 'C']);

    const trashed = page.sidebar.performBulkAction('trash');
    await confirmIn(env, 'Confirm');
    await runUntil(env, trashed);

    assert.deepEqual(page.toasts, [{ message: '2 notes moved to Trash', kind: 'success' }]);
    assert.equal(page.sidebar.selectionMode, false);
  });

  // #12 slice 7b, with the copy signed off for it: a note another tab deleted leaves the
  // selection, since no try can archive it, and the toast counts it apart. 1.4.x kept it
  // selected as one it couldn't archive, and said to try again.
  it('a bulk archive drops a note another tab already deleted from the selection, and says it was deleted', async () => {
    const env = createLegacyEnv();
    await createProfile(env.indexedDB);
    const page = await openPage(env, { open: ['A'] });
    await page.Storage.permanentlyDeleteNote('C');
    page.sidebar.selectionMode = true;
    page.sidebar.selectedNoteIds = new Set(['A', 'B', 'C']);

    const archived = page.sidebar.performBulkAction('archive');
    await confirmIn(env, 'Confirm');
    await runUntil(env, archived);

    const { notes } = await stored(env);
    assert.deepEqual([notes.A.archived, notes.B.archived], [true, true]);
    assert.deepEqual(page.toasts, [{ message: '2 of 3 notes archived. 1 was deleted.', kind: 'success' }]);
    assert.equal(page.sidebar.selectionMode, false);
    assert.deepEqual(plain([...page.sidebar.selectedNoteIds]), []);
  });

  it("a bulk archive keeps only the note it couldn't archive selected, and counts the one another tab deleted apart", async () => {
    const env = createLegacyEnv();
    await createProfile(env.indexedDB);
    const page = await openPage(env, { open: ['A'] });
    await page.Storage.permanentlyDeleteNote('C');
    page.sidebar.selectionMode = true;
    page.sidebar.selectedNoteIds = new Set(['A', 'B', 'C', 'D']);
    failNextWrite(page.Storage, 'canvases', (record) => record && record.id === 'B' && record.archived === true);

    const archived = page.sidebar.performBulkAction('archive');
    await confirmIn(env, 'Confirm');
    await runUntil(env, archived);

    const { notes } = await stored(env);
    assert.deepEqual([notes.A.archived, Boolean(notes.B.archived), notes.D.archived], [true, false, true]);
    assert.deepEqual(page.toasts, [{
      message: "1 of 4 notes couldn't be archived. It's still selected. 1 other was deleted.",
      kind: 'error',
    }]);
    assert.equal(page.sidebar.selectionMode, true);
    assert.deepEqual(plain([...page.sidebar.selectedNoteIds]), ['B']);
  });

  it('a bulk archive, unarchive, or restore of notes another tab all deleted says so, and leaves selection mode', async () => {
    for (const [action, one, many] of [
      ['archive', 'Failed to archive note: it was deleted.', 'Failed to archive notes: they were deleted.'],
      ['unarchive', 'Failed to restore note from Archive: it was deleted.', 'Failed to restore notes from Archive: they were deleted.'],
      ['restore', 'Failed to restore note from Trash: it was deleted.', 'Failed to restore notes from Trash: they were deleted.'],
    ]) {
      for (const [ids, message] of [[['C'], one], [['C', 'D'], many]]) {
        const env = createLegacyEnv();
        await createProfile(env.indexedDB);
        const page = await openPage(env, { open: ['A'] });
        for (const id of ids) await page.Storage.permanentlyDeleteNote(id);
        page.sidebar.selectionMode = true;
        page.sidebar.selectedNoteIds = new Set(ids);

        const ran = page.sidebar.performBulkAction(action);
        if (action === 'archive') await confirmIn(env, 'Confirm');
        await runUntil(env, ran);

        assert.deepEqual(page.toasts, [{ message, kind: 'error' }], `${action} ${ids}`);
        assert.equal(page.sidebar.selectionMode, false, `${action} ${ids}`);
      }
    }
  });

  it("Empty trash's confirmation counts a trashed note 1.4.x never listed, which now shows in Trash, and deletes it with the rest (#17 PR 3a)", async () => {
    const env = createLegacyEnv();
    await createProfile(env.indexedDB);
    // In the trash since long ago, with no updatedAt, so 1.4.x's Trash never showed it
    const db = await new Promise((resolve, reject) => {
      const request = env.indexedDB.open('CanvasTabDB');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    await new Promise((resolve, reject) => {
      const tx = db.transaction('canvases', 'readwrite');
      const hidden = note('HID', { name: 'Hidden in trash', trashed: true, trashedAt: 6 });
      delete hidden.updatedAt;
      tx.objectStore('canvases').put(hidden);
      tx.oncomplete = resolve;
      tx.onabort = () => reject(tx.error);
    });
    db.close();
    const page = await openPage(env);
    assert.deepEqual(plain(page.sidebar.trashedNotes.map((n) => n.id)).sort(), ['HID', 'TR'], 'Trash lists it');

    const emptied = page.sidebar.emptyTrash();
    const overlay = await waitFor(() => env.document.querySelectorAll('.confirm-dialog-overlay')
      .find((o) => o.getAttribute('aria-label') === 'Empty Trash') || null, { message: 'dialog Empty Trash' });
    assert.equal(overlay.querySelector('.confirm-dialog-message').textContent, 'Permanently delete 2 note(s)? This cannot be undone.');
    overlay.querySelector('.confirm-dialog-confirm').click();
    await runUntil(env, emptied);

    const { notes } = await stored(env);
    assert.deepEqual([notes.HID, notes.TR], [undefined, undefined]);
  });

  it('Empty trash puts back a pane on a note another tab restored first, and deletes the rest', async () => {
    const env = createLegacyEnv();
    await createProfile(env.indexedDB);
    const page = await openPage(env, { open: ['A', 'C'] });
    await page.Storage.trashNote('C');
    await page.page.noteList.reload();
    // Another tab restores C after this tab listed it in the trash
    await otherTabRestores(page.Storage, 'C');
    const before = view(page.tabs);

    const emptied = page.sidebar.emptyTrash();
    await confirmIn(env, 'Empty Trash');
    await runUntil(env, emptied);

    const { notes } = await stored(env);
    assert.deepEqual([Boolean(notes.C), notes.TR], [true, undefined]);
    assert.deepEqual(view(page.tabs), before, 'the pane is back on C');
  });

  it('deleting a note restored since the trash showed it says why it stayed', async () => {
    const env = createLegacyEnv();
    await createProfile(env.indexedDB);
    const page = await openPage(env, { open: ['A'] });
    await otherTabRestores(page.Storage, 'TR');

    const deleted = page.notes.permanentlyDeleteNoteById('TR');
    await confirmIn(env, 'Delete Permanently');
    await runUntil(env, deleted);

    assert.ok((await stored(env)).notes.TR);
    assert.deepEqual(page.toasts, [{ message: "Failed to delete note: it's no longer in the trash.", kind: 'error' }]);
  });

  it('filing into a folder another tab deleted reads the folders again, so the sidebar stops offering it', async () => {
    const env = createLegacyEnv();
    await createProfile(env.indexedDB);
    const page = await openPage(env, { open: ['A'] });
    await page.Storage.deleteFolder('F');
    assert.ok(page.page.noteList.folders().some((f) => f.id === 'F'), 'still listed');

    await runUntil(env, page.sidebar.moveNoteToFolder('A', 'F'));

    assert.ok(!page.page.noteList.folders().some((f) => f.id === 'F'), 'no longer listed');
  });
});

describe('a note filed in a folder that is gone', () => {
  it('a trashed note 1.4.x left on a deleted folder lists under Notes at the root once restored', async () => {
    const env = createLegacyEnv();
    // What 1.4.x's deleteFolder left behind: a trashed note still filed in a folder that's gone
    await createDatabase(env.indexedDB, {
      records: {
        canvases: [
          note('A', { name: 'Alpha' }),
          note('LOST', { name: 'Lost', trashed: true, trashedAt: Date.now(), folderId: 'GONE' }),
        ],
        elements: [block('a1', 'A', 0, 'Alpha body'), block('l1', 'LOST', 0, 'lost body')],
      },
    });
    const page = await openPage(env, { open: ['A'] });

    await runUntil(env, page.notes.restoreNoteById('LOST'));

    const list = page.page.noteList;
    assert.equal(list.note('LOST').folderId, null, 'the list files it at the root');
    assert.ok(list.view('active').some((n) => n.id === 'LOST'));
    page.sidebar.sidebarView = 'notes';
    await page.sidebar.renderNotesList();
    const shown = env.document.getElementById('sidebar-notes-list').querySelectorAll('.sidebar-note-name')
      .map((name) => name.textContent);
    assert.ok(shown.includes('Lost'), `the sidebar lists it: ${shown.join(', ')}`);
    assert.equal((await stored(env)).notes.LOST.folderId, 'GONE', 'the stored record is left as it was');
  });
});
