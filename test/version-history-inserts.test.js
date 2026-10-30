'use strict';

// #12 slice 4b2b: version history (snapshot, list, preview, revert) and AI chat's block
// inserts through the kernel. A revert rewrites a note's blocks, and an insert moves them,
// while the user may be typing, here or in another tab. T6 and T7 are plan 4b2.3's.

const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const {
  createLegacyEnv, createDatabase, settle, waitFor, plain, note, block, makeEditor, startEditorClient, runUntil,
} = require('./helpers/legacy-env');

const FILES = [
  'js/utils.js',
  'js/core/storage-error.js',
  'js/storage.js',
  'js/sidebar-utils.js',
  'js/blocks.js',
  'js/editor.js',
  'js/controllers/ai-chat-controller.js',
];

/** A page over `indexedDB` (a new one unless given), with Storage started and its document client */
async function page({ records, omit, shared } = {}) {
  const env = shared ? createLegacyEnv({ indexedDB: shared.indexedDB, chrome: shared.chrome }) : createLegacyEnv();
  if (!shared) await createDatabase(env.indexedDB, { records, omit });
  env.load(...FILES);
  const Storage = env.get('Storage');
  await Storage.init();
  await startEditorClient(env);
  const toasts = [];
  env.get('Utils').showToast = (message, kind) => toasts.push({ message, kind });
  return { env, Storage, toasts };
}

const RECORDS = {
  canvases: [note('A', { name: 'Groceries' }), note('B', { name: 'Work' })],
  elements: [block('a1', 'A', 0, 'Milk'), block('a2', 'A', 1, 'Eggs'), block('b1', 'B', 0, 'Plan')],
};

/** Type into a block of the loaded note, as onBlockInput does */
function type(editor, text, index = 0) {
  editor.blocks[index].content = text;
  editor.blocks[index].markUpdated();
  editor.scheduleSave();
}

/** Each stored block of `noteId` in note order, as [id, content] */
async function storedBlocks(Storage, noteId) {
  const blocks = plain(await Storage.getElementsByNote(noteId));
  return blocks.sort((a, b) => (a.order || 0) - (b.order || 0) || (a.id < b.id ? -1 : 1)).map((b) => [b.id, b.content]);
}

/** A snapshot of the note the editor holds, taken as the 5-minute interval takes it */
async function snapshotNow(env, editor) {
  editor._snapshotDirty = true;
  await runUntil(env, editor._autoSnapshot());
  const [summary] = await runUntil(env, env.documentClient.snapshots(editor.noteId));
  return summary;
}

