'use strict';

// NTN-12 slice 4c2: the note-list writes App and its controllers make go through kernel
// commands, on the production controllers over the page's kernel and note list. A note made
// from the sidebar, the Daily Note, an import, archive and unarchive, a pin, and a block dropped
// on a note each commit in one unit and reach the sidebar from the commit feed, with no refresh. Pinning the open note
// survives a save in flight, in both orders (plan 4c.3, L2).

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  createLegacyEnv, createDatabase, dumpDatabase, recordsOf, waitFor, plain, note, block, runUntil, bootNewTab,
  NEW_TAB_FILES, shownTabs,
} = require('./helpers/legacy-env');

const NAMES = { A: 'Alpha', B: 'Beta', C: 'Gamma' };

/** Three active notes, newest first, a folder, and a Daily Note template */
async function createProfile(factory) {
  await createDatabase(factory, {
    records: {
      canvases: [
        ...Object.entries(NAMES).map(([id, name], i) => note(id, { name, updatedAt: 1700000000900 - i * 100 })),
        note('TPL', { name: 'Daily template', isTemplate: true }),
      ],
      elements: [
        ...Object.entries(NAMES).map(([id, name]) => block(`${id.toLowerCase()}1`, id, 0, `${name} body`)),
        block('tpl1', 'TPL', 0, 'Plan for {{title}}'),
      ],
      folders: [{ id: 'F', name: 'Work', parentId: null, createdAt: 1, updatedAt: 1, color: null, collapsed: false }],
    },
  });
}

/**
 * A new tab with A open, the sidebar and NotesManager wired as App wires them, and a count
 * of every refresh and reload of the lists, which none of these writes should need
 */
async function openPage({ kernelNow, pageNow } = {}) {
  const env = createLegacyEnv();
  await createProfile(env.indexedDB);
  const listQueries = [];
  const booted = await bootNewTab(env, {
    files: [...NEW_TAB_FILES, 'js/ai-response-utils.js'],
    onListQuery: (query) => listQueries.push(query.type),
    kernelNow,
    pageNow,
  });
  const page = { ...booted, noteList: booted.page.noteList, get refreshes() { return booted.page.refreshes; } };
  await page.tabs.openNoteInNewTab('A');
  env.document.stub(['sidebar-tab-notes', 'sidebar-notes-list']);
  const deps = { domRefs: null, logger: null };
  const sidebar = page.wire(new (env.get('SidebarController'))({
    ...deps,
    settings: env.settingsClient,
    storageState: env.storageState,
  }));
  // The search index and vectors still go through the page's Storage (#22)
  const notes = page.wire(new (env.get('NotesManager'))({ ...deps, storage: page.Storage, llm: null }));
  const toasts = [];
  env.get('Utils').showToast = (message, kind) => { toasts.push({ message, kind }); };
  const reloads = { sidebar: 0, page: () => page.refreshes, list: () => listQueries.filter((type) => type === 'getNoteList').length };
  sidebar.reloadLists = async () => { reloads.sidebar += 1; };
  await sidebar.renderNotesList();
  // From here on, a full read of the lists is a reload, however it was asked for
  listQueries.length = 0;
  return { env, page, sidebar, notes, toasts, reloads, Storage: page.Storage };
}

const stored = async (env) => {
  const db = await dumpDatabase(env.indexedDB);
  return {
    notes: recordsOf(db, 'canvases'),
    elements: Object.values(recordsOf(db, 'elements')),
    search: recordsOf(db, 'search_index'),
  };
};

/** The sidebar's item for the note named `name` */
const itemOf = (env, name) => env.document.getElementById('sidebar-notes-list').querySelectorAll('.sidebar-note-item')
  .find((item) => item.querySelector('.sidebar-note-name').textContent === name) || null;
const pinShown = (env, name) => itemOf(env, name).querySelector('.sidebar-note-pin').classList.contains('pinned');
const listed = (env) => env.document.getElementById('sidebar-notes-list').querySelectorAll('.sidebar-note-name')
  .map((name) => name.textContent);

function type(editor, text) {
  editor.blocks[0].content = text;
  editor.blocks[0].markUpdated();
  editor.scheduleSave();
}

