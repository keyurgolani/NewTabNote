'use strict';

// AC1: switching notes, switching panes, closing the tab, or closing the PiP
// window inside the 500 ms debounce never moves a block to another note and
// keeps the last edit. Overlapping loadNote calls end on the later note.

const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const {
  createLegacyEnv, createDatabase, dumpDatabase, recordsOf, settle, waitFor, plain, note, block, FakeDocument, makeEditor,
  runUntil, startEditorClient, startNewTabKernel, quietNavigation,
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
  await startEditorClient(env);
  return { env, Storage };
}

/** canvasId and content of every element, by element ID. */
async function elementsById(env) {
  const rows = recordsOf(await dumpDatabase(env.indexedDB), 'elements');
  return Object.fromEntries(Object.entries(rows).map(([id, el]) => [id, { canvasId: el.canvasId, content: el.content }]));
}

/**
 * Make the next `times` saves of `noteId` fail, as a full disk does: the page's document
 * client answers them `unavailable`, as the kernel does when the transaction fails.
 * @returns {Array<string>} The note ID of every save attempted
 */
function failWritesOf(env, noteId, times) {
  const client = env.documentClient;
  const real = client.saveContent;
  const attempts = [];
  let left = times;
  client.saveContent = (save) => {
    attempts.push(save.noteId);
    if (save.noteId === noteId && left > 0) {
      left -= 1;
      return Promise.resolve({ kind: 'unavailable', cause: 'quota', code: 'quota', retryable: false });
    }
    return real(save);
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
    failWritesOf(env, 'A', 1);

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
    failWritesOf(env, 'A', 1);
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
    failWritesOf(env, 'A', 1);
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
    const attempts = failWritesOf(env, 'A', 1);
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
    const attempts = failWritesOf(env, 'A', 2);
    await switchWhileTyping('never stored');

    env.clock.tick(1000);
    await runUntil(env, editor.flushSave());

    assert.deepEqual(attempts, ['A', 'A']);
    assert.equal(statuses[statuses.length - 1], 'Error saving');
    assert.deepEqual(plain(toasts), [{ message: 'Failed to save note. Please try again.', kind: 'error' }]);
    assert.deepEqual((await elementsById(env)).b1, { canvasId: 'B', content: 'bravo' });
  });

  it('typing in the open note before the retry fires keeps the retry', async () => {
    failWritesOf(env, 'A', 1);
    await switchWhileTyping('kept for the retry');

    type(editor, 'bravo edited'); // re-arms the shared timer at 500 ms
    env.clock.tick(500);
    await runUntil(env, editor.flushSave());

    const rows = await elementsById(env);
    assert.deepEqual(rows.a1, { canvasId: 'A', content: 'kept for the retry' });
    assert.deepEqual(rows.b1, { canvasId: 'B', content: 'bravo edited' });
  });

  it('flushSave counts that retry as pending', async () => {
    failWritesOf(env, 'A', 1);
    await switchWhileTyping('flushed retry');

    await runUntil(env, editor.flushSave()); // before the 1 s retry timer fires

    assert.deepEqual((await elementsById(env)).a1, { canvasId: 'A', content: 'flushed retry' });
    assert.equal(editor.saveTimeout, null, 'nothing left pending');
  });

  it('closing the tab writes that retry right away', async () => {
    failWritesOf(env, 'A', 1);
    await switchWhileTyping('retry on close');

    const opened = spyTransactions(Storage);
    env.window.fire('pagehide');
    assert.equal(writesOf(opened).length, 1, 'opened before the handler returned');
    await settle();
    assert.deepEqual((await elementsById(env)).a1, { canvasId: 'A', content: 'retry on close' });
  });
});

