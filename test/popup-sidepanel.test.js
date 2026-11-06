'use strict';

// What Popup and Side Panel show from what they read, pinned on 1.4.x's own reads before #12
// slice 4 moves them to their kernels, which return what they read today (#12, "Ordered
// slices" item 4). Popup lists the notes with no archivedAt or trashedAt, templates included,
// and reads insightsEnabled from IndexedDB's settings store, which Storage.setSetting never
// writes (#4 fixes that). Side Panel reads every note the updatedAt index lists, and
// InsightsSummary leaves out the ones archived or trashed by date. Since #17 PR 3a both read a
// note without an updatedAt too, last (KD-011), which 1.4.x's index left out, and Popup also
// leaves out a note archived or trashed by flag alone, which 1.4.x listed (review R88).

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  createLegacyEnv, createDatabase, dumpDatabase, recordsOf, releaseStorage, waitFor, note,
} = require('./helpers/legacy-env');
const { loadBackground } = require('./helpers/load-background');
const { loadPageModule } = require('./helpers/page-module');
const { connectPage } = require('./helpers/runtime-ports');

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
 * A Popup on `records`, started as popup.html starts it. On `worker`'s profile, it shares the
 * worker's IndexedDB, chrome.* and Web Locks, as an extension's page does.
 * @param {Object} [records] - rows per store, or null for a profile with no database
 * @param {(env: any) => void} [prepare] - runs on the environment before Popup starts
 * @param {{worker?: any}} [options] - a worker test/helpers/load-background.js started
 */
