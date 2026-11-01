'use strict';

// 1.4.3 item 1 (#33): the close-time draft's writer. At the page's own pagehide, before any
// editor issues its closing write, every editor holding an edit it hasn't seen commit writes one
// draft to localStorage: the main pane's, the split view's and the pop-out's. The next start
// applies it (test/close-drafts.test.js has the applier's own rules).

const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const {
  createLegacyEnv, createDatabase, dumpDatabase, recordsOf, createLocalStorage, settle, plain, note, block, FakeDocument,
  makeEditor, runUntil,
} = require('./helpers/legacy-env');

const FILES = [
  'js/utils.js',
  'js/core/storage-error.js',
  'js/close-drafts.js',
  'js/storage.js',
  'js/sidebar-utils.js',
  'js/blocks.js',
  'js/editor.js',
];

/** A window for an editor's own document, as the pop-out has */
function windowTarget() {
  const listeners = {};
  const queued = [];
  return {
    addEventListener(type, fn) { (listeners[type] = listeners[type] || []).push(fn); },
    fire(type, fields = {}) { (listeners[type] || []).forEach((fn) => fn({ type, ...fields })); },
    requestAnimationFrame(fn) { queued.push(fn); return queued.length; },
  };
}

/** Type into a block of the loaded note, as onBlockInput does */
function type(editor, text, index = 0) {
  editor.blocks[index].content = text;
  editor.blocks[index].markUpdated();
  editor.scheduleSave();
}

async function setup({ localStorage = createLocalStorage(), indexedDB } = {}) {
  const env = createLegacyEnv({ localStorage, indexedDB });
  if (!indexedDB) {
    await createDatabase(env.indexedDB, {
      records: {
        canvases: [note('A', { name: 'Alpha' }), note('B', { name: 'Bravo' }), note('C', { name: 'Charlie' })],
        elements: [
          block('a1', 'A', 0, 'alpha'),
          block('a2', 'A', 1, 'alpha two'),
          block('b1', 'B', 0, 'bravo'),
          block('c1', 'C', 0, 'charlie'),
        ],
      },
    });
  }
  env.load(...FILES);
  const Storage = env.get('Storage');
  await Storage.init();
  return { env, Storage };
}

/** The drafts in `env`'s localStorage, oldest first */
const drafts = (env) => plain(env.get('CloseDrafts').list(env.global.localStorage).map(({ draft }) => draft));

/** The next start: another page on the same profile applies the drafts */
async function nextStart(env) {
  const { env: next, Storage } = await setup({ localStorage: env.global.localStorage, indexedDB: env.indexedDB });
  const result = plain(await next.get('CloseDrafts').apply({ db: Storage.db }));
  return { next, Storage, result };
}