function assertNoRefresh(reloads) {
  assert.equal(reloads.sidebar, 0, 'the sidebar read no list again');
  assert.equal(reloads.page(), 0, 'TabController read no list again');
  assert.equal(reloads.list(), 0, 'the note list read no list again');
}

function typeTitle(editor, title) {
  editor.titleEl.textContent = title;
  editor.onTitleChange();
}

describe('pinning the open note while it saves (L2)', () => {
  for (const first of ['save', 'pin']) {
    it(`${first === 'save' ? 'a pin while a save is in flight' : 'a save while a pin is in flight'}: the store, the list, and the sidebar say pinned, and the save's text, title, and preview landed`, async () => {
      const { env, page, sidebar, toasts, reloads } = await openPage();
      const editor = page.tabs.editor;
      assert.equal(editor.noteData.pinned, false, 'the editor loaded A unpinned');
      assert.equal(pinShown(env, 'Alpha'), false);
      let saving;
      let pinning;
      const edit = () => {
        typeTitle(editor, 'Alpha plan');
        type(editor, 'typed while pinning');
        return editor.flushSave();
      };
      if (first === 'save') {
        saving = edit();
        pinning = sidebar.toggleNotePin('A');
      } else {
        pinning = sidebar.toggleNotePin('A');
        saving = edit();
      }
      await runUntil(env, Promise.all([saving, pinning]));
      await page.noteList.settled();

      const { notes, elements } = await stored(env);
      assert.equal(notes.A.pinned, true, 'the store says pinned');
      assert.equal(elements.find((el) => el.id === 'a1').content, 'typed while pinning');
      // The save's own note fields: a whole-record pin write from a copy read before them undoes these
      assert.deepEqual(
        [notes.A.name, notes.A.titleManuallySet, notes.A.preview],
        ['Alpha plan', true, 'typed while pinning'],
        "the save's title and preview survive the pin",
      );
      assert.equal(page.noteList.note('A').name, 'Alpha plan');
      assert.equal(page.noteList.note('A').pinned, true, 'the note list says pinned');
      assert.equal(pinShown(env, 'Alpha plan'), true, 'the sidebar renders it pinned, under its new title');
      assert.equal(listed(env)[0], 'Alpha plan', 'pinned notes list first');
      assert.deepEqual(plain(toasts), [{ message: 'Note pinned', kind: 'success' }]);
      assertNoRefresh(reloads);

      // And a later save of the open note keeps it, from the editor's record loaded unpinned
      type(editor, 'typed after pinning');
      await runUntil(env, editor.flushSave());
      assert.equal((await stored(env)).notes.A.pinned, true);
    });
  }

  it('the toggle follows the pin the list shows, so a second click unpins', async () => {
    const { env, page, sidebar, toasts } = await openPage();
    await runUntil(env, sidebar.toggleNotePin('B'));
    await runUntil(env, sidebar.toggleNotePin('B'));
    assert.equal((await stored(env)).notes.B.pinned, false);
    assert.equal(page.noteList.note('B').pinned, false);
    assert.equal(pinShown(env, 'Beta'), false);
    assert.deepEqual(plain(toasts).map((toast) => toast.message), ['Note pinned', 'Note unpinned']);
  });

  it('a pin the kernel refuses says so and changes nothing', async () => {
    const { env, sidebar, toasts } = await openPage();
    sidebar.documentClient = { ...sidebar.documentClient, setPinned: async () => ({ kind: 'unavailable', cause: 'storage', code: 'quota-exceeded' }) };
    const errors = [];
    env.global.console = { ...console, error: (...args) => errors.push(args) };
    await runUntil(env, sidebar.toggleNotePin('B'));
    assert.equal((await stored(env)).notes.B.pinned, false);
    assert.deepEqual(plain(toasts), [{ message: 'Failed to pin note. Please try again.', kind: 'error' }]);
    assert.deepEqual(plain(errors), [['Failed to pin note:', 'unavailable', 'quota-exceeded']], 'codes, never content');
  });
});

