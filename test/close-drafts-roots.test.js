'use strict';

// 1.4.3 item 1 (#33): each root applies the close-time drafts at its start, before it reads a
// note: the new tab, Popup and the Side Panel. Only the new tab tells about recovered notes,
// its own and those a Popup or Side Panel start made before it, by their IDs, in 1.4.x's
// text-only toast, and it counts only notes that still exist.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  createLegacyEnv, createDatabase, dumpDatabase, recordsOf, createLocalStorage, note, block, FakeDocument,
} = require('./helpers/legacy-env');

const APP_FILES = [
  'js/utils.js', 'js/core/storage-error.js', 'js/core/event-bus.js', 'js/core/dom-refs.js', 'js/core/logger.js',
  'js/ui/export-notice.js', 'js/close-drafts.js', 'js/storage.js', 'js/search.js', 'js/app.js',
];
const T0 = 1700000000000;
/** The recovered notes no new tab has told about yet, by ID (CloseDrafts.UNTOLD_KEY) */
const UNTOLD = 'ntn-recovered-untold';

/** Note A, with blocks a1 and a2 */
async function profile(factory, a = {}) {
  await createDatabase(factory, {
    records: {
      canvases: [note('A', { name: 'Alpha plan', ...a })],
      elements: [block('a1', 'A', 0, 'alpha'), block('a2', 'A', 1, 'alpha two')],
    },
  });
}

/** A draft of note A's first block, written as a closing tab writes it */
function leaveDraft(env, { base = T0, content = 'alpha, from the closed tab' } = {}) {
  const CloseDrafts = env.get('CloseDrafts');
  CloseDrafts.write(env.global.localStorage, CloseDrafts.draftOf({
    noteId: 'A',
    base: { revision: null, updatedAt: base, issued: [] },
    blocks: [block('a1', 'A', 0, content)],
    deletedBlockIds: [],
    preview: content,
    todoProgress: null,
    linkedNames: [],
  }));
}

/** The new tab: App.init on the profile, with its toasts recorded */
async function startNewTab(shared) {
  const env = createLegacyEnv({ document: new FakeDocument(), indexedDB: shared.indexedDB, localStorage: shared.localStorage });
  env.document.stub(['app']);
  env.load(...APP_FILES);
  const toasts = [];
  env.get('Utils').showToast = (message, kind, duration) => toasts.push({ message, kind, duration });
  // Enough of the page for App.init to read the notes, which it does before it builds the editors
  env.global.Onboarding = { hasCompleted: async () => true };
  env.global.LLM = { init: async () => {} };
  const app = new (env.get('App'))();
  await app.init();
  return { env, app, toasts };
}

const draftCount = (storage) => Array.from({ length: storage.length }, (_, i) => storage.key(i)).filter((key) => key.startsWith('ntn-close-draft:')).length;

