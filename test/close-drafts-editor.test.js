'use strict';

// The stack's close-time draft writer (#33, the stack's close-time PR, R0's #138 ported): at the
// page's own pagehide, before any editor issues its closing write, every editor holding an edit
// it hasn't seen commit writes one draft to localStorage, the main pane's, the split view's and
// the pop-out's, under the commandId its closing save then takes. The draft's base is what the
// applier reads (js/kernel/core/domain/close-draft.js): the content revision the editor last saw
// commit, each block the draft names by its digest as stored, and the saves the page issued
// since. The next start applies it (test/kernel/close-drafts.test.mjs has the rules). On
// legacy-env pages with the real kernel on #17's adapter, sharing one profile.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  createLegacyEnv, createDatabase, dumpDatabase, recordsOf, createLocalStorage, settle, plain, note, block, FakeDocument,
  makeEditor, releaseStorage, runUntil, startEditorClient,
} = require('./helpers/legacy-env');
const { release143 } = require('./helpers/release-143');

const FILES = [
  'js/utils.js',
  'js/core/storage-error.js',
  'js/storage.js',
  'js/sidebar-utils.js',
  'js/blocks.js',
  'js/editor.js',
];

const PREFIX = 'ntn-close-draft:';

/** A window for an editor's own document, as the pop-out has, whose frames a test runs */
function windowTarget() {
  const listeners = {};
  const queued = [];
  return {
    listeners,
    addEventListener(type, fn) { (listeners[type] = listeners[type] || []).push(fn); },
    fire(type, fields = {}) { (listeners[type] || []).forEach((fn) => fn({ type, ...fields })); },
    requestAnimationFrame(fn) { queued.push(fn); return queued.length; },
    frames() {
      const batch = queued.splice(0, queued.length);
      batch.forEach((fn) => fn(0));
      return batch.length;
    },
  };
}

/** A pop-out's editor on `env`'s page, in its own document and window, holding `noteId` */
async function openPiP(env, noteId) {
  const pipDoc = new FakeDocument();
  const pipWindow = windowTarget();
  pipDoc.defaultView = pipWindow;
  const pip = makeEditor(env, pipDoc);
  await pip.loadNote(noteId);
  return { pip, pipWindow };
}

/** Keep the page's frames and the pop-out's flowing until `promise` settles */
async function runWithPiP(env, pipWindow, promise) {
  let finished = false;
  const tracked = Promise.resolve(promise).finally(() => { finished = true; });
  for (let i = 0; i < 400 && !finished; i++) {
    env.frames();
    pipWindow.frames();
    await settle(2);
  }
  return tracked;
}

/** Type into a block of the loaded note, as onBlockInput does */
function type(editor, text, index = 0) {
  editor.blocks[index].content = text;
  editor.blocks[index].markUpdated();
  editor.scheduleSave();
}

/**
 * A new tab's page on a profile at version 8, as 1.4.x left it, its editors on the real kernel
 * with the page's draft writer: notes A (a1, a2), B (b1) and C (c1, c2), and what `more` adds
 * @param {{localStorage?: Object, notes?: Array<Object>, blocks?: Array<Object>, files?: Array<string>}} [more]
 */
async function setup({ localStorage = createLocalStorage(), notes = [], blocks = [], files = FILES } = {}) {
  const env = createLegacyEnv({ localStorage });
  await createDatabase(env.indexedDB, {
    records: {
      canvases: [note('A', { name: 'Alpha' }), note('B', { name: 'Bravo' }), note('C', { name: 'Charlie' }), ...notes],
      elements: [
        block('a1', 'A', 0, 'alpha'),
        block('a2', 'A', 1, 'alpha two'),
        block('b1', 'B', 0, 'bravo'),
        block('c1', 'C', 0, 'charlie'),
        block('c2', 'C', 1, 'charlie two'),
        ...blocks,
      ],
    },
  });
  env.load(...files);
  await startEditorClient(env);
  return env;
}

/** Another tab's page on `env`'s profile, sharing its localStorage, as two new tabs do */
async function secondTab(env) {
  const other = createLegacyEnv({ indexedDB: env.indexedDB, localStorage: env.global.localStorage });
  other.load(...FILES);
  await startEditorClient(other);
  return other;
}

/** The drafts in `env`'s localStorage, oldest first, each with its key */
function drafts(env) {
  const storage = env.global.localStorage;
  const found = [];
  for (let index = 0; index < storage.length; index += 1) {
    const key = storage.key(index);
    if (key.startsWith(PREFIX)) found.push({ key, ...JSON.parse(storage.getItem(key)) });
  }
  return plain(found.sort((a, b) => a.at - b.at));
}

/**
 * The next start: another new tab on the same profile, whose root applies the drafts before its
 * first read (createNewTabPageClient). Answers what it applied.
 */
async function nextStart(env) {
  const newTab = await import('../js/kernel/composition/newtab.js');
  const client = newTab.createNewTabPageClient(
    newTab.createNewTabAdapter({
      indexedDB: env.indexedDB,
      settings: env.chrome.api.storage.local,
      awaitUpgrade: async () => {},
      locks: env.global.navigator.locks,
    }),
    { drafts: { storage: env.global.localStorage, locks: env.global.navigator.locks }, wake: () => {} },
  );
  const failure = await client.whenReady();
  if (failure) throw new Error(`the next start's kernel didn't start: ${failure.code}`);
  return plain(await client.applied());
}

/** The stored blocks and notes, by id */
async function storedRows(env) {
  const dump = await dumpDatabase(env.indexedDB);
  return { blocks: recordsOf(dump, 'elements'), notes: recordsOf(dump, 'canvases') };
}

