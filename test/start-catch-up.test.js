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
  createLegacyEnv, createDatabase, dumpDatabase, recordsOf, createLocalStorage, note, block, FakeDocument, DB_NAME,
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
  });

  it("the new tab's idle work runs it once and records when, so the next start skips it", CASE, async () => {
    const { shared, seed } = sharedProfile();
    await createDatabase(seed.indexedDB, {
      records: { canvases: [note('A', { preview: 'old line' })], elements: [block('a1', 'A', 0, 'new line')] },
    });
    const { env, app } = await startNewTab(shared);
    let passes = 0;
    const StartCatchUp = env.get('StartCatchUp');
    const fullPass = StartCatchUp.fullPass;
    env.global.StartCatchUp = { ...StartCatchUp, fullPass: (options) => { passes += 1; return fullPass(options); } };
    await app.checkRecordsWeekly();
    await app.checkRecordsWeekly();
    assert.equal(passes, 1);
    assert.equal(recordsOf(await dumpDatabase(shared.indexedDB), 'canvases').A.preview, 'new line');
    const checkedAt = await env.get('Storage').getSetting('recordsCheckedAt', null);
    assert.equal(typeof checkedAt, 'number');
  });
});
