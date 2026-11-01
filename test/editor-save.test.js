'use strict';

// AC1: switching notes, switching panes, closing the tab, or closing the PiP
// window inside the 500 ms debounce never moves a block to another note and
// keeps the last edit. Overlapping loadNote calls end on the later note.

const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const {
  createLegacyEnv, createDatabase, dumpDatabase, recordsOf, settle, waitFor, plain, note, block, FakeDocument, makeEditor,
  runUntil,
} = require('./helpers/legacy-env');

const FILES = [
  'js/utils.js',
  'js/core/storage-error.js',
  'js/storage.js',
  'js/sidebar-utils.js',
  'js/blocks.js',
  'js/editor.js',
];

/**
 * A window-like target for an editor's own document. The PiP window has its
 * own listeners and its own animation frames, which run apart from the new tab's.
 */
function windowTarget() {
  const listeners = {};
  const queued = [];
  return {
    listeners,
    addEventListener(type, fn) { (listeners[type] = listeners[type] || []).push(fn); },
    fire(type) { (listeners[type] || []).forEach((fn) => fn({ type })); },
    requestAnimationFrame(fn) { queued.push(fn); return queued.length; },
    /** Run this window's queued frame callbacks. */
    frames() {
      const batch = queued.splice(0, queued.length);
      batch.forEach((fn) => fn(0));
      return batch.length;
    },
    pendingFrames() { return queued.length; },
  };
}