/** The names of the stored notes that say they're recovered */
const recoveredNames = async (env) => Object.values((await storedRows(env)).notes)
  .map((row) => row.name)
  .filter((name) => typeof name === 'string' && name.startsWith('Recovered'));

/**
 * The page's saves, in order: each one's note, the commandId it was given, its blocks' ids, and
 * `done`, its answer. A save `hold` answers true for never answers, as one lost with a closing page.
 */
function watchSaves(env, { hold = () => false } = {}) {
  const client = env.documentClient;
  const real = client.saveContent;
  const saves = [];
  client.saveContent = (save, options) => {
    const done = hold(save, options) ? new Promise(() => {}) : real(save, options);
    saves.push({ noteId: save.noteId, commandId: options && options.commandId, blocks: save.blocks.map((b) => b.id), done });
    return done;
  };
  return saves;
}

/** A closing save, the one pagehide issues under its draft's id */
const closingSave = (save, options) => Boolean(options && options.commandId);

/** The page's own close: a pagehide that isn't a back/forward cache hide */
const closePage = (env) => env.window.fire('pagehide', { persisted: false });

/** Stub the DOM-only parts of deleting a block */
const allowDeletes = (editor) => Object.assign(editor, { removeBlockDOM() {}, focusBlock() {} });

/** Every save of `noteId` fails as a full disk's does, and the rest go through */
function failSavesOf(env, noteId) {
  const client = env.documentClient;
  const real = client.saveContent;
  client.saveContent = (save, options) => (save.noteId === noteId
    ? Promise.resolve({ kind: 'unavailable', cause: 'quota', code: 'quota', retryable: false })
    : real(save, options));
  return () => { client.saveContent = real; };
}

