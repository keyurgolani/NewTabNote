'use strict';

// AC1: switching notes, switching panes, closing the tab, or closing the PiP
// window inside the 500 ms debounce never moves a block to another note and
// keeps the last edit. Overlapping loadNote calls end on the later note.

const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const {
  createLegacyEnv, createDatabase, dumpDatabase, recordsOf, settle, note, block, FakeDocument,
} = require('./helpers/legacy-env');

const FILES = [
  'js/utils.js',
  'js/core/storage-error.js',
  'js/storage.js',
  'js/sidebar-utils.js',
  'js/blocks.js',
  'js/editor.js',
];

/** A window-like target for an editor's own document (the PiP window has its own). */
function windowTarget() {
  const listeners = {};
  return {
    listeners,
    addEventListener(type, fn) { (listeners[type] = listeners[type] || []).push(fn); },
    fire(type) { (listeners[type] || []).forEach((fn) => fn({ type })); },
  };
}

/**
 * A BlockEditor without its DOM constructor: render methods stubbed, real Storage.
 * @param {ReturnType<typeof createLegacyEnv>} env
 * @param {FakeDocument} [doc]
 */
function makeEditor(env, doc = env.document) {
  const BlockEditor = env.get('BlockEditor');
  const editor = Object.create(BlockEditor.prototype);
  Object.assign(editor, {
    root: { querySelector: () => null },
    doc,
    noteId: null,
    noteData: null,
    blocks: [],
    titleEl: { textContent: '' },
    container: { querySelector: () => null },
    insightsPollingId: null,
    undoStack: [],
    redoStack: [],
    _contentUndoPending: {},
    selectedBlockIds: new Set(),
    _snapshotDirty: false,
    _snapshotInterval: null,
    hasReceivedFirstContent: false,
    pendingAutoTitle: false,
  });
  editor._initPersistenceState();
  editor._bindLifecycleFlush();
  const noop = () => {};
  Object.assign(editor, {
    renderBlocks: noop,
    renderBacklinks: noop,
    updateTimestampDisplay: noop,
    updateSaveStatus: noop,
    clearBlockSelection: noop,
    placeCaretAtEnd: noop,
    renderInsights: async () => {},
    startInsightsPollingIfNeeded: async () => {},
    stripHtmlTags: (html) => String(html || '').replace(/<[^>]*>/g, ''),
  });
  return editor;
}

/** Type into the first block of the loaded note, as onBlockInput does. */
function type(editor, text, index = 0) {
  editor.blocks[index].content = text;
  editor.blocks[index].markUpdated();
  editor.scheduleSave();
}

/** Record transactions opened on the database. */
function spyTransactions(storage) {
  const db = storage.db;
  const original = db.transaction.bind(db);
  const opened = [];
  db.transaction = (stores, mode) => {
    opened.push({ stores: [].concat(stores), mode: mode || 'readonly' });
    return original(stores, mode);
  };
  return opened;
}

const writesOf = (opened) => opened.filter((t) => t.mode === 'readwrite');

async function setup() {
  const env = createLegacyEnv();
  await createDatabase(env.indexedDB, {
    records: {
      canvases: [note('A'), note('B'), note('C')],
      elements: [
        block('a1', 'A', 0, 'alpha'),
        block('a2', 'A', 1, 'alpha two'),
        block('b1', 'B', 0, 'bravo'),
        block('c1', 'C', 0, 'charlie'),
      ],
    },
  });
  env.load(...FILES);
  const Storage = env.get('Storage');
  await Storage.init();
  return { env, Storage };
}

/** canvasId and content of every element, by element ID. */
async function elementsById(env) {
  const rows = recordsOf(await dumpDatabase(env.indexedDB), 'elements');
  return Object.fromEntries(Object.entries(rows).map(([id, el]) => [id, { canvasId: el.canvasId, content: el.content }]));
}

