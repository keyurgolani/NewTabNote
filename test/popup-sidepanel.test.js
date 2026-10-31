'use strict';

// What Popup and Side Panel show from what they read, pinned on 1.4.x's own reads before #12
// slice 4 moves them to their kernels, which return what they read today (#12, "Ordered
// slices" item 4). Popup lists the notes with no archivedAt or trashedAt, templates included,
// and reads insightsEnabled from IndexedDB's settings store, which Storage.setSetting never
// writes (#4 fixes that). Side Panel reads every note the updatedAt index lists, and
// InsightsSummary leaves out the ones archived or trashed by date. Since #17 PR 3a both read a
// note without an updatedAt too, last (KD-011), which 1.4.x's index left out.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  createLegacyEnv, createDatabase, dumpDatabase, recordsOf, waitFor, note,
} = require('./helpers/legacy-env');
const { loadPageModule } = require('./helpers/page-module');

const AT = 1700000000000;

/**
 * Notes the new tab's lists treat differently from Popup's and Side Panel's reads, each with
 * a todo named after it, so a summary shows which notes it read
 */
function notes() {
  const todo = (/** @type {string} */ id) => ({ todos: [`todo ${id}`], reminders: [], deadlines: [], highlights: [] });
  return [
    note('newest', { name: 'Newest', updatedAt: AT + 9, insights: todo('newest') }),
    note('template', { name: 'Template', updatedAt: AT + 8, isTemplate: true, insights: todo('template') }),
    note('archived', { name: 'Archived', updatedAt: AT + 7, archived: true, archivedAt: AT + 7, insights: todo('archived') }),
    note('trash-flag', { name: 'Trashed without a date', updatedAt: AT + 6, trashed: true, trashedAt: null, insights: todo('trash-flag') }),
    note('archive-flag', { name: 'Archived without a date', updatedAt: AT + 5, archived: true, archivedAt: null }),
    note('trashed', { name: 'Trashed', updatedAt: AT + 4, trashed: true, trashedAt: AT + 4, insights: todo('trashed') }),
    note('older', { name: 'Older', updatedAt: AT + 3 }),
    note('oldest', { name: 'Oldest', updatedAt: AT + 2 }),
    note('no-time', { name: 'No time', updatedAt: undefined, insights: todo('no-time') }),
  ];
}

/**
 * A Popup on `records`, started as popup.html starts it
 * @param {Object} [records] - rows per store, or null for a profile with no database
 * @param {(env: any) => void} [prepare] - runs on the environment before Popup starts
 */
async function popup(records = { canvases: notes() }, prepare = () => {}) {
  const env = createLegacyEnv();
  if (records) await createDatabase(env.indexedDB, { records });
  prepare(env);
  const els = env.document.stub([
    { id: 'open-tab', tag: 'button' }, { id: 'quick-note-input', tag: 'input' },
    'main-content', 'daily-summary', 'summary-content', 'page-list',
  ]);
  await loadPageModule(env, 'js/popup.js');
  await Promise.all(env.document.fire('DOMContentLoaded'));
  /** The recent list as it reads: each note's name, or the list's message */
  const recent = () => {
    const items = els['page-list'].querySelectorAll('.page-item');
    return items.length > 0 ? items.map((item) => item.querySelector('.name').textContent) : els['page-list'].textContent;
  };
  /** The summary's items, or null when Popup shows none */
  const summary = () => (els['main-content'].classList.contains('no-summary')
    ? null
    : els['summary-content'].querySelectorAll('li').map((item) => item.textContent));
  return { env, els, recent, summary };
}

/**
 * A Side Panel on `records`, started as sidepanel.html starts it
 * @param {Object} [records] - rows per store, or null for a profile with no database
 */
async function sidePanel(records = { canvases: notes() }) {
  const env = createLegacyEnv();
  if (records) await createDatabase(env.indexedDB, { records });
  const els = env.document.stub(['open-notes', 'status', 'status-count', 'sections', 'empty-state']);
  const openButton = env.document.createElement('button');
  openButton.setAttribute('data-open-notes', '');
  env.document.body.appendChild(openButton);
  env.load('js/insights-summary.js');
  await loadPageModule(env, 'js/sidepanel.js');
  await Promise.all(env.document.fire('DOMContentLoaded'));
  /** Each section the panel shows, with its items' texts */
  const sections = () => els.sections.querySelectorAll('.section').map((section) => [
    section.querySelector('.section-header').textContent,
    section.querySelectorAll('.item-text').map((item) => item.textContent),
  ]);
  return { env, els, sections };
}

