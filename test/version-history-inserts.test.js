'use strict';

// #12 slice 4b2b: version history (snapshot, list, preview, revert) and AI chat's block
// inserts through the kernel. A revert rewrites a note's blocks, and an insert moves them,
// while the user may be typing, here or in another tab. T6 and T7 are plan 4b2.3's.

const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const {
  createLegacyEnv, createDatabase, dumpDatabase, recordsOf, settle, waitFor, plain, note, block, makeEditor, startEditorClient,
  runUntil, releaseStorage,
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

/**
 * A page over `indexedDB` (a new one unless given), with its kernel started, its document client,
 * and `frozen`, the frozen 1.4.1 Storage on its database, for the test's reads (legacy-env's
 * releaseStorage)
 */
async function page({ records, omit, shared } = {}) {
  const env = shared ? createLegacyEnv({ indexedDB: shared.indexedDB, chrome: shared.chrome }) : createLegacyEnv();
  if (!shared) await createDatabase(env.indexedDB, { records, omit });
  env.load(...FILES);
  await startEditorClient(env);
  const toasts = [];
  env.get('Utils').showToast = (message, kind) => toasts.push({ message, kind });
  return { env, frozen: await releaseStorage(env), toasts };
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
async function storedBlocks(frozen, noteId) {
  const blocks = plain(await frozen.getElementsByNote(noteId));
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
  let frozen;
  let toasts;
  let editor;

  beforeEach(async () => {
    ({ env, frozen, toasts } = await page({ records: RECORDS }));
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
    const moved = await frozen.getNote('A');
    moved.folderId = 'f1';
    await frozen.updateNote(moved);

    await runUntil(env, editor._revertToSnapshot(summary));

    const stored = plain(await frozen.getNote('A'));
    assert.deepEqual(
      [stored.name, stored.pinned, stored.folderId, stored.titleManuallySet],
      ['Groceries', true, 'f1', true],
    );
    assert.deepEqual(await storedBlocks(frozen, 'A'), [['a1', 'Milk'], ['a2', 'Eggs']]);
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

    assert.deepEqual(await storedBlocks(frozen, 'A'), [['a1', 'Milk'], ['a2', 'Eggs']]);
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

    assert.deepEqual(await storedBlocks(frozen, 'A'), [['a1', 'Milk'], ['a2', 'Eggs']]);
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
    assert.deepEqual(toasts.at(-1), { message: "Failed to revert: your latest changes aren't saved yet. Please try again.", kind: 'error' });
    const summaries = await runUntil(env, env.documentClient.snapshots('A'));
    assert.equal(summaries.length, 1, 'no pre-revert snapshot either');
  });

  it("a snapshot of another note, or one that's gone, reverts nothing", async () => {
    const summary = await snapshotNow(env, editor);
    await editor.loadNote('B');
    await runUntil(env, editor._revertToSnapshot(summary));
    assert.deepEqual(await storedBlocks(frozen, 'B'), [['b1', 'Plan']]);
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

describe('a revert whose answer stays unknown, which the note as stored settles (#35 slice 4d, rule 13, N2, R9)', () => {
  let env;
  let toasts;
  let editor;

  beforeEach(async () => {
    // As page() starts it, with no frozen 1.4.1 Storage beside it: these cases read what's stored
    // from the database itself, so the mutant review's copy of the tree, which holds no release
    // files, runs them
    env = createLegacyEnv();
    await createDatabase(env.indexedDB, { records: RECORDS });
    env.load(...FILES);
    await startEditorClient(env);
    toasts = [];
    env.get('Utils').showToast = (message, kind) => toasts.push({ message, kind });
    editor = makeEditor(env);
    await editor.loadNote('A');
  });

  /** A's blocks as stored, in note order, as [id, content] */
  const storedOfA = async () =>
    Object.values(recordsOf(await dumpDatabase(env.indexedDB), 'elements'))
      .filter((row) => row.canvasId === 'A')
      .sort((a, b) => (a.order || 0) - (b.order || 0) || (a.id < b.id ? -1 : 1))
      .map((row) => [row.id, row.content]);

  /**
   * The revert's restore goes to the page's kernel when `commits`, and its answer is lost on the
   * way back either way, as a reply the worker sent and the port dropped, which no ledger read
   * settled
   * @param {boolean} commits
   */
  function losingRestore(commits) {
    const client = env.documentClient;
    const real = client.restoreSnapshot;
    client.restoreSnapshot = async (...args) => {
      if (commits) await real(...args);
      return { kind: 'unknown', code: 'outcome-unknown', commandId: 'c-restore' };
    };
  }

  /** A snapshot of A as it is, then 'Oat milk' typed and saved over its first block */
  async function snapshotThenEdit() {
    const summary = await snapshotNow(env, editor);
    type(editor, 'Oat milk');
    env.clock.tick(500);
    await runUntil(env, editor.flushSave());
    return summary;
  }

  it('shows the snapshot and says Reverted to snapshot when the note as stored holds its blocks', async () => {
    const summary = await snapshotThenEdit();
    losingRestore(true);
    await runUntil(env, editor._revertToSnapshot(summary));
    assert.deepEqual(editor.blocks.map((b) => b.content), ['Milk', 'Eggs']);
    assert.deepEqual(toasts.at(-1), { message: 'Reverted to snapshot', kind: 'success' });
    assert.deepEqual(await storedOfA(), [['a1', 'Milk'], ['a2', 'Eggs']]);
  });

  it('says Failed to revert to snapshot when the note as stored holds anything else, and keeps the text', async () => {
    const summary = await snapshotThenEdit();
    losingRestore(false);
    await runUntil(env, editor._revertToSnapshot(summary));
    assert.deepEqual(editor.blocks.map((b) => b.content), ['Oat milk', 'Eggs']);
    assert.deepEqual(toasts.at(-1), { message: 'Failed to revert to snapshot', kind: 'error' });
    assert.deepEqual(await storedOfA(), [['a1', 'Oat milk'], ['a2', 'Eggs']]);
  });

  it("keeps saves held and shows the reload notice when the note as stored can't be read either, so no save lands on a note the revert may have restored", async () => {
    const summary = await snapshotThenEdit();
    losingRestore(false);
    env.documentClient.openNote = async () => {
      throw new Error('the read failed too');
    };
    await runUntil(env, editor._revertToSnapshot(summary));
    assert.ok(editor.root.querySelector('.reload-notice'), 'the reload notice shows');
    assert.equal(editor._savesHeld, true, 'saves stay held');
    type(editor, 'Typed after');
    env.clock.tick(500);
    for (let round = 0; round < 20; round++) {
      env.frames();
      await settle(2);
    }
    assert.deepEqual(await storedOfA(), [['a1', 'Oat milk'], ['a2', 'Eggs']], 'no save went');
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
function aiChat(env, editor) {
  const AIChatController = env.get('AIChatController');
  const chat = new AIChatController({
    settings: env.settingsClient,
    eventBus: null,
    domRefs: null,
    logger: { debug() {}, info() {}, warn() {}, error() {} },
    llm: { isConfigured: () => false },
    documentClient: env.documentClient,
  });
  const indexed = [];
  Object.assign(chat, {
    getEditor: () => editor,
    // NotesManager's indexing, as App hands it over
    indexing: { noteChanged: (noteId) => indexed.push(noteId), loadEmbeddingsModel() {} },
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
    const { env, frozen, toasts } = await page({ records: RECORDS });
    const editor = makeEditor(env);
    await editor.loadNote('A');
    editor.activeBlock = 'a1';
    const chat = aiChat(env, editor);
    await runUntil(env, chat.appendAIResponseToNote(REPLY));

    assert.deepEqual(await storedBlocks(frozen, 'A'), [
      ['a1', 'Milk'],
      [(await frozen.getElementsByNote('A')).find((b) => b.content === 'See [[Work]]').id, 'See [[Work]]'],
      [(await frozen.getElementsByNote('A')).find((b) => b.type === 'todo').id, 'Call the bakery'],
      ['a2', 'Eggs'],
    ]);
    const stored = plain(await frozen.getNote('A'));
    assert.deepEqual([stored.preview, stored.todoProgress], ['Milk', { completed: 0, total: 1 }]);
    assert.deepEqual(plain(await frozen.getBacklinks('B')).map((n) => n.id), ['A']);
    assert.deepEqual(editor.blocks.map((b) => b.content), ['Milk', 'See [[Work]]', 'Call the bakery', 'Eggs']);
    assert.deepEqual(chat.indexed, ['A']);
    assert.deepEqual(toasts.at(-1), { message: 'Added 2 AI blocks to note', kind: 'success' });
  });

  it("at the cursor, though the confirm click's blur clears the focus while the save before the insert is pending: the blocks go after the block focused as it began (#276)", async () => {
    // As page() starts it, with no frozen 1.4.1 Storage beside it: this case reads what's stored
    // from the database itself, so the mutant review's copy of the tree, which holds no release
    // files, runs it
    const env = createLegacyEnv();
    await createDatabase(env.indexedDB, { records: RECORDS });
    env.load(...FILES);
    await startEditorClient(env);
    const editor = makeEditor(env);
    await editor.loadNote('A');
    editor.activeBlock = 'a1';
    // The confirm click's blur clears the editor's focus 100 ms on (editor.js's onBlockBlur),
    // which lands while the save the insert waits on is pending, once that save takes longer
    const save = editor.save.bind(editor);
    editor.save = (...args) => {
      const saving = save(...args);
      editor.activeBlock = null;
      return saving;
    };
    await runUntil(env, aiChat(env, editor).appendAIResponseToNote(REPLY));

    const stored = Object.values(recordsOf(await dumpDatabase(env.indexedDB), 'elements'))
      .filter((row) => row.canvasId === 'A')
      .sort((a, b) => (a.order || 0) - (b.order || 0) || (a.id < b.id ? -1 : 1))
      .map((row) => row.content);
    assert.deepEqual(stored, ['Milk', 'See [[Work]]', 'Call the bakery', 'Eggs']);
    assert.deepEqual(editor.blocks.map((b) => b.content), ['Milk', 'See [[Work]]', 'Call the bakery', 'Eggs']);
  });

  describe("through the chat's preview, the block that held the caret picks where the insert goes, and never splits its text (#277)", () => {
    // Three blocks in A, so the block the person picks, the first one the load focuses, and the
    // end are each a different place, and two in B
    const CHAT_RECORDS = {
      canvases: [note('A', { name: 'Groceries' }), note('B', { name: 'Work' })],
      elements: [
        block('a1', 'A', 0, 'Milk'),
        block('a2', 'A', 1, 'Eggs'),
        block('a3', 'A', 2, 'Bread'),
        block('b1', 'B', 0, 'Plan'),
        block('b2', 'B', 1, 'Review'),
      ],
    };

    /**
     * A open in its editor, as page() starts it but with no frozen 1.4.1 Storage beside it, so the
     * mutant review's copy of the tree, which holds no release files, runs these: an element for each
     * of A's blocks in the blocks container, the chat's input and its insert preview beside it, and
     * the chat. Focus moves as the browser moves it, and the blocks container's focus and blur
     * listeners (editor.js) hear each move, its input listener what the person types, and its
     * click listener each click, so no case sets the editor's focused block itself. The load's own
     * focus of the first block (loadNote) has run.
     */
    async function chatPage() {
      const env = createLegacyEnv();
      await createDatabase(env.indexedDB, { records: CHAT_RECORDS });
      env.load(...FILES);
      await startEditorClient(env);
      const editor = makeEditor(env);
      await editor.loadNote('A');
      const doc = env.document;
      // No text is selected, as this fake keeps no selection: the wiki-link check typing runs reads it
      doc.defaultView.getSelection = () => ({ rangeCount: 0 });
      // A platform for the click listener's selection keys (Cmd on a Mac, Ctrl elsewhere)
      env.get('navigator').platform = 'Linux x86_64';
      /** @type {Record<string, any>} */
      const text = {};
      for (const id of ['a1', 'a2', 'a3']) {
        const row = editor.container.appendChild(doc.createElement('div'));
        row.className = 'block';
        row.setAttribute('data-id', id);
        text[id] = row.appendChild(doc.createElement('div'));
        text[id].className = 'block-content';
        text[id].setAttribute('contenteditable', 'true');
      }
      const input = doc.body.appendChild(doc.createElement('textarea'));
      input.id = 'ai-chat-input';
      const modal = doc.body.appendChild(doc.createElement('div'));
      modal.id = 'ai-insert-preview-modal';
      modal.className = 'hidden';
      const confirm = modal.appendChild(doc.createElement('button'));
      confirm.id = 'ai-insert-preview-confirm';
      /** What the blocks container's focus and blur listeners hear as focus moves from `from` to `to` */
      const hear = (/** @type {any} */ from, /** @type {any} */ to) => {
        if (from && from !== to && editor.container.contains(from)) editor.onBlockBlur({ type: 'blur', target: from });
        if (to && from !== to && editor.container.contains(to)) editor.onBlockFocus({ type: 'focus', target: to });
      };
      /** The person moves focus to `element` */
      const focus = (/** @type {any} */ element) => {
        const from = doc.activeElement;
        element.focus();
        hear(from, element);
      };
      /** `ms` pass, and the listeners hear any focus the page moved itself */
      const wait = (/** @type {number} */ ms) => {
        const from = doc.activeElement;
        env.clock.tick(ms);
        hear(from, doc.activeElement);
      };
      /** The person types `html` into `element`, which holds the focus, and the input listener hears it */
      const typeInto = (/** @type {any} */ element, /** @type {string} */ html) => {
        element.innerHTML = html;
        return editor.onBlockInput({ type: 'input', target: element });
      };
      /**
       * The person clicks `element`, in a block: focus moves to it unless it holds it already, as a
       * browser moves it, and the click listener hears the click
       */
      const click = (/** @type {any} */ element) => {
        if (doc.activeElement !== element) focus(element);
        editor.onBlockClick({ type: 'click', target: element, shiftKey: false, ctrlKey: false, metaKey: false });
      };
      // The load focuses the first block 50 ms on
      wait(100);
      /** A note's stored blocks' text, in note order, read from the database itself */
      const stored = async (/** @type {string} */ noteId) =>
        Object.values(recordsOf(await dumpDatabase(env.indexedDB), 'elements'))
          .filter((row) => row.canvasId === noteId)
          .sort((a, b) => (a.order || 0) - (b.order || 0) || (a.id < b.id ? -1 : 1))
          .map((row) => row.content);
      return { env, editor, chat: aiChat(env, editor), text, input, modal, confirm, focus, wait, typeInto, click, stored };
    }

    it('keeps the block once the caret leaves it for the chat, so the insert confirmed after the blur goes after it', async () => {
      const { env, editor, chat, text, input, confirm, focus, wait, stored } = await chatPage();
      focus(text.a2);
      wait(150);
      // The person types the question in the chat, and the blur's 100 ms pass
      focus(input);
      wait(150);
      chat.openAIInsertPreview('append', 'From the chat');
      focus(confirm);
      await runUntil(env, chat.confirmAIInsertPreview());
      assert.deepEqual(await stored('A'), ['Milk', 'Eggs', 'From the chat', 'Bread']);
      assert.deepEqual(editor.blocks.map((b) => b.content), ['Milk', 'Eggs', 'From the chat', 'Bread'], 'the Eggs block keeps its text');
    });

    it('takes the block as the preview opens, so focus that leaves for the preview before the confirm changes nothing', async () => {
      const { env, chat, text, modal, confirm, focus, wait, stored } = await chatPage();
      focus(text.a2);
      wait(150);
      chat.openAIInsertPreview('append', 'From the chat');
      // The person reads the preview, and the blur's 100 ms pass before the confirm
      focus(modal);
      wait(150);
      focus(confirm);
      await runUntil(env, chat.confirmAIInsertPreview());
      assert.deepEqual(await stored('A'), ['Milk', 'Eggs', 'From the chat', 'Bread']);
    });

    it("keeps the block when the caret moves to the note's title before the chat, so the insert still goes after it", async () => {
      const { env, editor, chat, text, input, confirm, focus, wait, stored } = await chatPage();
      focus(text.a2);
      wait(150);
      focus(editor.titleEl);
      wait(150);
      focus(input);
      wait(150);
      chat.openAIInsertPreview('append', 'From the chat');
      focus(confirm);
      await runUntil(env, chat.confirmAIInsertPreview());
      assert.deepEqual(await stored('A'), ['Milk', 'Eggs', 'From the chat', 'Bread']);
    });

    it('goes at the end of another note opened after the caret left the first, as no block there held it', async () => {
      const { env, editor, chat, text, input, confirm, focus, wait, stored } = await chatPage();
      focus(text.a2);
      wait(150);
      focus(input);
      wait(150);
      await editor.loadNote('B');
      chat.openAIInsertPreview('append', 'From the chat');
      focus(confirm);
      await runUntil(env, chat.confirmAIInsertPreview());
      assert.deepEqual(await stored('B'), ['Plan', 'Review', 'From the chat']);
      assert.deepEqual(await stored('A'), ['Milk', 'Eggs', 'Bread']);
    });

    it("goes at the end when the person placed no caret in the note: the load's own focus of the first block doesn't pick it", async () => {
      const { env, chat, input, confirm, focus, wait, stored } = await chatPage();
      focus(input);
      wait(150);
      chat.openAIInsertPreview('append', 'From the chat');
      focus(confirm);
      await runUntil(env, chat.confirmAIInsertPreview());
      assert.deepEqual(await stored('A'), ['Milk', 'Eggs', 'Bread', 'From the chat']);
    });

    it('takes typing in the first block, where the load put the caret, as a caret the person placed there', async () => {
      const { env, chat, text, input, confirm, focus, wait, typeInto, stored } = await chatPage();
      // The person types at the end of the first block, which the load's focus holds, so no focus moves
      await typeInto(text.a1, 'Milk and oats');
      focus(input);
      wait(150);
      chat.openAIInsertPreview('append', 'From the chat');
      focus(confirm);
      await runUntil(env, chat.confirmAIInsertPreview());
      assert.deepEqual(await stored('A'), ['Milk and oats', 'From the chat', 'Eggs', 'Bread']);
    });

    it('takes a click into the first block, where the load put the caret, as a caret the person placed there, though the click moves no focus', async () => {
      const { env, chat, text, input, confirm, focus, wait, click, stored } = await chatPage();
      // The load's focus holds the first block, so the click sends no focus event
      click(text.a1);
      focus(input);
      wait(150);
      chat.openAIInsertPreview('append', 'From the chat');
      focus(confirm);
      await runUntil(env, chat.confirmAIInsertPreview());
      assert.deepEqual(await stored('A'), ['Milk', 'From the chat', 'Eggs', 'Bread']);
    });

    it("takes the person's focus in the first block as a caret after a second load, whose own focus of that block, focused already, sends no focus event", async () => {
      const { env, editor, chat, text, input, confirm, focus, wait, stored } = await chatPage();
      // The note loads again while the first load's focus holds its first block, as two loads close together do
      await editor.loadNote('A');
      wait(100);
      focus(input);
      wait(150);
      // The person comes back to the first block with the keys, then goes to the chat
      focus(text.a1);
      wait(150);
      focus(input);
      wait(150);
      chat.openAIInsertPreview('append', 'From the chat');
      focus(confirm);
      await runUntil(env, chat.confirmAIInsertPreview());
      assert.deepEqual(await stored('A'), ['Milk', 'From the chat', 'Eggs', 'Bread']);
    });
  });

  it('with no block focused, after the last block', async () => {
    const { env, frozen } = await page({ records: RECORDS });
    const editor = makeEditor(env);
    await editor.loadNote('A');
    editor.activeBlock = null;
    await runUntil(env, aiChat(env, editor).appendAIResponseToNote(REPLY));
    assert.deepEqual((await storedBlocks(frozen, 'A')).map(([, content]) => content), [
      'Milk', 'Eggs', 'See [[Work]]', 'Call the bakery',
    ]);
  });

  it('text typed in this tab and not yet saved is stored first, and stays', async () => {
    const { env, frozen } = await page({ records: RECORDS });
    const editor = makeEditor(env);
    await editor.loadNote('A');
    editor.activeBlock = 'a1';
    type(editor, 'Oat milk');
    await runUntil(env, aiChat(env, editor).appendAIResponseToNote(REPLY));
    assert.deepEqual((await storedBlocks(frozen, 'A')).map(([, content]) => content), [
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
      const chat = aiChat(tabA.env, editorA);
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

      const contents = (await storedBlocks(tabA.frozen, 'A')).map(([, content]) => content).sort();
      assert.deepEqual(contents, ['Brown eggs', 'Call the bakery', 'Milk', 'See [[Work]]'], first);
      const stored = plain(await tabA.frozen.getNote('A'));
      assert.equal(stored.name, 'Groceries', first);
    }
  });

  it('"new note from response" makes the note with its id taken first, then inserts the blocks into it', async () => {
    const { env, frozen, toasts } = await page({ records: RECORDS });
    const editor = makeEditor(env);
    await editor.loadNote('A');
    const chat = aiChat(env, editor);
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
    const made = plain(await frozen.getNote(noteId));
    assert.deepEqual([made.name, made.preview, made.todoProgress], ['AI Generated', 'See [[Work]]', { completed: 0, total: 1 }]);
    assert.deepEqual((await storedBlocks(frozen, noteId)).map(([, content]) => content), ['See [[Work]]', 'Call the bakery']);
    assert.deepEqual(plain(await frozen.getBacklinks('B')).map((n) => n.id), [noteId]);
    assert.deepEqual(toasts.at(-1), { message: 'New note created from AI response', kind: 'success' });
  });

  it('an insert into a note deleted meanwhile is refused and says so', async () => {
    const { env, frozen, toasts } = await page({ records: RECORDS });
    const editor = makeEditor(env);
    await editor.loadNote('A');
    const chat = aiChat(env, editor);
    editor.save = async () => { await frozen.permanentlyDeleteNote('A'); };
    await runUntil(env, chat.appendAIResponseToNote(REPLY));
    assert.equal(await frozen.getNote('A'), undefined);
    assert.deepEqual(await storedBlocks(frozen, 'A'), []);
    assert.deepEqual(toasts.at(-1), { message: 'Failed to add content', kind: 'error' });
    await settle();
  });
});

/** A window-like target for a PiP editor's own document, with its own listeners and frames */
function windowTarget() {
  const listeners = {};
  return {
    addEventListener(type, fn) { (listeners[type] = listeners[type] || []).push(fn); },
    fire(type) { (listeners[type] || []).forEach((fn) => fn({ type })); },
    requestAnimationFrame(fn) { setImmediate(() => fn(0)); return 1; },
  };
}

/**
 * The ways a page writes what's pending at once (_writePendingNow): the page hiding, a tab
 * switch, another context's upgrade closing the connection, and the PiP window closing. Each
 * makes an editor on note A over `env`, and `flush()` runs its route.
 */
const FLUSH_ROUTES = {
  pagehide: (env) => ({ editor: makeEditor(env), flush: () => env.window.fire('pagehide') }),
  'tab switch': (env) => ({
    editor: makeEditor(env),
    flush: () => {
      env.document.visibilityState = 'hidden';
      env.document.fire('visibilitychange');
    },
  }),
  'connection close': (env) => {
    let flushes = [];
    const documentClient = {
      ...env.documentClient,
      beforeConnectionCloses: (flush) => {
        flushes.push(flush);
        return () => { flushes = flushes.filter((one) => one !== flush); };
      },
    };
    return { editor: makeEditor(env, env.document, { documentClient }), flush: () => flushes.forEach((one) => one()) };
  },
  'PiP window closing': (env) => {
    const { FakeDocument } = require('./helpers/legacy-env');
    const pipDoc = new FakeDocument();
    const pipWindow = windowTarget();
    pipDoc.defaultView = pipWindow;
    return { editor: makeEditor(env, pipDoc), flush: () => pipWindow.fire('pagehide') };
  },
};

describe('a flush while a revert commits keeps the screen and the note the same (review R70)', () => {
  for (const [route, make] of Object.entries(FLUSH_ROUTES)) {
    for (const when of ['before', 'after']) {
      it(`${route}, ${when} the restore's unit commits: no replaced block comes back, and the typing is a snapshot`, async () => {
        const { env, frozen } = await page({ records: RECORDS });
        const { editor, flush } = make(env);
        await editor.loadNote('A');
        const summary = await snapshotNow(env, editor);
        // A block added after the snapshot, and saved
        editor.blocks.push(env.get('Block').deserialize({ id: 'a3', type: 'text', content: 'Bread' }));
        editor.scheduleSave();
        env.clock.tick(600);
        await runUntil(env, editor.flushSave());
        assert.deepEqual((await storedBlocks(frozen, 'A')).map(([id]) => id), ['a1', 'a2', 'a3']);

        const client = editor.documentClient;
        const real = client.restoreSnapshot;
        let release;
        const held = new Promise((resolve) => { release = resolve; });
        let committing;
        client.restoreSnapshot = (...args) => {
          committing = real(...args);
          return held.then(() => committing);
        };
        const reverting = editor._revertToSnapshot(summary);
        await waitFor(() => editor._revertingNoteId === 'A', { message: 'the revert to start' });
        if (when === 'after') await runUntil(env, committing);
        type(editor, 'Typed during the revert');
        flush();
        release();
        await runUntil(env, reverting);
        client.restoreSnapshot = real;
        env.clock.tick(2000);
        await runUntil(env, editor.flushSave());

        const stored = await storedBlocks(frozen, 'A');
        assert.deepEqual(stored, [['a1', 'Milk'], ['a2', 'Eggs']]);
        assert.deepEqual(stored, editor.blocks.map((b) => [b.id, b.content]), 'the note is what the screen shows');
        const texts = [];
        for (const { id } of await runUntil(env, env.documentClient.snapshots('A'))) {
          const snap = await runUntil(env, env.documentClient.snapshot(id));
          texts.push(snap.blocks.map((b) => b.content).join('|'));
        }
        assert.ok(texts.includes('Typed during the revert|Eggs|Bread'), JSON.stringify(texts));
      });
    }
  }

  it('a save() while a revert commits waits for it, then writes the restored blocks', async () => {
    const { env, frozen } = await page({ records: RECORDS });
    const editor = makeEditor(env);
    await editor.loadNote('A');
    const summary = await snapshotNow(env, editor);
    type(editor, 'Oat milk');
    env.clock.tick(600);
    await runUntil(env, editor.flushSave());
    const client = env.documentClient;
    const real = client.restoreSnapshot;
    let release;
    const held = new Promise((resolve) => { release = resolve; });
    client.restoreSnapshot = (...args) => {
      const outcome = real(...args);
      return held.then(() => outcome);
    };
    const reverting = editor._revertToSnapshot(summary);
    await waitFor(() => editor._revertingNoteId === 'A', { message: 'the revert to start' });
    type(editor, 'Typed');
    let saved = false;
    const saving = editor.save().then(() => { saved = true; });
    await settle();
    assert.equal(saved, false, 'save() resolves once the revert is done');
    release();
    await runUntil(env, reverting);
    await runUntil(env, saving);
    client.restoreSnapshot = real;
    await runUntil(env, editor.flushSave());
    assert.deepEqual(await storedBlocks(frozen, 'A'), [['a1', 'Milk'], ['a2', 'Eggs']]);
  });

  it('a revert that fails saves what was typed meanwhile onto the note', async () => {
    const { env, frozen } = await page({ records: RECORDS });
    const editor = makeEditor(env);
    await editor.loadNote('A');
    const summary = await snapshotNow(env, editor);
    const client = env.documentClient;
    const real = client.restoreSnapshot;
    let release;
    const held = new Promise((resolve) => { release = resolve; });
    client.restoreSnapshot = () => held.then(() => ({ kind: 'unavailable', cause: 'quota', code: 'quota', retryable: false }));
    const reverting = editor._revertToSnapshot(summary);
    await waitFor(() => editor._revertingNoteId === 'A', { message: 'the revert to start' });
    type(editor, 'Typed while it failed');
    env.window.fire('pagehide');
    release();
    await runUntil(env, reverting);
    client.restoreSnapshot = real;
    env.clock.tick(600);
    await runUntil(env, editor.flushSave());
    assert.deepEqual(await storedBlocks(frozen, 'A'), [['a1', 'Typed while it failed'], ['a2', 'Eggs']]);
  });
});

describe('an AI insert confirmed while a revert commits (the #70 delta check)', () => {
  it('waits for the revert, then goes in after the restored blocks, and the screen shows it', async () => {
    const records = {
      canvases: [note('A', { name: 'Plan' })],
      elements: [block('0-a', 'A', 0, 'One'), block('0-b', 'A', 1, 'Two')],
    };
    const { env, frozen, toasts } = await page({ records });
    const editor = makeEditor(env);
    await editor.loadNote('A');
    const summary = await snapshotNow(env, editor);
    // After the snapshot: a third block, saved
    editor.blocks.push(env.get('Block').deserialize({ id: '0-c', type: 'text', content: 'Three' }));
    editor.scheduleSave();
    env.clock.tick(600);
    await runUntil(env, editor.flushSave());

    const client = env.documentClient;
    const real = client.restoreSnapshot;
    let release;
    const held = new Promise((resolve) => { release = resolve; });
    client.restoreSnapshot = (...args) => {
      const outcome = real(...args);
      return held.then(() => outcome);
    };
    const reverting = editor._revertToSnapshot(summary);
    await waitFor(() => editor._revertingNoteId === 'A', { message: 'the revert to start' });
    // The cursor is in the block the revert takes away
    editor.activeBlock = '0-c';
    let appended = false;
    const appending = aiChat(env, editor).appendAIResponseToNote([{ type: 'text', content: 'New1' }])
      .then(() => { appended = true; });
    await settle();
    assert.equal(appended, false, 'the append waits for the revert');
    release();
    await runUntil(env, reverting);
    await runUntil(env, appending);
    client.restoreSnapshot = real;
    env.clock.tick(2000);
    await runUntil(env, editor.flushSave());

    assert.deepEqual((await storedBlocks(frozen, 'A')).map(([, content]) => content), ['One', 'Two', 'New1']);
    assert.deepEqual(editor.blocks.map((b) => b.content), ['One', 'Two', 'New1']);
    assert.deepEqual(toasts.at(-1), { message: 'Added 1 AI block to note', kind: 'success' });
  });

  it("flushSave while a revert commits waits for it, rather than going round and storing nothing", async () => {
    const { env, frozen } = await page({ records: RECORDS });
    const editor = makeEditor(env);
    await editor.loadNote('A');
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
    await waitFor(() => editor._revertingNoteId === 'A', { message: 'the revert to start' });
    type(editor, 'Typed');
    let flushed = false;
    const flushing = editor.flushSave().then(() => { flushed = true; });
    await settle();
    assert.equal(flushed, false, 'the flush waits for the revert');
    release();
    await runUntil(env, reverting);
    await runUntil(env, flushing);
    client.restoreSnapshot = real;
    assert.equal(editor._hasPendingSave(), false, 'nothing is left pending');
    assert.deepEqual(await storedBlocks(frozen, 'A'), [['a1', 'Milk'], ['a2', 'Eggs']]);
  });
  it('a second revert while one commits is dropped without a word, and an append waiting on the first still settles (review R77, P6)', async () => {
    const { env, frozen, toasts } = await page({ records: RECORDS });
    const editor = makeEditor(env);
    await editor.loadNote('A');
    const first = await snapshotNow(env, editor);
    editor.blocks.push(env.get('Block').deserialize({ id: 'a3', type: 'text', content: 'Bread' }));
    editor.scheduleSave();
    env.clock.tick(600);
    await runUntil(env, editor.flushSave());
    env.clock.tick(1000);
    const second = await snapshotNow(env, editor);

    const client = env.documentClient;
    const real = client.restoreSnapshot;
    const releases = [];
    client.restoreSnapshot = (...args) => {
      const outcome = real(...args);
      return new Promise((resolve) => releases.push(resolve)).then(() => outcome);
    };
    const reverting = editor._revertToSnapshot(first);
    await waitFor(() => editor._revertingNoteId === 'A', { message: 'the revert to start' });
    type(editor, 'Typed');
    editor.activeBlock = null;
    let appended = false;
    const appending = aiChat(env, editor).appendAIResponseToNote([{ type: 'text', content: 'New1' }])
      .then(() => { appended = true; });
    await settle();
    env.window.fire('pagehide');
    // The user clicks a second revert in the panel still open
    const toastsBefore = toasts.length;
    await runUntil(env, editor._revertToSnapshot(second));
    assert.equal(releases.length, 1, 'no second restore');
    assert.equal(toasts.length, toastsBefore, 'the second click shows nothing');
    releases[0]();
    await runUntil(env, reverting);
    await runUntil(env, appending);
    client.restoreSnapshot = real;
    env.clock.tick(2000);
    await runUntil(env, editor.flushSave());

    assert.equal(appended, true);
    assert.deepEqual((await storedBlocks(frozen, 'A')).map(([, content]) => content), ['Milk', 'Eggs', 'New1']);
    assert.deepEqual(editor.blocks.map((b) => b.content), ['Milk', 'Eggs', 'New1']);
    // And a revert after the first one ends runs
    const after = await runUntil(env, env.documentClient.snapshots('A'));
    await runUntil(env, editor._revertToSnapshot(after.find((s) => s.id === second.id)));
    assert.deepEqual(toasts.at(-1), { message: 'Reverted to snapshot', kind: 'success' });
  });

  it('a revert whose render throws once shows the note as stored, and the saves waiting on it go on (review R77)', async () => {
    const { env, frozen, toasts } = await page({ records: RECORDS });
    const editor = makeEditor(env);
    await editor.loadNote('A');
    const summary = await snapshotNow(env, editor);
    const render = editor.renderBlocks;
    let throwOnce = true;
    editor.renderBlocks = function () {
      if (throwOnce) {
        throwOnce = false;
        throw new Error('render failed');
      }
      return render.call(this);
    };
    const client = env.documentClient;
    const real = client.restoreSnapshot;
    let release;
    const held = new Promise((resolve) => { release = resolve; });
    client.restoreSnapshot = (...args) => {
      const outcome = real(...args);
      return held.then(() => outcome);
    };
    const reverting = editor._revertToSnapshot(summary).then(() => 'resolved', (error) => error.message);
    await waitFor(() => editor._revertingNoteId === 'A', { message: 'the revert to start' });
    type(editor, 'Typed');
    const saving = editor.save();
    release();
    assert.equal(await runUntil(env, reverting), 'resolved');
    await runUntil(env, saving);
    client.restoreSnapshot = real;
    assert.deepEqual([editor._savesHeld, editor._revertingNoteId, editor._revertInFlight], [false, null, false]);
    await runUntil(env, editor.flushSave());
    assert.equal(editor._hasPendingSave(), false);
    assert.deepEqual((await storedBlocks(frozen, 'A')).map(([, content]) => content), ['Milk', 'Eggs']);
    assert.deepEqual(editor.blocks.map((b) => b.content), ['Milk', 'Eggs']);
    assert.deepEqual(toasts.at(-1), { message: 'Reverted to snapshot', kind: 'success' });
    assert.ok((await snapshotTexts(env, 'A')).includes('Typed'), 'what was typed is in version history');
  });
});

/** The first block's text in each of `noteId`'s snapshots */
async function snapshotTexts(env, noteId) {
  const texts = [];
  for (const { id } of await runUntil(env, env.documentClient.snapshots(noteId))) {
    const snap = await runUntil(env, env.documentClient.snapshot(id));
    texts.push(snap.blocks[0] && snap.blocks[0].content);
  }
  return texts;
}

describe("a committed revert whose blocks don't reach the screen (review R77, P8)", () => {
  /**
   * A page with note A loaded and a snapshot of it, a revert to that snapshot committing, and
   * text typed and a save waiting while it commits. `failing` decides when Block.deserialize throws.
   */
  async function revertWhileTyping(failing) {
    const { env, frozen, toasts } = await page({ records: RECORDS });
    const editor = makeEditor(env);
    await editor.loadNote('A');
    const summary = await snapshotNow(env, editor);
    const Block = env.get('Block');
    const deserialize = Block.deserialize;
    Block.deserialize = function (data) {
      if (failing()) throw new Error('deserialize failed');
      return deserialize.call(this, data);
    };
    const client = env.documentClient;
    const real = client.restoreSnapshot;
    let release;
    const held = new Promise((resolve) => { release = resolve; });
    client.restoreSnapshot = (...args) => {
      const outcome = real(...args);
      return held.then(() => outcome);
    };
    const reverting = editor._revertToSnapshot(summary).then(() => 'resolved', (error) => error.message);
    await waitFor(() => editor._revertingNoteId === 'A', { message: 'the revert to start' });
    type(editor, 'Typed');
    const saving = editor.save();
    const done = async () => {
      const result = await runUntil(env, reverting);
      await runUntil(env, saving);
      client.restoreSnapshot = real;
      Block.deserialize = deserialize;
      await runUntil(env, editor.flushSave());
      return result;
    };
    return { env, frozen, toasts, editor, release, done };
  }

  it('a throw before the blocks are replaced shows the note as stored, and no save writes the replaced blocks back', async () => {
    let throwNext = false;
    const { env, frozen, toasts, editor, release, done } = await revertWhileTyping(() => {
      const now = throwNext;
      throwNext = false;
      return now;
    });
    throwNext = true;
    release();
    assert.equal(await done(), 'resolved');
    assert.deepEqual([editor._savesHeld, editor._revertingNoteId, editor._revertInFlight], [false, null, false]);
    assert.equal(editor._hasPendingSave(), false);
    assert.deepEqual((await storedBlocks(frozen, 'A')).map(([, content]) => content), ['Milk', 'Eggs']);
    assert.deepEqual(editor.blocks.map((b) => b.content), ['Milk', 'Eggs']);
    assert.deepEqual(toasts.at(-1), { message: 'Reverted to snapshot', kind: 'success' });
    assert.ok((await snapshotTexts(env, 'A')).includes('Typed'), 'what was typed is in version history');
  });

  it("when the note as stored can't be shown either, the note goes back to what's on screen and the toast says so", async () => {
    let failing = false;
    const { env, frozen, toasts, editor, release, done } = await revertWhileTyping(() => failing);
    failing = true;
    release();
    assert.equal(await done(), 'resolved');
    assert.deepEqual([editor._savesHeld, editor._revertingNoteId, editor._revertInFlight], [false, null, false]);
    assert.equal(editor._hasPendingSave(), false);
    assert.deepEqual(editor.blocks.map((b) => b.content), ['Typed', 'Eggs']);
    assert.deepEqual((await storedBlocks(frozen, 'A')).map(([, content]) => content), ['Typed', 'Eggs']);
    assert.deepEqual(toasts.at(-1), { message: 'Failed to revert to snapshot', kind: 'error' });
    assert.ok((await snapshotTexts(env, 'A')).includes('Milk'), 'the snapshot is still in version history');
  });
});

describe('typing while an AI insert commits (review R70, 1.4.x misplaced the block)', () => {
  for (const hide of [false, true]) {
    it(`keeps every block where the insert put it${hide ? ', with the page hidden meanwhile' : ''}`, async () => {
      const records = {
        canvases: [note('A', { name: 'Plan' })],
        elements: [block('0-a', 'A', 0, 'One'), block('0-b', 'A', 1, 'Two'), block('0-c', 'A', 2, 'Three')],
      };
      const { env, frozen } = await page({ records });
      const editor = makeEditor(env);
      await editor.loadNote('A');
      editor.activeBlock = '0-a';
      const chat = aiChat(env, editor);
      const client = env.documentClient;
      const real = client.insertBlocks;
      let release;
      const held = new Promise((resolve) => { release = resolve; });
      let started;
      const opened = new Promise((resolve) => { started = resolve; });
      client.insertBlocks = (...args) => {
        const outcome = real(...args);
        started();
        return held.then(() => outcome);
      };
      const inserting = chat.appendAIResponseToNote([{ type: 'text', content: 'New1' }]);
      await runUntil(env, opened);
      type(editor, 'Three typed', editor.blocks.findIndex((b) => b.id === '0-c'));
      if (hide) env.window.fire('pagehide');
      release();
      await runUntil(env, inserting);
      client.insertBlocks = real;
      env.clock.tick(2000);
      await runUntil(env, editor.flushSave());
      assert.deepEqual((await storedBlocks(frozen, 'A')).map(([, content]) => content), ['One', 'New1', 'Two', 'Three typed']);
      assert.deepEqual(editor.blocks.map((b) => b.content), ['One', 'New1', 'Two', 'Three typed']);
    });
  }

  it('an insert that is refused takes its blocks off the screen again', async () => {
    const { env, frozen, toasts } = await page({ records: RECORDS });
    const editor = makeEditor(env);
    await editor.loadNote('A');
    editor.activeBlock = 'a1';
    const client = env.documentClient;
    const real = client.insertBlocks;
    client.insertBlocks = () => Promise.resolve({ kind: 'unavailable', cause: 'quota', code: 'quota', retryable: false });
    await runUntil(env, aiChat(env, editor).appendAIResponseToNote(REPLY));
    client.insertBlocks = real;
    assert.deepEqual(editor.blocks.map((b) => b.content), ['Milk', 'Eggs']);
    assert.deepEqual(toasts.at(-1), { message: 'Failed to add content', kind: 'error' });
  });
});