describe('BlockEditor save and load (AC1)', () => {
  let env;
  let Storage;
  let editor;

  beforeEach(async () => {
    ({ env, Storage } = await setup());
    editor = makeEditor(env);
    await editor.loadNote('A');
  });

  it('loads a note and its blocks in order', () => {
    assert.equal(editor.noteId, 'A');
    assert.equal(editor.noteData.id, 'A');
    assert.deepEqual(editor.blocks.map((b) => b.id), ['a1', 'a2']);
  });

  it('switching notes inside the debounce saves the edit to the note it was typed in', async () => {
    type(editor, 'alpha edited');
    assert.notEqual(editor.saveTimeout, null, 'a save is pending');

    const load = editor.loadNote('B');
    env.frames();
    await load;

    assert.equal(editor.noteId, 'B');
    assert.deepEqual(editor.blocks.map((b) => b.id), ['b1']);
    assert.deepEqual(await elementsById(env), {
      a1: { canvasId: 'A', content: 'alpha edited' },
      a2: { canvasId: 'A', content: 'alpha two' },
      b1: { canvasId: 'B', content: 'bravo' },
      c1: { canvasId: 'C', content: 'charlie' },
    });
    assert.equal(editor.saveTimeout, null);
  });

  it('a debounce timer that fires during the switch cannot pair note B with note A blocks', async () => {
    type(editor, 'first');
    const load = editor.loadNote('B');
    // Edits keep arriving in the old DOM while the next note is read, and the timer fires.
    type(editor, 'second');
    env.clock.tick(500);
    env.frames();
    await load;
    env.frames();
    await editor.flushSave();

    const rows = await elementsById(env);
    assert.deepEqual(rows.a1, { canvasId: 'A', content: 'second' });
    assert.deepEqual(rows.b1, { canvasId: 'B', content: 'bravo' });
    assert.equal(Object.values(rows).filter((r) => r.canvasId === 'B').length, 1, 'no block moved to B');
  });

  it('save() uses only what it captured before its first await', async () => {
    type(editor, 'captured');
    const saving = editor.save();
    // The old bug: noteId and blocks change before the save writes.
    editor.noteId = 'B';
    editor.noteData = await Storage.getNote('B');
    env.frames();
    await saving;

    const rows = await elementsById(env);
    assert.deepEqual(rows.a1, { canvasId: 'A', content: 'captured' });
    assert.deepEqual(rows.b1, { canvasId: 'B', content: 'bravo' });
  });

  it('writes the note and its blocks in one readwrite transaction', async () => {
    const opened = spyTransactions(Storage);
    type(editor, 'one transaction');
    env.clock.tick(500);
    env.frames();
    await editor.flushSave();

    const first = writesOf(opened)[0];
    assert.deepEqual(first, { stores: ['canvases', 'elements'], mode: 'readwrite' });
    const stored = await Storage.getNote('A');
    assert.ok(stored.updatedAt > note('A').updatedAt, 'updatedAt set like updateNote');
  });

  it('a pending retry counts: switching notes runs it before loading the next note', async () => {
    const realSave = Storage.saveNoteWithBlocks.bind(Storage);
    let failures = 1;
    Storage.saveNoteWithBlocks = (n, els) => (failures-- > 0 ? Promise.reject(new Error('disk busy')) : realSave(n, els));

    type(editor, 'retry me');
    env.clock.tick(500);
    env.frames();
    await settle();
    assert.equal(editor._retryPending, true, 'the 1 s retry is pending in saveTimeout');

    const load = editor.loadNote('B');
    env.frames();
    await load;

    assert.equal(editor.noteId, 'B');
    assert.deepEqual((await elementsById(env)).a1, { canvasId: 'A', content: 'retry me' });
  });

  it('overlapping loadNote calls end on the later note with that note\'s blocks', async () => {
    type(editor, 'before overlap');
    const first = editor.loadNote('B');
    const second = editor.loadNote('C');
    env.frames();
    await Promise.all([first, second]);

    assert.equal(editor.noteId, 'C');
    assert.equal(editor.noteData.id, 'C');
    assert.deepEqual(editor.blocks.map((b) => b.id), ['c1']);
    const rows = await elementsById(env);
    assert.deepEqual(rows.a1, { canvasId: 'A', content: 'before overlap' });
    assert.equal(rows.b1.canvasId, 'B');
    assert.equal(rows.c1.canvasId, 'C');
  });

  it('a missing note keeps the loaded note instead of pointing the editor at nothing', async () => {
    await editor.loadNote('does-not-exist');
    assert.equal(editor.noteId, 'A');
    type(editor, 'still A');
    env.clock.tick(500);
    env.frames();
    await editor.flushSave();
    assert.deepEqual((await elementsById(env)).a1, { canvasId: 'A', content: 'still A' });
  });

  it('flushSave writes nothing when nothing is pending', async () => {
    const opened = spyTransactions(Storage);
    await editor.flushSave();
    assert.equal(writesOf(opened).length, 0);
  });
});

