'use strict';

// #12 slice 7c: removeNotes and App's empty state (js/app.js, followEmptyState and
// holdEmptyState). Trashing the only note while its pane shows it commits before the pane gets
// a new Untitled note (TabController.leaveNotes waits), so App holds the empty state while the
// panes move and follows the list once after. With no archived note either, the empty state
// never shows, as on `next` and 1.4.1. From R97's probe of #104.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { createLegacyEnv, createDatabase, note, block, bootNewTab, waitFor } = require('./helpers/legacy-env');

const FILES = [
  'js/utils.js', 'js/core/storage-error.js', 'js/ui/confirm-dialog.js', 'js/storage.js', 'js/sidebar-utils.js',
  'js/blocks.js', 'js/editor.js', 'js/controllers/tab-controller.js', 'js/controllers/notes-manager.js',
  'js/controllers/sidebar-controller.js', 'js/controllers/settings-controller.js', 'js/app.js',
];

/**
 * A new tab with one active note, Alpha, one in trash, and one template, with `open` in the
 * pane. App holds what its root gives it, and removeNotes leaves and announces through App, as
 * js/kernel/composition/newtab.js builds it. `shown` records, after each of App's empty-state
 * updates, whether the empty state shows.
 * @param {string} open - the note the pane shows
 */
async function pageOn(open) {
  const env = createLegacyEnv();
  await createDatabase(env.indexedDB, {
    records: {
      canvases: [
        note('A', { name: 'Alpha', updatedAt: 1700000000900 }),
        note('TR', { name: 'In trash', trashed: true, trashedAt: 6 }),
        note('T', { name: 'Recipe', isTemplate: true, updatedAt: 1700000000100 }),
      ],
      elements: [block('a1', 'A', 0, 'Alpha body'), block('tr1', 'TR', 0, 'trashed body'), block('t1', 'T', 0, 'Recipe body')],
    },
  });
  const { tabs, page, wire } = await bootNewTab(env, { files: FILES });
  await tabs.openNoteInNewTab(open);
  env.get('Utils').showToast = () => {};
  const els = env.document.stub(['empty-state', 'sidebar-tab-notes', 'sidebar-notes-list']);
  els['empty-state'].className = 'empty-state hidden';

  const App = env.get('App');
  const app = Object.assign(Object.create(App.prototype), { noteList: page.noteList, tabController: tabs });
  const removal = env.removalFor({ leave: (ids) => app.leaveNotes(ids), announce: (ids) => app.notesLeft(ids) });
  const shown = [];
  const update = App.prototype.updateEmptyState;
  app.updateEmptyState = function recordedUpdate() {
    update.call(this);
    shown.push(!els['empty-state'].classList.contains('hidden'));
  };
  app.followEmptyState();

  const notes = Object.assign(wire(new (env.get('NotesManager'))({
    storage: env.get('Storage'), domRefs: null, logger: null, llm: null, documentClient: env.documentClient, settings: env.settingsClient,
  })), { removal });
  const sidebar = Object.assign(wire(new (env.get('SidebarController'))({
    settings: env.settingsClient, storageState: env.storageState, domRefs: null, logger: null,
  })), { removal });
  sidebar.getEditor = () => tabs.getEditor();
  return { env, tabs, noteList: page.noteList, notes, sidebar, shown, els };
}

async function confirmIn(env, title) {
  const overlay = await waitFor(() => env.document.querySelectorAll('.confirm-dialog-overlay')
    .find((o) => o.getAttribute('aria-label') === title) || null, { message: `dialog ${title}` });
  overlay.querySelector('.confirm-dialog-confirm').click();
}

/** The pane got a new note, and every list has every commit */
async function paneMoved({ tabs, noteList }) {
  await waitFor(() => noteList.view('active').length === 1, { message: 'a new note for the pane' });
  await noteList.settled();
  const [made] = noteList.view('active');
  assert.notEqual(made.id, 'A');
  assert.equal(tabs.getEditor().noteId, made.id, 'the pane shows the new note');
}

describe("App's empty state while notes leave", () => {
  it('trashing the only note while its pane shows it never shows the empty state', async () => {
    const page = await pageOn('A');
    await page.notes.trashNoteById('A');
    await paneMoved(page);
    assert.equal(page.shown.includes(true), false, `updates: ${JSON.stringify(page.shown)}`);
    assert.ok(page.shown.length > 0, 'it followed the list once the pane moved');
    assert.equal(page.els['empty-state'].classList.contains('hidden'), true);
  });

  it('a bulk trash of the only note while its pane shows it never shows the empty state', async () => {
    const page = await pageOn('A');
    page.sidebar.selectionMode = true;
    page.sidebar.selectedNoteIds = new Set(['A']);
    const ran = page.sidebar.performBulkAction('trash');
    await confirmIn(page.env, 'Confirm');
    await ran;
    await paneMoved(page);
    assert.equal(page.shown.includes(true), false, `updates: ${JSON.stringify(page.shown)}`);
    assert.ok(page.shown.length > 0, 'it followed the list once the pane moved');
    assert.equal(page.els['empty-state'].classList.contains('hidden'), true);
  });

  it('with the pane on a template, trashing the last note shows the empty state once the panes have moved', async () => {
    const page = await pageOn('T');
    await page.notes.trashNoteById('A');
    await page.noteList.settled();
    assert.equal(page.noteList.view('active').length, 0);
    assert.equal(page.shown.at(-1), true, `updates: ${JSON.stringify(page.shown)}`);
    assert.equal(page.els['empty-state'].classList.contains('hidden'), false);
  });
});
