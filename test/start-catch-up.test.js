'use strict';

// 1.4.3 items 2 and 3 (#33): at each new tab's start, right after the close-time drafts, a note
// whose blocks a closing tab saved without its record gets the preview, to-do progress and
// links its blocks give, and a note deleted for good loses what it left: its blocks, media,
// vector and snapshots. The name and updatedAt stay as stored. Popup and the Side Panel pass
// the notes their own drafts named to the next new tab, by ID. A full pass at idle catches what
// no draft named, at the first 1.4.3 start and then weekly.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  createLegacyEnv, createDatabase, dumpDatabase, recordsOf, createLocalStorage, note, block, FakeDocument, DB_NAME, settle,
} = require('./helpers/legacy-env');

const APP_FILES = [
  'js/utils.js', 'js/core/storage-error.js', 'js/core/event-bus.js', 'js/core/dom-refs.js', 'js/core/logger.js',
  'js/ui/export-notice.js', 'js/sidebar-utils.js', 'js/close-drafts.js', 'js/start-catch-up.js', 'js/storage.js',
  'js/search.js', 'js/app.js',
];
const T0 = 1700000000000;
const DAY = 24 * 60 * 60 * 1000;
const CASE = { timeout: 20_000 };

/** A todo block */
const todo = (id, canvasId, order, content, checked) => block(id, canvasId, order, content, { type: 'todo', checked });

/** A shared profile: one localStorage and one IndexedDB that every page of the test opens */
function sharedProfile() {
  const shared = { indexedDB: undefined, localStorage: createLocalStorage() };
  const seed = createLegacyEnv({ localStorage: shared.localStorage });
  shared.indexedDB = seed.indexedDB;
  seed.load('js/utils.js', 'js/sidebar-utils.js', 'js/close-drafts.js', 'js/start-catch-up.js');
  return { shared, seed };
}

/** A draft that holds what's stored already: the closing tab's blocks went in, its record didn't */
function leaveDraft(env, noteId, blocks, { base = T0 } = {}) {
  const CloseDrafts = env.get('CloseDrafts');
  CloseDrafts.write(env.global.localStorage, CloseDrafts.draftOf({
    noteId,
    base: { revision: null, updatedAt: base, issued: [] },
    blocks,
    deletedBlockIds: [],
    preview: '',
    todoProgress: null,
    linkedNames: [],
  }));
}

/** The new tab: App.init on the profile */
async function startNewTab(shared) {
  const env = createLegacyEnv({ document: new FakeDocument(), indexedDB: shared.indexedDB, localStorage: shared.localStorage });
  env.document.stub(['app']);
  env.load(...APP_FILES);
  env.get('Utils').showToast = () => {};
  env.global.Onboarding = { hasCompleted: async () => true };
  env.global.LLM = { init: async () => {} };
  const app = new (env.get('App'))();
  await app.init();
  return { env, app };
}