describe('the new tab applies the close-time drafts at its start', () => {
  it('before it reads a note: the notes it lists already have the edit', async () => {
    const shared = { indexedDB: undefined, localStorage: createLocalStorage() };
    const seed = createLegacyEnv({ localStorage: shared.localStorage });
    shared.indexedDB = seed.indexedDB;
    await profile(seed.indexedDB);
    seed.load('js/close-drafts.js');
    leaveDraft(seed);

    const { app } = await startNewTab(shared);
    const listed = app.notes.find((n) => n.id === 'A');
    assert.equal(listed.preview, 'alpha, from the closed tab', 'App read the notes after the draft was applied');
    const rows = recordsOf(await dumpDatabase(shared.indexedDB), 'elements');
    assert.equal(rows.a1.content, 'alpha, from the closed tab');
    assert.equal(draftCount(shared.localStorage), 0);
  });

  it("tells about the note it recovered, once, in the toast's words", async () => {
    const shared = { indexedDB: undefined, localStorage: createLocalStorage() };
    const seed = createLegacyEnv({ localStorage: shared.localStorage });
    shared.indexedDB = seed.indexedDB;
    await profile(seed.indexedDB, { updatedAt: T0 + 5 }); // saved elsewhere after the draft's base
    seed.load('js/close-drafts.js');
    leaveDraft(seed);

    const { app, toasts } = await startNewTab(shared);
    await app.tellRecoveredNotes();
    const told = toasts.filter((t) => t.message.startsWith('Kept your changes'));
    assert.deepEqual(told, [{ message: 'Kept your changes to “Alpha plan” from a closed tab in a recovered note.', kind: 'info', duration: 6000 }],
      "1.4.x's text-only toast, for 6 s, as import's summary shows");
    assert.equal(shared.localStorage.getItem(UNTOLD), null, 'told once: the list is cleared');
    await app.tellRecoveredNotes();
    assert.equal(toasts.filter((t) => t.message.startsWith('Kept your changes')).length, 1);
  });

  it('says both notes are in Archive when the original was archived', async () => {
    const shared = { indexedDB: undefined, localStorage: createLocalStorage() };
    const seed = createLegacyEnv({ localStorage: shared.localStorage });
    shared.indexedDB = seed.indexedDB;
    await profile(seed.indexedDB, { updatedAt: T0 + 5, archived: true, archivedAt: T0 + 3 });
    seed.load('js/close-drafts.js');
    leaveDraft(seed);

    const { app, toasts } = await startNewTab(shared);
    await app.tellRecoveredNotes();
    assert.deepEqual(toasts.filter((t) => t.message.startsWith('Kept your changes')).map((t) => t.message),
      ['Kept your changes to “Alpha plan” from a closed tab in a recovered note. Both are in Archive.']);
  });

  it('says both notes are in the Trash only while both are', async () => {
    const shared = { indexedDB: undefined, localStorage: createLocalStorage() };
    const seed = createLegacyEnv({ localStorage: shared.localStorage });
    shared.indexedDB = seed.indexedDB;
    await profile(seed.indexedDB, { updatedAt: T0 + 5, trashed: true, trashedAt: T0 + 3 });
    seed.load('js/close-drafts.js');
    leaveDraft(seed);

    const { app, env, toasts } = await startNewTab(shared);
    // The original comes back from the Trash before this new tab tells about its recovered note
    const Storage = env.get('Storage');
    const A = await Storage.getNote('A');
    const tx = Storage.db.transaction(['canvases'], 'readwrite');
    tx.objectStore('canvases').put({ ...A, trashed: false, trashedAt: null });
    await new Promise((resolve) => { tx.oncomplete = resolve; });
    await app.tellRecoveredNotes();
    assert.deepEqual(toasts.filter((t) => t.message.startsWith('Kept your changes')).map((t) => t.message),
      ['Kept your changes to “Alpha plan” from a closed tab in a recovered note.']);
  });

  it('tells nothing of a recovered note whose original is gone, rather than name it "Untitled"', async () => {
    const shared = { indexedDB: undefined, localStorage: createLocalStorage() };
    const seed = createLegacyEnv({ localStorage: shared.localStorage });
    shared.indexedDB = seed.indexedDB;
    await profile(seed.indexedDB, { updatedAt: T0 + 5 });
    seed.load('js/close-drafts.js');
    leaveDraft(seed);

    const { app, env, toasts } = await startNewTab(shared);
    const Storage = env.get('Storage');
    const tx = Storage.db.transaction(['canvases'], 'readwrite');
    tx.objectStore('canvases').delete('A');
    await new Promise((resolve) => { tx.oncomplete = resolve; });
    await app.tellRecoveredNotes();
    assert.deepEqual(toasts.filter((t) => t.message.startsWith('Kept your changes')), []);
  });

  it("has the toasts' live region on the page from the start, empty, so a screen reader reads the first toast", () => {
    const html = fs.readFileSync(path.join(__dirname, '..', 'newtab.html'), 'utf8');
    const region = html.indexOf('<div class="toast-container" aria-live="polite" role="status"></div>');
    assert.ok(region > 0, 'newtab.html has the empty region');
    assert.ok(region < html.indexOf('<script'), 'before the scripts, so it is there before any toast');
  });
});