/** A PiP editor on `noteId`, in its own document and window. */
async function openPiP(env, noteId) {
  const pipDoc = new FakeDocument();
  const pipWindow = windowTarget();
  pipDoc.defaultView = pipWindow;
  const pip = allowDeletes(makeEditor(env, pipDoc));
  await pip.loadNote(noteId);
  return { pip, pipWindow };
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

/** Record the transactions whose commit() is called, as a closing page's flush calls it. */
function spyCommits(storage) {
  const db = storage.db;
  const original = db.transaction.bind(db);
  const committed = [];
  db.transaction = (stores, mode) => {
    const tx = original(stores, mode);
    const commit = tx.commit.bind(tx);
    tx.commit = () => {
      committed.push([].concat(stores));
      return commit();
    };
    return tx;
  };
  return committed;
}

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

/**
 * Make the next `times` writes of `noteId` fail, as a quota or I/O error does.
 * @returns {Array<string>} The note ID of every write attempted
 */
function failWritesOf(Storage, noteId, times) {
  const real = Storage.saveNoteWithBlocks.bind(Storage);
  const attempts = [];
  let left = times;
  Storage.saveNoteWithBlocks = (n, els) => {
    attempts.push(n.id);
    if (n.id === noteId && left > 0) {
      left -= 1;
      return Promise.reject(new Error('QuotaExceededError'));
    }
    return real(n, els);
  };
  return attempts;
}

/** Record save status text and toasts. */
function watchFeedback(env, editor) {
  const statuses = [];
  const toasts = [];
  editor.updateSaveStatus = (status) => statuses.push(status);
  env.get('Utils').showToast = (message, kind) => toasts.push({ message, kind });
  return { statuses, toasts };
}

/** Stub the DOM-only parts of deleting a block. */
function allowDeletes(editor) {
  Object.assign(editor, { removeBlockDOM() {}, focusBlock() {} });
  return editor;
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

  it('save() keeps the note it started for when a switch starts before its frame', async () => {
    type(editor, 'captured');
    const saving = editor.save();
    const load = editor.loadNote('B');
    env.frames();
    await saving;
    await runUntil(env, load);

    assert.equal(editor.noteId, 'B');
    const rows = await elementsById(env);
    assert.deepEqual(rows.a1, { canvasId: 'A', content: 'captured' });
    assert.deepEqual(rows.b1, { canvasId: 'B', content: 'bravo' });
  });

  it('a save never pairs its note with another note\'s blocks', async () => {
    type(editor, 'captured');
    const saving = editor.save();
    // The 1.4.0 bug: the note changes before the save writes. loadNote writes
    // the note it leaves first; anything else changing it must not move blocks.
    const B = env.get('Block');
    editor.noteId = 'B';
    editor.noteData = await Storage.getNote('B');
    editor.blocks = (await Storage.getElementsByNote('B')).map((data) => B.deserialize(data));
    env.frames();
    await saving;

    const rows = await elementsById(env);
    assert.deepEqual(rows.b1, { canvasId: 'B', content: 'bravo' }, 'no B block moved to A');
    assert.deepEqual([rows.a1.canvasId, rows.a2.canvasId], ['A', 'A'], 'no A block moved to B');
    assert.equal((await Storage.getNote('A')).name, note('A').name, "A's record not overwritten with B's");
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
    assert.equal((await Storage.getNote('A')).preview, 'hidden tab', 'preview computed without a frame');
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

  it('pagehide (closing the tab) commits the pending edit\'s blocks before the handler returns (#33)', async () => {
    const opened = spyTransactions(Storage);
    const committed = spyCommits(Storage);
    type(editor, 'tab closing');
    env.window.fire('pagehide');
    assert.deepEqual(writesOf(opened), [{ stores: ['elements'], mode: 'readwrite' }], 'over the blocks alone');
    assert.deepEqual(committed, [['elements']], 'a closing page runs no more callbacks, so it commits now');
    await settle();
    assert.deepEqual((await elementsById(env)).a1, { canvasId: 'A', content: 'tab closing' });
    assert.equal((await Storage.getNote('A')).preview, '', "the note's record catches up on its next save");
  });

  it('pagehide writes nothing for a note the editor found deleted, as a closing write commits without the read that finds it gone (#33)', async () => {
    type(editor, 'typed into A');
    await Storage.permanentlyDeleteNote('A'); // another tab
    await runUntil(env, editor.flushSave());
    assert.equal(editor.noteGone, true, 'its save found A gone');
    type(editor, 'typed again');
    const opened = spyTransactions(Storage);
    env.window.fire('pagehide');
    assert.equal(writesOf(opened).length, 0);
    await settle();
    const rows = await elementsById(env);
    assert.equal(rows.a1, undefined, "A's blocks stay deleted");
    assert.equal(rows.a2, undefined);
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

  it("closing the pop-out writes its whole pending save, title included, as this page and its connection stay (#33)", async () => {
    const { pip, pipWindow } = await openPiP(env, 'C');
    pip.noteData.name = 'Renamed in the pop-out';
    type(pip, 'charlie in the pop-out');
    const opened = spyTransactions(Storage);
    const committed = spyCommits(Storage);
    pipWindow.fire('pagehide');
    assert.deepEqual(writesOf(opened), [{ stores: ['canvases', 'elements'], mode: 'readwrite' }],
      "the note's record and its blocks, opened before the handler returns");
    assert.deepEqual(committed, [], 'not the closing write: only the pop-out went');
    await settle();
    const stored = await Storage.getNote('C');
    assert.equal(stored.name, 'Renamed in the pop-out');
    assert.equal(stored.preview, 'charlie in the pop-out');
    assert.deepEqual((await elementsById(env)).c1, { canvasId: 'C', content: 'charlie in the pop-out' });
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

describe('BlockEditor deletes stay deleted', () => {
  let env;
  let Storage;
  let editor;

  beforeEach(async () => {
    ({ env, Storage } = await setup());
    editor = allowDeletes(makeEditor(env));
    await editor.loadNote('A');
  });

  it('a block deleted while a save waits for its frame is not written back', async () => {
    type(editor, 'alpha edited');
    env.clock.tick(500); // the save starts and waits for requestAnimationFrame
    assert.equal(env.pendingFrames(), 1);
    editor.deleteBlock('a2'); // deleteElement commits right away
    await settle();

    env.frames(); // the waiting save writes
    await settle();
    await runUntil(env, editor.flushSave()); // and so does the delete's own save

    const rows = await elementsById(env);
    assert.equal(rows.a2, undefined, 'a2 stays deleted');
    assert.deepEqual(rows.a1, { canvasId: 'A', content: 'alpha edited' });
    const fresh = makeEditor(env);
    await fresh.loadNote('A');
    assert.deepEqual(fresh.blocks.map((b) => b.id), ['a1'], 'a reload shows it gone');
  });

  it('with no frames running in the PiP window, closing it writes one fresh copy', async () => {
    const { pip, pipWindow } = await openPiP(env, 'A');

    // The PiP window paints no frames (minimized, say), so each save waits.
    type(pip, 'first');
    env.clock.tick(500);
    pip.deleteBlock('a2');
    await settle();
    env.clock.tick(500);
    type(pip, 'second');
    env.clock.tick(500);
    assert.equal(pipWindow.pendingFrames(), 3, 'three saves waiting for a frame');

    const opened = spyTransactions(Storage);
    const blockWrites = () => writesOf(opened).filter((t) => t.stores.includes('elements')).length;
    pipWindow.fire('pagehide');
    assert.equal(writesOf(opened).length, 1, 'one write, opened before the handler returned');
    await settle();
    pipWindow.frames(); // the waiting saves wake up much later
    await settle();
    assert.equal(blockWrites(), 1, 'the older copies are superseded');

    const rows = await elementsById(env);
    assert.equal(rows.a2, undefined, 'a2 stays deleted');
    assert.deepEqual(rows.a1, { canvasId: 'A', content: 'second' });
  });
});

describe('BlockEditor in a PiP window', () => {
  let env;
  let Storage;
  let editor;

  beforeEach(async () => {
    ({ env, Storage } = await setup());
    editor = makeEditor(env);
    await editor.loadNote('A');
  });

  it("saves on the PiP window's frames while the new tab paints none", async () => {
    const { pip, pipWindow } = await openPiP(env, 'C');
    type(pip, 'charlie in PiP');
    env.clock.tick(500);
    assert.equal(env.pendingFrames(), 0, 'nothing waits on the new tab, which is in the background');
    assert.equal(pipWindow.pendingFrames(), 1);

    pipWindow.frames();
    await settle();
    assert.deepEqual((await elementsById(env)).c1, { canvasId: 'C', content: 'charlie in PiP' });
  });

  it('when frames come back, only the newest waiting save of the note writes', async () => {
    const { pip, pipWindow } = await openPiP(env, 'C');
    for (const text of ['one', 'two', 'three']) {
      type(pip, text);
      env.clock.tick(500);
    }
    assert.equal(pipWindow.pendingFrames(), 3);

    const opened = spyTransactions(Storage);
    pipWindow.frames();
    await settle();
    assert.equal(writesOf(opened).filter((t) => t.stores.includes('elements')).length, 1, 'one write, not three');
    assert.deepEqual((await elementsById(env)).c1, { canvasId: 'C', content: 'three' });
  });

  it("the new tab's editors keep saving on the new tab's frames", async () => {
    type(editor, 'alpha in main');
    env.clock.tick(500);
    assert.equal(env.pendingFrames(), 1);
    env.frames();
    await settle();
    assert.deepEqual((await elementsById(env)).a1, { canvasId: 'A', content: 'alpha in main' });
  });
});

describe('BlockEditor saves of a deleted note', () => {
  let env;
  let Storage;
  let editor;
  let feedback;

  beforeEach(async () => {
    ({ env, Storage } = await setup());
    editor = allowDeletes(makeEditor(env));
    feedback = watchFeedback(env, editor);
    await editor.loadNote('A');
  });

  const stored = async () => {
    const db = await dumpDatabase(env.indexedDB);
    return { notes: recordsOf(db, 'canvases'), elements: Object.values(recordsOf(db, 'elements')) };
  };
  const noticeOf = (ed) => ed.root.querySelector('.note-gone-notice');

  it('an edit still pending when the note is deleted does not bring it back, and stays on screen with a notice', async () => {
    type(editor, 'typed before the delete');
    await Storage.permanentlyDeleteNote('A'); // emptying trash, or another tab
    await runUntil(env, editor.loadNote('B')); // the switch writes the pending edit

    const { notes, elements } = await stored();
    assert.equal(notes.A, undefined, 'A stays deleted');
    assert.deepEqual(elements.filter((el) => el.canvasId === 'A'), [], 'its blocks too');
    assert.equal(editor._retryPending, false, 'no retry');

    assert.equal(editor.noteId, 'A', 'the editor stays on the text instead of loading B');
    assert.equal(editor.blocks[0].content, 'typed before the delete');
    assert.equal(editor.noteGone, true);
    const notice = noticeOf(editor);
    assert.ok(notice, 'a notice says the text is not saved');
    assert.equal(notice.getAttribute('role'), 'alert');
    assert.equal(notice.querySelector('.note-gone-text').textContent, "This note was deleted, so these changes aren't saved.");
    assert.equal(notice.querySelector('.note-gone-btn').textContent, 'Save as a new note');
    assert.equal(feedback.statuses.at(-1), 'Not saved');
    assert.deepEqual(feedback.toasts, []);
  });

  it('"Save as a new note" keeps the text in a new active note, and later typing saves there', async () => {
    type(editor, 'typed before the delete');
    await Storage.permanentlyDeleteNote('A');
    await runUntil(env, editor.flushSave());
    assert.equal(editor.noteGone, true);

    noticeOf(editor).querySelector('.note-gone-btn').click();
    await runUntil(env, waitFor(() => !editor._savingAsNew && editor.noteId !== 'A', { message: 'the new note' }));

    const copyId = editor.noteId;
    assert.equal(editor.noteGone, false);
    assert.equal(noticeOf(editor), null, 'the notice is gone');
    let { notes, elements } = await stored();
    assert.equal(notes.A, undefined, 'A stays deleted');
    assert.equal(notes[copyId].name, 'Note A', 'the new note keeps the title');
    assert.equal(notes[copyId].trashed, undefined);
    assert.deepEqual(
      elements.filter((el) => el.canvasId === copyId).sort((a, b) => a.order - b.order).map((el) => el.content),
      ['typed before the delete', 'alpha two'],
    );

    type(editor, 'typed after saving it');
    await runUntil(env, editor.flushSave());
    ({ elements } = await stored());
    assert.ok(elements.some((el) => el.canvasId === copyId && el.content === 'typed after saving it'));
    assert.deepEqual(feedback.toasts, []);
  });

  it('a note picked while "Save as a new note" runs opens after it, and each note keeps its own blocks', async () => {
    type(editor, 'typed before the delete');
    await Storage.permanentlyDeleteNote('A');
    await runUntil(env, editor.flushSave());

    const saving = editor.saveAsNewNote();
    const load = editor.loadNote('B');
    await runUntil(env, Promise.all([saving, load]));

    assert.equal(editor.noteId, 'B');
    assert.deepEqual(editor.blocks.map((b) => b.id), ['b1']);
    const { notes, elements } = await stored();
    const copy = Object.values(notes).find((n) => n.name === 'Note A');
    assert.ok(copy, 'the text was saved as a new note');
    assert.ok(elements.some((el) => el.canvasId === copy.id && el.content === 'typed before the delete'));
    assert.deepEqual(elements.filter((el) => el.canvasId === 'B').map((el) => el.id), ['b1'], "B's block stays with B");
  });

  it('moving on from the notice loads the next note', async () => {
    type(editor, 'typed before the delete');
    await Storage.permanentlyDeleteNote('A');
    await runUntil(env, editor.flushSave());
    assert.equal(editor.noteGone, true);

    await runUntil(env, editor.loadNote('B'));
    assert.equal(editor.noteId, 'B');
    assert.equal(editor.noteGone, false);
    assert.equal(noticeOf(editor), null);
    assert.equal((await stored()).notes.A, undefined, 'A stays deleted');
  });

  it('trashing an empty untitled note while an edit is pending deletes it for good, and the editor keeps the text', async () => {
    const untitled = await Storage.createNote('Untitled');
    await runUntil(env, editor.loadNote(untitled.id));
    type(editor, 'typed into the untitled note');

    // Storage alone: with no stored content, trashNote deletes it. The app writes the edit first (forgetNotes).
    const trashed = await Storage.trashNote(untitled.id);
    assert.equal(trashed.permanentlyDeleted, true);
    await runUntil(env, editor.loadNote('B'));

    const { notes, elements } = await stored();
    assert.equal(notes[untitled.id], undefined, 'not back as an active note');
    assert.deepEqual(elements.filter((el) => el.canvasId === untitled.id), []);
    assert.equal(editor.noteId, untitled.id, 'the text stays on screen');
    assert.equal(editor.blocks[0].content, 'typed into the untitled note');
    assert.ok(noticeOf(editor));
    assert.deepEqual(feedback.toasts, []);
  });

  it('the retry of a note deleted meanwhile does not bring it back, and a toast says its last changes are lost', async () => {
    failWritesOf(Storage, 'A', 1);
    const load = editor.loadNote('B');
    type(editor, 'typed while switching');
    env.frames();
    await load;
    await settle();
    assert.equal(editor._retryPending, true, 'the failed save of A waits to retry');

    await Storage.permanentlyDeleteNote('A');
    env.clock.tick(1000);
    await runUntil(env, editor.flushSave());

    const { notes, elements } = await stored();
    assert.equal(notes.A, undefined);
    assert.deepEqual(elements.filter((el) => el.canvasId === 'A'), []);
    assert.deepEqual(feedback.toasts, [{ message: "A note you edited was deleted, so its last changes aren't saved.", kind: 'error' }]);
    assert.ok(!feedback.statuses.includes('Error saving'));
    assert.equal(editor.noteGone, false, 'the note on screen is fine');
    assert.equal(noticeOf(editor), null);
  });
});

describe('BlockEditor failed save before a note switch', () => {
  let env;
  let Storage;
  let editor;

  beforeEach(async () => {
    ({ env, Storage } = await setup());
    editor = makeEditor(env);
    await editor.loadNote('A');
  });

  /** Type into A while loadNote('B') reads B, so A's last write starts during the switch. */
  async function switchWhileTyping(text) {
    const load = editor.loadNote('B');
    type(editor, text);
    env.frames();
    await load;
    await settle();
    assert.equal(editor.noteId, 'B');
  }

  it('the retry writes the failed copy of the note that was left, not the note now open', async () => {
    const { statuses, toasts } = watchFeedback(env, editor);
    const attempts = failWritesOf(Storage, 'A', 1);
    await switchWhileTyping('typed while switching');
    assert.equal(statuses[statuses.length - 1], 'Retrying...');

    env.clock.tick(1000);
    await runUntil(env, editor.flushSave());

    const rows = await elementsById(env);
    assert.deepEqual(rows.a1, { canvasId: 'A', content: 'typed while switching' });
    assert.deepEqual(rows.b1, { canvasId: 'B', content: 'bravo' });
    assert.deepEqual(attempts, ['A', 'A'], "A's retry did not write B");
    assert.equal(statuses[statuses.length - 1], 'Saved');
    assert.deepEqual(toasts, []);
  });

  it('a second failure of that copy shows the error toast', async () => {
    const { statuses, toasts } = watchFeedback(env, editor);
    const attempts = failWritesOf(Storage, 'A', 2);
    await switchWhileTyping('never stored');

    env.clock.tick(1000);
    await runUntil(env, editor.flushSave());

    assert.deepEqual(attempts, ['A', 'A']);
    assert.equal(statuses[statuses.length - 1], 'Error saving');
    assert.deepEqual(plain(toasts), [{ message: 'Failed to save note. Please try again.', kind: 'error' }]);
    assert.deepEqual((await elementsById(env)).b1, { canvasId: 'B', content: 'bravo' });
  });

  it('typing in the open note before the retry fires keeps the retry', async () => {
    failWritesOf(Storage, 'A', 1);
    await switchWhileTyping('kept for the retry');

    type(editor, 'bravo edited'); // re-arms the shared timer at 500 ms
    env.clock.tick(500);
    await runUntil(env, editor.flushSave());

    const rows = await elementsById(env);
    assert.deepEqual(rows.a1, { canvasId: 'A', content: 'kept for the retry' });
    assert.deepEqual(rows.b1, { canvasId: 'B', content: 'bravo edited' });
  });

  it('flushSave counts that retry as pending', async () => {
    failWritesOf(Storage, 'A', 1);
    await switchWhileTyping('flushed retry');

    await runUntil(env, editor.flushSave()); // before the 1 s retry timer fires

    assert.deepEqual((await elementsById(env)).a1, { canvasId: 'A', content: 'flushed retry' });
    assert.equal(editor.saveTimeout, null, 'nothing left pending');
  });

  it('closing the tab writes that retry right away', async () => {
    failWritesOf(Storage, 'A', 1);
    await switchWhileTyping('retry on close');

    const opened = spyTransactions(Storage);
    env.window.fire('pagehide');
    assert.equal(writesOf(opened).length, 1, 'opened before the handler returned');
    await settle();
    assert.deepEqual((await elementsById(env)).a1, { canvasId: 'A', content: 'retry on close' });
  });
});

describe('BlockEditor reloading the open note', () => {
  let env;
  let Storage;
  let editor;

  beforeEach(async () => {
    ({ env, Storage } = await setup());
    editor = makeEditor(env);
    await editor.loadNote('A');
    // Another writer adds a block, as the AI insert does before it reloads the note.
    await Storage.saveElements([block('ai1', 'A', 5, 'from AI')]);
  });

  it('keeps an edit typed while the reload reads the note', async () => {
    const reload = editor.loadNote('A');
    type(editor, 'typed during reload');
    await runUntil(env, reload);

    assert.deepEqual(editor.blocks.map((b) => b.id), ['a1', 'a2', 'ai1'], 'the added block is loaded');
    assert.equal(editor.blocks[0].content, 'typed during reload', 'the edit is still in the editor');

    type(editor, 'alpha two edited', 1);
    env.clock.tick(500);
    await runUntil(env, editor.flushSave());
    const rows = await elementsById(env);
    assert.deepEqual(rows.a1, { canvasId: 'A', content: 'typed during reload' }, 'the next save keeps it');
    assert.deepEqual(rows.a2, { canvasId: 'A', content: 'alpha two edited' });
    assert.deepEqual(rows.ai1, { canvasId: 'A', content: 'from AI' });
  });

  it('keeps the blocks in the editor when edits keep racing the reads', async () => {
    const realRead = Storage.getElementsByNote.bind(Storage);
    let races = 0;
    Storage.getElementsByNote = async (id) => {
      const rows = await realRead(id);
      races += 1;
      type(editor, `race ${races}`);
      return rows;
    };
    const reload = editor.loadNote('A');
    await runUntil(env, reload);
    Storage.getElementsByNote = realRead;

    assert.equal(editor.blocks[0].content, `race ${races}`, 'the newest edit is still in the editor');
    await runUntil(env, editor.flushSave());
    const rows = await elementsById(env);
    assert.deepEqual(rows.a1, { canvasId: 'A', content: `race ${races}` });
    assert.deepEqual(rows.ai1, { canvasId: 'A', content: 'from AI' }, 'the added block stays stored');
  });
});

describe('BlockEditor saves keep trash and archive state', () => {
  let env;
  let Storage;
  let editor;

  beforeEach(async () => {
    ({ env, Storage } = await setup());
    editor = makeEditor(env);
    await editor.loadNote('A');
  });

  /** Change the stored note the way another tab, trash, or an import does. */
  async function storeFlags(flags) {
    const stored = await Storage.getNote('A');
    for (const [key, value] of Object.entries(flags)) {
      if (value === undefined) delete stored[key];
      else stored[key] = value;
    }
    await Storage.updateNote(stored);
  }

  async function saveEdit(text) {
    type(editor, text);
    env.clock.tick(500);
    await runUntil(env, editor.flushSave());
    return Storage.getNote('A');
  }

  it('an older copy of the note in the editor cannot take it out of trash', async () => {
    await storeFlags({ trashed: true, trashedAt: 42, archived: false, archivedAt: null });
    const stored = await saveEdit('edited in an older copy');
    assert.equal(stored.trashed, true);
    assert.equal(stored.trashedAt, 42);
    assert.equal(editor.noteData.trashed, true, 'the editor picks up the stored state');
    assert.deepEqual((await elementsById(env)).a1, { canvasId: 'A', content: 'edited in an older copy' });
  });

  it('or out of the archive', async () => {
    await storeFlags({ archived: true, archivedAt: 7 });
    const stored = await saveEdit('edited while archived elsewhere');
    assert.equal(stored.archived, true);
    assert.equal(stored.archivedAt, 7);
  });

  it('or back into trash after a restore', async () => {
    editor.adoptNoteFlags({ trashed: true, trashedAt: 42, archived: false, archivedAt: null });
    await storeFlags({ trashed: undefined, trashedAt: undefined });
    const stored = await saveEdit('edited after a restore');
    assert.equal(stored.trashed, undefined);
    assert.equal(stored.trashedAt, undefined);
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

  it('a save that comes due while held waits for release and keeps the import\'s trash flags', async () => {
    const opened = spyTransactions(Storage);
    editor.holdSaves();
    type(editor, 'typed during import');
    env.clock.tick(500);
    env.frames();
    await settle();
    assert.equal(writesOf(opened).length, 0, 'held');

    // The import commit trashes A, then the editor takes on the same flags.
    const flags = { trashed: true, trashedAt: 123, archived: false, archivedAt: null };
    await Storage.updateNote({ ...(await Storage.getNote('A')), ...flags });
    const writesBeforeRelease = writesOf(opened).length;
    editor.adoptNoteFlags(flags);
    editor.releaseSaves();
    env.frames();
    await editor.flushSave();

    assert.ok(writesOf(opened).length > writesBeforeRelease, 'the held save ran after release');
    const stored = await Storage.getNote('A');
    assert.equal(stored.trashed, true);
    assert.equal(stored.trashedAt, 123);
    assert.equal(editor.noteData.trashed, true);
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
