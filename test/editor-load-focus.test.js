'use strict';

// #197: a load's deferred focus of its first block keeps its own promise, loadFocus, which the tab
// bar's + waits for before it focuses the title. The promise settles once the deferred focus has
// run, and also when that focus throws, so + never waits on it forever.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  createLegacyEnv, createDatabase, note, block, makeEditor, settle, startEditorClient,
} = require('./helpers/legacy-env');

const FILES = [
  'js/utils.js',
  'js/core/storage-error.js',
  'js/storage.js',
  'js/sidebar-utils.js',
  'js/blocks.js',
  'js/editor.js',
];

/** A started page with note A, and an editor on its document */
async function editorOnA() {
  const env = createLegacyEnv();
  await createDatabase(env.indexedDB, {
    records: {
      canvases: [note('A', { name: 'Alpha' })],
      elements: [block('a1', 'A', 0, 'alpha')],
    },
  });
  env.load(...FILES);
  await startEditorClient(env);
  return { env, editor: makeEditor(env, env.document) };
}

/** Whether `promise` has settled once the microtasks and a few real timers have run */
async function settledYet(promise) {
  let settled = false;
  promise.then(() => { settled = true; }, () => { settled = true; });
  await settle();
  return settled;
}

describe("a load's deferred focus and loadFocus", () => {
  it('loadFocus settles once the deferred focus has run, and not before', async () => {
    const { env, editor } = await editorOnA();
    await editor.loadNote('A');
    assert.equal(await settledYet(editor.loadFocus), false, 'pending before the deferred focus');
    env.clock.tick(50);
    assert.equal(await settledYet(editor.loadFocus), true, 'settled after it');
  });

  it("loadFocus settles when the deferred focus throws, so the tab bar's + never waits on it forever", async () => {
    const { env, editor } = await editorOnA();
    await editor.loadNote('A');
    // The editor's own blocks aren't drawn here, so give the focus a first block to reach
    const first = editor.container.appendChild(env.document.createElement('div'));
    first.className = 'block-content';
    editor._focusInOverlay = () => { throw new Error('The overlay check fails'); };
    assert.throws(() => env.clock.tick(50), /The overlay check fails/);
    assert.equal(await settledYet(editor.loadFocus), true, 'settled after the deferred focus threw');
  });
});