describe('BlockEditor page lifecycle flush (AC1)', () => {
  let env;
  let Storage;
  let editor;

  beforeEach(async () => {
    ({ env, Storage } = await setup());
    editor = makeEditor(env);
    await editor.loadNote('A');
  });

  it('visibilitychange to hidden opens the transaction before the handler returns', async () => {
    const opened = spyTransactions(Storage);
    type(editor, 'hidden tab');
    env.document.visibilityState = 'hidden';
    env.document.fire('visibilitychange');

    assert.deepEqual(writesOf(opened), [{ stores: ['canvases', 'elements'], mode: 'readwrite' }],
      'opened synchronously, with no animation frame');
    assert.equal(env.pendingFrames(), 0);
    await settle();
    assert.deepEqual((await elementsById(env)).a1, { canvasId: 'A', content: 'hidden tab' });
    assert.equal(editor.saveTimeout, null);
  });

  it('visibilitychange to visible does nothing', () => {
    const opened = spyTransactions(Storage);
    type(editor, 'visible');
    env.document.visibilityState = 'visible';
    env.document.fire('visibilitychange');
    assert.equal(writesOf(opened).length, 0);
    assert.notEqual(editor.saveTimeout, null);
  });

  it('pagehide (closing the tab) writes the pending edit synchronously', async () => {
    const opened = spyTransactions(Storage);
    type(editor, 'tab closing');
    env.window.fire('pagehide');
    assert.equal(writesOf(opened).length, 1);
    await settle();
    const stored = await Storage.getNote('A');
    assert.deepEqual((await elementsById(env)).a1, { canvasId: 'A', content: 'tab closing' });
    assert.equal(stored.preview, 'tab closing', 'preview computed without a frame');
  });

  it('a save waiting for its frame is written by pagehide, and only once', async () => {
    const opened = spyTransactions(Storage);
    type(editor, 'in flight');
    env.clock.tick(500); // the save starts and waits for requestAnimationFrame
    assert.equal(env.pendingFrames(), 1);
    assert.equal(writesOf(opened).length, 0);

    env.window.fire('pagehide');
    assert.equal(writesOf(opened).length, 1, 'captured state written before the handler returned');

    env.frames();
    await editor.flushSave();
    assert.equal(writesOf(opened).filter((t) => t.stores.includes('elements')).length, 1, 'the frame does not write it again');
    assert.deepEqual((await elementsById(env)).a1, { canvasId: 'A', content: 'in flight' });
  });

  it('a pending retry is written by pagehide', async () => {
    const realSave = Storage.saveNoteWithBlocks.bind(Storage);
    let failures = 1;
    Storage.saveNoteWithBlocks = (n, els) => (failures-- > 0 ? Promise.reject(new Error('disk busy')) : realSave(n, els));
    type(editor, 'retry on close');
    env.clock.tick(500);
    env.frames();
    await settle();
    assert.equal(editor._retryPending, true);

    env.window.fire('pagehide');
    await settle();
    assert.deepEqual((await elementsById(env)).a1, { canvasId: 'A', content: 'retry on close' });
  });

  it('nothing pending: pagehide and visibilitychange write nothing', () => {
    const opened = spyTransactions(Storage);
    env.window.fire('pagehide');
    env.document.visibilityState = 'hidden';
    env.document.fire('visibilitychange');
    assert.equal(writesOf(opened).length, 0);
  });

  it('closing the PiP window writes only the PiP editor\'s pending edit', async () => {
    const pipDoc = new FakeDocument();
    const pipWindow = windowTarget();
    pipDoc.defaultView = pipWindow;
    const pipEditor = makeEditor(env, pipDoc);
    await pipEditor.loadNote('C');

    type(pipEditor, 'charlie in PiP');
    type(editor, 'alpha in main');
    const opened = spyTransactions(Storage);
    pipWindow.fire('pagehide');
    assert.equal(writesOf(opened).length, 1, 'PiP edit written synchronously');
    assert.notEqual(editor.saveTimeout, null, 'the main editor keeps its own debounce');
    await settle();

    const rows = await elementsById(env);
    assert.deepEqual(rows.c1, { canvasId: 'C', content: 'charlie in PiP' });
    assert.deepEqual(rows.a1, { canvasId: 'A', content: 'alpha' }, 'main editor not written yet');

    env.clock.tick(500);
    env.frames();
    await editor.flushSave();
    assert.deepEqual((await elementsById(env)).a1, { canvasId: 'A', content: 'alpha in main' });
  });

  it('switching panes: each editor keeps its own pending edit on its own note', async () => {
    const secondary = makeEditor(env);
    await secondary.loadNote('B');
    type(editor, 'left pane');
    type(secondary, 'right pane');

    // The user moves to the right pane and opens another note there.
    const load = secondary.loadNote('C');
    env.frames();
    await load;
    env.clock.tick(500);
    env.frames();
    await editor.flushSave();

    const rows = await elementsById(env);
    assert.deepEqual(rows.a1, { canvasId: 'A', content: 'left pane' });
    assert.deepEqual(rows.b1, { canvasId: 'B', content: 'right pane' });
    assert.deepEqual(rows.c1, { canvasId: 'C', content: 'charlie' });
  });
});