/** Record the transactions whose commit() is called, as a closing page's write calls it */
function spyCommits(Storage) {
  const db = Storage.db;
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

async function elementsById(env) {
  return recordsOf(await dumpDatabase(env.indexedDB), 'elements');
}

describe("the close-time draft's writer", () => {
  let env;
  let Storage;
  let editor;

  beforeEach(async () => {
    ({ env, Storage } = await setup());
    editor = makeEditor(env);
    await editor.loadNote('A');
  });

  it('writes one draft at pagehide inside the debounce, with only the changed blocks, before the closing write', async () => {
    const stamp = (await Storage.getNote('A')).updatedAt;
    const committed = spyCommits(Storage);
    type(editor, 'typed as the tab closed');
    env.window.fire('pagehide');

    const [draft, ...more] = drafts(env);
    assert.equal(more.length, 0);
    assert.equal(draft.noteId, 'A');
    assert.deepEqual(draft.base, { revision: null, updatedAt: stamp, issued: [] });
    assert.deepEqual(draft.blocks.map((b) => [b.id, b.content, b.canvasId, b.order]), [['a1', 'typed as the tab closed', 'A', 0]],
      'a2 is unchanged, so it stays out');
    assert.deepEqual(draft.deletedBlockIds, []);
    assert.equal('name' in draft, false, "the title didn't change");
    assert.equal(draft.preview, 'typed as the tab closed');
    assert.deepEqual(committed, [['elements']], "#133's closing write still runs");
  });

  it('the next start applies it as a save when the closing write was lost', async () => {
    Storage.saveNoteWithBlocks = (n, els, options) => (options && options.closing
      ? new Promise(() => {}) // held behind another page's transaction, and gone with the page
      : Storage.constructor.prototype.saveNoteWithBlocks.call(Storage, n, els, options));
    type(editor, 'kept by the draft');
    env.window.fire('pagehide');
    const { result } = await nextStart(env);
    assert.deepEqual(result.saved, ['A']);
    assert.equal((await elementsById(env)).a1.content, 'kept by the draft');
    assert.deepEqual(drafts(env), []);
  });

  it('carries the title, typed or generated, when it changed since the last save', async () => {
    editor.noteData.name = 'Alpha, retitled';
    editor.noteData.titleManuallySet = true;
    editor.scheduleSave();
    env.window.fire('pagehide');
    const [draft] = drafts(env);
    assert.deepEqual([draft.name, draft.titleOrigin], ['Alpha, retitled', 'typed']);
    assert.deepEqual(draft.blocks, [], 'no block changed');
  });

  it('lists a block deleted since the last save, which stays deleted after the next start', async () => {
    Object.assign(editor, { removeBlockDOM() {}, focusBlock() {} });
    Storage.deleteElement = () => new Promise(() => {}); // its transaction is lost with the page
    editor.deleteBlock('a2');
    type(editor, 'alpha, with a2 gone');
    env.window.fire('pagehide');
    const [draft] = drafts(env);
    assert.deepEqual(draft.deletedBlockIds, ['a2']);
    await nextStart(env);
    const rows = await elementsById(env);
    assert.equal(rows.a2, undefined);
    assert.equal(rows.a1.content, 'alpha, with a2 gone');
  });

  it('lists a block added and saved since the load, then deleted with its delete lost, and the next start deletes it', async () => {
    const added = env.get('Block').deserialize({ type: 'text', content: 'added after the load' });
    editor.blocks.push(added);
    editor.scheduleSave();
    await runUntil(env, editor.flushSave());
    Object.assign(editor, { removeBlockDOM() {}, focusBlock() {} });
    Storage.deleteElement = () => new Promise(() => {}); // its transaction is lost with the page
    Storage.saveNoteWithBlocks = (n, els, options) => (options && options.closing
      ? new Promise(() => {})
      : Storage.constructor.prototype.saveNoteWithBlocks.call(Storage, n, els, options));
    editor.deleteBlock(added.id);
    env.window.fire('pagehide');
    const [draft] = drafts(env);
    assert.deepEqual(draft.deletedBlockIds, [added.id], 'the save it saw commit had the block');
    await nextStart(env);
    assert.equal((await elementsById(env))[added.id], undefined);
  });

  it('writes nothing when every edit has committed, and nothing for a bfcache hide', async () => {
    type(editor, 'saved before the close');
    await runUntil(env, editor.flushSave());
    env.window.fire('pagehide');
    assert.deepEqual(drafts(env), []);

    type(editor, 'pending, then cached');
    env.window.fire('pagehide', { persisted: true });
    assert.deepEqual(drafts(env), [], 'the page may come back, and it still has the edit');
  });

  it('writes nothing for a note the editor found deleted', async () => {
    type(editor, 'typed into A');
    await Storage.permanentlyDeleteNote('A'); // another tab
    await runUntil(env, editor.flushSave());
    assert.equal(editor.noteGone, true);
    type(editor, 'typed again');
    env.window.fire('pagehide');
    assert.deepEqual(drafts(env), []);
  });

  it("a draft that won't fit is skipped: pagehide doesn't throw, and the closing write still runs", async () => {
    const small = await setup({ localStorage: createLocalStorage({ quota: 100 }) });
    const tight = makeEditor(small.env);
    await tight.loadNote('A');
    const committed = spyCommits(small.Storage);
    type(tight, 'x'.repeat(300));
    assert.doesNotThrow(() => small.env.window.fire('pagehide'));
    assert.deepEqual(drafts(small.env), []);
    assert.deepEqual(committed, [['elements']]);
    await settle();
    assert.equal((await elementsById(small.env)).a1.content, 'x'.repeat(300));
  });

  it("covers every editor of the page: the split view's and the pop-out's, one draft each", async () => {
    const secondary = makeEditor(env);
    await secondary.loadNote('B');
    const pipDoc = new FakeDocument();
    const pipWindow = windowTarget();
    pipDoc.defaultView = pipWindow;
    const pip = makeEditor(env, pipDoc);
    await pip.loadNote('C');
    pip.noteData.name = 'Charlie, renamed in the pop-out';
    pip.noteData.titleManuallySet = true;
    type(editor, 'main pane');
    type(secondary, 'split view');
    type(pip, 'pop-out');

    env.window.fire('pagehide');
    const byNote = Object.fromEntries(drafts(env).map((draft) => [draft.noteId, draft]));
    assert.deepEqual(Object.keys(byNote).sort(), ['A', 'B', 'C']);
    assert.equal(byNote.C.blocks[0].content, 'pop-out');
    assert.equal(byNote.C.name, 'Charlie, renamed in the pop-out', "the pop-out's title too");
  });

  it("the pop-out's own close writes its whole save and no draft, as the page stays", async () => {
    const pipDoc = new FakeDocument();
    const pipWindow = windowTarget();
    pipDoc.defaultView = pipWindow;
    const pip = makeEditor(env, pipDoc);
    await pip.loadNote('C');
    type(pip, 'pop-out, closing alone');
    pipWindow.fire('pagehide');
    assert.deepEqual(drafts(env), []);
    await settle();
    assert.equal((await elementsById(env)).c1.content, 'pop-out, closing alone');
  });

  it('a failed save of a note the editor left still gets a draft, from the copy waiting to retry', async () => {
    const real = Storage.saveNoteWithBlocks.bind(Storage);
    let fail = 1;
    Storage.saveNoteWithBlocks = (n, els, options) => (n.id === 'A' && fail-- > 0 ? Promise.reject(new Error('disk busy')) : real(n, els, options));
    // Typed into A while loadNote('B') reads B, so A's last write starts during the switch
    const load = editor.loadNote('B');
    type(editor, 'alpha, failed once');
    env.frames();
    await load;
    await settle();
    assert.equal(editor.noteId, 'B');
    assert.equal(editor._retryCopies.has('A'), true, "A's copy waits for its retry");
    env.window.fire('pagehide');
    const [draft] = drafts(env).filter((d) => d.noteId === 'A');
    assert.ok(draft, 'a draft of A');
    assert.deepEqual(draft.blocks.map((b) => b.content), ['alpha, failed once'], 'only the block that changed');
  });
});

describe('the writer and the applier together', () => {
  it('the visibility flush commits, pagehide drafts the same edit while that save is in flight, and the next start drops it without writing', async () => {
    const { env, Storage } = await setup();
    const editor = makeEditor(env);
    await editor.loadNote('A');
    type(editor, 'flushed when the tab hid');
    env.document.visibilityState = 'hidden';
    env.document.fire('visibilitychange'); // the save opens now, and commits after pagehide
    env.window.fire('pagehide');
    assert.equal(drafts(env).length, 1, 'its save was still in flight');
    await settle();
    const saved = await Storage.getNote('A');
    assert.equal(saved.preview, 'flushed when the tab hid');

    const { result } = await nextStart(env);
    assert.deepEqual(result.dropped, ['A']);
    const after = await Storage.getNote('A');
    assert.equal(after.updatedAt, saved.updatedAt, 'not written again');
    assert.equal(Object.keys(recordsOf(await dumpDatabase(env.indexedDB), 'canvases')).length, 3, 'no recovered note');
  });

  it("an earlier save of the tab that commits after the close is its own: the draft saves the later edit, with no recovered note", async () => {
    const { env, Storage } = await setup();
    const editor = makeEditor(env);
    await editor.loadNote('A');
    const real = Storage.saveNoteWithBlocks.bind(Storage);
    const held = [];
    // The tab's earlier save is in flight at the close, and its closing write is lost
    Storage.saveNoteWithBlocks = (n, els, options) => {
      if (options && options.closing) return new Promise(() => {});
      const write = real(n, els, options);
      held.push(write);
      return write;
    };
    type(editor, 'the earlier edit');
    env.document.visibilityState = 'hidden';
    env.document.fire('visibilitychange');
    type(editor, 'the later edit');
    env.window.fire('pagehide');
    const [draft] = drafts(env);
    assert.equal(draft.base.issued.length, 1, "the save in flight's stamp");
    await Promise.all(held);
    assert.equal((await elementsById(env)).a1.content, 'the earlier edit', 'the earlier save committed after the close');

    const { result } = await nextStart(env);
    assert.deepEqual(result.saved, ['A']);
    assert.deepEqual(result.recovered, []);
    assert.equal((await elementsById(env)).a1.content, 'the later edit');
  });
});