describe('BlockEditor flushSave answers whether what it holds is stored (#27 slice 3b)', () => {
  let env;
  let editor;

  beforeEach(async () => {
    ({ env } = await setup());
    editor = allowDeletes(makeEditor(env));
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

  it('answers true with nothing pending, and once a pending edit is written', async () => {
    assert.equal(await runUntil(env, editor.flushSave()), true);
    type(editor, 'written by the flush');
    assert.equal(await runUntil(env, editor.flushSave()), true);
    assert.deepEqual((await elementsById(env)).a1, { canvasId: 'A', content: 'written by the flush' });
  });

  it('answers true when a write fails and its one-second retry stores it', async () => {
    failWritesOf(env, 'A', 1);
    type(editor, 'stored by the retry');
    assert.equal(await runUntil(env, editor.flushSave()), true);
    assert.deepEqual((await elementsById(env)).a1, { canvasId: 'A', content: 'stored by the retry' });
  });

  it('answers false when the retry fails too, and keeps answering false until a later save stores the edit', async () => {
    const { statuses } = watchFeedback(env, editor);
    failWritesOf(env, 'A', 2);
    type(editor, 'not stored');
    assert.equal(await runUntil(env, editor.flushSave()), false);
    assert.equal(statuses.at(-1), 'Error saving');
    assert.equal(await runUntil(env, editor.flushSave()), false, 'nothing is pending, and the edit still is not stored');

    type(editor, 'stored at last');
    assert.equal(await runUntil(env, editor.flushSave()), true);
    assert.deepEqual((await elementsById(env)).a1, { canvasId: 'A', content: 'stored at last' });
  });

  it("answers false for the failed copy of a note the editor left, which isn't stored", async () => {
    failWritesOf(env, 'A', 2);
    await switchWhileTyping('left unsaved');
    env.clock.tick(1000);
    assert.equal(await runUntil(env, editor.flushSave()), false);
    assert.deepEqual((await elementsById(env)).a1, { canvasId: 'A', content: 'alpha' });
  });

  it('answers false while a deleted note keeps its unsaved text on screen', async () => {
    type(editor, 'typed before the delete');
    await env.get('Storage').permanentlyDeleteNote('A');
    assert.equal(await runUntil(env, editor.flushSave()), false);
    assert.equal(editor.noteGone, true);
  });

  it('a quiet flush says a failed retry once: the save status, and no toast', async () => {
    const { statuses, toasts } = watchFeedback(env, editor);
    failWritesOf(env, 'A', 2);
    type(editor, 'not stored, said once');
    assert.equal(await runUntil(env, editor.flushSave({ quiet: true })), false);
    assert.equal(statuses.at(-1), 'Error saving');
    assert.deepEqual(toasts, []);

    // A flush that isn't quiet shows the toast as before
    type(editor, 'still not stored');
    failWritesOf(env, 'A', 2);
    assert.equal(await runUntil(env, editor.flushSave()), false);
    assert.deepEqual(plain(toasts), [{ message: 'Failed to save note. Please try again.', kind: 'error' }]);
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
    const client = env.documentClient;
    const realRead = client.openNote;
    let races = 0;
    client.openNote = async (id) => {
      const opened = await realRead(id);
      races += 1;
      type(editor, `race ${races}`);
      return opened;
    };
    const reload = editor.loadNote('A');
    await runUntil(env, reload);
    client.openNote = realRead;

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
    assert.deepEqual((await elementsById(env)).a1, { canvasId: 'A', content: 'edited in an older copy' });
    // A save writes no trash or archive field at all, so the next one keeps the trash too
    const again = await saveEdit('edited again');
    assert.deepEqual([again.trashed, again.trashedAt], [true, 42]);
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

  /** Refresh insights, with an AI that finds one to-do */
  async function refreshInsights() {
    editor.ai = { isConfigured: () => true, extractInsights: async () => ({ todos: ['call'] }) };
    await runUntil(env, editor.refreshInsights());
    return Storage.getNote('A');
  }

  it('Refresh insights after a save keeps a trash made elsewhere, and writes the insights', async () => {
    await storeFlags({ trashed: true, trashedAt: 42, archived: false, archivedAt: null });
    await saveEdit('edited after the trash, long enough for insights');
    const stored = await refreshInsights();
    assert.deepEqual([stored.trashed, stored.trashedAt], [true, 42]);
    assert.deepEqual(plain(stored.insights), { todos: ['call'] });
    assert.equal(typeof stored.lastInsightsExtractedAt, 'number');
  });

  it('Refresh insights after a save keeps an archive made elsewhere', async () => {
    await storeFlags({ archived: true, archivedAt: 7 });
    await saveEdit('edited after the archive, long enough for insights');
    const stored = await refreshInsights();
    assert.deepEqual([stored.archived, stored.archivedAt], [true, 7]);
  });

  it('a snapshot revert keeps a trash made elsewhere, and writes the snapshot title', async () => {
    await storeFlags({ trashed: true, trashedAt: 42, archived: false, archivedAt: null });
    await saveEdit('edited after the trash');
    await runUntil(env, env.documentClient.saveSnapshot('A', [{ id: 'a1', type: 'text', content: 'restored' }], 'From the snapshot'));
    const [summary] = await runUntil(env, env.documentClient.snapshots('A'));
    await runUntil(env, editor._revertToSnapshot(summary));
    const stored = await Storage.getNote('A');
    assert.deepEqual([stored.trashed, stored.trashedAt, stored.name], [true, 42, 'From the snapshot']);
    assert.deepEqual((await elementsById(env)).a1, { canvasId: 'A', content: 'restored' });
  });

  it('Refresh insights on a note deleted meanwhile leaves it deleted', async () => {
    await saveEdit('edited before the delete, long enough for insights');
    await Storage.permanentlyDeleteNote('A');
    assert.equal(await refreshInsights(), undefined);
  });
});

describe('BlockEditor template inserts (#12)', () => {
  it("inserts a template's blocks in the order 1.4.x read them, by id, which R1 keeps", async () => {
    const { env } = await setup();
    // The template's blocks were dragged around: t1 shows second, t2 first. Their ids have the
    // form 1.4.x's Utils.generateId gave every block, which begins with when it was made.
    const Storage = env.get('Storage');
    await Storage.updateNote({ ...(await Storage.getNote('C')), isTemplate: true });
    await Storage.saveElements([
      block('1700000000000-t1aaaaaaa', 'C', 1, 'second shown'),
      block('1700000005000-t2bbbbbbb', 'C', 0, 'first shown'),
    ]);
    await Storage.deleteElements(['c1']);
    const editor = Object.assign(makeEditor(env), { hideTemplateMenu() {}, focusBlock() {} });
    await editor.loadNote('A');
    // The caret is in A's first block, where "/template" was typed
    const blockEl = { dataset: { id: 'a1' }, querySelector: () => ({ textContent: '/template' }) };
    editor.doc.defaultView.getSelection = () => ({
      rangeCount: 1,
      getRangeAt: () => ({ startContainer: { parentElement: { closest: () => blockEl } } }),
    });
    await runUntil(env, editor.selectTemplateItem('C'));
    await runUntil(env, editor.flushSave());

    const inserted = editor.blocks.slice(1, 3).map((b) => b.content);
    assert.deepEqual(inserted, ['second shown', 'first shown']);
    const stored = (await Storage.getElementsByNote('A')).sort((a, b) => a.order - b.order).map((b) => b.content);
    assert.deepEqual(plain(stored).slice(1, 3), ['second shown', 'first shown'], 'and saves them in that order');
  });

  it('inserts them in the order they were made when legacy and UUID ids mix, as 1.4.x did by id (#17 PR 2a)', async () => {
    const { env } = await setup();
    const Storage = env.get('Storage');
    await Storage.updateNote({ ...(await Storage.getNote('C')), isTemplate: true });
    // Two blocks from 1.4.x, whose ids sort by time, then two a 2a build made, whose UUIDs don't:
    // one typed, and one captured, which has no createdAt and keeps its capture time as order
    await Storage.saveElements([
      block('1700000000000-aaaaaaaaa', 'C', 3, 'made first', { createdAt: 1700000000000 }),
      block('0f2c41aa-0000-4000-8000-000000000003', 'C', 0, 'made third', { createdAt: 1700000002000 }),
      block('1700000001000-bbbbbbbbb', 'C', 2, 'made second', { createdAt: 1700000001000 }),
      block('00a1b2c3-0000-4000-8000-000000000004', 'C', 1700000003000, 'captured last', { createdAt: undefined }),
    ]);
    await Storage.deleteElements(['c1']);
    const editor = Object.assign(makeEditor(env), { hideTemplateMenu() {}, focusBlock() {} });
    await editor.loadNote('A');
    const blockEl = { dataset: { id: 'a1' }, querySelector: () => ({ textContent: '/template' }) };
    editor.doc.defaultView.getSelection = () => ({
      rangeCount: 1,
      getRangeAt: () => ({ startContainer: { parentElement: { closest: () => blockEl } } }),
    });
    await runUntil(env, editor.selectTemplateItem('C'));
    await runUntil(env, editor.flushSave());

    assert.deepEqual(editor.blocks.slice(1, 5).map((b) => b.content), ['made first', 'made second', 'made third', 'captured last']);
  });

  /**
   * "/template" with `templateId` in A's first block, in `editor` or a new one; the text of the
   * `count` blocks it puts in
   */
  async function insertTemplate(env, templateId, count, editor = Object.assign(makeEditor(env), { hideTemplateMenu() {}, focusBlock() {} })) {
    await editor.loadNote('A');
    const blockEl = { dataset: { id: 'a1' }, querySelector: () => ({ textContent: '/template' }) };
    editor.doc.defaultView.getSelection = () => ({
      rangeCount: 1,
      getRangeAt: () => ({ startContainer: { parentElement: { closest: () => blockEl } } }),
    });
    await runUntil(env, editor.selectTemplateItem(templateId));
    await runUntil(env, editor.flushSave());
    return editor.blocks.slice(1, 1 + count).map((b) => b.content);
  }

  it('puts the copies 1.4.x made from a template after the blocks typed before them, by the time in their ids (#17 PR 2a)', async () => {
    const { env } = await setup();
    const Storage = env.get('Storage');
    await Storage.updateNote({ ...(await Storage.getNote('C')), isTemplate: true });
    // Two blocks typed in the template, then another template put in after them. 1.4.x gave each
    // copy a new id, which begins with when it went in, and kept the createdAt of the block it
    // copied, from before the typed ones. Both copies went in within one millisecond, where 1.4.x's
    // id order fell to the random rest of each id: their order breaks that tie.
    await Storage.saveElements([
      block('1700000100000-k2m9x0a1b', 'C', 0, 'typed first', { createdAt: 1700000100000 }),
      block('1700000101000-a0b1c2d3e', 'C', 1, 'typed second', { createdAt: 1700000101000 }),
      block('1700000200000-zz9y8x7w6', 'C', 2, 'copy put in first', { createdAt: 1700000000000 }),
      block('1700000200000-aa1b2c3d4', 'C', 3, 'copy put in second', { createdAt: 1700000000500 }),
    ]);
    await Storage.deleteElements(['c1']);

    assert.deepEqual(await insertTemplate(env, 'C', 4), ['typed first', 'typed second', 'copy put in first', 'copy put in second']);
  });

  it('puts UUID captures in the order they were captured, after the editor has saved them (#17 PR 2a)', async () => {
    const { env } = await setup();
    const Storage = env.get('Storage');
    const { captureBlock } = await import('../js/kernel/core/domain/note.js');
    await Storage.updateNote({ ...(await Storage.getNote('C')), isTemplate: true });
    // Two captures a minute apart, as the kernel stores them, whose UUIDs sort the other way
    const capturedAt = 1761800000000;
    const first = 'f0000000-0000-4000-8000-000000000001';
    const second = '00000000-0000-4000-8000-000000000002';
    await Storage.saveElements([
      captureBlock({ id: first, noteId: 'C', capture: { type: 'text', content: 'captured first' }, now: capturedAt }),
      captureBlock({ id: second, noteId: 'C', capture: { type: 'text', content: 'captured second' }, now: capturedAt + 60_000 }),
    ]);
    await Storage.deleteElements(['c1']);
    // The editor loads both at one moment, an hour later, and the second is moved up. The save
    // gives each block its place as its order, and a createdAt: the one it has, else the load's.
    const editor = Object.assign(makeEditor(env), { hideTemplateMenu() {}, focusBlock() {} });
    const PageDate = env.get('Date');
    const realNow = PageDate.now;
    PageDate.now = () => capturedAt + 3_600_000;
    try {
      await editor.loadNote('C');
    } finally {
      PageDate.now = realNow;
    }
    editor.moveBlockByDirection(second, -1);
    env.clock.tick(500);
    await runUntil(env, editor.flushSave());
    const saved = (await Storage.getElementsByNote('C')).sort((a, b) => a.order - b.order);
    assert.deepEqual(saved.map((b) => b.content), ['captured second', 'captured first'], 'the save keeps the move');

    assert.deepEqual(await insertTemplate(env, 'C', 2, editor), ['captured first', 'captured second']);
  });
});

describe("the search index's and the embeddings' text, in the order a note's blocks were made (#17 PR 2a)", () => {
  const made = 'made first made second made third';

  /** NotesManager on a note whose blocks' key order is the reverse of the order they were made */
  async function manager() {
    const env = createLegacyEnv();
    await createDatabase(env.indexedDB, {
      records: {
        canvases: [note('N', { name: 'Reading list' })],
        // Two UUID blocks, the second moved up, then a copy 1.4.x made from a template, which
        // kept the createdAt of the block it copied
        elements: [
          block('ffffffff-0000-4000-8000-000000000001', 'N', 1, 'made first', { createdAt: 1700000001000 }),
          block('cccccccc-0000-4000-8000-000000000002', 'N', 0, 'made second', { createdAt: 1700000002000 }),
          block('1700000003000-abcdefghi', 'N', 2, 'made third', { createdAt: 1600000000000 }),
        ],
      },
    });
    env.load('js/utils.js', 'js/core/storage-error.js', 'js/storage.js', 'js/controllers/notes-manager.js');
    const Storage = env.get('Storage');
    await Storage.init();
    // The page's document client, which NotesManager reads a note's blocks through
    await startEditorClient(env);
    const quiet = { debug() {}, info() {}, warn() {}, error() {} };
    const notes = new (env.get('NotesManager'))({
      storage: Storage,
      domRefs: null,
      logger: quiet,
      llm: null,
      documentClient: env.documentClient,
    });
    const active = [await Storage.getNote('N')];
    notes.noteList = { view: (which) => (which === 'active' ? active : []), settled: async () => {} };
    return { env, notes };
  }

  it('indexes UUID blocks and a copy 1.4.x made as 1.4.x did by id, not in their key or note order', async () => {
    const { notes } = await manager();
    const sent = [];
    notes.indexerWorker = { postMessage: (message) => sent.push(plain(message)) };
    await notes.rebuildSearchIndex();
    await notes.updateNoteIndex('N');

    // The indexer's own entries from what it was sent, by js/workers/indexer.js in a worker of its own.
    // It's a module worker whose first import is the network guard (#21 slice 1b), which
    // test/network-guard.test.js covers, so the rest runs here as a script.
    const indexer = createLegacyEnv({ context: 'worker' });
    const guardImport = "import '../kernel/composition/network-guard-first.js';\n";
    const source = fs.readFileSync(path.join(__dirname, '../js/workers/indexer.js'), 'utf8');
    assert.ok(source.includes(guardImport), 'the indexer imports the network guard first');
    vm.runInContext(source.replace(guardImport, ''), indexer.context);
    const answers = [];
    indexer.global.postMessage = (message) => answers.push(plain(message));
    for (const message of sent) indexer.global.onmessage({ data: message });
    assert.deepEqual(
      answers.map(({ type, data }) => [type, type === 'INDEX_COMPLETE' ? data.map((entry) => entry.content) : data.entry.content]),
      [['INDEX_COMPLETE', [made]], ['INDEX_UPDATED', made]],
    );
  });

  it('embeds them in that order too', async () => {
    const { env, notes } = await manager();
    const embedded = [];
    env.global.Embeddings = { generateEmbedding: async (text) => { embedded.push(text); return [1, 0]; } };
    let finished = false;
    const run = notes.updateMissingEmbeddings().finally(() => { finished = true; });
    // It waits 100 ms after a note
    for (let i = 0; i < 100 && !finished; i++) {
      env.clock.tick(100);
      await settle(2);
    }
    await run;
    assert.deepEqual(embedded, [`Reading list\n${made}`]);
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

/**
 * Record what each readwrite transaction puts, by store: `{stores, puts: [{store, record}]}`.
 * @returns {Array<{stores: Array<string>, puts: Array<{store: string, record: Object}>}>}
 */
function spyPuts(storage) {
  const db = storage.db;
  const original = db.transaction.bind(db);
  const writes = [];
  db.transaction = (stores, mode) => {
    const tx = original(stores, mode);
    if (mode !== 'readwrite') return tx;
    const entry = { stores: [].concat(stores), puts: [] };
    writes.push(entry);
    const objectStore = tx.objectStore.bind(tx);
    const spied = new Set();
    tx.objectStore = (name) => {
      const store = objectStore(name);
      if (spied.has(store)) return store;
      spied.add(store);
      const put = store.put.bind(store);
      store.put = (record, ...rest) => {
        entry.puts.push({ store: name, record: plain(record) });
        return put(record, ...rest);
      };
      return store;
    };
    return tx;
  };
  return writes;
}

/** Type a title, as the title element's input handler does. */
function typeTitle(editor, title) {
  editor.titleEl.textContent = title;
  editor.onTitleChange();
}

/** Give a note a search entry, as Storage.createNote does */
function putSearchEntry(Storage, noteId, name) {
  return new Promise((resolve, reject) => {
    const tx = Storage.db.transaction('search_index', 'readwrite');
    tx.objectStore('search_index').put({ noteId, name, content: '', updatedAt: 1 });
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

/** The search entry of a note, as stored */
function searchEntryOf(Storage, noteId) {
  return new Promise((resolve, reject) => {
    const request = Storage.db.transaction('search_index').objectStore('search_index').get(noteId);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

describe("BlockEditor saves write the note's content only (#12)", () => {
  let env;
  let Storage;
  let editor;

  beforeEach(async () => {
    ({ env, Storage } = await setup());
    editor = makeEditor(env);
    await editor.loadNote('A');
  });

  /** Type into A and let the save finish. */
  async function saveEdit(text) {
    type(editor, text);
    await runUntil(env, editor.flushSave());
    return Storage.getNote('A');
  }

  it("moving the open note into a folder survives the editor's next save", async () => {
    const folder = await Storage.createFolder('Work');
    await Storage.moveNoteToFolder('A', folder.id); // the sidebar's move
    const stored = await saveEdit('typed after the move');
    assert.equal(stored.folderId, folder.id, 'the save left the folder alone');
    assert.deepEqual((await elementsById(env)).a1, { canvasId: 'A', content: 'typed after the move' });
  });

  it("converting the open note to a template survives the editor's next save", async () => {
    // As NotesManager.convertNoteToTemplate writes it
    const stored = await Storage.getNote('A');
    Object.assign(stored, { isTemplate: true, folderId: null });
    await Storage.updateNote(stored);
    assert.equal((await saveEdit('typed after converting')).isTemplate, true, 'still a template');
  });

  it("pinning the open note survives the editor's next save", async () => {
    await Storage.updateNote({ ...(await Storage.getNote('A')), pinned: true }); // the sidebar's pin
    assert.equal((await saveEdit('typed after pinning')).pinned, true);
  });

  it('a title and text typed inside one debounce both land, in the one transaction that writes the blocks', async () => {
    const writes = spyPuts(Storage);
    typeTitle(editor, 'Groceries');
    type(editor, 'eggs');
    await runUntil(env, editor.flushSave());

    const saves = writes.filter((w) => w.puts.some((p) => p.store === 'elements'));
    assert.equal(saves.length, 1, 'one save');
    assert.deepEqual(saves[0].stores.slice().sort(), ['canvases', 'elements']);
    const written = saves[0].puts.find((p) => p.store === 'canvases').record;
    assert.equal(written.name, 'Groceries', 'the typed title went in with the blocks');
    assert.equal(written.titleManuallySet, true);
    assert.ok(saves[0].puts.some((p) => p.store === 'elements' && p.record.id === 'a1' && p.record.content === 'eggs'));
    const stored = await Storage.getNote('A');
    assert.deepEqual([stored.name, stored.titleManuallySet, stored.preview], ['Groceries', true, 'eggs']);
  });

  it("a content save of a note opened with its title marks nothing as set by hand, and moves updatedAt as Storage.saveNoteWithBlocks did", async () => {
    const writes = spyPuts(Storage);
    const before = Date.now();
    const stored = await saveEdit('content only');
    const after = Date.now();
    assert.deepEqual([stored.name, stored.titleManuallySet], ['Note A', false]);
    assert.ok(stored.updatedAt >= before && stored.updatedAt <= after, 'updatedAt is the time of the save');
    const written = writes.flatMap((w) => w.puts).filter((p) => p.store === 'canvases');
    assert.equal(written.length, 1, 'the note record is written once, with the blocks');
  });

  it('a content save after a generated title landed leaves it, and marks nothing as set by hand', async () => {
    // NotesManager's auto-title: it stores the title, then shows it in the editor
    await Storage.updateNote({ ...(await Storage.getNote('A')), name: 'Generated', lastAutoTitleAt: 5 });
    editor.setTitleProgrammatically('Generated');
    await runUntil(env, editor.flushSave());
    let stored = await Storage.getNote('A');
    assert.deepEqual([stored.name, stored.titleManuallySet], ['Generated', false]);

    stored = await saveEdit('typed after the title came');
    assert.deepEqual([stored.name, stored.titleManuallySet], ['Generated', false]);
  });

  it('a title element input that changes nothing sends no title', async () => {
    const writes = spyPuts(Storage);
    typeTitle(editor, 'Note A');
    type(editor, 'content');
    await runUntil(env, editor.flushSave());
    const stored = await Storage.getNote('A');
    assert.deepEqual([stored.name, stored.titleManuallySet], ['Note A', false]);
    assert.ok(writes.some((w) => w.puts.some((p) => p.store === 'elements')), 'the content was saved');
  });

  it('a save with no typed title leaves a rename made elsewhere, and marks nothing as set by hand', async () => {
    await Storage.updateNote({ ...(await Storage.getNote('A')), name: 'Renamed in the sidebar' });
    const stored = await saveEdit('typed after the rename');
    assert.equal(stored.name, 'Renamed in the sidebar');
    assert.equal(stored.titleManuallySet, false);
  });

  it('a title the AI set goes in with the blocks without marking it as set by hand', async () => {
    const writes = spyPuts(Storage);
    editor.setTitleProgrammatically('Weekly plan');
    type(editor, 'monday');
    await runUntil(env, editor.flushSave());

    const saves = writes.filter((w) => w.puts.some((p) => p.store === 'elements'));
    assert.equal(saves.length, 1);
    assert.equal(saves[0].puts.find((p) => p.store === 'canvases').record.name, 'Weekly plan');
    const stored = await Storage.getNote('A');
    assert.deepEqual([stored.name, stored.titleManuallySet, typeof stored.lastAutoTitleAt], ['Weekly plan', false, 'number']);
  });

  it('a typed title whose save failed goes in with the newer save that supersedes its retry', async () => {
    failWritesOf(env, 'A', 1);
    typeTitle(editor, 'Retried title');
    env.clock.tick(500);
    env.frames();
    await settle();
    assert.equal(editor._retryPending, true);
    type(editor, 'typed before the retry');
    await runUntil(env, editor.flushSave());
    const stored = await Storage.getNote('A');
    assert.deepEqual([stored.name, stored.titleManuallySet], ['Retried title', true]);
    assert.deepEqual((await elementsById(env)).a1, { canvasId: 'A', content: 'typed before the retry' });
  });

  it("a save renames the note's search entry and replaces its wiki links", async () => {
    await Storage.updateNote({ ...(await Storage.getNote('B')), name: 'Bravo' });
    await putSearchEntry(Storage, 'A', 'Note A');
    typeTitle(editor, 'Alpha');
    type(editor, 'see [[bravo]] and [[Alpha]]');
    await runUntil(env, editor.flushSave());
    assert.deepEqual(plain((await Storage.getBacklinks('B')).map((n) => n.id)), ['A'], 'a link to B, none to itself');
    assert.equal((await searchEntryOf(Storage, 'A')).name, 'Alpha');

    type(editor, 'no links now');
    await runUntil(env, editor.flushSave());
    assert.deepEqual(plain(await Storage.getBacklinks('B')), []);
  });
});

describe('BlockEditor "Save as a new note" (#12)', () => {
  let env;
  let Storage;
  let editor;

  /** A in a folder, pinned, its title set by hand, deleted with an edit pending; then "Save as a new note". */
  async function saveGoneNoteAsNew({ folderGone }) {
    ({ env, Storage } = await setup());
    const folder = await Storage.createFolder('Work');
    await Storage.updateNote({ ...(await Storage.getNote('A')), folderId: folder.id, pinned: true, titleManuallySet: true });
    editor = makeEditor(env);
    await editor.loadNote('A');
    type(editor, 'typed before the delete');
    if (folderGone) await Storage.deleteFolder(folder.id);
    await Storage.permanentlyDeleteNote('A');
    await runUntil(env, editor.flushSave());
    assert.equal(editor.noteGone, true);
    await runUntil(env, editor.saveAsNewNote());
    assert.notEqual(editor.noteId, 'A');
    return { folder, copy: await Storage.getNote(editor.noteId) };
  }

  it('keeps the pin, the hand-set title, and the folder', async () => {
    const { folder, copy } = await saveGoneNoteAsNew({ folderGone: false });
    assert.deepEqual([copy.name, copy.pinned, copy.titleManuallySet, copy.folderId], ['Note A', true, true, folder.id]);
    assert.ok((await Storage.getElementsByNote(copy.id)).some((el) => el.content === 'typed before the delete'));
    assert.equal((await searchEntryOf(Storage, copy.id)).name, 'Note A', 'with its search entry');
  });

  it('files the note at the root when its folder is gone', async () => {
    const { copy } = await saveGoneNoteAsNew({ folderGone: true });
    assert.deepEqual([copy.pinned, copy.titleManuallySet, copy.folderId], [true, true, null]);
    assert.ok((await Storage.getElementsByNote(copy.id)).some((el) => el.content === 'typed before the delete'));
  });
});

describe('BlockEditor when the page has to reload (#12)', () => {
  /** A new tab started by its own root, on A, with its editor */
  async function newTabOnA() {
    const env = createLegacyEnv();
    await createDatabase(env.indexedDB, {
      records: { canvases: [note('A')], elements: [block('a1', 'A', 0, 'alpha')] },
    });
    env.load(...FILES);
    const Storage = env.get('Storage');
    await startNewTabKernel(env);
    const navigation = quietNavigation();
    const editor = makeEditor(env, env.document, { navigation });
    const feedback = watchFeedback(env, editor);
    await runUntil(env, editor.loadNote('A'));
    return { env, Storage, navigation, editor, feedback };
  }

  /** A newer build opens the database at a higher version, as after an update in another tab */
  function upgradeElsewhere(env) {
    return new Promise((resolve, reject) => {
      const upgrade = env.indexedDB.open('CanvasTabDB', 9);
      upgrade.onsuccess = () => {
        upgrade.result.close();
        resolve();
      };
      upgrade.onerror = () => reject(upgrade.error);
      upgrade.onblocked = () => reject(new Error('the new tab held the database open'));
    });
  }

  it('an edit still in the debounce when another context upgrades is written before the connection closes', async () => {
    const { env, Storage, editor, feedback } = await newTabOnA();
    const opened = spyTransactions(Storage);
    type(editor, 'typed just before the upgrade');
    assert.notEqual(editor.saveTimeout, null, 'pending');
    await upgradeElsewhere(env);
    assert.equal(Storage.openState, 'version-changed', 'the connection closed');
    assert.deepEqual(writesOf(opened)[0], { stores: ['canvases', 'elements'], mode: 'readwrite' },
      'its transaction opened before the close');
    await runUntil(env, editor.flushSave());

    assert.deepEqual((await elementsById(env)).a1, { canvasId: 'A', content: 'typed just before the upgrade' }, 'committed');
    assert.equal(editor.saveTimeout, null);
    assert.equal(editor._retryPending, false, 'nothing retries');
    assert.equal(editor.root.querySelector('.reload-notice'), null, 'no notice until the next edit');
    assert.equal(feedback.statuses.at(-1), 'Saved');

    type(editor, 'typed after it');
    await runUntil(env, editor.flushSave());
    assert.ok(editor.root.querySelector('.reload-notice'), 'the next edit shows the reload notice');
    assert.equal(editor._retryPending, false, 'and nothing retries');
    assert.deepEqual((await elementsById(env)).a1, { canvasId: 'A', content: 'typed just before the upgrade' });
  });

  it("flushSave answers false once the page has to reload and holds an edit it can't store (#27 slice 3b)", async () => {
    const { env, editor } = await newTabOnA();
    await upgradeElsewhere(env);
    type(editor, 'typed after the upgrade');
    assert.equal(await runUntil(env, editor.flushSave()), false);
    assert.ok(editor.root.querySelector('.reload-notice'), 'the reload notice says so');
  });

  it('a save under way when another context upgrades is reported saved, and the next edit gets the notice', async () => {
    const { env, Storage, editor, feedback } = await newTabOnA();
    // The upgrade comes in the same task the save opens its transaction in
    const client = env.documentClient;
    const realSave = client.saveContent;
    let upgraded = null;
    client.saveContent = (save) => {
      const answer = realSave(save);
      client.saveContent = realSave;
      upgraded = upgradeElsewhere(env);
      return answer;
    };
    type(editor, 'typed and saving as the upgrade comes');
    env.clock.tick(500);
    env.frames();
    await runUntil(env, editor.flushSave());
    await upgraded;
    assert.equal(Storage.openState, 'version-changed');

    assert.deepEqual((await elementsById(env)).a1, { canvasId: 'A', content: 'typed and saving as the upgrade comes' });
    assert.equal(feedback.statuses.at(-1), 'Saved', 'what was stored is not reported as unsaved');
    assert.equal(editor.root.querySelector('.reload-notice'), null);
    assert.equal(editor._retryPending, false);

    type(editor, 'typed after it');
    await runUntil(env, editor.flushSave());
    assert.ok(editor.root.querySelector('.reload-notice'));
    assert.equal(feedback.statuses.at(-1), 'Not saved');
    assert.equal(editor._retryPending, false);
  });

  it('switching notes after another context upgraded keeps the note on screen and shows the reload notice', async () => {
    const { env, editor, feedback } = await newTabOnA();
    await upgradeElsewhere(env);
    assert.equal(await runUntil(env, editor.loadNote('B')), false, 'the switch reads nothing');
    assert.equal(editor.noteId, 'A', 'the note stays on screen');
    assert.ok(editor.root.querySelector('.reload-notice'), 'and the notice says why');
    assert.equal(feedback.statuses.at(-1), 'Not saved');
    assert.equal(editor._retryPending, false);
  });

  it('with nothing pending, the upgrade writes nothing before the connection closes', async () => {
    const { env, Storage } = await newTabOnA();
    const opened = spyTransactions(Storage);
    await upgradeElsewhere(env);
    assert.equal(Storage.openState, 'version-changed');
    assert.deepEqual(writesOf(opened), []);
  });

  it('a save after another context upgraded the database keeps the text and shows the reload notice', async () => {
    const { env, Storage, navigation, editor, feedback } = await newTabOnA();
    await upgradeElsewhere(env);
    assert.equal(Storage.openState, 'version-changed');

    type(editor, 'typed after the upgrade');
    await runUntil(env, editor.flushSave());

    assert.equal(editor.blocks[0].content, 'typed after the upgrade', 'the text stays on screen');
    assert.equal(editor.noteId, 'A');
    assert.equal(editor._retryPending, false, 'no retry, which would fail the same way');
    const notice = editor.root.querySelector('.reload-notice');
    assert.ok(notice, 'the reload notice shows');
    assert.equal(notice.getAttribute('role'), 'alert');
    assert.equal(notice.querySelector('.note-gone-text').textContent,
      "This page lost its connection to your notes, so these changes aren't saved. Copy anything you need, then reload.");
    assert.equal(notice.querySelector('.note-gone-btn').textContent, 'Reload');
    assert.equal(feedback.statuses.at(-1), 'Not saved');
    assert.deepEqual(feedback.toasts, []);

    // Another edit keeps the one notice
    type(editor, 'typed again');
    await runUntil(env, editor.flushSave());
    assert.equal(editor.root.querySelectorAll('.reload-notice').length, 1);

    notice.querySelector('.note-gone-btn').click();
    assert.deepEqual(navigation.calls.filter(([method]) => method === 'reloadPage'), [['reloadPage']]);
  });
});