describe("the stack's close-time draft writer", () => {
  it("writes one draft at the page's own pagehide inside the debounce, keyed by the commandId its closing save takes after it", async () => {
    const env = await setup();
    const opened = await env.documentClient.openNote('A');
    const editor = makeEditor(env);
    await editor.loadNote('A');
    const order = [];
    const storage = env.global.localStorage;
    const setItem = storage.setItem.bind(storage);
    storage.setItem = (key, value) => {
      if (String(key).startsWith(PREFIX)) order.push('draft');
      return setItem(key, value);
    };
    const saves = watchSaves(env, { hold: () => { order.push('save'); return false; } });
    type(editor, 'typed as the tab closed');
    closePage(env);

    const all = drafts(env);
    assert.equal(all.length, 1);
    const [draft] = all;
    assert.deepEqual(order, ['draft', 'save'], 'the draft first, then the closing save');
    assert.equal(draft.key, `${PREFIX}${draft.id}`);
    assert.equal(saves.length, 1);
    assert.equal(saves[0].commandId, draft.id, "the closing save shares the draft's id");
    assert.equal(draft.v, 1);
    assert.equal(draft.noteId, 'A');
    assert.equal(draft.page, env.documentClient.closeDrafts.page);
    assert.deepEqual(draft.blocks.map((b) => [b.id, b.content, b.canvasId, b.order]), [['a1', 'typed as the tab closed', 'A', 0]],
      'a2 is unchanged, so it stays out');
    assert.deepEqual(draft.deletedBlockIds, []);
    assert.equal('name' in draft, false, "the title didn't change");
    assert.equal(draft.preview, 'typed as the tab closed');
    assert.equal(typeof opened.revision, 'number');
    const a1 = opened.blocks.find((b) => b.id === 'a1');
    assert.deepEqual(draft.base, {
      revision: opened.revision,
      updatedAt: opened.note.updatedAt,
      issued: [],
      name: 'Alpha',
      blocks: { a1: env.documentClient.closeDrafts.digest(a1, 'A') },
      issuedSaves: [],
    }, 'the base names only the block the draft holds, by its digest as stored');
    await saves[0].done;
  });

  it('the next start applies it as a save when the closing save was lost', async () => {
    const env = await setup();
    const editor = makeEditor(env);
    await editor.loadNote('A');
    watchSaves(env, { hold: closingSave });
    type(editor, 'kept by the draft');
    closePage(env);
    const result = await nextStart(env);
    assert.deepEqual(result.saved, ['A']);
    assert.equal((await storedRows(env)).blocks.a1.content, 'kept by the draft');
    assert.deepEqual(drafts(env), []);
    assert.deepEqual(await recoveredNames(env), []);
  });

  it("carries the title, typed or generated, when it changed since the base, and none when it is the base's", async () => {
    const env = await setup();
    const editor = makeEditor(env);
    await editor.loadNote('A');
    watchSaves(env, { hold: closingSave });
    editor._titleSet('Alpha, retitled', 'typed');
    editor.scheduleSave();
    closePage(env);
    const [draft] = drafts(env);
    assert.deepEqual([draft.name, draft.titleOrigin], ['Alpha, retitled', 'typed']);
    assert.deepEqual(draft.blocks, [], 'no block changed');

    const generated = await setup();
    const ai = makeEditor(generated);
    await ai.loadNote('A');
    watchSaves(generated, { hold: closingSave });
    ai._titleSet('Alpha, by the AI', 'generated');
    ai.scheduleSave();
    closePage(generated);
    const [made] = drafts(generated);
    assert.deepEqual([made.name, made.titleOrigin], ['Alpha, by the AI', 'generated']);

    const same = await setup();
    const unchanged = makeEditor(same);
    await unchanged.loadNote('A');
    watchSaves(same, { hold: closingSave });
    unchanged._titleSet('Alpha', 'typed');
    type(unchanged, 'alpha, edited');
    closePage(same);
    assert.equal('name' in drafts(same)[0], false, "the title it set is the note's");
  });

  it('lists a block whose delete is still in flight, which stays deleted after the next start, and not one whose delete committed', async () => {
    const env = await setup();
    const editor = allowDeletes(makeEditor(env));
    await editor.loadNote('A');
    watchSaves(env, { hold: closingSave });
    env.documentClient.deleteBlocks = () => new Promise(() => {}); // lost with the page
    editor.deleteBlock('a2');
    type(editor, 'alpha, with a2 gone');
    closePage(env);
    const [draft] = drafts(env);
    assert.deepEqual(draft.deletedBlockIds, ['a2']);
    assert.deepEqual(Object.keys(draft.base.blocks).sort(), ['a1', 'a2'], 'the base names the deleted block too');
    await nextStart(env);
    const rows = (await storedRows(env)).blocks;
    assert.equal(rows.a2, undefined);
    assert.equal(rows.a1.content, 'alpha, with a2 gone');

    const committed = await setup();
    const other = allowDeletes(makeEditor(committed));
    await other.loadNote('A');
    watchSaves(committed, { hold: closingSave });
    const realDelete = committed.documentClient.deleteBlocks;
    const deletes = [];
    committed.documentClient.deleteBlocks = (noteId, ids) => {
      const done = realDelete(noteId, ids);
      deletes.push(done);
      return done;
    };
    other.deleteBlock('a2');
    assert.equal((await deletes[0]).kind, 'committed');
    type(other, 'alpha, a2 deleted before');
    closePage(committed);
    const [after] = drafts(committed);
    assert.deepEqual(after.deletedBlockIds, []);
    assert.deepEqual(Object.keys(after.base.blocks), ['a1']);
  });

  it("covers every editor of the page: the split view's and the pop-out's, one draft each, the pop-out's title included", async () => {
    const env = await setup();
    const main = makeEditor(env);
    await main.loadNote('A');
    const secondary = makeEditor(env);
    await secondary.loadNote('B');
    const { pip } = await openPiP(env, 'C');
    watchSaves(env, { hold: closingSave });
    pip._titleSet('Charlie, renamed in the pop-out', 'typed');
    type(main, 'main pane');
    type(secondary, 'split view');
    type(pip, 'pop-out');
    closePage(env);
    const all = drafts(env);
    const byNote = Object.fromEntries(all.map((draft) => [draft.noteId, draft]));
    assert.deepEqual(Object.keys(byNote).sort(), ['A', 'B', 'C']);
    assert.equal(byNote.A.blocks[0].content, 'main pane');
    assert.equal(byNote.B.blocks[0].content, 'split view');
    assert.equal(byNote.C.blocks[0].content, 'pop-out');
    assert.equal(byNote.C.name, 'Charlie, renamed in the pop-out', "the pop-out's title too");
    assert.equal(new Set(all.map((draft) => draft.page)).size, 1, "one page's drafts, one page id");
    assert.equal(new Set(all.map((draft) => draft.id)).size, 3);
  });

  it('a failed save of a note the editor left still gets a draft, from the copy waiting to retry', async () => {
    const env = await setup();
    const editor = makeEditor(env);
    await editor.loadNote('A');
    const client = env.documentClient;
    const real = client.saveContent;
    let fail = 1;
    client.saveContent = (save, options) => (save.noteId === 'A' && fail-- > 0
      ? Promise.resolve({ kind: 'unavailable', cause: 'quota', code: 'quota', retryable: false })
      : real(save, options));
    // Typed into A as loadNote('B') starts, so the switch writes it, and that write fails
    const load = editor.loadNote('B');
    type(editor, 'alpha, failed once');
    env.frames();
    await load;
    await settle();
    assert.equal(editor.noteId, 'B');
    assert.equal(editor._retryCopies.has('A'), true, "A's copy waits for its retry");
    closePage(env);
    const all = drafts(env);
    assert.deepEqual(all.map((draft) => draft.noteId), ['A'], 'B is as loaded, so it has none');
    assert.deepEqual(all[0].blocks.map((b) => b.content), ['alpha, failed once'], 'only the block that changed');
  });

  it("counts a save another editor of the page issued as the page's own: when both changed one block, the later edit wins, with no recovered note", async () => {
    const env = await setup();
    const main = makeEditor(env);
    await main.loadNote('C');
    const { pip, pipWindow } = await openPiP(env, 'C');
    // The pop-out saves c1 and c2, so the note's revision moves past the main pane's base
    type(pip, 'charlie, from the pop-out', 0);
    type(pip, 'charlie two, from the pop-out', 1);
    assert.equal(await runWithPiP(env, pipWindow, pip.flushSave()), true);
    watchSaves(env, { hold: closingSave });
    // The main pane's copy is stale, and it types into c1 too
    type(main, 'charlie, from the main pane, later', 0);
    closePage(env);
    const all = drafts(env);
    assert.equal(all.length, 1, "the pop-out has nothing it hasn't seen commit");
    assert.deepEqual(all[0].blocks.map((b) => b.id), ['c1']);
    assert.equal(all[0].base.issuedSaves.length, 1, "the pop-out's save, from the main pane's base on");
    const result = await nextStart(env);
    assert.deepEqual(result.saved, ['C']);
    assert.deepEqual(await recoveredNames(env), [], 'the same page, so no recovered note');
    const rows = (await storedRows(env)).blocks;
    assert.equal(rows.c1.content, 'charlie, from the main pane, later', 'the later edit wins on c1');
    assert.equal(rows.c2.content, 'charlie two, from the pop-out', "the pop-out's block stays");
  });

  it('the visibility flush commits, pagehide drafts the same edit while that save is in flight, and the next start drops it without writing', async () => {
    const env = await setup();
    const editor = makeEditor(env);
    await editor.loadNote('A');
    type(editor, 'flushed when the tab hid');
    env.document.visibilityState = 'hidden';
    env.document.fire('visibilitychange'); // the save opens now, and commits after pagehide
    closePage(env);
    assert.equal(drafts(env).length, 1, 'its save was still in flight');
    assert.equal(await runUntil(env, editor.flushSave()), true);
    const saved = (await storedRows(env)).notes.A;
    assert.equal(saved.preview, 'flushed when the tab hid');
    const result = await nextStart(env);
    assert.deepEqual(result.dropped, ['A']);
    assert.equal((await storedRows(env)).notes.A.updatedAt, saved.updatedAt, 'not written again');
    assert.deepEqual(await recoveredNames(env), []);
  });

  it("an earlier save of the page that commits after the close is the page's own: the draft saves the later edit, with no recovered note", async () => {
    const env = await setup();
    const editor = makeEditor(env);
    await editor.loadNote('A');
    const saves = watchSaves(env, { hold: closingSave });
    type(editor, 'the earlier edit');
    env.document.visibilityState = 'hidden';
    env.document.fire('visibilitychange');
    type(editor, 'the later edit');
    closePage(env);
    const [draft] = drafts(env);
    assert.equal(draft.base.issuedSaves.length, 1, 'the save in flight');
    assert.equal(saves.length, 2, 'the earlier save, then the closing one');
    assert.equal((await saves[0].done).kind, 'committed');
    assert.equal((await storedRows(env)).blocks.a1.content, 'the earlier edit', 'the earlier save committed after the close');
    const result = await nextStart(env);
    assert.deepEqual(result.saved, ['A']);
    assert.deepEqual(result.recovered, []);
    assert.equal((await storedRows(env)).blocks.a1.content, 'the later edit');
  });

  it("a block stored in a shape the editor doesn't write stays out unless edited, and one edited is still the page's own once the revision moved", async () => {
    // 1.4.x records with a field the editor's serialize() leaves out
    const env = await setup({
      notes: [note('D', { name: 'Delta' })],
      blocks: [block('d1', 'D', 0, 'delta', { legacyField: 'kept' }), block('d2', 'D', 1, 'delta two', { legacyField: 'kept' })],
    });
    const editor = makeEditor(env);
    await editor.loadNote('D');
    watchSaves(env, { hold: closingSave });
    type(editor, 'delta two, edited', 1);
    // Another writer's insert moves the note's revision past the base
    const insert = await env.kernel.execute({
      type: 'insertBlocks',
      commandId: 'another-writer-insert',
      noteId: 'D',
      blocks: [{ id: 'd3', type: 'text', content: 'from another writer' }],
    });
    assert.equal(insert.kind, 'committed');
    closePage(env);
    const [draft] = drafts(env);
    assert.deepEqual(draft.blocks.map((b) => b.id), ['d2'], 'd1 is unchanged, whatever its stored shape');
    const result = await nextStart(env);
    assert.deepEqual(result.saved, ['D']);
    assert.deepEqual(await recoveredNames(env), []);
    const rows = (await storedRows(env)).blocks;
    assert.equal(rows.d2.content, 'delta two, edited');
    assert.equal(rows.d1.legacyField, 'kept', 'd1 as stored');
    assert.equal(rows.d3.content, 'from another writer');
  });

  it("an edit the page couldn't save once its connection went comes back at the next start, read by its digests with no revision known (V7, d20)", async () => {
    const env = await setup();
    const editor = makeEditor(env);
    await editor.loadNote('A');
    const client = env.documentClient;
    const real = client.saveContent;
    let open = true;
    client.connectionOpen = () => open;
    let calls = 0;
    // The first save commits, then the connection closes for another context's upgrade, so it
    // answers reload-required, which the editor takes as 'stored', with no revision. Every save
    // after that is refused.
    client.saveContent = async (save, options) => {
      calls += 1;
      if (calls === 1) {
        await real(save, options);
        open = false;
      }
      return { kind: 'unavailable', cause: 'storage', code: 'reload-required', retryable: false };
    };
    type(editor, 'stored as the connection closed');
    assert.equal(await runUntil(env, editor.flushSave()), true);
    type(editor, 'typed after the connection went');
    assert.equal(await runUntil(env, editor.flushSave()), false);
    assert.equal(editor.reloadRequired, true, 'the reload notice shows');
    // The user reloads: the page's own close
    closePage(env);
    const [draft] = drafts(env);
    assert.equal(draft.base.revision, null, "the 'stored' save gave no revision");
    assert.equal(typeof draft.base.blocks.a1, 'string', 'a stack draft, told by its digests');
    assert.deepEqual(draft.blocks.map((b) => b.content), ['typed after the connection went']);
    const result = await nextStart(env);
    assert.deepEqual(result.saved, ['A'], 'read by its digests, not as a 1.4.3 draft');
    assert.deepEqual(await recoveredNames(env), []);
    assert.equal((await storedRows(env)).blocks.a1.content, 'typed after the connection went');
  });

  it('writes nothing when every edit has committed, for a back/forward cache hide, for a note found deleted, or for a note a revert is replacing', async () => {
    const env = await setup();
    const editor = makeEditor(env);
    await editor.loadNote('A');
    type(editor, 'saved before the close');
    assert.equal(await runUntil(env, editor.flushSave()), true);
    closePage(env);
    assert.deepEqual(drafts(env), []);

    const cached = await setup();
    const kept = makeEditor(cached);
    await kept.loadNote('A');
    type(kept, 'pending, then cached');
    cached.window.fire('pagehide', { persisted: true });
    assert.deepEqual(drafts(cached), [], 'the page may come back, and it still has the edit');

    const deleted = await setup();
    const gone = makeEditor(deleted);
    await gone.loadNote('A');
    type(gone, 'typed into A');
    await (await releaseStorage(deleted)).permanentlyDeleteNote('A'); // another tab
    assert.equal(await runUntil(deleted, gone.flushSave()), false);
    assert.equal(gone.noteGone, true);
    type(gone, 'typed again');
    closePage(deleted);
    assert.deepEqual(drafts(deleted), []);

    const reverting = await setup();
    const reverted = makeEditor(reverting);
    await reverted.loadNote('A');
    watchSaves(reverting, { hold: closingSave });
    type(reverted, 'typed while the revert commits');
    // A revert is replacing the note's blocks (_revertToSnapshot): what's typed meanwhile goes
    // to version history, and none of it goes back onto the note
    reverted._revertingNoteId = 'A';
    closePage(reverting);
    assert.deepEqual(drafts(reverting), []);
  });

  it("a draft that won't fit is skipped: pagehide doesn't throw, and the closing save still runs", async () => {
    const env = await setup({ localStorage: createLocalStorage({ quota: 100 }) });
    const editor = makeEditor(env);
    await editor.loadNote('A');
    const saves = watchSaves(env);
    type(editor, 'x'.repeat(300));
    assert.doesNotThrow(() => closePage(env));
    assert.deepEqual(drafts(env), []);
    assert.equal(saves.length, 1, 'the closing save');
    assert.equal((await saves[0].done).kind, 'committed');
    assert.equal((await storedRows(env)).blocks.a1.content, 'x'.repeat(300));
  });
});