describe('Popup and the Side Panel apply the close-time drafts at their start', () => {
  it("Popup recovers a note and shows nothing; the next new tab tells about it, counting only notes that still exist", async () => {
    const shared = { indexedDB: undefined, localStorage: createLocalStorage() };
    const seed = createLegacyEnv({ localStorage: shared.localStorage });
    shared.indexedDB = seed.indexedDB;
    await profile(seed.indexedDB, { updatedAt: T0 + 5 });
    seed.load('js/close-drafts.js');
    leaveDraft(seed);

    const popup = createLegacyEnv({ indexedDB: shared.indexedDB, localStorage: shared.localStorage });
    popup.document.stub([
      { id: 'open-tab', tag: 'button' }, { id: 'quick-note-input', tag: 'input' },
      'main-content', 'daily-summary', 'summary-content', 'page-list',
    ]);
    popup.load('js/close-drafts.js', 'js/popup.js');
    await Promise.all(popup.document.fire('DOMContentLoaded'));
    assert.equal(draftCount(shared.localStorage), 0, 'the Popup applied the draft');
    const untold = JSON.parse(shared.localStorage.getItem(UNTOLD));
    assert.equal(untold.length, 1);
    assert.deepEqual(Object.keys(untold[0]).sort(), ['id', 'of'], 'IDs only, never the text');

    // A second recovered note whose record is gone by the time a new tab starts
    shared.localStorage.setItem(UNTOLD, JSON.stringify([...untold, { id: 'no-such-note', of: 'A' }]));
    const { app, toasts } = await startNewTab(shared);
    await app.tellRecoveredNotes();
    assert.deepEqual(toasts.filter((t) => t.message.startsWith('Kept your changes')).map((t) => t.message),
      ['Kept your changes to “Alpha plan” from a closed tab in a recovered note.']);
  });

  it('the Side Panel applies a draft before its summary reads the notes', async () => {
    const shared = { indexedDB: undefined, localStorage: createLocalStorage() };
    const seed = createLegacyEnv({ localStorage: shared.localStorage });
    shared.indexedDB = seed.indexedDB;
    await profile(seed.indexedDB);
    seed.load('js/close-drafts.js');
    leaveDraft(seed);

    const panel = createLegacyEnv({ indexedDB: shared.indexedDB, localStorage: shared.localStorage });
    panel.document.stub(['open-notes', 'status', 'status-count', 'sections', 'empty-state']);
    const openButton = panel.document.createElement('button');
    openButton.setAttribute('data-open-notes', '');
    panel.document.body.appendChild(openButton);
    panel.load('js/close-drafts.js', 'js/insights-summary.js', 'js/sidepanel.js');
    await Promise.all(panel.document.fire('DOMContentLoaded'));
    assert.equal(draftCount(shared.localStorage), 0);
    assert.equal(recordsOf(await dumpDatabase(shared.indexedDB), 'elements').a1.content, 'alpha, from the closed tab');
  });

  it("a permanent delete takes the recovered note off the list the next new tab tells", async () => {
    const shared = { indexedDB: undefined, localStorage: createLocalStorage() };
    const seed = createLegacyEnv({ localStorage: shared.localStorage });
    shared.indexedDB = seed.indexedDB;
    await profile(seed.indexedDB, { updatedAt: T0 + 5 });
    seed.load('js/utils.js', 'js/core/storage-error.js', 'js/close-drafts.js', 'js/storage.js');
    leaveDraft(seed);
    const Storage = seed.get('Storage');
    await Storage.init();
    const result = await seed.get('CloseDrafts').apply({ db: Storage.db });
    await Storage.permanentlyDeleteNote(result.recovered[0].recoveredId);
    assert.equal(shared.localStorage.getItem(UNTOLD), null);
  });
});