describe('T6: a revert keeps what was done elsewhere and loses nothing typed', () => {
  let env;
  let Storage;
  let toasts;
  let editor;

  beforeEach(async () => {
    ({ env, Storage, toasts } = await page({ records: RECORDS }));
    editor = makeEditor(env);
    await editor.loadNote('A');
  });

  it('after a pin and a folder move, it keeps both and puts back the blocks and the title', async () => {
    const summary = await snapshotNow(env, editor);
    // The user goes on: a new title and new text, saved
    editor.titleEl.textContent = 'Shopping';
    editor.onTitleChange();
    type(editor, 'Oat milk');
    env.clock.tick(500);
    await runUntil(env, editor.flushSave());
    // Pinned in the sidebar, and moved into a folder from another tab
    await runUntil(env, env.kernel.execute({ type: 'setPinned', commandId: 'pin', noteId: 'A', pinned: true }));
    const moved = await Storage.getNote('A');
    moved.folderId = 'f1';
    await Storage.updateNote(moved);

    await runUntil(env, editor._revertToSnapshot(summary));

    const stored = plain(await Storage.getNote('A'));
    assert.deepEqual(
      [stored.name, stored.pinned, stored.folderId, stored.titleManuallySet],
      ['Groceries', true, 'f1', true],
    );
    assert.deepEqual(await storedBlocks(Storage, 'A'), [['a1', 'Milk'], ['a2', 'Eggs']]);
    assert.deepEqual([editor.titleEl.textContent, editor.blocks.map((b) => b.content)], ['Groceries', ['Milk', 'Eggs']]);
    assert.deepEqual(toasts.at(-1), { message: 'Reverted to snapshot', kind: 'success' });
    // What the note was before the revert is the newest snapshot
    const [pre] = await runUntil(env, env.documentClient.snapshots('A'));
    const kept = await runUntil(env, env.documentClient.snapshot(pre.id));
    assert.deepEqual([kept.title, kept.blocks.map((b) => b.content)], ['Shopping', ['Oat milk', 'Eggs']]);
  });

  it('with a save pending, the snapshot taken first holds the pending text, and nothing writes it back after', async () => {
    const summary = await snapshotNow(env, editor);
    type(editor, 'Typed just before the revert');
    // The debounce hasn't fired
    assert.equal(editor._hasPendingSave(), true);

    await runUntil(env, editor._revertToSnapshot(summary));
    env.clock.tick(2000);
    await runUntil(env, editor.flushSave());

    assert.deepEqual(await storedBlocks(Storage, 'A'), [['a1', 'Milk'], ['a2', 'Eggs']]);
    const [pre] = await runUntil(env, env.documentClient.snapshots('A'));
    const kept = await runUntil(env, env.documentClient.snapshot(pre.id));
    assert.deepEqual(kept.blocks.map((b) => b.content), ['Typed just before the revert', 'Eggs']);
  });

  it('text typed while the revert commits goes into version history, and no save puts the replaced blocks back', async () => {
    const summary = await snapshotNow(env, editor);
    const client = env.documentClient;
    const real = client.restoreSnapshot;
    let release;
    const held = new Promise((resolve) => { release = resolve; });
    client.restoreSnapshot = (...args) => {
      const outcome = real(...args);
      return held.then(() => outcome);
    };
    const reverting = editor._revertToSnapshot(summary);
    await waitFor(() => editor._savesHeld, { message: 'the revert to hold saves' });
    type(editor, 'Typed during the revert');
    env.clock.tick(600);
    release();
    await runUntil(env, reverting);
    client.restoreSnapshot = real;
    env.clock.tick(600);
    await runUntil(env, editor.flushSave());

    assert.deepEqual(await storedBlocks(Storage, 'A'), [['a1', 'Milk'], ['a2', 'Eggs']]);
    const summaries = await runUntil(env, env.documentClient.snapshots('A'));
    const contents = [];
    for (const { id } of summaries) {
      const snap = await runUntil(env, env.documentClient.snapshot(id));
      contents.push(snap.blocks[0].content);
    }
    assert.ok(contents.includes('Typed during the revert'), JSON.stringify(contents));
  });

  it('when the text on screen failed to save, nothing is reverted and the text stays', async () => {
    const summary = await snapshotNow(env, editor);
    const client = env.documentClient;
    const real = client.saveContent;
    client.saveContent = () => Promise.resolve({ kind: 'unavailable', cause: 'quota', code: 'quota', retryable: false });
    type(editor, 'Not stored');
    env.clock.tick(500);
    await runUntil(env, editor.flushSave());
    await runUntil(env, editor._revertToSnapshot(summary));
    client.saveContent = real;

    assert.equal(editor.blocks[0].content, 'Not stored');
    assert.deepEqual(toasts.at(-1), { message: 'Failed to revert to snapshot', kind: 'error' });
    const summaries = await runUntil(env, env.documentClient.snapshots('A'));
    assert.equal(summaries.length, 1, 'no pre-revert snapshot either');
  });

  it("a snapshot of another note, or one that's gone, reverts nothing", async () => {
    const summary = await snapshotNow(env, editor);
    await editor.loadNote('B');
    await runUntil(env, editor._revertToSnapshot(summary));
    assert.deepEqual(await storedBlocks(Storage, 'B'), [['b1', 'Plan']]);
    assert.deepEqual(toasts.at(-1), { message: 'Failed to revert to snapshot', kind: 'error' });
    await runUntil(env, editor._revertToSnapshot({ id: 'gone', timestamp: 1 }));
    assert.deepEqual(toasts.at(-1), { message: 'Failed to load snapshot', kind: 'error' });
  });

  it('lists snapshots newest first, and previews one with its blocks', async () => {
    await snapshotNow(env, editor);
    type(editor, 'Second');
    env.clock.tick(500);
    await runUntil(env, editor.flushSave());
    env.clock.tick(1000);
    await snapshotNow(env, editor);
    const summaries = await runUntil(env, env.documentClient.snapshots('A'));
    assert.equal(summaries.length, 2);
    assert.ok(summaries[0].timestamp >= summaries[1].timestamp);
    assert.deepEqual(Object.keys(summaries[0]).sort(), ['id', 'timestamp', 'title']);
    await runUntil(env, editor._previewSnapshot(summaries[0]));
    const modal = env.document.getElementById('snapshot-preview-modal');
    assert.ok(modal, 'the preview opens');
    assert.match(modal.textContent, /Second/);
  });
});