/** AI chat on `env`'s page, adding to the note `editor` shows, as App hands it the editor */
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
  return Object.assign(chat, { getEditor: () => editor, indexing: null });
}

/** A snapshot of note A as `editor` shows it, then an edit to a1 saved, so a revert to it changes a1 */
async function snapshotThenEdit(env, editor) {
  const snap = await env.documentClient.saveSnapshot('A', editor.blocks.map((b) => b.serialize()), 'Alpha');
  assert.equal(snap.kind, 'committed');
  type(editor, 'alpha, edited after the snapshot', 0);
  assert.equal(await runUntil(env, editor.flushSave()), true);
  const [summary] = await env.documentClient.snapshots('A');
  return summary;
}

/** As AI chat's appendAIResponseToNote: the editor's copy saved, then the insert, which the editor takes into its blocks in the same task, with its outcome */
async function insertFromAI(env, editor, at) {
  assert.equal(await runUntil(env, editor.save().then(() => true)), true);
  const blocks = [{ type: 'text', content: 'from the AI', id: env.documentClient.newId() }];
  const inserting = env.documentClient.insertBlocks('A', blocks, at);
  editor.placeInsertedBlocks('A', blocks, at, inserting);
  assert.equal((await inserting).kind, 'committed');
}

describe("the base after the editor's own writes that aren't saves: AI chat's insert and a revert (R160's B1)", () => {
  it('an AI insert into the loaded note, then the close with nothing typed since: no draft, and no recovered note', async () => {
    const env = await setup();
    const editor = makeEditor(env);
    await editor.loadNote('A');
    await insertFromAI(env, editor, 1);
    watchSaves(env, { hold: closingSave });
    closePage(env);
    assert.deepEqual(drafts(env), [], 'the page stored every block it shows');
    await nextStart(env);
    assert.deepEqual(await recoveredNames(env), [], 'nothing but the page itself wrote the note');
  });

  it('an AI insert, then an edit inside the debounce, the closing save lost: the edit goes into the note at the next start', async () => {
    const env = await setup();
    const editor = makeEditor(env);
    await editor.loadNote('A');
    await insertFromAI(env, editor, 1);
    watchSaves(env, { hold: closingSave });
    type(editor, 'alpha, typed after the insert', 0);
    closePage(env);
    const [draft] = drafts(env);
    assert.deepEqual(draft.blocks.map((b) => b.id), ['a1'], 'only the block typed into');
    const result = await nextStart(env);
    assert.deepEqual(result.saved, ['A']);
    assert.deepEqual(await recoveredNames(env), []);
    assert.equal((await storedRows(env)).blocks.a1.content, 'alpha, typed after the insert');
  });

  it('an edit not saved yet to a block the insert moves down stays in the draft, and the next start keeps it', async () => {
    const env = await setup();
    const editor = makeEditor(env);
    await editor.loadNote('A');
    watchSaves(env, { hold: closingSave });
    // Typed into a2 inside the debounce, and the insert goes in above it
    type(editor, 'alpha two, typed before the insert', 1);
    const blocks = [{ type: 'text', content: 'from the AI', id: env.documentClient.newId() }];
    const inserting = env.documentClient.insertBlocks('A', blocks, 1);
    editor.placeInsertedBlocks('A', blocks, 1, inserting);
    assert.equal((await inserting).kind, 'committed');
    closePage(env);
    const [draft] = drafts(env);
    assert.ok(draft, 'a draft');
    assert.deepEqual(draft.blocks.filter((b) => b.id === 'a2').map((b) => b.content), ['alpha two, typed before the insert']);
    await nextStart(env);
    const kept = Object.values((await storedRows(env)).blocks).filter((row) => row.content === 'alpha two, typed before the insert');
    assert.equal(kept.length, 1, 'the edit is kept, in the note or in a recovered one');
  });

  it("through AI chat's own insert at the cursor: the close with nothing typed writes no draft, and an edit to a block it moved down goes into the note", async () => {
    const files = [...FILES, 'js/controllers/ai-chat-controller.js'];
    const env = await setup({ files });
    env.get('Utils').showToast = () => {};
    const editor = makeEditor(env);
    await editor.loadNote('A');
    editor.activeBlock = 'a1';
    await runUntil(env, aiChat(env, editor).appendAIResponseToNote([{ type: 'text', content: 'from the AI' }]));
    assert.deepEqual(editor.blocks.map((b) => b.content), ['alpha', 'from the AI', 'alpha two'], 'in after a1, with a2 moved down');
    closePage(env);
    assert.deepEqual(drafts(env), []);

    const typed = await setup({ files });
    typed.get('Utils').showToast = () => {};
    const other = makeEditor(typed);
    await other.loadNote('A');
    other.activeBlock = 'a1';
    await runUntil(typed, aiChat(typed, other).appendAIResponseToNote([{ type: 'text', content: 'from the AI' }]));
    watchSaves(typed, { hold: closingSave });
    type(other, 'alpha two, moved down, then typed', 2);
    closePage(typed);
    const [draft] = drafts(typed);
    assert.deepEqual(draft.blocks.map((b) => [b.id, b.order]), [['a2', 2]], 'only the block typed into');
    const result = await nextStart(typed);
    assert.deepEqual(result.saved, ['A']);
    assert.deepEqual(await recoveredNames(typed), []);
    const rows = (await storedRows(typed)).blocks;
    assert.deepEqual([rows.a2.content, rows.a2.order], ['alpha two, moved down, then typed', 2]);
  });

  it('a revert, then an edit to a block it changed, the closing save lost: the edit goes into the note, with no recovered note', async () => {
    const env = await setup();
    const editor = makeEditor(env);
    await editor.loadNote('A');
    const summary = await snapshotThenEdit(env, editor);
    await runUntil(env, editor._revertToSnapshot(summary));
    assert.equal(editor.blocks[0].content, 'alpha', 'the revert is on screen');
    const { revision } = await env.documentClient.openNote('A');
    watchSaves(env, { hold: closingSave });
    type(editor, 'alpha, typed after the revert', 0);
    closePage(env);
    const [draft] = drafts(env);
    assert.deepEqual(draft.blocks.map((b) => b.id), ['a1']);
    assert.equal(draft.base.revision, revision, "the revert's own revision");
    const result = await nextStart(env);
    assert.deepEqual(result.saved, ['A']);
    assert.deepEqual(await recoveredNames(env), [], "the page's own revert is no other writer");
    assert.equal((await storedRows(env)).blocks.a1.content, 'alpha, typed after the revert');
  });

  it('a revert, then the close with nothing typed since: no draft, whether its blocks reached the screen at once or from a read of the note', async () => {
    const env = await setup();
    const editor = makeEditor(env);
    await editor.loadNote('A');
    const summary = await snapshotThenEdit(env, editor);
    await runUntil(env, editor._revertToSnapshot(summary));
    closePage(env);
    assert.deepEqual(drafts(env), [], 'every change the page made has committed');

    // The restored blocks don't reach the screen at once, so the note as stored goes on screen
    // from a read of it (R77, P8), which is the base then
    const read = await setup();
    const shown = makeEditor(read);
    await shown.loadNote('A');
    const again = await snapshotThenEdit(read, shown);
    const Block = read.get('Block');
    const deserialize = Block.deserialize;
    let throwNext = true;
    Block.deserialize = function (data) {
      if (throwNext) {
        throwNext = false;
        throw new Error('deserialize failed');
      }
      return deserialize.call(this, data);
    };
    await runUntil(read, shown._revertToSnapshot(again));
    Block.deserialize = deserialize;
    assert.equal(throwNext, false, 'the first one threw');
    assert.equal(shown.blocks[0].content, 'alpha', 'the revert is on screen');
    closePage(read);
    assert.deepEqual(drafts(read), []);
  });
});

