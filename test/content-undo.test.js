'use strict';

// Content undo across a note switch (a 1.4.x fix, #12's harness list): the editor groups a
// block's keystrokes into one undo step 600 ms after the last one. Loading a note empties the
// undo history and the groups waiting, so a group's timer that fires after a load does nothing,
// even when the note that's open again is the one it was typed in. 1.4.x's timer read its group
// back from the emptied map, and threw, whenever the note was opened again inside the 600 ms.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  createLegacyEnv, FakeDocument, createDatabase, note, block, startEditorClient, quietNavigation,
} = require('./helpers/legacy-env');

const FILES = ['js/utils.js', 'js/core/storage-error.js', 'js/storage.js', 'js/sidebar-utils.js', 'js/blocks.js', 'js/shortcut-utils.js', 'js/editor.js'];

/**
 * A BlockEditor on a page with two notes, Alpha (one block, `a1`) and Beta, open on Alpha. It's
 * built without its DOM constructor, as test/type-anywhere.test.js builds one: real loads,
 * rendering stubbed.
 */
async function editorOnAlpha() {
  const env = createLegacyEnv({ document: new FakeDocument() });
  await createDatabase(env.indexedDB, {
    records: {
      canvases: [note('A', { name: 'Alpha' }), note('B', { name: 'Beta' })],
      elements: [block('a1', 'A', 0, 'Alpha body'), block('b1', 'B', 0, 'Beta body')],
    },
  });
  env.load(...FILES);
  await env.get('Storage').init();
  const documentClient = await startEditorClient(env);
  const doc = env.document;
  const editor = Object.create(env.get('BlockEditor').prototype);
  const noop = () => {};
  Object.assign(editor, {
    root: doc.body, doc, documentClient, navigation: quietNavigation(), noteId: null, noteData: null, blocks: [], titleEl: { textContent: '' },
    container: { querySelector: () => null, querySelectorAll: () => [] }, insightsPollingId: null,
    undoStack: [], redoStack: [], _contentUndoPending: {}, selectedBlockIds: new Set(), _snapshotDirty: false,
    _snapshotInterval: null, hasReceivedFirstContent: false, pendingAutoTitle: false,
  });
  editor._initPersistenceState();
  Object.assign(editor, {
    renderBlocks: noop, renderBacklinks: noop, updateTimestampDisplay: noop, updateSaveStatus: noop, clearBlockSelection: noop,
    placeCaretAtEnd: noop, renderInsights: async () => {}, startInsightsPollingIfNeeded: async () => {},
  });
  await editor.loadNote('A');
  return { env, editor };
}

/** Type `text` at the end of the open note's block `blockId`, as the editor's input handler records it */
function type(editor, blockId, text) {
  const target = editor.getBlockById(blockId);
  const before = editor.snapshotBlock(target);
  target.content += text;
  editor._recordContentUndo(blockId, before);
}

describe('content undo across a note switch', () => {
  it('a group typed just before a switch does nothing when its time comes after Alpha is open again', async () => {
    const { env, editor } = await editorOnAlpha();
    type(editor, 'a1', ' then a switch');
    await editor.loadNote('B');
    await editor.loadNote('A');
    // 1.4.x threw here: the timer found Alpha's block, and no group in the emptied map
    assert.doesNotThrow(() => env.clock.tick(600));
    assert.equal(editor.undoStack.length, 0, 'the undo history the load emptied stays empty');
    assert.deepEqual(Object.keys(editor._contentUndoPending), []);
  });

  it('a group typed after Alpha is open again keeps its own before, and becomes one undo step', async () => {
    const { env, editor } = await editorOnAlpha();
    type(editor, 'a1', ' one');
    env.clock.tick(300);
    await editor.loadNote('B');
    await editor.loadNote('A');
    type(editor, 'a1', ' two');
    // The first group's time: it leaves the new group alone
    env.clock.tick(300);
    assert.equal(editor.undoStack.length, 0);
    assert.deepEqual(Object.keys(editor._contentUndoPending), ['a1']);
    // The new group's time
    env.clock.tick(300);
    assert.equal(editor.undoStack.length, 1);
    assert.equal(editor.undoStack[0].before.content, 'Alpha body');
    assert.equal(editor.undoStack[0].after.content, 'Alpha body two');
    assert.deepEqual(Object.keys(editor._contentUndoPending), []);
  });
});