describe("the sidebar's new notes and Daily Notes", () => {
  it('two Daily Note clicks at once make one Daily Note, with the template, and open it', async () => {
    const { env, page, sidebar, reloads, Storage } = await openPage();
    await Storage.setSetting('dailyNoteTemplate', 'TPL');
    const ids = await runUntil(env, Promise.all([sidebar.ensureDailyNote(), sidebar.ensureDailyNote()]));
    assert.equal(ids[0], ids[1], 'both name one note');
    const { notes, elements, search } = await stored(env);
    const daily = Object.values(notes).filter((n) => n.isDaily);
    assert.equal(daily.length, 1);
    const today = new Date();
    assert.equal(daily[0].dateStr, today.toISOString().split('T')[0], "keyed by the UTC date, as 1.4.x's");
    assert.equal(
      daily[0].name,
      `Daily Note - ${today.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}`,
    );
    assert.deepEqual(elements.filter((el) => el.canvasId === daily[0].id).map((el) => el.content), [`Plan for ${daily[0].name}`]);
    assert.equal(search[daily[0].id].name, daily[0].name);
    assert.ok(page.noteList.note(daily[0].id), 'the note list has it');
    assert.ok(listed(env).includes(daily[0].name), 'the sidebar lists it');
    assertNoRefresh(reloads);
  });

  it("today's Daily Note asked for just before UTC midnight opens, though the kernel runs just after", async () => {
    // The page decides the day at 23:59:59.900 UTC; its kernel's clock already reads the next day
    const asked = Date.UTC(2026, 9, 30, 23, 59, 59, 900);
    const { env, page, sidebar, toasts } = await openPage({ pageNow: () => asked, kernelNow: () => asked + 200 });
    const noteId = await runUntil(env, sidebar.ensureDailyNote());
    assert.ok(noteId, 'the ensure and the read agree on the day');
    await runUntil(env, sidebar.onOpenNoteInNewTab(noteId));
    assert.equal(page.tabs.editor.noteId, noteId, 'it opens');
    const daily = Object.values((await stored(env)).notes).filter((n) => n.isDaily);
    const name = `Daily Note - ${new Date(asked).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}`;
    assert.deepEqual(plain(daily.map((n) => [n.id, n.dateStr, n.name])), [[noteId, '2026-10-30', name]],
      'keyed by the UTC date and named with the local one, both of the moment it was asked for');
    assert.deepEqual(plain(toasts), [], 'no failure toast');
    // Asked again a moment later, still from before midnight, it finds that note
    assert.equal(await runUntil(env, sidebar.ensureDailyNote()), noteId);
    assert.deepEqual(plain(toasts), []);
  });

  it("a calendar day's Daily Note is keyed and named by that day, and clicking it twice opens one note", async () => {
    const { env, page, sidebar, reloads } = await openPage();
    const day = sidebar.createCalendarDay(5, '2026-10-05', '', new Set(), '2026-10-30');
    day.click();
    day.click();
    await waitFor(() => page.tabs.openTabs.length === 2, { message: 'the Daily Note to open' });
    await runUntil(env, page.noteList.settled());
    const daily = Object.values((await stored(env)).notes).filter((n) => n.isDaily);
    assert.deepEqual(plain(daily.map((n) => [n.dateStr, n.name])), [['2026-10-05', 'Daily Note - Oct 5, 2026']]);
    assert.equal(page.tabs.openTabs[1].noteId, daily[0].id);
    assert.deepEqual(shownTabs(env), ['Alpha', 'Daily Note - Oct 5, 2026']);
    assertNoRefresh(reloads);
  });

  it('a block dropped on the sidebar becomes a note with that block, in one unit, and opens', async () => {
    const { env, page, sidebar, toasts, reloads } = await openPage();
    await runUntil(env, sidebar._createNoteFromBlock('Dragged words', 'text', '<b>Dragged</b> words'));
    const { notes, elements, search } = await stored(env);
    const made = Object.values(notes).find((n) => n.name === 'Dragged words');
    assert.ok(made, JSON.stringify(Object.keys(notes)));
    assert.deepEqual(
      plain(elements.filter((el) => el.canvasId === made.id).map(({ type: kind, content, order }) => ({ kind, content, order }))),
      [{ kind: 'text', content: '<b>Dragged</b> words', order: 0 }],
    );
    assert.equal(search[made.id].name, 'Dragged words');
    assert.equal(page.tabs.editor.noteId, made.id);
    assert.ok(listed(env).includes('Dragged words'));
    assert.deepEqual(plain(toasts), [{ message: 'Note created from block', kind: 'success' }]);
    assertNoRefresh(reloads);
  });

  it("a block dropped on a sidebar note goes after its last block with insertBlocks, and the note's other fields stay", async () => {
    const { env, page, sidebar, toasts, reloads, Storage } = await openPage();
    // Another write to C's record after this tab last read it, and a second block
    await Storage.updateNote({ ...(await Storage.getNote('C')), pinned: true, folderId: 'F' });
    await Storage.saveElement({ id: 'c2', canvasId: 'C', type: 'text', content: 'Gamma second', order: 4 });
    await runUntil(env, sidebar._appendBlockToNote('C', 'todo', 'Dropped task'));
    const { notes, elements } = await stored(env);
    const blocks = elements.filter((el) => el.canvasId === 'C').sort((a, b) => a.order - b.order);
    assert.deepEqual(plain(blocks.map(({ content, order, type: kind }) => [content, order, kind])), [
      ['Gamma body', 0, 'text'],
      ['Gamma second', 4, 'text'],
      ['Dropped task', 5, 'todo'],
    ]);
    assert.deepEqual([notes.C.pinned, notes.C.folderId, notes.C.name], [true, 'F', 'Gamma'], 'only the block fields moved');
    assert.ok(notes.C.updatedAt > 1700000000900, 'the note reads as just changed');
    assert.equal(page.noteList.note('C').updatedAt, notes.C.updatedAt, 'the note list has it');
    assert.deepEqual(plain(toasts), [{ message: 'Block appended to note', kind: 'success' }]);
    assertNoRefresh(reloads);

    // A note deleted meanwhile gets no orphan block
    env.global.console = { ...console, error: () => {} };
    await runUntil(env, sidebar._appendBlockToNote('gone', 'text', 'Nowhere'));
    assert.ok(!(await stored(env)).elements.some((el) => el.content === 'Nowhere'));
    assert.deepEqual(plain(toasts).at(-1), { message: 'Failed to append block: that note was deleted.', kind: 'error' });
  });

  it("Add Note to Folder makes the note in the folder in one write, and opens it", async () => {
    const { env, page, sidebar, reloads } = await openPage();
    await sidebar.showFolderContextMenu({ pageX: 0, pageY: 0 }, page.noteList.folders()[0]);
    const items = env.document.querySelectorAll('.context-menu-item');
    items[2].click();
    await waitFor(() => page.tabs.openTabs.length === 2, { message: 'the new note to open' });
    const made = Object.values((await stored(env)).notes).find((n) => n.name === 'New Note');
    assert.equal(made.folderId, 'F');
    assert.equal(made.updatedAt, made.createdAt, 'filed as it was made, with no second write');
    assert.equal(page.noteList.note(made.id).folderId, 'F');
    assertNoRefresh(reloads);
  });

  it('Add Note to Folder into a folder deleted meanwhile makes no note and says the folder is gone', async () => {
    const { env, page, sidebar, toasts, Storage } = await openPage();
    const folder = page.noteList.folders()[0];
    await Storage.deleteFolder(folder.id);
    env.global.console = { ...console, error: () => {} };
    await sidebar.showFolderContextMenu({ pageX: 0, pageY: 0 }, folder);
    env.document.querySelectorAll('.context-menu-item')[2].click();
    await waitFor(() => toasts.length > 0, { message: 'the toast' });
    assert.deepEqual(plain(toasts), [{ message: 'Failed to create note: that folder no longer exists.', kind: 'error' }]);
    assert.ok(!Object.values((await stored(env)).notes).some((n) => n.name === 'New Note'));
    assert.equal(page.tabs.openTabs.length, 1);
  });
});