describe("a note opened with no blocks, which the editor shows with one empty block (R160's S2)", () => {
  it('the close with nothing typed writes no draft and leaves the note as it was, and typed into, its block goes into the note', async () => {
    const env = await setup({ notes: [note('E', { name: 'Untitled' })] });
    const editor = makeEditor(env);
    await editor.loadNote('E');
    assert.equal(editor.blocks.length, 1, 'the editor shows one empty block');
    const before = (await storedRows(env)).notes.E;
    closePage(env);
    assert.deepEqual(drafts(env), [], 'no edit, so no draft');
    await nextStart(env);
    assert.equal((await storedRows(env)).notes.E.updatedAt, before.updatedAt, 'the note is as it was');

    const typed = await setup({ notes: [note('E', { name: 'Untitled' })] });
    const other = makeEditor(typed);
    await other.loadNote('E');
    watchSaves(typed, { hold: closingSave });
    type(other, 'the first words of E');
    closePage(typed);
    const [draft] = drafts(typed);
    assert.deepEqual(draft.blocks.map((b) => b.content), ['the first words of E']);
    const result = await nextStart(typed);
    assert.deepEqual(result.saved, ['E']);
    const rows = Object.values((await storedRows(typed)).blocks).filter((row) => row.canvasId === 'E');
    assert.deepEqual(rows.map((row) => row.content), ['the first words of E']);
  });

  it("typed into after another tab saved the note, the closing save lost: the edit goes into the note beside the other tab's, with no recovered note", async () => {
    const env = await setup({ notes: [note('E', { name: 'Untitled' })] });
    const closing = makeEditor(env);
    await closing.loadNote('E');
    const other = await secondTab(env);
    const otherEditor = makeEditor(other);
    await otherEditor.loadNote('E');
    // The other tab types into the empty block it shows, so the note's revision moves past the closing tab's base
    type(otherEditor, 'from the other tab');
    assert.equal(await runUntil(other, otherEditor.flushSave()), true);
    watchSaves(env, { hold: closingSave });
    type(closing, 'from the closing tab');
    closePage(env);
    const result = await nextStart(env);
    assert.deepEqual(result.saved, ['E']);
    assert.deepEqual(await recoveredNames(env), [], 'the empty block the closing tab showed was never stored, so no other writer changed it');
    const rows = Object.values((await storedRows(env)).blocks).filter((row) => row.canvasId === 'E');
    assert.deepEqual(rows.map((row) => row.content).sort(), ['from the closing tab', 'from the other tab']);
  });
});