describe('what Popup shows', () => {
  it('lists the five latest notes with no archivedAt or trashedAt, templates included', async () => {
    const { recent } = await popup();
    assert.deepEqual(recent(), ['Newest', 'Template', 'Trashed without a date', 'Archived without a date', 'Older']);
  });

  it("shows the day's summary only when IndexedDB's settings store says insightsEnabled", async () => {
    const enabled = await popup({ canvases: notes(), settings: [{ key: 'insightsEnabled', value: true }] });
    assert.deepEqual(enabled.summary(), [
      '[Newest] todo newest', '[Template] todo template', '[Trashed without a date] todo trash-flag', '[No time] todo no-time',
    ]);

    const off = await popup({ canvases: notes(), settings: [{ key: 'insightsEnabled', value: false }] });
    assert.equal(off.summary(), null);

    // The setting the new tab writes lives in chrome.storage.local, which Popup doesn't read
    const unread = await popup({ canvases: notes() }, (env) => {
      env.chrome.api.storage.local.set({ setting_insightsEnabled: true });
    });
    assert.equal(unread.summary(), null);
  });

  it('says there are no notes yet, on a profile with no notes and one with no database', async () => {
    assert.equal((await popup({ canvases: [] })).recent(), 'No notes yet');
    assert.equal((await popup(null)).recent(), 'No notes yet');
  });
});

describe("Popup's quick note", () => {
  // #12: Popup's notes take createNote's record and search entry, the one record-shape change it
  // allows, and since #17 PR 2a the three versions #17's adapter keeps on every note it writes
  it("saves the record and search entry the new tab's Storage.createNote saves, and lists the note first", async () => {
    const { env, els, recent } = await popup({ canvases: notes() });
    const input = els['quick-note-input'];
    input.value = '  Call the plumber  ';
    input.dispatchEvent({ type: 'keydown', key: 'Enter' });
    await waitFor(() => recent()[0] === 'Call the plumber', { message: 'the quick note listed first' });
    assert.equal(input.value, '');

    // The new tab's own createNote, on the same profile
    const page = createLegacyEnv({ indexedDB: env.indexedDB, chrome: env.chrome });
    page.load('js/utils.js', 'js/storage.js');
    const Storage = page.get('Storage');
    await Storage.open();
    const { id: referenceId } = await Storage.createNote('Reference');
    Storage.db.close();

    const dump = await dumpDatabase(env.indexedDB);
    const saved = Object.values(recordsOf(dump, 'canvases')).find((record) => record.name === 'Call the plumber');
    const reference = recordsOf(dump, 'canvases')[referenceId];
    const fields = ({ id, name, createdAt, updatedAt, ...rest }) => rest;
    const { revision, placementVersion, sourceRevision, placement, kind, lifecycle, ...own } = saved;
    assert.deepEqual(fields(own), fields(reference));
    assert.deepEqual([revision, placementVersion, sourceRevision], [1, 0, 0]);
    // #17 PR 3a's group beside the flags: Unfiled, a note, active
    assert.deepEqual([placement, kind, lifecycle], [{ kind: 'collection', folderId: null }, 'note', 'active']);
    assert.equal(typeof saved.createdAt, 'number');
    assert.equal(saved.updatedAt, saved.createdAt);
    assert.deepEqual(recordsOf(dump, 'search_index')[saved.id], {
      content: '', name: 'Call the plumber', noteId: saved.id, updatedAt: saved.updatedAt,
    });
  });
});

describe('what Side Panel shows', () => {
  it('summarizes the insights of every note it reads, leaving out what was archived or trashed by date', async () => {
    const { sections, els } = await sidePanel();
    assert.deepEqual(sections(), [['Action Items', ['todo newest', 'todo template', 'todo trash-flag', 'todo no-time']]]);
    assert.equal(els['status-count'].textContent, '4');
  });

  it('shows its empty state on a profile with no notes and one with no database', async () => {
    for (const records of [{ canvases: [] }, null]) {
      const { sections, els } = await sidePanel(records);
      assert.deepEqual(sections(), []);
      assert.equal(els['empty-state'].classList.contains('hidden'), false);
    }
  });
});