describe('archive and unarchive through the kernel', () => {
  it("archiving the open note keeps #46's order: its pane moves off and saves first, then the write, then the other tabs hear", async () => {
    const { env, page, notes, toasts, reloads, Storage } = await openPage();
    await page.tabs.openNoteInNewTab('B');
    const order = [];
    const archived = async (noteId) => Boolean((await Storage.getNote(noteId)).archived);
    // removeNotes as App wires it, with each step recorded and whether the write had landed by then
    notes.removal = env.removalFor({
      leave: async (ids) => {
        order.push(['leaving', ...ids, await archived(ids[0])]);
        return page.tabs.leaveNotes(ids);
      },
      announce: async (ids) => { order.push(['left', ...ids, await archived(ids[0])]); },
    });
    type(page.tabs.editor, 'typed before archiving');
    await runUntil(env, notes.archiveNote('B'));
    order.push(['written', await archived('B')]);

    assert.deepEqual(order, [['leaving', 'B', false], ['left', 'B', true], ['written', true]]);
    const { notes: records, elements } = await stored(env);
    assert.equal(records.B.archived, true);
    assert.equal(typeof records.B.archivedAt, 'number');
    assert.equal(elements.find((el) => el.id === 'b1').content, 'typed before archiving', 'the edit landed first');
    assert.equal(page.tabs.editor.noteId === 'B', false, 'the pane moved off');
    assert.ok(page.noteList.view('archived').some((n) => n.id === 'B'));
    assert.ok(!listed(env).includes('Beta'));
    assert.deepEqual(plain(toasts), [{ message: 'Note archived', kind: 'success' }]);
    assertNoRefresh(reloads);
  });

  it('archive writes the placement fields and nothing else, so a field set meanwhile stays', async () => {
    const { env, notes, Storage } = await openPage();
    // Another write to C's record after this tab last read it
    await Storage.updateNote({ ...(await Storage.getNote('C')), preview: 'set elsewhere', pinned: true });
    await runUntil(env, notes.archiveNote('C'));
    await runUntil(env, notes.unarchiveNote('C'));
    const { notes: records } = await stored(env);
    assert.deepEqual([records.C.preview, records.C.pinned, records.C.archived, records.C.archivedAt], ['set elsewhere', true, false, null]);
  });

  it('unarchive lists the note again from the commit feed', async () => {
    const { env, page, notes, toasts, reloads } = await openPage();
    await runUntil(env, notes.archiveNote('C'));
    await runUntil(env, notes.unarchiveNote('C'));
    assert.ok(page.noteList.view('active').some((n) => n.id === 'C'));
    assert.ok(listed(env).includes('Gamma'));
    assert.deepEqual(plain(toasts).map((t) => t.message), ['Note archived', 'Note restored from archive']);
    assertNoRefresh(reloads);
  });

  it("archive or unarchive of a note deleted in another tab says it was deleted, and the other tabs aren't told", async () => {
    const { env, page, notes, toasts, Storage } = await openPage();
    const left = [];
    notes.removal = env.removalFor({ leave: (ids) => page.tabs.leaveNotes(ids), announce: (ids) => left.push(ids) });
    env.global.console = { ...console, error: () => {} };
    // Deleted for good in another tab, which this one hasn't heard of yet
    await Storage.permanentlyDeleteNote('C');
    await runUntil(env, notes.archiveNote('C'));
    await runUntil(env, notes.unarchiveNote('C'));
    assert.deepEqual(left, []);
    assert.deepEqual(plain(toasts), [
      { message: 'Failed to archive note: it was deleted.', kind: 'error' },
      { message: 'Failed to restore note from archive: it was deleted.', kind: 'error' },
    ]);
    assert.equal((await stored(env)).notes.C, undefined, 'nothing brought it back');
  });

  it('an archive that fails for another reason asks for another try', async () => {
    const { env, notes, toasts } = await openPage();
    notes.removal = { removeNotes: async () => ({ kind: 'unavailable', cause: 'storage', code: 'quota-exceeded' }) };
    env.global.console = { ...console, error: () => {} };
    await runUntil(env, notes.archiveNote('C'));
    assert.deepEqual(plain(toasts), [{ message: 'Failed to archive note. Please try again.', kind: 'error' }]);
    assert.equal((await stored(env)).notes.C.archived, false);
  });
});