describe("two tabs, and a block stored in a shape the editor doesn't write (R160's N1)", () => {
  /**
   * Note D, open in two tabs, whose d1 is stored as a capture is: its text and its source, with
   * none of the fields every block has that the editor's serialize() fills in (indentLevel,
   * checked, imageUrl, calloutIcon). A field the record holds beyond those, its source here, the
   * editor writes back as loaded since #14 slice 3, so only a filled-in field tells its copy apart.
   */
  async function twoTabsOnD() {
    const capture = { id: 'd1', canvasId: 'D', order: 0, type: 'text', content: 'delta', source: 'https://example.test/', createdAt: 1700000000000, updatedAt: 1700000000000 };
    const env = await setup({
      notes: [note('D', { name: 'Delta' })],
      blocks: [capture, block('d2', 'D', 1, 'delta two')],
    });
    const closing = makeEditor(env);
    await closing.loadNote('D');
    const other = await secondTab(env);
    const otherEditor = makeEditor(other);
    await otherEditor.loadNote('D');
    return { env, closing, other, otherEditor };
  }

  it("another tab's save puts it back unchanged, as the editor writes it: the closing tab's edit to it is saved, with no recovered note", async () => {
    const { env, closing, other, otherEditor } = await twoTabsOnD();
    // The other tab edits d2, and its whole save puts d1 back as the editor writes it
    type(otherEditor, 'delta two, from the other tab', 1);
    assert.equal(await runUntil(other, otherEditor.flushSave()), true);
    const resaved = (await storedRows(env)).blocks.d1;
    assert.equal(resaved.indentLevel, 0, 'd1 is stored as the editor writes it now, with the fields it fills in');
    assert.equal(resaved.source, 'https://example.test/', 'and with its source as loaded');
    watchSaves(env, { hold: closingSave });
    type(closing, 'delta, from the closing tab', 0);
    closePage(env);
    const result = await nextStart(env);
    assert.deepEqual(result.saved, ['D']);
    assert.deepEqual(await recoveredNames(env), [], "nobody changed d1's text but the closing tab");
    const rows = (await storedRows(env)).blocks;
    assert.equal(rows.d1.content, 'delta, from the closing tab');
    assert.equal(rows.d2.content, 'delta two, from the other tab');
  });

  it("another tab's save changes its text: the closing tab's edit to it is a recovered note, and the note keeps the other tab's", async () => {
    const { env, closing, other, otherEditor } = await twoTabsOnD();
    type(otherEditor, 'delta, from the other tab', 0);
    assert.equal(await runUntil(other, otherEditor.flushSave()), true);
    watchSaves(env, { hold: closingSave });
    type(closing, 'delta, from the closing tab', 0);
    closePage(env);
    const result = await nextStart(env);
    assert.deepEqual(result.recovered.map((entry) => entry.noteId), ['D']);
    assert.equal((await storedRows(env)).blocks.d1.content, 'delta, from the other tab');
  });
});