async function popup(records = { canvases: notes() }, prepare = () => {}, { worker = null } = {}) {
  // On the worker's profile, one lock manager, the worker's, as Chrome shares navigator.locks
  // between an extension's pages and its worker, so the worker sees the page's owner lock
  const env = worker
    ? createLegacyEnv({ indexedDB: worker.indexedDB, chrome: worker.env.chrome, locks: worker.env.global.navigator.locks })
    : createLegacyEnv();
  if (records && !worker) await createDatabase(env.indexedDB, { records });
  prepare(env);
  const els = env.document.stub([
    { id: 'open-tab', tag: 'button' }, { id: 'quick-note-input', tag: 'input' },
    'main-content', 'daily-summary', 'summary-content', 'page-list',
  ]);
  // Popup loads its chunks through import(), as Chrome loads them
  await loadPageModule(env, 'js/popup.js', { dynamicImports: true });
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
 * A Popup on `records`, on a profile js/background.js started on first, as a browser start wakes
 * it, whose port reaches the port listener the worker's router installs
 * (test/helpers/runtime-ports.js)
 * @param {Object} [records] - rows per store, or null for a profile with no database
 */
async function popupOnWorker(records = { canvases: notes() }) {
  const worker = await loadBackground({
    setup: async (env) => {
      if (records) await createDatabase(env.indexedDB, { records });
    },
  });
  connectPage(worker.env.chrome, 'popup.html');
  return { worker, ...(await popup(null, () => {}, { worker })) };
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
  it('lists the five latest notes not archived or trashed, by flag or by date, templates included', async () => {
    const { recent } = await popup();
    // 1.4.x listed a note archived or trashed by flag alone, which review R88 fixed (#17 PR 3a)
    assert.deepEqual(recent(), ['Newest', 'Template', 'Older', 'Oldest', 'No time']);
  });

  it("leaves out a trashed or archived note 1.4.x's index never listed, one with no time in either state (#17 PR 3a, review R88)", async () => {
    const { recent } = await popup({
      canvases: [
        note('active', { name: 'Active', updatedAt: AT }),
        note('trashed-unlisted', { name: 'Trashed, never listed', updatedAt: undefined, trashed: true }),
        note('archived-unlisted', { name: 'Archived, never listed', updatedAt: undefined, archived: true }),
      ],
    });
    assert.deepEqual(recent(), ['Active']);
  });

  it("shows the day's summary only when IndexedDB's settings store says insightsEnabled", async () => {
    const enabled = await popup({ canvases: notes(), settings: [{ key: 'insightsEnabled', value: true }] });
    assert.deepEqual(enabled.summary(), ['[Newest] todo newest', '[Template] todo template', '[No time] todo no-time']);

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
  // allows, and since #17 PR 2a the three versions #17's adapter keeps on every note it writes.
  // On a profile the worker started on, whose run made the database this build's.
  it("saves the record and search entry 1.4.x's Storage.createNote saves, and lists the note first", async () => {
    const { env, els, recent } = await popupOnWorker({ canvases: notes() });
    const input = els['quick-note-input'];
    input.value = '  Call the plumber  ';
    input.dispatchEvent({ type: 'keydown', key: 'Enter' });
    await waitFor(() => recent()[0] === 'Call the plumber', { withinMs: 5000, message: 'the quick note listed first' });
    assert.equal(input.value, '');

    // 1.4.x's own createNote, on the same profile: the frozen 1.4.1 release's, as the new tab's
    // Storage.createNote was until #17 PR 4b
    const release = await releaseStorage(env);
    const { id: referenceId } = await release.createNote('Reference');
    release.db.close();

    const dump = await dumpDatabase(env.indexedDB);
    const saved = Object.values(recordsOf(dump, 'canvases')).find((record) => record.name === 'Call the plumber');
    const reference = recordsOf(dump, 'canvases')[referenceId];
    const fields = ({ id, name, createdAt, updatedAt, ...rest }) => rest;
    const { revision, placementVersion, sourceRevision, placement, kind, lifecycle, ...own } = saved;
    assert.deepEqual(fields(own), fields(reference));
    assert.deepEqual([revision, placementVersion, sourceRevision], [1, 0, 0]);
    // The worker's run is in, so the database is this build's, which keeps #17 PR 3a's group
    // beside the flags: a note, at the root, active
    assert.deepEqual([placement, kind, lifecycle], [{ kind: 'collection', folderId: null }, 'note', 'active']);
    assert.equal(typeof saved.createdAt, 'number');
    assert.equal(saved.updatedAt, saved.createdAt);
    assert.deepEqual(recordsOf(dump, 'search_index')[saved.id], {
      content: '', name: 'Call the plumber', noteId: saved.id, updatedAt: saved.updatedAt,
    });
  });

  // #35 slice 3b: a quick note the kernel couldn't take now may be kept in the journal, under its
  // ids, for the drain. Another Enter of the same text sends it again under those ids, so it's
  // made once, whichever lands. New text is another note, under new ids.
  it('an Enter after an answer that may land later sends the same note under the same ids, and new text, or the same text once it landed, gets new ones (#35 slice 3b)', async () => {
    const { els, recent } = await popupOnWorker({ canvases: notes() });
    const { IDBObjectStore } = require('fake-indexeddb');
    const original = IDBObjectStore.prototype.put;
    /** @type {string[]} the id of each note record a quick note put, in order, as often as it's put */
    const puts = [];
    let failing = 2;
    // The worker shares the profile, and once its run is in it fills the profile's own notes'
    // new fields in batches (transforms.js), so only the quick notes' records count
    const quick = new Set(['Call the plumber', 'Water the plants']);
    /** @type {string[]} the name of each quick note record the full disk failed */
    const failed = [];
    IDBObjectStore.prototype.put = function put(value, key) {
      if (this.name !== 'canvases' || !value || !quick.has(value.name)) return original.call(this, value, key);
      puts.push(value.id);
      // The first two fail as a full disk does, so the kernel answers that they aren't in
      if (failing > 0) {
        failing -= 1;
        failed.push(value.name);
        throw new DOMException('The quota has been exceeded.', 'QuotaExceededError');
      }
      return original.call(this, value, key);
    };
    try {
      const input = els['quick-note-input'];
      /** Presses Enter, and waits until it's answered: `count` note records put, and the input back */
      const enter = async (/** @type {number} */ count, /** @type {string} */ message) => {
        input.dispatchEvent({ type: 'keydown', key: 'Enter' });
        await waitFor(() => puts.length >= count && !input.disabled, { withinMs: 5000, message });
      };
      input.value = 'Call the plumber';
      await enter(1, 'the first went, and failed');
      assert.equal(input.value, 'Call the plumber', 'kept for another Enter');
      // Other text is another note, under new ids
      input.value = 'Water the plants';
      await enter(2, 'the second went, and failed');
      assert.notEqual(puts[1], puts[0], 'new text, new ids');
      assert.deepEqual(failed, ['Call the plumber', 'Water the plants'], 'the full disk failed each quick note once');
      // The same text again: the same note, under the same ids
      await enter(3, 'the third went');
      await waitFor(() => recent()[0] === 'Water the plants', { withinMs: 5000, message: 'the third landed' });
      assert.deepEqual([...new Set(puts.slice(1))], [puts[1]], 'the same note, under the same ids');
      // Once it's in, the same text again is another note, under new ids
      const landed = puts.length;
      input.value = 'Water the plants';
      await enter(landed + 1, 'the fourth went');
      assert.notEqual(puts[landed], puts[1], 'a new note, under new ids');
    } finally {
      IDBObjectStore.prototype.put = original;
    }
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
