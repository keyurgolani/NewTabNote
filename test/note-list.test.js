'use strict';

// NTN-12 slice 4c1: one note list per new tab (js/kernel/core/application/note-list.js) feeds
// the sidebar, the command palette, App, and analytics, in a stubbed page running the
// production controllers. A commit reaches every one of them through one getNotesByIds read,
// with no refresh, and a bulk action the sidebar runs on today's legacy path reaches the
// palette and App through the list's reload (the lost update #12's body names). Nothing that
// reads a record the list hands out changes it.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  createLegacyEnv, FakeDocument, FakeElement, createDatabase, startEditorClient, settle, waitFor, plain, note, block,
} = require('./helpers/legacy-env');

const FILES = [
  'js/utils.js',
  'js/core/storage-error.js',
  'js/ui/confirm-dialog.js',
  'js/storage.js',
  'js/sidebar-utils.js',
  'js/virtual-scroller.js',
  'js/command-palette-utils.js',
  'js/analytics.js',
  'js/controllers/sidebar-controller.js',
  'js/controllers/shortcuts-manager.js',
  'js/controllers/analytics-controller.js',
  'js/app.js',
];

/** Four active notes, newest first, an archived one, and one in trash, with a folder */
function profile() {
  const at = (offset) => 1700000000000 + offset;
  return {
    canvases: [
      note('A', { name: 'Alpha', updatedAt: at(400) }),
      note('B', { name: 'Beta', updatedAt: at(300), folderId: 'F' }),
      note('C', { name: 'Gamma', updatedAt: at(200) }),
      note('D', { name: 'Delta', updatedAt: at(100) }),
      note('R', { name: 'Archived once', updatedAt: at(50), archived: true, archivedAt: at(60) }),
      note('T', { name: 'In trash', updatedAt: at(10), trashed: true, trashedAt: at(20) }),
    ],
    elements: [
      block('a1', 'A', 0, 'alpha one two'),
      block('b1', 'B', 0, 'beta three'),
      block('r1', 'R', 0, 'archived four five six'),
    ],
    folders: [{ id: 'F', name: 'Work', parentId: null, createdAt: at(0), updatedAt: at(0), color: null, collapsed: false }],
    search_index: [
      { noteId: 'A', name: 'Alpha', content: 'alpha one two', updatedAt: at(400) },
      { noteId: 'B', name: 'Beta', content: 'beta three', updatedAt: at(300) },
      { noteId: 'C', name: 'Gamma', content: '', updatedAt: at(200) },
      { noteId: 'D', name: 'Delta', content: '', updatedAt: at(100) },
    ],
  };
}

/**
 * A new tab's page with the sidebar, the palette, analytics, and App over the page's one note
 * list, wired as App wires them, and the elements they render into
 */
async function openPage() {
  const env = createLegacyEnv({ document: new FakeDocument() });
  // The palette scrolls its selected item into view, which the stub DOM has no layout for
  FakeElement.prototype.scrollIntoView = () => {};
  await createDatabase(env.indexedDB, { records: profile() });
  env.load(...FILES);
  const Storage = env.get('Storage');
  await Storage.init();
  const queries = [];
  await startEditorClient(env, { onListQuery: (query) => queries.push(plain(query)) });
  const noteList = env.noteList;
  await noteList.settled();
  env.document.stub([
    'sidebar-notes-list', 'sidebar-tab-notes', 'sidebar-trash-actions', 'notes-count', 'archive-count', 'trash-count',
    'command-palette-modal', { id: 'command-palette-input', tag: 'input' }, 'command-palette-results',
  ]);
  env.document.getElementById('command-palette-modal').classList.add('hidden');
  const deps = { storage: Storage, eventBus: null, domRefs: null, logger: null };
  const sidebar = new (env.get('SidebarController'))(deps);
  sidebar.getEditor = () => null;
  const palette = new (env.get('ShortcutsManager'))(deps);
  palette.getEditor = () => null;
  palette.getOpenTabs = () => [];
  palette.getSidebarOpen = () => true;
  palette.getAISidebarOpen = () => false;
  palette.onCloseAllModals = () => {};
  const analytics = new (env.get('AnalyticsController'))(deps);
  // As App wires them: a noteList field each, and analytics reads blocks through the document client.
  // The sidebar files and removes notes through the document client and removeNotes, with no panes here.
  sidebar.documentClient = env.documentClient;
  sidebar.removal = env.removalFor({ leave: () => null, announce: () => {} });
  sidebar.noteList = noteList;
  palette.noteList = noteList;
  analytics.noteList = noteList;
  env.get('Analytics').connect({ noteList, getNoteBlocks: (noteId) => env.documentClient.blocksOf(noteId) });
  const app = Object.assign(Object.create(env.get('App').prototype), {
    noteList, documentClient: env.documentClient, sidebarController: sidebar, shortcutsManager: palette,
    analyticsController: analytics,
  });
  app.updateEmptyState = () => {};
  queries.length = 0;
  return { env, Storage, noteList, sidebar, palette, analytics, app, queries };
}