describe("the saves a page keeps for a pane that no longer shows the note (R160's S1)", () => {
  it('split view showed B on the right, then closed keeping B on the left: none of the 40 saves the left pane makes of B is kept for the right one', async () => {
    const env = await setup();
    const main = makeEditor(env);
    await main.loadNote('A');
    const secondary = makeEditor(env);
    await secondary.loadNote('B');
    // Split view closes with the right pane's note kept: the right pane shows no note, the left one B
    assert.equal(await runUntil(env, secondary.unload()), true);
    assert.equal(secondary._seen.size, 0, 'the right pane holds no base');
    await main.loadNote('B');
    const ROUNDS = 40;
    for (let round = 1; round <= ROUNDS; round += 1) {
      type(main, `bravo, round ${round}`, 0);
      assert.equal(await runUntil(env, main.flushSave()), true);
    }
    const held = env.get('pageSaves').get('B') || [];
    assert.equal(held.length, 0, `the page kept ${held.length} of ${ROUNDS} saves of B`);
  });
});

describe("the saves a page keeps while one pane saves a note another holds idle (R160's S1)", () => {
  it("the pop-out saves 40 times while the main pane holds the same note: the page keeps the newest save alone, and the main pane's later edit still wins at the next start", async () => {
    const env = await setup();
    const main = makeEditor(env);
    await main.loadNote('A');
    const { pip, pipWindow } = await openPiP(env, 'A');
    const ROUNDS = 40;
    for (let round = 1; round <= ROUNDS; round += 1) {
      type(pip, `alpha two, pop-out round ${round}`, 1);
      assert.equal(await runWithPiP(env, pipWindow, pip.flushSave()), true);
    }
    const held = env.get('pageSaves').get('A') || [];
    // Read into this realm's array: the page's list is made in its own
    assert.deepEqual(Array.from(held, (save) => save.blocks.size), [2], `the newest of the ${ROUNDS}, with its 2 blocks`);
    watchSaves(env, { hold: closingSave });
    type(main, 'alpha, from the main pane at the end', 0);
    closePage(env);
    const [draft] = drafts(env);
    assert.deepEqual(draft.blocks.map((b) => b.id), ['a1']);
    assert.equal(draft.base.issuedSaves.length, 1, "the pop-out's newest save");
    const result = await nextStart(env);
    assert.deepEqual(result.saved, ['A']);
    assert.deepEqual(await recoveredNames(env), []);
    const rows = (await storedRows(env)).blocks;
    assert.equal(rows.a1.content, 'alpha, from the main pane at the end');
    assert.equal(rows.a2.content, `alpha two, pop-out round ${ROUNDS}`);
  });

  it("two of the pop-out's saves of a block commit in the other order from the one it issued them in: the page keeps the one stored, so the main pane's later edit still wins", async () => {
    const env = await setup();
    const main = makeEditor(env);
    await main.loadNote('A');
    const { pip, pipWindow } = await openPiP(env, 'A');
    // The first save is held before its transaction opens, as an async step on its way could
    // hold it, so the second one commits first
    const client = env.documentClient;
    const real = client.saveContent;
    let release = null;
    client.saveContent = (save, options) => {
      if (release !== null) return real(save, options);
      return new Promise((resolve) => {
        release = () => resolve(real(save, options));
      });
    };
    type(pip, 'alpha two, issued first', 1);
    const first = pip.save();
    for (let i = 0; i < 100 && release === null; i++) {
      env.frames();
      pipWindow.frames();
      await settle(2);
    }
    assert.equal(typeof release, 'function', 'the first save was issued');
    type(pip, 'alpha two, issued second', 1);
    assert.equal(await runWithPiP(env, pipWindow, pip.save().then(() => true)), true);
    release();
    await runWithPiP(env, pipWindow, first);
    client.saveContent = real;
    assert.equal((await storedRows(env)).blocks.a2.content, 'alpha two, issued first', 'the save issued first committed last');
    watchSaves(env, { hold: closingSave });
    type(main, 'alpha two, from the main pane at the end', 1);
    closePage(env);
    const result = await nextStart(env);
    assert.deepEqual(result.saved, ['A']);
    assert.deepEqual(await recoveredNames(env), [], "both commits are the page's own");
    assert.equal((await storedRows(env)).blocks.a2.content, 'alpha two, from the main pane at the end');
  });
});