/** The profile's database, open, for the module's own calls */
function openDb(factory) {
  return new Promise((resolve, reject) => {
    const request = factory.open(DB_NAME);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

/** A block's text, as the editor reads it for wiki links, for the module's own calls */
const textOf = (blocks) => blocks.map((b) => String(b.content || '')).filter((t) => t.trim()).join('\n\n');

/** Each store's record IDs, sorted */
async function ids(factory, ...stores) {
  const dump = await dumpDatabase(factory);
  return Object.fromEntries(stores.map((store) => [store, Object.keys(recordsOf(dump, store)).sort()]));
}

describe('the new tab catches a note up right after the drafts', () => {
  it("gives a note whose draft was already in the blocks' preview and to-do progress, keeping its name and updatedAt", CASE, async () => {
    const { shared, seed } = sharedProfile();
    const blocks = [todo('a1', 'A', 0, 'Buy milk', true), todo('a2', 'A', 1, 'Buy eggs', false)];
    await createDatabase(seed.indexedDB, {
      records: { canvases: [note('A', { name: 'Groceries', titleManuallySet: true, preview: 'old line', todoProgress: null })], elements: blocks },
    });
    leaveDraft(seed, 'A', blocks);

    const { app } = await startNewTab(shared);
    const stored = recordsOf(await dumpDatabase(shared.indexedDB), 'canvases').A;
    assert.equal(stored.preview, 'Buy milk');
    assert.deepEqual(stored.todoProgress, { completed: 1, total: 2 });
    assert.equal(stored.name, 'Groceries');
    assert.equal(stored.updatedAt, T0);
    assert.equal(app.notes.find((n) => n.id === 'A').preview, 'Buy milk', 'the list reads the note caught up');
  });

  it('removes what a note deleted for good left, its blocks, media, vector and snapshots, and nothing of another note', CASE, async () => {
    const { shared, seed } = sharedProfile();
    await createDatabase(seed.indexedDB, {
      records: {
        canvases: [note('B')],
        elements: [block('g1', 'G', 0, 'left behind'), block('g2', 'G', 1, 'left behind too'), block('b1', 'B', 0, 'kept')],
        media: [{ id: 'mg', canvasId: 'G', blob: 'x', type: 'image/png', createdAt: T0 }, { id: 'mb', canvasId: 'B', blob: 'x', type: 'image/png', createdAt: T0 }],
        vectors: [{ id: 'G', noteId: 'G', vector: [1], updatedAt: T0 }, { id: 'B', noteId: 'B', vector: [1], updatedAt: T0 }],
        snapshots: [{ id: 'sg', noteId: 'G', timestamp: T0, blocks: [], title: 'G' }, { id: 'sb', noteId: 'B', timestamp: T0, blocks: [], title: 'B' }],
      },
    });
    leaveDraft(seed, 'G', [block('g1', 'G', 0, 'left behind')]);

    await startNewTab(shared);
    assert.deepEqual(await ids(shared.indexedDB, 'elements', 'media', 'vectors', 'snapshots'), {
      elements: ['b1'], media: ['mb'], vectors: ['B'], snapshots: ['sb'],
    });
  });

  it("catches up the notes a Popup or Side Panel start's drafts named, by their IDs, and clears them", CASE, async () => {
    const { shared, seed } = sharedProfile();
    const blocks = [block('a1', 'A', 0, 'From the side panel start')];
    await createDatabase(seed.indexedDB, {
      records: { canvases: [note('A', { preview: 'old line' })], elements: [...blocks, block('g1', 'G', 0, 'left behind')] },
    });
    // What a Popup or Side Panel start does: apply the drafts, then pass on what they named
    leaveDraft(seed, 'A', blocks);
    leaveDraft(seed, 'G', [block('g1', 'G', 0, 'left behind')]);
    const result = await seed.get('CloseDrafts').apply({ db: await openDb(seed.indexedDB), storage: shared.localStorage, locks: null });
    seed.get('StartCatchUp').remember(result, shared.localStorage);
    assert.ok(shared.localStorage.getItem(seed.get('StartCatchUp').PENDING_KEY), 'IDs wait for the next new tab');
    assert.doesNotMatch(shared.localStorage.getItem(seed.get('StartCatchUp').PENDING_KEY), /side panel|left behind/, 'IDs only');

    await startNewTab(shared);
    const dump = await dumpDatabase(shared.indexedDB);
    assert.equal(recordsOf(dump, 'canvases').A.preview, 'From the side panel start');
    assert.deepEqual(Object.keys(recordsOf(dump, 'elements')), ['a1']);
    assert.equal(shared.localStorage.getItem(seed.get('StartCatchUp').PENDING_KEY), null);
  });

  it("forgets a note's IDs when the note is deleted for good, as its drafts are", CASE, async () => {
    const { shared, seed } = sharedProfile();
    const StartCatchUp = seed.get('StartCatchUp');
    StartCatchUp.remember({ saved: [], recovered: [], dropped: ['A', 'B'], gone: ['G'], kept: [] }, shared.localStorage);
    StartCatchUp.forget(shared.localStorage, ['A', 'G']);
    assert.deepEqual(JSON.parse(JSON.stringify(StartCatchUp.pending(shared.localStorage))), { dropped: ['B'], gone: [] });
  });

  it('keeps the ID of a note whose permanent delete failed, so the note still catches up at the next start', CASE, async () => {
    const { shared, seed } = sharedProfile();
    const blocks = [block('a1', 'A', 0, 'From the side panel start')];
    await createDatabase(seed.indexedDB, {
      records: { canvases: [note('A', { preview: 'old line' }), note('B')], elements: [...blocks, block('b1', 'B', 0, 'bravo')] },
    });
    const StartCatchUp = seed.get('StartCatchUp');
    StartCatchUp.remember({ saved: [], recovered: [], dropped: ['A', 'B'], gone: [], kept: [] }, shared.localStorage);

    // Another page empties the trash: A's delete fails, B's goes through
    const other = createLegacyEnv({ indexedDB: shared.indexedDB, localStorage: shared.localStorage });
    other.load('js/utils.js', 'js/core/storage-error.js', 'js/sidebar-utils.js', 'js/close-drafts.js', 'js/start-catch-up.js', 'js/storage.js');
    const Storage = other.get('Storage');
    await Storage.init();
    const deleteElements = Storage.deleteElementsByNote;
    Storage.deleteElementsByNote = () => Promise.reject(new DOMException('test: the disk is gone', 'UnknownError'));
    await assert.rejects(Storage.permanentlyDeleteNote('A'), { name: 'UnknownError' });
    Storage.deleteElementsByNote = deleteElements;
    await Storage.permanentlyDeleteNote('B');
    assert.deepEqual(JSON.parse(JSON.stringify(StartCatchUp.pending(shared.localStorage))), { dropped: ['A'], gone: [] },
      "A still waits for the catch-up, and B, deleted, doesn't");

    await startNewTab(shared);
    assert.equal(recordsOf(await dumpDatabase(shared.indexedDB), 'canvases').A.preview, 'From the side panel start');
    assert.equal(shared.localStorage.getItem(StartCatchUp.PENDING_KEY), null);
  });
});

describe('the catch-up writes only what the blocks give, and only what differs', () => {
  it("rebuilds a note's links from its text, resolved as the editor's save resolves them", CASE, async () => {
    const { seed } = sharedProfile();
    await createDatabase(seed.indexedDB, {
      records: {
        canvases: [
          note('A', { preview: 'See [[Plan]] and [[gone]]' }),
          note('P1', { name: 'Plan', updatedAt: T0 + 1 }),
          note('P2', { name: 'plan', updatedAt: T0 + 2 }),
          note('T', { name: 'Gone', trashed: true }),
        ],
        elements: [block('a1', 'A', 0, 'See [[Plan]] and [[gone]]')],
        links: [{ id: 'old', fromNoteId: 'A', toNoteId: 'T', createdAt: T0 }],
      },
    });
    const StartCatchUp = seed.get('StartCatchUp');
    const done = await StartCatchUp.catchUp({ db: await openDb(seed.indexedDB), dropped: ['A'], gone: [], textOf, now: () => T0 + 10 });
    assert.equal(done.rebuilt, 1);
    const links = Object.values(recordsOf(await dumpDatabase(seed.indexedDB), 'links'));
    // The newest note of the name wins, and a trashed one isn't a target
    assert.deepEqual(links.map((l) => [l.fromNoteId, l.toNoteId]), [['A', 'P2']]);
  });

  it('writes nothing for a note already matching its blocks', CASE, async () => {
    const { seed } = sharedProfile();
    await createDatabase(seed.indexedDB, {
      records: { canvases: [note('A', { preview: 'Same line', todoProgress: null })], elements: [block('a1', 'A', 0, 'Same line')] },
    });
    const done = await seed.get('StartCatchUp').catchUp({ db: await openDb(seed.indexedDB), dropped: ['A'], gone: [], textOf });
    assert.deepEqual({ rebuilt: done.rebuilt, removed: done.removed }, { rebuilt: 0, removed: 0 });
  });

  it("removes nothing of a note whose record exists when the sweep's transaction reads it, a note created since the scan included", CASE, async () => {
    const { seed } = sharedProfile();
    await createDatabase(seed.indexedDB, {
      records: { canvases: [note('N')], elements: [block('n1', 'N', 0, 'just made')] },
    });
    // N is named as gone, as a scan from before its record existed would name it
    const done = await seed.get('StartCatchUp').catchUp({ db: await openDb(seed.indexedDB), dropped: [], gone: ['N'], textOf });
    assert.equal(done.removed, 0);
    assert.deepEqual((await ids(seed.indexedDB, 'elements')).elements, ['n1']);
  });
});

describe('the full pass, at idle', () => {
  it('catches up every lagging record and removes every orphan no draft named, and keeps the blocks of every live note', CASE, async () => {
    const { seed } = sharedProfile();
    const now = T0 + DAY;
    await createDatabase(seed.indexedDB, {
      records: {
        canvases: [
          note('A', { preview: 'old line' }),
          note('R', { archived: true, archivedAt: T0 }),
          note('X', { trashed: true, trashedAt: T0 }),
          note('M', { isTemplate: true }),
          note('D', { isDaily: true, dateStr: '2023-11-14' }),
        ],
        elements: [
          block('a1', 'A', 0, 'new line'),
          block('r1', 'R', 0, 'Block r1'), block('x1', 'X', 0, 'Block x1'), block('m1', 'M', 0, 'Block m1'), block('d1', 'D', 0, 'Block d1'),
          block('o1', 'O', 0, 'orphan'),
          // A block with no note ID isn't anyone's orphan
          { id: 'free', type: 'text', content: 'no note', order: 0, createdAt: T0, updatedAt: T0 },
        ],
        media: [{ id: 'mo', canvasId: 'O', blob: 'x', type: 'image/png', createdAt: T0 }],
        snapshots: [{ id: 'so', noteId: 'O', timestamp: T0, blocks: [], title: 'O' }],
        vectors: [{ id: 'O', noteId: 'O', vector: [1], updatedAt: T0 }],
      },
    });
    const done = await seed.get('StartCatchUp').fullPass({ db: await openDb(seed.indexedDB), textOf, now: () => now });
    const dump = await dumpDatabase(seed.indexedDB);
    assert.equal(recordsOf(dump, 'canvases').A.preview, 'new line');
    assert.equal(recordsOf(dump, 'canvases').A.updatedAt, T0);
    assert.deepEqual(Object.keys(recordsOf(dump, 'elements')).sort(), ['a1', 'd1', 'free', 'm1', 'r1', 'x1']);
    assert.deepEqual([recordsOf(dump, 'media'), recordsOf(dump, 'snapshots'), recordsOf(dump, 'vectors')].map((r) => Object.keys(r)), [[], [], []]);
    assert.ok(done.rebuilt >= 1 && done.removed === 4);
  });

  it('leaves an orphan whose blocks were edited in the last ten minutes for a later pass', CASE, async () => {
    const { seed } = sharedProfile();
    const now = T0 + DAY;
    await createDatabase(seed.indexedDB, {
      records: { canvases: [], elements: [block('o1', 'O', 0, 'recent', { updatedAt: now - 60_000 })] },
    });
    const done = await seed.get('StartCatchUp').fullPass({ db: await openDb(seed.indexedDB), textOf, now: () => now });
    assert.equal(done.removed, 0);
    assert.deepEqual((await ids(seed.indexedDB, 'elements')).elements, ['o1']);
  });

  it('runs at the first 1.4.3 start, then again only once its last run is more than seven days old', CASE, async () => {
    const { seed } = sharedProfile();
    const StartCatchUp = seed.get('StartCatchUp');
    assert.equal(StartCatchUp.due(null, T0), true);
    assert.equal(StartCatchUp.due(T0 - 8 * DAY, T0), true);
    assert.equal(StartCatchUp.due(T0 - DAY, T0), false);
    // A clock set back: a last run in the future doesn't hold the pass off
    assert.equal(StartCatchUp.due(T0 + DAY, T0), true);
  });

  it("the new tab's idle work runs it once and records when, so the next start skips it", CASE, async () => {
    const { shared, seed } = sharedProfile();
    await createDatabase(seed.indexedDB, {
      records: { canvases: [note('A', { preview: 'old line' })], elements: [block('a1', 'A', 0, 'new line')] },
    });
    const { env, app } = await startNewTab(shared);
    assert.equal(app.notes.find((n) => n.id === 'A').preview, 'old line', 'the list before the pass');
    let passes = 0;
    const StartCatchUp = env.get('StartCatchUp');
    const fullPass = StartCatchUp.fullPass;
    env.global.StartCatchUp = { ...StartCatchUp, fullPass: (options) => { passes += 1; return fullPass(options); } };
    await app.checkRecordsWeekly();
    await app.checkRecordsWeekly();
    assert.equal(passes, 1);
    assert.equal(recordsOf(await dumpDatabase(shared.indexedDB), 'canvases').A.preview, 'new line');
    assert.equal(app.notes.find((n) => n.id === 'A').preview, 'new line', 'the list shows the note caught up, with no reload');
    const checkedAt = await env.get('Storage').getSetting('recordsCheckedAt', null);
    assert.equal(typeof checkedAt, 'number');
  });
});

// ─── Database and page wrappers for the rules below ───

/** Every call of `target` but the ones `traps` names, on the real object */
function through(target, traps = {}) {
  return new Proxy(target, {
    get(t, p) {
      if (Object.prototype.hasOwnProperty.call(traps, p)) return traps[p];
      const value = Reflect.get(t, p);
      return typeof value === 'function' ? value.bind(t) : value;
    },
    set(t, p, value) {
      t[p] = value;
      return true;
    },
  });
}

/** A db that, right before its first readwrite transaction over canvases opens, commits `write` in a transaction of its own */
function writeBeforeFirstReadwrite(db, write) {
  let done = false;
  return through(db, {
    transaction(stores, mode) {
      if (!done && mode === 'readwrite' && [].concat(stores).includes('canvases')) {
        done = true;
        // Created first, so IndexedDB runs it first: it lands between the pass's read and its write
        write(db.transaction(['canvases', 'elements', 'links'], 'readwrite'));
      }
      return db.transaction(stores, mode);
    },
  });
}

/** A db that lists its transactions: their stores, mode, and how many notes' blocks each read */
function countingDb(db) {
  const seen = [];
  const counting = through(db, {
    transaction(stores, mode = 'readonly') {
      const entry = { stores: [].concat(stores), mode, blockReads: 0 };
      seen.push(entry);
      const tx = db.transaction(stores, mode);
      return through(tx, {
        objectStore(name) {
          const store = tx.objectStore(name);
          if (name !== 'elements') return store;
          return through(store, {
            index(indexName) {
              const index = store.index(indexName);
              return through(index, { getAll(...args) { entry.blockReads += 1; return index.getAll(...args); } });
            },
          });
        },
      });
    },
  });
  return { db: counting, seen };
}

/** Web Locks as Chrome grants them: exclusive per name, and `ifAvailable` answers null while another holds it */
function lockManager() {
  const tails = new Map();
  const held = new Set();
  return {
    request(name, optionsOrCallback, maybeCallback) {
      const callback = typeof optionsOrCallback === 'function' ? optionsOrCallback : maybeCallback;
      const options = typeof optionsOrCallback === 'function' ? {} : optionsOrCallback || {};
      if (options.ifAvailable && held.has(name)) return Promise.resolve().then(() => callback(null));
      const run = (tails.get(name) || Promise.resolve()).then(async () => {
        held.add(name);
        try {
          return await callback({ name, mode: 'exclusive' });
        } finally {
          held.delete(name);
        }
      });
      tails.set(name, run.catch(() => {}));
      return run;
    },
  };
}

/** A page with the editor's real text reader (BlockEditor's), for the module's default textOf */
function readerPage() {
  const page = createLegacyEnv();
  // stripHtmlTags parses in a document of its own; text without its tags stands in for that here
  page.document.implementation = {
    createHTMLDocument: () => ({
      createElement: () => {
        let text = '';
        return { set innerHTML(html) { text = String(html).replace(/<[^>]*>/g, ''); }, get textContent() { return text; } };
      },
    }),
  };
  page.load('js/utils.js', 'js/core/storage-error.js', 'js/sidebar-utils.js', 'js/blocks.js', 'js/editor.js', 'js/start-catch-up.js');
  return page;
}

/** A new tab's App on the profile, before its start; `options` go to its page */
function newTabApp(shared, options = {}) {
  const env = createLegacyEnv({ document: new FakeDocument(), indexedDB: shared.indexedDB, localStorage: shared.localStorage, ...options });
  env.document.stub(['app']);
  env.load(...APP_FILES);
  env.get('Utils').showToast = () => {};
  env.global.Onboarding = { hasCompleted: async () => true };
  env.global.LLM = { init: async () => {} };
  return env;
}

/** Leave a draft already in the blocks for A, and one for G, whose note is gone */
function leaveDroppedAndGone(env, shared) {
  const CloseDrafts = env.get('CloseDrafts');
  for (const [noteId, blocks] of [['A', [block('a1', 'A', 0, 'stored by the closing write')]], ['G', [block('g1', 'G', 0, 'gone')]]]) {
    CloseDrafts.write(shared.localStorage, CloseDrafts.draftOf({
      noteId, base: { revision: null, updatedAt: T0, issued: [] }, blocks, deletedBlockIds: [], preview: '', todoProgress: null, linkedNames: [],
    }));
  }
}

describe('Popup and the Side Panel pass on the notes their drafts named', () => {
  for (const root of ['popup', 'sidepanel']) {
    it(`the ${root === 'popup' ? 'Popup' : 'Side Panel'}'s own start keeps their IDs for the next new tab`, CASE, async () => {
      const { shared, seed } = sharedProfile();
      await createDatabase(seed.indexedDB, {
        records: { canvases: [note('A', { preview: 'stale' })], elements: [block('a1', 'A', 0, 'stored by the closing write')] },
      });
      leaveDroppedAndGone(seed, shared);
      const page = createLegacyEnv({ indexedDB: shared.indexedDB, localStorage: shared.localStorage });
      if (root === 'popup') {
        page.document.stub([{ id: 'open-tab', tag: 'button' }, { id: 'quick-note-input', tag: 'input' }, 'main-content', 'daily-summary', 'summary-content', 'page-list']);
        page.load('js/close-drafts.js', 'js/start-catch-up.js', 'js/popup.js');
      } else {
        page.document.stub(['open-notes', 'status', 'status-count', 'sections', 'empty-state']);
        const openButton = page.document.createElement('button');
        openButton.setAttribute('data-open-notes', '');
        page.document.body.appendChild(openButton);
        page.load('js/close-drafts.js', 'js/start-catch-up.js', 'js/insights-summary.js', 'js/sidepanel.js');
      }
      await Promise.all(page.document.fire('DOMContentLoaded'));
      await settle();
      assert.deepEqual(JSON.parse(shared.localStorage.getItem(seed.get('StartCatchUp').PENDING_KEY) || 'null'), { dropped: ['A'], gone: ['G'] });
    });
  }
});

describe('the rebuild reads inside its own transaction', () => {
  it('keeps the name, updatedAt and preview a save in another tab wrote after the pass read the notes', CASE, async () => {
    const { seed } = sharedProfile();
    await createDatabase(seed.indexedDB, {
      records: { canvases: [note('A', { name: 'Old name', preview: 'stale preview' })], elements: [block('a1', 'A', 0, 'stored text')] },
    });
    const db = writeBeforeFirstReadwrite(await openDb(seed.indexedDB), (tx) => {
      tx.objectStore('canvases').put(note('A', { name: 'New name', updatedAt: T0 + 999, preview: 'saved elsewhere' }));
      tx.objectStore('elements').put(block('a1', 'A', 0, 'saved elsewhere'));
    });
    await seed.get('StartCatchUp').fullPass({ db, textOf, now: () => T0 + DAY });
    const A = recordsOf(await dumpDatabase(seed.indexedDB), 'canvases').A;
    assert.deepEqual([A.name, A.updatedAt, A.preview], ['New name', T0 + 999, 'saved elsewhere']);
  });

  it('keeps a link a save wrote to a note made after the pass read the notes', CASE, async () => {
    const { seed } = sharedProfile();
    await createDatabase(seed.indexedDB, {
      records: { canvases: [note('X', { name: 'Source', preview: 'stale' })], elements: [block('x1', 'X', 0, 'see [[Yonder]]')], links: [] },
    });
    // Another tab makes Yonder, and a save of X writes its link, between the pass's read and X's rebuild
    const db = writeBeforeFirstReadwrite(await openDb(seed.indexedDB), (tx) => {
      tx.objectStore('canvases').put(note('Y', { name: 'Yonder', updatedAt: T0 + 5 }));
      tx.objectStore('elements').put(block('y1', 'Y', 0, 'target'));
      tx.objectStore('links').put({ id: 'l1', fromNoteId: 'X', toNoteId: 'Y', createdAt: T0 + 5 });
    });
    const done = await seed.get('StartCatchUp').fullPass({ db, textOf, now: () => T0 + DAY });
    const dump = await dumpDatabase(seed.indexedDB);
    assert.equal(done.rebuilt, 1, "X's preview is caught up");
    assert.deepEqual(Object.values(recordsOf(dump, 'links')).map((l) => `${l.fromNoteId}->${l.toNoteId}`), ['X->Y']);
  });

  it("derives links through the editor's own text reader, markup and case as a save reads them", CASE, async () => {
    const page = readerPage();
    await createDatabase(page.indexedDB, {
      records: {
        canvases: [note('A', { preview: 'stale' }), note('T', { name: 'Target' })],
        elements: [block('a1', 'A', 0, 'bold <b>[[target]]</b> link'), block('t1', 'T', 0, 'target body')],
        links: [],
      },
    });
    // No textOf: the module reads the page's editor, as the new tab's catch-up does
    await page.get('StartCatchUp').catchUp({ db: await openDb(page.indexedDB), dropped: ['A'], gone: [] });
    const links = Object.values(recordsOf(await dumpDatabase(page.indexedDB), 'links'));
    assert.deepEqual(links.map((l) => `${l.fromNoteId}->${l.toNoteId}`), ['A->T']);
  });

  it("skips and counts a note whose blocks the editor can't read, catches up the rest, and the new tab records the pass", CASE, async () => {
    const page = readerPage();
    await createDatabase(page.indexedDB, {
      records: {
        canvases: [note('A', { preview: 'stale' }), note('O', { preview: 'stale' })],
        // A table row that isn't a list, which import lets in and the editor's reader throws on
        elements: [block('a1', 'A', 0, 'fresh'), { ...block('o1', 'O', 0, ''), type: 'table', tableData: ['not a row'] }],
        links: [],
      },
    });
    const done = await page.get('StartCatchUp').fullPass({ db: await openDb(page.indexedDB), now: () => T0 + DAY });
    const notes = recordsOf(await dumpDatabase(page.indexedDB), 'canvases');
    assert.deepEqual({ rebuilt: done.rebuilt, skipped: done.skipped }, { rebuilt: 1, skipped: 1 });
    assert.deepEqual([notes.A.preview, notes.O.preview], ['fresh', 'stale']);

    // The same at a new tab's idle pass: it finishes and is recorded
    const { shared, seed } = sharedProfile();
    await createDatabase(seed.indexedDB, {
      records: { canvases: [note('A', { preview: 'stale' }), note('O')], elements: [block('a1', 'A', 0, 'fresh'), { ...block('o1', 'O', 0, ''), type: 'table' }], links: [] },
    });
    const { env, app } = await startNewTab(shared);
    const StartCatchUp = env.get('StartCatchUp');
    const unreadable = (blocks) => {
      if (blocks.some((b) => b.type === 'table')) throw new TypeError('test: the reader throws on this block');
      return textOf(blocks);
    };
    env.global.StartCatchUp = { ...StartCatchUp, fullPass: (options) => StartCatchUp.fullPass({ ...options, textOf: unreadable }) };
    await app.checkRecordsWeekly();
    assert.equal(typeof await env.get('Storage').getSetting('recordsCheckedAt', null), 'number');
    assert.equal(recordsOf(await dumpDatabase(shared.indexedDB), 'canvases').A.preview, 'fresh');
  });
});

describe('the full pass holds no store long, and runs in one tab at a time', () => {
  it("reads at most 50 notes' blocks per transaction", CASE, async () => {
    const { seed } = sharedProfile();
    const many = Array.from({ length: 120 }, (_, i) => `N${String(i).padStart(3, '0')}`);
    await createDatabase(seed.indexedDB, {
      records: { canvases: many.map((id) => note(id, { preview: `Block ${id}` })), elements: many.map((id) => block(`${id}-1`, id, 0, `Block ${id}`)) },
    });
    const { db, seen } = countingDb(await openDb(seed.indexedDB));
    const done = await seed.get('StartCatchUp').fullPass({ db, textOf, now: () => T0 + DAY });
    assert.equal(done.notes, 120);
    assert.deepEqual(seen.filter((t) => t.mode === 'readonly' && t.blockReads > 0).map((t) => t.blockReads), [50, 50, 20]);
  });

  it('scans and sweeps many deleted notes in batches, removing every orphan and keeping every live block', { timeout: 90_000 }, async () => {
    const { seed } = sharedProfile();
    const live = Array.from({ length: 1200 }, (_, i) => `L${String(i).padStart(4, '0')}`);
    const gone = Array.from({ length: 1300 }, (_, i) => `G${String(i).padStart(4, '0')}`);
    await createDatabase(seed.indexedDB, {
      records: {
        canvases: live.map((id) => note(id, { preview: `Block ${id}-1` })),
        elements: [...live.map((id) => block(`${id}-1`, id, 0)), ...gone.map((id) => block(`${id}-1`, id, 0))],
        media: gone.slice(0, 600).map((id) => ({ id: `${id}-m`, canvasId: id, blob: 'x', type: 'image/png', createdAt: T0 })),
        vectors: [...live.slice(0, 700), ...gone.slice(0, 700)].map((id) => ({ id, noteId: id, vector: [1], updatedAt: T0 })),
      },
    });
    const { db, seen } = countingDb(await openDb(seed.indexedDB));
    const done = await seed.get('StartCatchUp').fullPass({ db, textOf: null, now: () => T0 + DAY });
    const dump = await dumpDatabase(seed.indexedDB);
    const elements = Object.keys(recordsOf(dump, 'elements'));
    assert.equal(done.removed, 1300 + 600 + 700);
    assert.equal(elements.length, 1200);
    assert.ok(elements.every((id) => id.startsWith('L')), "only live notes' blocks are left");
    assert.equal(Object.keys(recordsOf(dump, 'vectors')).length, 700);
    // 2,500 distinct note IDs over the blocks, 500 per read; 1,300 orphans, 50 per sweep
    const scans = seen.filter((t) => t.mode === 'readonly' && t.stores.join() === 'elements' && t.blockReads === 0);
    const sweeps = seen.filter((t) => t.mode === 'readwrite' && t.stores.includes('vectors'));
    assert.equal(scans.length, 6);
    assert.equal(sweeps.length, 26);
    assert.ok(sweeps.every((t) => t.blockReads <= 50));
  });

  it('a new tab skips the pass while another holds it, and records nothing', CASE, async () => {
    const locks = lockManager();
    const { shared, seed } = sharedProfile();
    await createDatabase(seed.indexedDB, { records: { canvases: [note('A', { preview: 'old line' })], elements: [block('a1', 'A', 0, 'new line')] } });
    const env = newTabApp(shared, { locks });
    const app = new (env.get('App'))();
    await app.init();

    let release;
    const holding = locks.request('ntn-start-catch-up', () => new Promise((resolve) => { release = resolve; }));
    await settle();
    let finished = false;
    const check = app.checkRecordsWeekly().then(() => { finished = true; });
    for (let i = 0; i < 200 && !finished; i++) await settle(2);
    const skipped = finished;
    release();
    await Promise.all([holding, check]);
    assert.equal(skipped, true, 'it goes on without waiting for the other tab');
    assert.equal(await env.get('Storage').getSetting('recordsCheckedAt', null), null);
    assert.equal(recordsOf(await dumpDatabase(shared.indexedDB), 'canvases').A.preview, 'old line');
  });

  it('the idle work runs the pass even when a step before it failed', CASE, async () => {
    const { shared, seed } = sharedProfile();
    await createDatabase(seed.indexedDB, { records: { canvases: [note('A', { preview: 'old line' })], elements: [block('a1', 'A', 0, 'new line')] } });
    const env = newTabApp(shared);
    const app = new (env.get('App'))();
    await app.init();
    // The steps before the pass, the graph view failing
    Object.assign(app, {
      initAnalyticsController: async () => {},
      initGraphView: async () => { throw new Error('test: the graph view failed'); },
      initSyncService: async () => {},
      notesManager: null,
    });
    await assert.rejects(app.runDeferredWork(), /the graph view failed/);
    assert.equal(typeof await env.get('Storage').getSetting('recordsCheckedAt', null), 'number');
    assert.equal(recordsOf(await dumpDatabase(shared.indexedDB), 'canvases').A.preview, 'new line');
  });
});