describe('version history over a database without the snapshots store', () => {
  it('is off once a snapshot is refused as store-unavailable, and claims nothing', async () => {
    const { env } = await page({ records: RECORDS, omit: ['snapshots'] });
    const editor = makeEditor(env);
    await editor.loadNote('A');
    editor._snapshotDirty = true;
    await runUntil(env, editor._autoSnapshot());
    assert.equal(editor._snapshotInterval, null);
    editor._startSnapshotInterval();
    assert.equal(editor._snapshotInterval, null, 'no interval starts again on this page');
    const other = makeEditor(env);
    await other.loadNote('B');
    assert.equal(other._snapshotInterval, null, 'nor for another editor on it');
    assert.deepEqual(await runUntil(env, env.documentClient.snapshots('A')), []);
  });
});

/** AIChatController as App wires it, with the editor as the one getEditor answers */
function aiChat(env, Storage, editor) {
  const AIChatController = env.get('AIChatController');
  const chat = new AIChatController({
    storage: Storage,
    eventBus: null,
    domRefs: null,
    logger: { debug() {}, info() {}, warn() {}, error() {} },
    llm: { isConfigured: () => false },
    documentClient: env.documentClient,
  });
  const indexed = [];
  Object.assign(chat, {
    getEditor: () => editor,
    onRefreshNotesList: async () => {},
    onTriggerIndexing: (noteId) => indexed.push(noteId),
    onOpenNoteInNewTab: async () => {},
  });
  chat.indexed = indexed;
  return chat;
}

const REPLY = [
  { type: 'text', content: 'See [[Work]]' },
  { type: 'todo', content: 'Call the bakery', checked: false },
];