describe('importing a note', () => {
  /** A file the import reads as text */
  const fileOf = (name, text) => ({ name, text });

  async function importPage() {
    const opened = await openPage();
    opened.env.get('Utils').readFileAsText = async (file) => file.text;
    return opened;
  }

  it('a Markdown file becomes one note with its blocks, in one unit, titled by its first heading', async () => {
    const { env, page, notes, toasts, reloads } = await importPage();
    await runUntil(env, notes.importNote(fileOf('trip.md', '# Trip plan\n\nPack the bags\n\n- tickets\n- passport\n')));
    const { notes: records, elements } = await stored(env);
    const made = Object.values(records).find((n) => n.name === 'Trip plan');
    assert.ok(made);
    const blocks = elements.filter((el) => el.canvasId === made.id).sort((a, b) => a.order - b.order);
    assert.ok(blocks.length >= 2, JSON.stringify(blocks));
    assert.deepEqual(blocks.map((el) => el.order), blocks.map((_, i) => i));
    assert.ok(blocks.some((el) => /Pack the bags/.test(el.content)));
    assert.equal(page.tabs.editor.noteId, made.id, 'it opens');
    assert.ok(listed(env).includes('Trip plan'));
    assert.deepEqual(plain(toasts), [{ message: 'Note imported', kind: 'success' }]);
    assertNoRefresh(reloads);
  });

  it("a single-note JSON export becomes a new note with the export's blocks, under new ids", async () => {
    const { env, notes, toasts } = await importPage();
    const exported = {
      exportType: 'single-note',
      note: { id: 'old', name: 'Exported plan', pinned: true },
      blocks: [
        { id: 'x1', canvasId: 'old', type: 'h2', content: 'Goals', order: 0 },
        { id: 'x2', canvasId: 'old', type: 'todo', content: 'Ship', checked: true, order: 1 },
      ],
    };
    await runUntil(env, notes.importNote(fileOf('plan.json', JSON.stringify(exported))));
    const { notes: records, elements } = await stored(env);
    const made = Object.values(records).find((n) => n.name === 'Exported plan');
    assert.ok(made && made.id !== 'old');
    assert.equal(made.pinned, false, 'a new note, as 1.4.x made it');
    assert.equal(records.old, undefined);
    const blocks = elements.filter((el) => el.canvasId === made.id).sort((a, b) => a.order - b.order);
    assert.deepEqual(plain(blocks.map(({ type: kind, content, checked }) => ({ kind, content, checked }))), [
      { kind: 'h2', content: 'Goals', checked: undefined },
      { kind: 'todo', content: 'Ship', checked: true },
    ]);
    assert.ok(blocks.every((el) => el.id !== 'x1' && el.id !== 'x2'));
    assert.deepEqual(plain(toasts), [{ message: 'Note imported', kind: 'success' }]);
  });

  it("an import that doesn't commit leaves no note, opens nothing, and isn't counted as imported", async () => {
    const { env, page, notes, toasts } = await importPage();
    const before = Object.keys((await stored(env)).notes).sort();
    // A disk that fills while the blocks are written: the note and its blocks fail together
    const write = page.Storage.db.transaction.bind(page.Storage.db);
    page.Storage.db.transaction = (stores, mode) => {
      const tx = write(stores, mode);
      if (mode === 'readwrite' && [].concat(stores).includes('elements')) {
        const store = tx.objectStore.bind(tx);
        tx.objectStore = (name) => {
          const target = store(name);
          if (name === 'elements') target.put = () => { throw Object.assign(new Error('full'), { name: 'QuotaExceededError' }); };
          return target;
        };
      }
      return tx;
    };
    const errors = [];
    env.global.console = { ...console, error: (...args) => errors.push(args) };
    await runUntil(env, notes.importNote(fileOf('lost.md', '# Lost\n\nWords')));
    page.Storage.db.transaction = write;
    assert.deepEqual(Object.keys((await stored(env)).notes).sort(), before, 'no note stays behind without its blocks');
    assert.equal(page.tabs.openTabs.length, 1);
    assert.deepEqual(plain(toasts), [{ message: 'Failed to import note. Please try again.', kind: 'error' }]);
    assert.equal(errors.length, 1);
    assert.ok(errors[0].every((part) => !String(part).includes('Words') && !String(part).includes('Lost')), 'no content logged');
  });
});