const listed = (env) => env.document.getElementById('sidebar-notes-list')
  .querySelectorAll('.sidebar-note-name').map((name) => name.textContent);
const count = (env, id) => {
  const badge = env.document.getElementById(id);
  return badge.classList.contains('hidden') ? 0 : Number(badge.textContent);
};
const paletteNotes = (palette) => plain(palette.commandPaletteItems
  .filter((item) => item.kind === 'note')
  .map((item) => [item.noteId, item.badges]));
/** The ids of a list the page's note list made, as this realm's array */
const ids = (list) => plain(list.map((record) => record.id));

async function confirmIn(env, title) {
  const overlay = await waitFor(() => env.document.querySelectorAll('.confirm-dialog-overlay')
    .find((o) => o.getAttribute('aria-label') === title) || null, { message: `dialog ${title}` });
  overlay.querySelector('.confirm-dialog-confirm').click();
}

describe('one note list per new tab', () => {
  it('feeds the sidebar, the palette, App, and analytics the same lists', async () => {
    const { env, noteList, sidebar, palette, analytics, app } = await openPage();
    const active = noteList.view('active');
    assert.deepEqual(ids(active), ['A', 'B', 'C', 'D']);
    for (const reader of [sidebar, analytics, app]) {
      assert.equal(reader.notes, active, `${reader.constructor.name}: the same frozen list, not a copy`);
      assert.equal(reader.folders, noteList.folders());
    }
    assert.equal(sidebar.archivedNotes, app.archivedNotes);
    assert.equal(sidebar.trashedNotes, app.trashedNotes);
    assert.equal(sidebar.templates, app.templates);
    assert.equal(app.searchIndexByNoteId.get('A'), noteList.searchEntry('A'));
    assert.deepEqual(plain(palette.getCommandPaletteNotes().map((n) => [n.id, n.badges])), [
      ['A', []], ['B', []], ['C', []], ['D', []], ['R', ['Archived']],
    ]);
    const stats = await env.get('Analytics').getGlobalStats();
    assert.deepEqual(plain(stats), { totalNotes: 4, archivedNotes: 1, trashedNotes: 1, totalWords: 9 });

    await sidebar.renderNotesList();
    sidebar.updateBadgeCounts();
    // Beta in its folder, then the root notes, newest first
    assert.deepEqual(listed(env), ['Beta', 'Alpha', 'Gamma', 'Delta']);
    assert.deepEqual([count(env, 'notes-count'), count(env, 'archive-count'), count(env, 'trash-count')], [4, 1, 1]);
  });

  it("a commit reaches every reader with one getNotesByIds read and no refresh: a derived title shows in the sidebar", async () => {
    const { env, noteList, sidebar, palette, app, queries } = await openPage();
    palette.toggleCommandPalette(true);
    await settle();
    assert.equal(palette.isCommandPaletteOpen(), true);
    await settle();
    await sidebar.renderNotesList();
    const before = listed(env);
    // The editor's first-content auto-title saves the note with the title it generated
    const outcome = await env.documentClient.saveContent({
      noteId: 'C', blocks: [{ id: 'c1', type: 'text', content: 'shopping list', order: 0 }],
      name: 'Shopping', titleOrigin: 'generated',
    });
    assert.equal(outcome.kind, 'committed', JSON.stringify(outcome));
    await noteList.settled();
    assert.deepEqual(queries, [{ type: 'getNotesByIds', noteIds: ['C'] }], 'one read of what the commit changed, no full read');
    assert.notDeepEqual(listed(env), before);
    assert.ok(listed(env).includes('Shopping'), 'the sidebar shows the title without a refresh');
    assert.equal(app.notes[0].id, 'C', 'the saved note is newest');
    assert.equal(app.notes[0].name, 'Shopping');
    assert.ok(paletteNotes(palette).some(([id]) => id === 'C'));
    assert.equal(palette.commandPaletteItems.find((item) => item.noteId === 'C').title, 'Shopping',
      'the open palette shows it');
  });

  it('a derived or renamed title committed with no save reaches the sidebar from the commit feed, re-sorted, with no reload', async () => {
    const { env, noteList, sidebar, app, queries } = await openPage();
    sidebar.sidebarSortMode = 'updated';
    await sidebar.renderNotesList();
    assert.deepEqual(listed(env), ['Beta', 'Alpha', 'Gamma', 'Delta']);
    const execute = async (command) => {
      const outcome = await env.kernel.execute({ ...command, commandId: env.kernel.ids.next() });
      assert.equal(outcome.kind, 'committed', JSON.stringify(outcome));
      await noteList.settled();
    };
    // Auto-title or Generate title for Delta, which isn't open: the job's applyDerivedTitle alone
    await execute({ type: 'applyDerivedTitle', noteId: 'D', name: 'Groceries' });
    assert.deepEqual(listed(env), ['Beta', 'Groceries', 'Alpha', 'Gamma'], 'the new title, newest first');
    assert.equal(app.notes[0].name, 'Groceries');
    // AI chat's confirmed title for Gamma
    await execute({ type: 'renameNote', noteId: 'C', name: 'Trip plan' });
    assert.deepEqual(listed(env), ['Beta', 'Trip plan', 'Groceries', 'Alpha']);
    assert.deepEqual(queries, [
      { type: 'getNotesByIds', noteIds: ['D'] },
      { type: 'getNotesByIds', noteIds: ['C'] },
    ], 'one read per commit, and no reload');
  });

  it('with a search typed in the sidebar, every refresh and read still finishes, and later commits still show', async () => {
    const { env, Storage, noteList, sidebar, analytics, app } = await openPage();
    // A search engine over the entries the sidebar hands it, as js/search.js's Fuse index is
    sidebar.searchEngine = {
      entries: [],
      updateIndex(entries) { this.entries = entries; },
      async search(query) {
        return this.entries.filter((entry) => String(entry.name).toLowerCase().includes(query.toLowerCase()))
          .map((entry) => ({ id: entry.noteId, score: 1 }));
      },
    };
    sidebar.searchQuery = 'a';
    await sidebar.renderNotesList();
    const within = (what, promise) => Promise.race([
      Promise.resolve(promise).then(() => `${what} finished`),
      new Promise((resolve) => setTimeout(() => resolve(`${what} hung`), 3000)),
    ]);
    // Archive, as NotesManager.archiveNote does it: the legacy write, then App's refresh
    await Storage.archiveNote('A');
    assert.equal(await within('archive', app.refreshNotesList()), 'archive finished');
    // Another tab's change, which reaches this one as a lists-only refresh
    await Storage.trashNote('C');
    assert.equal(await within('cross-tab', app.refreshNotesList({ listsOnly: true })), 'cross-tab finished');
    // Stats
    env.document.stub(['stat-total-notes', 'stat-total-words', 'stat-daily-notes', 'stat-active-tags']);
    env.global.Chart = class { destroy() {} };
    assert.equal(await within('stats', analytics.renderAnalytics()), 'stats finished');
    // A wiki link to a note that doesn't exist yet, which creates it
    const opened = [];
    app.openNoteById = async (noteId) => { opened.push(noteId); };
    const created = app.openNoteByName('Fresh page');
    await confirmIn(env, 'Create Note');
    assert.equal(await within('openNoteByName', created), 'openNoteByName finished');
    assert.equal(opened.length, 1);
    // The indexer's read of every entry, asked for while a commit's read is pending
    const pin = env.kernel.execute({ type: 'setPinned', commandId: env.kernel.ids.next(), noteId: 'D', pinned: true });
    await pin;
    assert.equal(await within('indexer', noteList.searchEntriesChanged('all')), 'indexer finished');
    assert.equal(await within('settled', noteList.settled()), 'settled finished');
    // And a save after all that still reaches the sidebar
    const saved = await env.documentClient.saveContent({
      noteId: 'D', blocks: [{ id: 'd1', type: 'text', content: 'later', order: 0 }], name: 'Delta saved', titleOrigin: 'typed',
    });
    assert.equal(saved.kind, 'committed');
    await within('save', noteList.settled());
    assert.ok(listed(env).includes('Delta saved'), JSON.stringify(listed(env)));
    assert.deepEqual(noteList.state().kind, 'ready');
    assert.deepEqual(ids(app.archivedNotes).sort(), ['A', 'R']);
  });

  it('opening Stats leaves the sidebar alone, and only its own refresh starts the virtual scroller over', async () => {
    const { env, Storage, noteList, sidebar, analytics, app } = await openPage();
    // An Archive view long enough for the virtual scroller
    for (let i = 0; i < 55; i++) await Storage.archiveNote((await Storage.createNote(`Archived ${i}`)).id);
    sidebar.sidebarView = 'archive';
    await sidebar.refreshNotesList();
    const scroller = sidebar.virtualScroller;
    assert.ok(scroller, 'the Archive view scrolls virtually');
    let renders = 0;
    const render = sidebar.renderNotesList.bind(sidebar);
    sidebar.renderNotesList = async () => { renders += 1; return render(); };
    env.document.stub(['stat-total-notes', 'stat-total-words', 'stat-daily-notes', 'stat-active-tags']);
    env.global.Chart = class { destroy() {} };
    await analytics.renderAnalytics();
    assert.equal(renders, 0, 'opening Stats renders no sidebar');
    assert.equal(sidebar.virtualScroller, scroller);
    // App's refresh renders, as it always did, and keeps the scroller
    await app.refreshNotesList();
    assert.equal(renders, 1);
    assert.equal(sidebar.virtualScroller, scroller);
    // A commit renders, and keeps it too
    await env.kernel.execute({ type: 'unarchiveNote', commandId: env.kernel.ids.next(), noteId: 'R' });
    await noteList.settled();
    assert.equal(renders, 2);
    assert.equal(sidebar.virtualScroller, scroller);
    // The sidebar's own refresh starts it over, as it always did
    await sidebar.refreshNotesList();
    assert.equal(renders, 3);
    assert.ok(sidebar.virtualScroller && sidebar.virtualScroller !== scroller);
    assert.equal(noteList.state().kind, 'ready');
  });

  it('the open palette keeps the selected note selected when a commit moves it', async () => {
    const { env, noteList, palette } = await openPage();
    palette.toggleCommandPalette(true);
    await settle();
    const at = (noteId) => palette.commandPaletteItems.findIndex((item) => item.noteId === noteId);
    palette.commandPaletteIndex = at('D');
    // A save of Gamma makes it newest, so it moves up past Delta
    const saved = await env.documentClient.saveContent({
      noteId: 'C', blocks: [{ id: 'c1', type: 'text', content: 'moved', order: 0 }],
    });
    assert.equal(saved.kind, 'committed');
    await noteList.settled();
    assert.equal(palette.commandPaletteItems[palette.commandPaletteIndex].noteId, 'D', 'still Delta');
    // Trashed from elsewhere: it's gone, so the nearest one is selected
    const index = palette.commandPaletteIndex;
    await env.kernel.execute({ type: 'trashNote', commandId: env.kernel.ids.next(), noteId: 'D' });
    await noteList.settled();
    assert.equal(at('D'), -1);
    assert.equal(palette.commandPaletteIndex, Math.min(index, palette.commandPaletteItems.length - 1));
  });

  it('a bulk archive, then the palette, shows the notes archived; a bulk trash, and they are gone, with App and the counts agreeing', async () => {
    const { env, Storage, noteList, sidebar, palette, app, queries } = await openPage();
    sidebar.selectionMode = true;
    sidebar.selectedNoteIds = new Set(['A', 'C']);
    const archived = sidebar.performBulkAction('archive');
    await confirmIn(env, 'Confirm');
    await archived;
    // One kernel command per note, which the list reads back by id, with no reload
    assert.deepEqual(queries.map((query) => query.type), ['getNotesByIds', 'getNotesByIds']);
    assert.deepEqual(queries.flatMap((query) => query.noteIds).sort(), ['A', 'C']);

    palette.toggleCommandPalette(true);
    assert.deepEqual(
      paletteNotes(palette).filter(([, badges]) => badges.includes('Archived')).map(([id]) => id).sort(),
      ['A', 'C', 'R'],
    );
    assert.deepEqual(ids(app.notes), ['B', 'D']);
    assert.deepEqual(ids(app.archivedNotes).sort(), ['A', 'C', 'R']);
    palette.toggleCommandPalette(false);

    sidebar.selectionMode = true;
    sidebar.selectedNoteIds = new Set(['A', 'B']);
    const trashed = sidebar.performBulkAction('trash');
    await confirmIn(env, 'Confirm');
    await trashed;
    palette.toggleCommandPalette(true);
    const shown = paletteNotes(palette).map(([id]) => id);
    assert.ok(!shown.includes('A') && !shown.includes('B'), 'trashed notes leave the palette');
    assert.deepEqual(shown.sort(), ['C', 'D', 'R']);
    assert.deepEqual(ids(app.notes), ['D']);
    assert.deepEqual(ids(app.trashedNotes).sort(), ['A', 'B', 'T']);
    assert.deepEqual(
      [count(env, 'notes-count'), count(env, 'archive-count'), count(env, 'trash-count')],
      [app.notes.length, app.archivedNotes.length, app.trashedNotes.length],
    );
    assert.deepEqual(ids(app.notes), ids(await Storage.getAllNotes()));
  });

  it('opening the stats reads the lists again, so they count a note another tab made', async () => {
    const { env, Storage, noteList, analytics, queries } = await openPage();
    // Another tab's note, which this tab's lists haven't heard of
    await Storage.createNote('From another tab');
    assert.equal(noteList.view('active').length, 4);
    const stats = [];
    env.document.stub(['stat-total-notes', 'stat-total-words', 'stat-daily-notes', 'stat-active-tags']);
    env.global.Chart = class { constructor() {} destroy() {} };
    const { getGlobalStats } = env.get('Analytics');
    env.get('Analytics').getGlobalStats = async function () {
      const result = await getGlobalStats.call(this);
      stats.push(plain(result));
      return result;
    };
    await analytics.renderAnalytics().catch(() => {});
    assert.equal(queries[0].type, 'getNoteList');
    assert.equal(stats[0].totalNotes, 5);
  });

  it('no reader changes a record the list hands out', async () => {
    const { env, noteList, sidebar, palette, analytics, app } = await openPage();
    const records = [...noteList.view('withArchived'), ...noteList.view('trashed'), ...noteList.folders()];
    const before = JSON.stringify(plain(records));
    assert.ok(records.every((record) => Object.isFrozen(record)));
    // Everything that reads them: renders in each view, the palette, analytics, a folder's
    // collapse toggle, rename, and move, and a bulk action
    for (const view of ['notes', 'archive', 'trash', 'templates']) {
      sidebar.sidebarView = view;
      await sidebar.renderNotesList();
      sidebar.renderCalendar();
      sidebar.updateBadgeCounts();
    }
    sidebar.sidebarView = 'notes';
    sidebar.searchQuery = '';
    await sidebar.renderNotesList();
    palette.toggleCommandPalette(true);
    palette.toggleCommandPalette(false);
    await env.get('Analytics').getActivityData(30);
    await env.get('Analytics').getTagDistribution();
    await env.get('Analytics').getContentTypeBreakdown();
    app.updateBadgeCounts();
    const folder = env.document.getElementById('sidebar-notes-list').querySelector('.sidebar-folder');
    folder.querySelector('.sidebar-folder-header').click();
    // The toggle writes the one field, and the lists read the folders again
    await waitFor(() => noteList.folders()[0].collapsed === true, { message: 'the folder to read back collapsed' });
    await noteList.settled();
    assert.equal(records.find((record) => record.id === 'F').collapsed, false, 'the folder it listed is as it was');
    assert.equal(JSON.stringify(plain(records)), before);
    assert.ok(analytics.notes.every((record) => Object.isFrozen(record)));
  });
});