describe('T7: AI chat inserts move blocks, update the note, and lose no save', () => {
  it('at the cursor: the blocks after it move down, and the preview and links follow', async () => {
    const { env, Storage, toasts } = await page({ records: RECORDS });
    const editor = makeEditor(env);
    await editor.loadNote('A');
    editor.activeBlock = 'a1';
    const chat = aiChat(env, Storage, editor);
    await runUntil(env, chat.appendAIResponseToNote(REPLY));

    assert.deepEqual(await storedBlocks(Storage, 'A'), [
      ['a1', 'Milk'],
      [(await Storage.getElementsByNote('A')).find((b) => b.content === 'See [[Work]]').id, 'See [[Work]]'],
      [(await Storage.getElementsByNote('A')).find((b) => b.type === 'todo').id, 'Call the bakery'],
      ['a2', 'Eggs'],
    ]);
    const stored = plain(await Storage.getNote('A'));
    assert.deepEqual([stored.preview, stored.todoProgress], ['Milk', { completed: 0, total: 1 }]);
    assert.deepEqual(plain(await Storage.getBacklinks('B')).map((n) => n.id), ['A']);
    assert.deepEqual(editor.blocks.map((b) => b.content), ['Milk', 'See [[Work]]', 'Call the bakery', 'Eggs']);
    assert.deepEqual(chat.indexed, ['A']);
    assert.deepEqual(toasts.at(-1), { message: 'Added 2 AI blocks to note', kind: 'success' });
  });

  it('with no block focused, after the last block', async () => {
    const { env, Storage } = await page({ records: RECORDS });
    const editor = makeEditor(env);
    await editor.loadNote('A');
    editor.activeBlock = null;
    await runUntil(env, aiChat(env, Storage, editor).appendAIResponseToNote(REPLY));
    assert.deepEqual((await storedBlocks(Storage, 'A')).map(([, content]) => content), [
      'Milk', 'Eggs', 'See [[Work]]', 'Call the bakery',
    ]);
  });

  it('text typed in this tab and not yet saved is stored first, and stays', async () => {
    const { env, Storage } = await page({ records: RECORDS });
    const editor = makeEditor(env);
    await editor.loadNote('A');
    editor.activeBlock = 'a1';
    type(editor, 'Oat milk');
    await runUntil(env, aiChat(env, Storage, editor).appendAIResponseToNote(REPLY));
    assert.deepEqual((await storedBlocks(Storage, 'A')).map(([, content]) => content), [
      'Oat milk', 'See [[Work]]', 'Call the bakery', 'Eggs',
    ]);
    assert.deepEqual(editor.blocks.map((b) => b.content), ['Oat milk', 'See [[Work]]', 'Call the bakery', 'Eggs']);
  });

  it("another tab's save of the note while the insert commits loses nothing, in either order", async () => {
    for (const first of ['save', 'insert']) {
      const tabA = await page({ records: RECORDS });
      const tabB = await page({ shared: tabA.env });
      const editorA = makeEditor(tabA.env);
      const editorB = makeEditor(tabB.env);
      await editorA.loadNote('A');
      await editorB.loadNote('A');
      editorA.activeBlock = 'a1';
      // The other tab still shows the note as it was before the insert
      type(editorB, 'Brown eggs', 1);
      const chat = aiChat(tabA.env, tabA.Storage, editorA);
      // This tab's editor writes what it holds first, as it always has, and the other tab's save
      // runs once it has: before the insert, or while the insert commits. (Two editors saving
      // one note's blocks race until #35, a declared gap of the legacy adapter.)
      const saveHere = editorA.save.bind(editorA);
      let saved = Promise.resolve();
      editorA.save = async () => {
        await saveHere();
        saved = runUntil(tabB.env, editorB.flushSave());
        if (first === 'save') await saved;
      };
      await runUntil(tabA.env, chat.appendAIResponseToNote(REPLY));
      await saved;

      const contents = (await storedBlocks(tabA.Storage, 'A')).map(([, content]) => content).sort();
      assert.deepEqual(contents, ['Brown eggs', 'Call the bakery', 'Milk', 'See [[Work]]'], first);
      const stored = plain(await tabA.Storage.getNote('A'));
      assert.equal(stored.name, 'Groceries', first);
    }
  });

  it('"new note from response" makes the note with its id taken first, then inserts the blocks into it', async () => {
    const { env, Storage, toasts } = await page({ records: RECORDS });
    const editor = makeEditor(env);
    await editor.loadNote('A');
    const chat = aiChat(env, Storage, editor);
    const sent = [];
    const client = env.documentClient;
    const realCreate = client.createNote;
    const realInsert = client.insertBlocks;
    client.createNote = (fields) => { sent.push(['createNote', fields.noteId]); return realCreate(fields); };
    client.insertBlocks = (noteId, blocks, atOrder) => {
      sent.push(['insertBlocks', noteId, atOrder]);
      return realInsert(noteId, blocks, atOrder);
    };
    await runUntil(env, chat.createNoteFromAIResponse(REPLY, 'raw'));
    const [[, noteId], insert] = sent;
    assert.deepEqual(insert, ['insertBlocks', noteId, undefined]);
    const made = plain(await Storage.getNote(noteId));
    assert.deepEqual([made.name, made.preview, made.todoProgress], ['AI Generated', 'See [[Work]]', { completed: 0, total: 1 }]);
    assert.deepEqual((await storedBlocks(Storage, noteId)).map(([, content]) => content), ['See [[Work]]', 'Call the bakery']);
    assert.deepEqual(plain(await Storage.getBacklinks('B')).map((n) => n.id), [noteId]);
    assert.deepEqual(toasts.at(-1), { message: 'New note created from AI response', kind: 'success' });
  });

  it('an insert into a note deleted meanwhile is refused and says so', async () => {
    const { env, Storage, toasts } = await page({ records: RECORDS });
    const editor = makeEditor(env);
    await editor.loadNote('A');
    const chat = aiChat(env, Storage, editor);
    editor.save = async () => { await Storage.permanentlyDeleteNote('A'); };
    await runUntil(env, chat.appendAIResponseToNote(REPLY));
    assert.equal(await Storage.getNote('A'), undefined);
    assert.deepEqual(await storedBlocks(Storage, 'A'), []);
    assert.deepEqual(toasts.at(-1), { message: 'Failed to add content', kind: 'error' });
    await settle();
  });
});