describe('the writer and saveOpenEditors (#129)', () => {
  it('a reload forced past a failed save, the edit unstored, brings the edit back at the next start', async () => {
    const env = await setup();
    const editor = makeEditor(env);
    await editor.loadNote('A');
    // Every save of A fails, its retry too, as a full disk's does
    const restore = failSavesOf(env, 'A');
    type(editor, 'unsaved when the user reloads anyway');
    // A part's Reload asks every open editor first, as saveOpenEditors does, and stops on false
    assert.equal(await runUntil(env, editor.flushSave({ quiet: true })), false);
    // "Reload anyway": the page's own close, the edit still unstored
    closePage(env);
    assert.equal(drafts(env).length, 1);
    restore();
    const result = await nextStart(env);
    assert.deepEqual(result.saved, ['A']);
    assert.equal((await storedRows(env)).blocks.a1.content, 'unsaved when the user reloads anyway');
  });
});

describe("1.4.3 reads a draft the stack's writer wrote, on a profile at version 8 (the lead's Q1, QA1)", () => {
  it('saves one on its own base, a note nothing wrote since the load', async () => {
    const env = await setup();
    const editor = makeEditor(env);
    await editor.loadNote('A');
    const release = release143(env);
    watchSaves(env, { hold: closingSave });
    type(editor, 'alpha, edited in the stack');
    closePage(env);
    assert.equal(plain(release.CloseDrafts.list(release.storage)).length, 1, '1.4.3 lists it, as a draft it can apply');
    const result = await release.apply({ now: Date.now() });
    assert.deepEqual(result.saved, ['A']);
    assert.equal((await storedRows(env)).blocks.a1.content, 'alpha, edited in the stack');
  });

  it("recovers one after the page's own committed save, since its base's stamp is the load's: a recovered note, never a loss", async () => {
    const env = await setup();
    const editor = makeEditor(env);
    await editor.loadNote('A');
    const release = release143(env);
    type(editor, 'saved by the stack');
    assert.equal(await runUntil(env, editor.flushSave()), true);
    watchSaves(env, { hold: closingSave });
    type(editor, 'then typed as the tab closed');
    closePage(env);
    const [draft] = drafts(env);
    assert.equal(draft.base.updatedAt, note('A').updatedAt, "the load's stamp, which the page's own saves never move");
    assert.deepEqual(draft.base.issued, []);
    const result = await release.apply({ now: Date.now() });
    assert.deepEqual(result.recovered.map((entry) => entry.noteId), ['A']);
    const rows = await storedRows(env);
    assert.equal(rows.blocks.a1.content, 'saved by the stack', 'the note as the stack saved it');
    const copies = Object.values(rows.blocks).filter((row) => row.canvasId === `${draft.id}-recovered`);
    assert.ok(copies.some((row) => row.content === 'then typed as the tab closed'), 'the edit is in the recovered note');
  });
});