describe('BlockEditor save hold (import)', () => {
  let env;
  let Storage;
  let editor;

  beforeEach(async () => {
    ({ env, Storage } = await setup());
    editor = makeEditor(env);
    await editor.loadNote('A');
  });

  it('a save that comes due while held waits for release and keeps adopted flags', async () => {
    const opened = spyTransactions(Storage);
    editor.holdSaves();
    type(editor, 'typed during import');
    env.clock.tick(500);
    env.frames();
    await settle();
    assert.equal(writesOf(opened).length, 0, 'held');

    editor.adoptNoteFlags({ trashed: true, trashedAt: 123, archived: false, archivedAt: null });
    editor.releaseSaves();
    env.frames();
    await editor.flushSave();

    const stored = await Storage.getNote('A');
    assert.equal(stored.trashed, true);
    assert.equal(stored.trashedAt, 123);
    assert.deepEqual((await elementsById(env)).a1, { canvasId: 'A', content: 'typed during import' });
  });

  it('loadNote waits for the hold to end before writing the old note', async () => {
    editor.holdSaves();
    type(editor, 'switch during import');
    let loaded = false;
    const load = editor.loadNote('B').then(() => { loaded = true; });
    await settle();
    assert.equal(loaded, false);
    editor.releaseSaves();
    await settle(); // loadNote resumes, flushes, and waits for a frame
    env.frames();
    await load;
    assert.equal(editor.noteId, 'B');
    assert.deepEqual((await elementsById(env)).a1, { canvasId: 'A', content: 'switch during import' });
  });
});
