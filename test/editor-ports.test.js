'use strict';

// #12 slice 4b: BlockEditor asks the page around it through the navigation port App and
// TabController give it, in place of getApp's window.app lookup. A backlink opens its note
// through it: 1.4.x called an App.openNote that never existed (e2e/backlinks.spec.js runs the
// click in the built extension).

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  createLegacyEnv, createDatabase, note, block, makeEditor, quietNavigation, runUntil, settle, startEditorClient,
} = require('./helpers/legacy-env');

const FILES = [
  'js/utils.js',
  'js/core/storage-error.js',
  'js/storage.js',
  'js/sidebar-utils.js',
  'js/blocks.js',
  'js/editor.js',
];

/** A started page with note A, which note B links to, and an editor on A with `navigation` */
async function editorOnA() {
  const env = createLegacyEnv();
  await createDatabase(env.indexedDB, {
    records: {
      canvases: [note('A', { name: 'Alpha' }), note('B', { name: 'Bravo' })],
      elements: [block('a1', 'A', 0, 'alpha'), block('b1', 'B', 0, 'See [[Alpha]]')],
      links: [{ id: 'l1', fromNoteId: 'B', toNoteId: 'A', createdAt: 1 }],
    },
  });
  env.load(...FILES);
  await startEditorClient(env);
  const navigation = quietNavigation();
  const editor = makeEditor(env, env.document, { navigation });
  return { env, navigation, editor };
}

describe('BlockEditor asks the page through its navigation port', () => {
  it('a backlink opens the note that links here', async () => {
    const { env, navigation, editor } = await editorOnA();
    // The pane's backlinks panel, rendered for real
    const panel = editor.root.appendChild(env.document.createElement('div'));
    panel.className = 'backlinks-panel hidden';
    const list = panel.appendChild(env.document.createElement('div'));
    list.className = 'backlinks-list';
    editor.renderBacklinks = env.get('BlockEditor').prototype.renderBacklinks;
    await editor.loadNote('A');
    await settle();

    assert.equal(panel.classList.contains('hidden'), false);
    const items = list.querySelectorAll('.backlink-item');
    assert.deepEqual(items.map(item => item.textContent.trim()), ['Bravo']);
    items[0].click();
    assert.deepEqual(navigation.calls, [['openNote', 'B']]);
  });

  it('a wiki link opens the note it names', async () => {
    const { env, navigation, editor } = await editorOnA();
    await editor.loadNote('A');
    const link = env.document.createElement('span');
    link.className = 'wiki-link';
    link.dataset.noteName = 'Bravo';
    editor.onBlockClick({ target: link, preventDefault() {} });
    assert.deepEqual(navigation.calls, [['openNoteByName', 'Bravo']]);
  });

  it("a title edit renames the note's tab, and its save tells search and the sidebar", async () => {
    const { env, navigation, editor } = await editorOnA();
    await editor.loadNote('A');
    editor.titleEl.textContent = 'Alpha renamed';
    editor.onTitleChange();
    await runUntil(env, editor.flushSave());
    const [renamed, saved, ...rest] = navigation.calls;
    assert.deepEqual(renamed, ['titleChanged', 'Alpha renamed']);
    assert.deepEqual([saved[0], saved[1].id, saved[1].name], ['noteSaved', 'A', 'Alpha renamed']);
    assert.deepEqual(rest, []);
  });
});
