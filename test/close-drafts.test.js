'use strict';

// 1.4.3 item 1 (#33): the close-time drafts' applier, on the notes database a root has open.
// A draft is applied as a save with its deletes, recovered as a note beside the original when
// another writer saved that note after the draft's base, dropped when its edit is already in,
// when it only deleted blocks of a note saved elsewhere, or when its note is gone, and kept when
// its transaction fails. One applier runs at a time across pages, and a permanent delete clears
// what a note left. The recovered note's words and placement are the Design gate's.

// The recovered note's dates are local time, as 1.4.x's are; UTC here pins its strings
process.env.TZ = 'UTC';

const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const {
  createLegacyEnv, createDatabase, dumpDatabase, recordsOf, createLocalStorage, createLockManager, note, block, plain, settle,
} = require('./helpers/legacy-env');
const SidebarUtils = require('../js/sidebar-utils.js');

const FILES = ['js/utils.js', 'js/core/storage-error.js', 'js/close-drafts.js', 'js/storage.js'];

const T0 = 1700000000000;
const EDITED_AT = Date.UTC(2026, 9, 31, 21, 41);
/** The recovered note's title for a draft made at EDITED_AT, its date's spaces no-break */
const RECOVERED_A = 'Recovered: Alpha plan (Oct\u00a031,\u00a09:41\u00a0PM)';
/** The first block's first sentence for that draft */
const CLOSED_A = 'These changes to “Alpha plan” are from a tab that closed on Oct 31, 2026 at 9:41 PM, before they were saved.';

/** A profile with note A (blocks a1, a2) and note B (b1), at T0 */
async function profile(env, { a = {}, records = {} } = {}) {
  await createDatabase(env.indexedDB, {
    records: {
      canvases: [note('A', { name: 'Alpha plan', ...a }), note('B', { name: 'Bravo' })],
      elements: [block('a1', 'A', 0, 'alpha'), block('a2', 'A', 1, 'alpha two'), block('b1', 'B', 0, 'bravo')],
      search_index: [{ noteId: 'A', name: 'Alpha plan', content: 'alpha alpha two', updatedAt: T0 }],
      ...records,
    },
  });
}

/** A page of the extension, with Storage open on the profile */
async function page(options = {}) {
  const env = createLegacyEnv(options);
  if (!options.indexedDB) await profile(env, options.profile);
  env.load(...FILES);
  await env.get('Storage').init();
  return env;
}

/** A draft of note A's edit, as the editor writes one */
function draftOfA(env, fields = {}) {
  const CloseDrafts = env.get('CloseDrafts');
  const draft = CloseDrafts.draftOf({
    noteId: 'A',
    base: { revision: null, updatedAt: T0, issued: [] },
    blocks: [block('a1', 'A', 0, 'alpha, edited as the tab closed', { updatedAt: T0 + 5 })],
    deletedBlockIds: [],
    preview: 'alpha, edited as the tab closed',
    todoProgress: null,
    linkedNames: [],
    at: EDITED_AT,
    ...fields,
  });
  CloseDrafts.write(env.global.localStorage, draft);
  return draft;
}

const apply = (env, options = {}) => env.get('CloseDrafts').apply({ db: env.get('Storage').db, ...options }).then(plain);

/** The stored records, by ID */
async function stored(env) {
  const dump = await dumpDatabase(env.indexedDB);
  return { notes: recordsOf(dump, 'canvases'), blocks: recordsOf(dump, 'elements'), search: recordsOf(dump, 'search_index'), links: recordsOf(dump, 'links') };
}

const draftKeys = (env) => {
  const storage = env.global.localStorage;
  return Array.from({ length: storage.length }, (_, index) => storage.key(index)).filter((key) => key.startsWith('ntn-close-draft:'));
};

/** The note IDs in the result, by what happened to each draft */
const empty = { saved: [], recovered: [], dropped: [], gone: [], kept: [] };

describe('the close-time draft applier: one test per path', () => {
  let env;
  beforeEach(async () => {
    env = await page();
  });

  it('applies a draft as a save, with its deletes, and removes it', async () => {
    draftOfA(env, {
      blocks: [block('a1', 'A', 0, 'see [[Bravo]]', { updatedAt: T0 + 5 })],
      deletedBlockIds: ['a2'],
      name: 'Alpha plan, renamed',
      titleOrigin: 'typed',
      preview: 'see [[Bravo]]',
      linkedNames: ['Bravo'],
    });
    const result = await apply(env, { now: () => T0 + 100 });
    assert.deepEqual(result, { ...empty, saved: ['A'] });

    const after = await stored(env);
    assert.equal(after.blocks.a1.content, 'see [[Bravo]]');
    assert.equal(after.blocks.a1.canvasId, 'A');
    assert.equal(after.blocks.a2, undefined, 'the block the tab deleted is deleted');
    assert.equal(after.blocks.b1.content, 'bravo', 'no other note changes');
    assert.equal(after.notes.A.name, 'Alpha plan, renamed');
    assert.equal(after.notes.A.titleManuallySet, true);
    assert.equal(after.notes.A.preview, 'see [[Bravo]]');
    assert.equal(after.notes.A.updatedAt, T0 + 100);
    assert.equal(after.search.A.name, 'Alpha plan, renamed', "the search entry's name, as the editor's save writes it");
    assert.deepEqual(Object.values(after.links).map((link) => [link.fromNoteId, link.toNoteId]), [['A', 'B']]);
    assert.deepEqual(draftKeys(env), []);
  });

  it('recovers a draft as one note beside the original when another writer saved it after the base', async () => {
    const other = await page({ indexedDB: env.indexedDB });
    const elsewhere = await other.get('Storage').getNote('A');
    await other.get('Storage').saveNoteWithBlocks(elsewhere, [block('a1', 'A', 0, 'saved in another tab')]);
    const original = (await stored(env)).notes.A;
    assert.ok(original.updatedAt > T0);

    draftOfA(env, { deletedBlockIds: ['a2'] });
    const result = await apply(env, { now: () => T0 + 100 });
    assert.equal(result.recovered.length, 1);
    assert.deepEqual({ ...result, recovered: [] }, empty);
    const { noteId, recoveredId } = result.recovered[0];
    assert.equal(noteId, 'A');

    const after = await stored(env);
    assert.deepEqual(after.notes.A, original, 'the original is as the other tab saved it');
    assert.equal(after.blocks.a1.content, 'saved in another tab');
    assert.equal(after.blocks.a2.content, 'alpha two', 'its deletes are only said, not done');
    const recovered = after.notes[recoveredId];
    assert.equal(recovered.name, RECOVERED_A);
    assert.equal(recovered.titleManuallySet, true, 'set as a title, so auto-title leaves it');
    assert.equal(recovered.createdAt, original.createdAt - 1, 'beside the original by Created');
    assert.equal(recovered.updatedAt, original.updatedAt - 1, 'and by Recent');
    assert.equal(recovered.isDaily, false);
    assert.equal(recovered.isTemplate, false);
    const blocks = Object.values(after.blocks).filter((row) => row.canvasId === recoveredId).sort((x, y) => x.order - y.order);
    assert.deepEqual(blocks.map((row) => [row.type, row.order, row.calloutIcon]), [['callout', 0, 'ℹ️'], ['text', 1, '💡']]);
    assert.equal(blocks[0].content, `${CLOSED_A} That note was saved elsewhere too, so NewTabNote kept the changes here and left it as it is.`
      + ' Below are only the blocks that tab changed. That tab also deleted a block, which is still in that note.'
      + ' Copy what you need into that note, then delete this one.');
    assert.equal(blocks[1].content, 'alpha, edited as the tab closed');
    assert.notEqual(blocks[1].id, 'a1', 'a copy under a new ID, so no block moves notes');
    assert.equal(recovered.preview, blocks[0].content.slice(0, 119).trimEnd() + '…', 'the list shows what the note is');
    assert.deepEqual(after.search[recoveredId], { noteId: recoveredId, name: recovered.name, content: '', updatedAt: recovered.updatedAt },
      "Storage.createNote's entry, with the note's own time");
    assert.deepEqual(plain(env.get('CloseDrafts').takeUntold(env.global.localStorage)), [{ id: recoveredId, of: 'A' }],
      'the next new tab tells about it, by IDs only');
    assert.deepEqual(draftKeys(env), []);
  });

  it('drops a draft that only deleted blocks of a note saved elsewhere since: no recovered note, and the blocks stay', async () => {
    const other = await page({ indexedDB: env.indexedDB });
    const elsewhere = await other.get('Storage').getNote('A');
    await other.get('Storage').saveNoteWithBlocks(elsewhere, [block('a1', 'A', 0, 'saved in another tab'), block('a2', 'A', 1, 'alpha two')]);
    const before = await stored(env);
    assert.ok(before.notes.A.updatedAt > T0);

    draftOfA(env, { blocks: [], deletedBlockIds: ['a2'] });
    const result = await apply(env, { now: () => T0 + 100 });
    assert.deepEqual(result, { ...empty, dropped: ['A'] });
    assert.deepEqual(await stored(env), before, 'nothing is written, and a2 stays');
    assert.deepEqual(draftKeys(env), []);
    assert.deepEqual(plain(env.get('CloseDrafts').takeUntold(env.global.localStorage)), [], 'nothing to tell');
  });

  it('drops a draft whose only change is an AI title, over a note saved elsewhere since', async () => {
    const Storage = env.get('Storage');
    await Storage.updateNote(await Storage.getNote('A')); // another tab's write moves its updatedAt
    const before = await stored(env);
    draftOfA(env, { blocks: [], name: 'An AI title', titleOrigin: 'generated' });
    const result = await apply(env, { now: () => T0 + 100 });
    assert.deepEqual(result, { ...empty, dropped: ['A'] });
    assert.deepEqual(await stored(env), before, 'nothing is written: the save treats an AI title as replaceable');
  });

  it("saves the title of a draft whose blocks the closing write stored and whose title it didn't", async () => {
    // #133's closing write puts the blocks alone, so the record keeps the base's stamp and name
    const edited = block('a1', 'A', 0, 'alpha, edited as the tab closed', { updatedAt: T0 + 5 });
    const tx = env.get('Storage').db.transaction(['elements'], 'readwrite');
    tx.objectStore('elements').put(edited);
    await new Promise((resolve) => { tx.oncomplete = resolve; });
    draftOfA(env, { blocks: [edited], name: 'A typed title', titleOrigin: 'typed' });
    const result = await apply(env, { now: () => T0 + 100 });
    assert.deepEqual(result, { ...empty, saved: ['A'] });
    const after = await stored(env);
    assert.deepEqual([after.notes.A.name, after.notes.A.titleManuallySet], ['A typed title', true]);
  });

  it('takes back a block stored under no note, and deletes one the draft deleted', async () => {
    // Stored as Block.serialize() writes a block, with no canvasId and no order
    const tx = env.get('Storage').db.transaction(['elements'], 'readwrite');
    for (const row of [block('a1', 'A', 0, 'alpha'), block('a2', 'A', 1, 'alpha two')]) {
      const serialized = { ...row };
      delete serialized.canvasId;
      delete serialized.order;
      tx.objectStore('elements').put(serialized);
    }
    await new Promise((resolve) => { tx.oncomplete = resolve; });
    draftOfA(env, { blocks: [block('a2', 'A', 1, 'alpha two, edited')], deletedBlockIds: ['a1'] });
    const result = await apply(env, { now: () => T0 + 100 });
    assert.deepEqual(result, { ...empty, saved: ['A'] });
    const shown = await env.get('Storage').getElementsByNote('A');
    assert.deepEqual(shown.map((row) => [row.id, row.content]), [['a2', 'alpha two, edited']]);
    assert.equal((await stored(env)).blocks.a1, undefined, 'the block it deleted is gone');
  });

  it('drops a draft whose edit is already stored, writing nothing', async () => {
    const before = await stored(env);
    // The same text, with the times the editor gave the block since
    draftOfA(env, { blocks: [block('a1', 'A', 0, 'alpha', { updatedAt: T0 + 9 })] });
    const result = await apply(env);
    assert.deepEqual(result, { ...empty, dropped: ['A'] });
    assert.deepEqual(await stored(env), before);
    assert.deepEqual(draftKeys(env), []);
  });

  it('drops a draft whose note was deleted for good, writing nothing', async () => {
    await env.get('Storage').permanentlyDeleteNote('A');
    const before = await stored(env);
    draftOfA(env);
    const result = await apply(env);
    assert.deepEqual(result, { ...empty, gone: ['A'] });
    assert.deepEqual(await stored(env), before);
    assert.deepEqual(draftKeys(env), []);
  });

  it('skips a draft that would take localStorage past its quota, without throwing', () => {
    const full = createLocalStorage({ quota: 200 });
    const CloseDrafts = env.get('CloseDrafts');
    const draft = CloseDrafts.draftOf({
      noteId: 'A', base: { revision: null, updatedAt: T0, issued: [] }, blocks: [block('a1', 'A', 0, 'x'.repeat(500))],
      deletedBlockIds: [], preview: '', todoProgress: null, linkedNames: [],
    });
    assert.equal(CloseDrafts.write(full, draft), false);
    assert.equal(full.length, 0);
  });

  it("a permanent delete clears that note's drafts, the drafts whose recovered note it is, and its untold entries", async () => {
    draftOfA(env);
    const CloseDrafts = env.get('CloseDrafts');
    const other = CloseDrafts.draftOf({
      noteId: 'B', base: { revision: null, updatedAt: T0, issued: [] }, blocks: [block('b1', 'B', 0, 'bravo, edited')],
      deletedBlockIds: [], preview: '', todoProgress: null, linkedNames: [],
    });
    CloseDrafts.write(env.global.localStorage, other);
    env.global.localStorage.setItem(CloseDrafts.UNTOLD_KEY, JSON.stringify([{ id: 'A', of: 'Z' }, { id: 'R', of: 'B' }, { id: 'R2', of: 'A' }]));

    await env.get('Storage').permanentlyDeleteNote('A');
    assert.deepEqual(draftKeys(env), [`ntn-close-draft:${other.id}`], "B's draft stays");
    assert.deepEqual(plain(CloseDrafts.takeUntold(env.global.localStorage)), [{ id: 'R', of: 'B' }],
      "A goes from the list as a recovered note and as one's original, so the toast never names a note that's gone");

    // B's draft is left over from a start that made its recovered note: deleting that note takes it
    await env.get('Storage').permanentlyDeleteNote(CloseDrafts.recoveredIdOf(other));
    assert.deepEqual(draftKeys(env), []);
  });

  it('a permanent delete that fails puts the drafts back, so the note keeps its last edit', async () => {
    draftOfA(env);
    const Storage = env.get('Storage');
    Storage.deleteElementsByNote = () => Promise.reject(new DOMException('test: the disk is gone', 'UnknownError'));
    await assert.rejects(Storage.permanentlyDeleteNote('A'), { name: 'UnknownError' });
    assert.equal(draftKeys(env).length, 1, 'the draft is back');
    assert.deepEqual(await apply(env, { now: () => T0 + 100 }), { ...empty, saved: ['A'] });
  });

  it('keeps a draft whose transaction fails, for the next start', async () => {
    const db = env.get('Storage').db;
    const open = db.transaction.bind(db);
    db.transaction = (stores, mode) => {
      if (mode === 'readwrite') throw new DOMException('test: the disk is gone', 'UnknownError');
      return open(stores, mode);
    };
    draftOfA(env);
    const result = await apply(env);
    assert.deepEqual(result, { ...empty, kept: ['A'] });
    assert.equal(draftKeys(env).length, 1);
  });

  it('with no draft, takes no lock and opens no transaction', async () => {
    const db = env.get('Storage').db;
    let opened = 0;
    const open = db.transaction.bind(db);
    db.transaction = (...args) => {
      opened += 1;
      return open(...args);
    };
    let requested = 0;
    const result = await apply(env, { locks: { request: () => { requested += 1; return Promise.resolve(); } } });
    assert.deepEqual(result, empty);
    assert.equal(opened, 0);
    assert.equal(requested, 0);
  });
});

describe("the close-time draft applier: the draft's base", () => {
  let env;
  beforeEach(async () => {
    env = await page();
  });

  /** Note A as stored with `updatedAt` stamped by whoever wrote it last */
  async function storedAt(updatedAt, content) {
    const A = await env.get('Storage').getNote('A');
    const tx = env.get('Storage').db.transaction(['canvases', 'elements'], 'readwrite');
    tx.objectStore('canvases').put({ ...A, updatedAt });
    tx.objectStore('elements').put(block('a1', 'A', 0, content));
    await new Promise((resolve) => { tx.oncomplete = resolve; });
  }

  it("an earlier save from the same tab that commits after the close is the editor's own: the draft saves, with no recovered note", async () => {
    // The tab's save stamped T0 + 10 and was in flight at the close; its closing write was lost
    await storedAt(T0 + 10, 'alpha, saved by the save in flight');
    draftOfA(env, { base: { revision: null, updatedAt: T0, issued: [T0 + 10] } });
    const result = await apply(env, { now: () => T0 + 100 });
    assert.deepEqual(result, { ...empty, saved: ['A'] });
    assert.equal((await stored(env)).blocks.a1.content, 'alpha, edited as the tab closed');
  });

  it("another tab's save stamped just before this tab's save in flight, and committed after it, isn't overwritten", async () => {
    // This tab's save stamped T0 + 10; the other tab's took T0 + 9 and committed last
    await storedAt(T0 + 9, 'saved in another tab');
    draftOfA(env, { base: { revision: null, updatedAt: T0, issued: [T0 + 10] } });
    const result = await apply(env, { now: () => T0 + 100 });
    assert.equal(result.recovered.length, 1);
    const after = await stored(env);
    assert.equal(after.blocks.a1.content, 'saved in another tab', 'the other tab keeps its save');
    assert.equal(after.notes.A.updatedAt, T0 + 9);
  });

  it('a draft with no base never overwrites a note', async () => {
    draftOfA(env, { base: { revision: null, updatedAt: null, issued: [] } });
    const result = await apply(env);
    assert.equal(result.recovered.length, 1);
    assert.equal((await stored(env)).blocks.a1.content, 'alpha');
  });
});

describe('the close-time draft applier: what it never does', () => {
  let env;
  beforeEach(async () => {
    env = await page();
  });

  it("moves no block between notes and deletes none of another note's: a draft holding one becomes a recovered note, and drops no edit", async () => {
    draftOfA(env, {
      blocks: [block('a1', 'A', 0, 'alpha, edited'), block('b1', 'A', 1, 'a block of B, as if it were A\'s')],
      deletedBlockIds: ['b1'],
    });
    const result = await apply(env, { now: () => T0 + 100 });
    assert.deepEqual({ ...result, recovered: [] }, empty, "not saved, since one of its blocks is another note's");
    const after = await stored(env);
    assert.equal(after.blocks.a1.content, 'alpha', 'A as it was');
    assert.deepEqual([after.blocks.b1.canvasId, after.blocks.b1.content], ['B', 'bravo']);
    const copies = Object.values(after.blocks).filter((row) => row.canvasId === result.recovered[0].recoveredId).sort((x, y) => x.order - y.order);
    assert.deepEqual(copies.slice(1).map((row) => row.content), ['alpha, edited', 'a block of B, as if it were A\'s'], 'both edits, as copies');
  });

  it('a generated title never replaces one set by hand', async () => {
    const A = await env.get('Storage').getNote('A');
    await env.get('Storage').updateNote({ ...A, titleManuallySet: true, updatedAt: T0 });
    const base = (await env.get('Storage').getNote('A')).updatedAt;
    draftOfA(env, { base: { revision: null, updatedAt: base, issued: [] }, name: 'An AI title', titleOrigin: 'generated' });
    await apply(env);
    const after = await stored(env);
    assert.equal(after.notes.A.name, 'Alpha plan');
    assert.equal(after.blocks.a1.content, 'alpha, edited as the tab closed', 'the rest of the save lands');
  });

  it('removes a draft it can\'t read, which nothing could apply', async () => {
    env.global.localStorage.setItem('ntn-close-draft:broken', '{"v": 1, "noteId": ');
    env.global.localStorage.setItem('ntn-close-draft:future', JSON.stringify({ v: 2, id: 'future', noteId: 'A' }));
    const result = await apply(env);
    assert.deepEqual(result, empty);
    assert.deepEqual(draftKeys(env), []);
  });
});

describe('the close-time draft applier across pages', () => {
  it('two roots starting together take turns: each draft is applied once, with no recovered note', async () => {
    const localStorage = createLocalStorage();
    const locks = createLockManager();
    const first = await page({ localStorage, locks });
    const second = await page({ localStorage, locks, indexedDB: first.indexedDB });
    draftOfA(first);
    const [one, two] = await Promise.all([apply(first, { now: () => T0 + 100 }), apply(second, { now: () => T0 + 200 })]);
    assert.deepEqual([one, two], [{ ...empty, saved: ['A'] }, empty]);
    const after = await stored(first);
    assert.equal(after.notes.A.updatedAt, T0 + 100, 'written once');
    assert.equal(Object.keys(after.notes).length, 2, 'no recovered note');
  });

  it('two roots starting together over a draft to recover make one recovered note between them', async () => {
    const localStorage = createLocalStorage();
    const locks = createLockManager();
    const first = await page({ localStorage, locks, profile: { a: { updatedAt: T0 + 5 } } });
    const second = await page({ localStorage, locks, indexedDB: first.indexedDB });
    draftOfA(first);
    const [one, two] = await Promise.all([apply(first), apply(second)]);
    assert.deepEqual([one.recovered.length, two.recovered.length], [1, 0]);
    const names = Object.values((await stored(first)).notes).map((n) => n.name);
    assert.equal(names.filter((name) => name.startsWith('Recovered: ')).length, 1);
  });

  it('an applier stopped after its save and before its remove leaves the draft, which the next start drops without applying it again', async () => {
    const env = await page();
    draftOfA(env);
    const storage = env.global.localStorage;
    const removeItem = storage.removeItem.bind(storage);
    storage.removeItem = () => {}; // the page closes between the commit and the remove
    await apply(env, { now: () => T0 + 100 });
    storage.removeItem = removeItem;
    assert.equal(draftKeys(env).length, 1);

    const result = await apply(env, { now: () => T0 + 200 });
    assert.deepEqual(result, { ...empty, dropped: ['A'] });
    const after = await stored(env);
    assert.equal(after.notes.A.updatedAt, T0 + 100, 'not written again');
    assert.equal(Object.keys(after.notes).length, 2, 'no recovered note');
  });

  it('an applier stopped after its recovered note commits and before its remove leaves the draft, and the next start makes no second one', async () => {
    const renamedOnly = { blocks: [], deletedBlockIds: ['a2'], name: 'Alpha plan, renamed', titleOrigin: 'typed' };
    // The page goes right after the commit: before the remove, and before or after the untold list
    for (const [fields, untoldLost] of [[{}, false], [renamedOnly, true]]) {
      const env = await page({ profile: { a: { updatedAt: T0 + 5 } } });
      const CloseDrafts = env.get('CloseDrafts');
      draftOfA(env, fields);
      const storage = env.global.localStorage;
      const removeItem = storage.removeItem.bind(storage);
      const setItem = storage.setItem.bind(storage);
      storage.removeItem = () => {};
      if (untoldLost) storage.setItem = (key, value) => { if (key !== CloseDrafts.UNTOLD_KEY) setItem(key, value); };
      const first = await apply(env, { now: () => T0 + 100 });
      storage.removeItem = removeItem;
      storage.setItem = setItem;
      assert.equal(draftKeys(env).length, 1);

      const second = await apply(env, { now: () => T0 + 200 });
      assert.deepEqual(second, { ...empty, recovered: first.recovered }, 'the one it made');
      const names = Object.values((await stored(env)).notes).map((n) => n.name);
      assert.equal(names.filter((name) => name.startsWith('Recovered: ')).length, 1);
      assert.deepEqual(draftKeys(env), []);
      assert.deepEqual(plain(CloseDrafts.takeUntold(storage)), [{ id: first.recovered[0].recoveredId, of: 'A' }], 'told once');
    }
  });

  it('an applier stopped after a save that kept the hand-set title over an AI one leaves the draft, which the next start drops', async () => {
    const env = await page({ profile: { a: { titleManuallySet: true } } });
    draftOfA(env, { name: 'An AI title', titleOrigin: 'generated' });
    const storage = env.global.localStorage;
    const removeItem = storage.removeItem.bind(storage);
    storage.removeItem = () => {};
    assert.deepEqual(await apply(env, { now: () => T0 + 100 }), { ...empty, saved: ['A'] });
    storage.removeItem = removeItem;
    assert.deepEqual(await apply(env, { now: () => T0 + 200 }), { ...empty, dropped: ['A'] }, "the save never writes that title, so it's in");
    const after = await stored(env);
    assert.equal(after.notes.A.name, 'Alpha plan');
    assert.equal(Object.keys(after.notes).length, 2, 'no recovered note');
  });

  it('a permanent delete that clears a draft while a start is between its list and its apply wins: no recovered copy of the note', async () => {
    const localStorage = createLocalStorage();
    const locks = createLockManager();
    // In the Trash, so trashing it moved its updatedAt past the draft's base, as Empty Trash finds it
    const env = await page({ localStorage, locks, profile: { a: { trashed: true, trashedAt: T0 + 5, updatedAt: T0 + 5 } } });
    const other = await page({ localStorage, locks, indexedDB: env.indexedDB });
    draftOfA(env);
    let release = () => {};
    const gate = new Promise((resolve) => { release = resolve; });
    let waiting = false;
    // The start lists the draft, then waits for the Trash's keeping time
    const applying = apply(env, { now: () => T0 + 100, trashDays: () => { waiting = true; return gate.then(() => 30); } });
    await settle();
    assert.equal(waiting, true, 'the start has listed the draft');
    const Storage = other.get('Storage');
    const deleteElements = Storage.deleteElementsByNote.bind(Storage);
    // Empty Trash's delete, in another page: the start goes on once the blocks are gone, before the record
    Storage.deleteElementsByNote = async (id) => {
      await deleteElements(id);
      release();
      await settle();
    };
    const [result] = await Promise.all([applying, Storage.permanentlyDeleteNote('A')]);
    assert.deepEqual(result, empty, 'the draft was gone by its turn');
    const after = await stored(env);
    assert.equal(after.notes.A, undefined);
    assert.deepEqual(Object.values(after.notes).map((n) => n.name), ['Bravo'], 'no recovered copy of a note deleted for good');
  });
});

describe('the close-time draft applier on a note in the Trash', () => {
  const trashedAt = T0 + 50;

  it('saves into the trashed note, which stays in the Trash', async () => {
    const env = await page({ profile: { a: { trashed: true, trashedAt } } });
    const base = (await env.get('Storage').getNote('A')).updatedAt;
    draftOfA(env, { base: { revision: null, updatedAt: base, issued: [] } });
    const result = await apply(env, { now: () => T0 + 100 });
    assert.deepEqual(result, { ...empty, saved: ['A'] });
    const after = await stored(env);
    assert.equal(after.blocks.a1.content, 'alpha, edited as the tab closed');
    assert.deepEqual([after.notes.A.trashed, after.notes.A.trashedAt], [true, trashedAt]);
  });

  it('after Replace all trashed the note, recovers the draft into the Trash too, on top, saying how long it keeps it', async () => {
    const env = await page();
    env.chrome.local.setting_trashRetention = 7;
    draftOfA(env);
    // Import's Replace all trashes every active note, A included, and moves its updatedAt
    const backup = { version: 1, canvases: [note('X', { name: 'From the backup' })], elements: [block('x1', 'X', 0, 'restored')] };
    await env.get('Storage').importData(backup, 'replace');
    const result = await apply(env, { now: () => T0 + 100 });
    assert.equal(result.recovered.length, 1);
    const { recoveredId } = result.recovered[0];
    const after = await stored(env);
    const recovered = after.notes[recoveredId];
    assert.deepEqual([recovered.trashed, recovered.trashedAt, recovered.archived, recovered.pinned], [true, T0 + 100, false, false],
      'in the Trash with the Trash\'s whole keeping time from this start');
    const first = Object.values(after.blocks).find((row) => row.canvasId === recoveredId && row.order === 0);
    assert.equal(first.content, `${CLOSED_A} That note is in the Trash, so NewTabNote kept the changes here and put this note in the Trash too.`
      + ' Below are only the blocks that tab changed. Restore this note to keep them. Otherwise the Trash deletes it in 7 days.');

    const untold = plain(env.get('CloseDrafts').takeUntold(env.global.localStorage));
    assert.deepEqual(untold, [{ id: recoveredId, of: 'A' }]);
  });

  it('with the Trash set to keep notes until it\'s emptied, says only how to keep them', async () => {
    const env = await page({ profile: { a: { trashed: true, trashedAt, updatedAt: T0 + 50 } } });
    env.chrome.local.setting_trashRetention = 0;
    draftOfA(env);
    const result = await apply(env);
    const { recoveredId } = result.recovered[0];
    const first = Object.values((await stored(env)).blocks).find((row) => row.canvasId === recoveredId && row.order === 0);
    assert.equal(first.content, `${CLOSED_A} That note is in the Trash, so NewTabNote kept the changes here and put this note in the Trash too.`
      + ' Below are only the blocks that tab changed. Restore this note to keep them.');
  });

  it('says a day as "1 day"', async () => {
    const env = await page({ profile: { a: { trashed: true, trashedAt, updatedAt: T0 + 50 } } });
    draftOfA(env);
    const result = await apply(env, { trashDays: () => Promise.resolve(1) });
    const { recoveredId } = result.recovered[0];
    const first = Object.values((await stored(env)).blocks).find((row) => row.canvasId === recoveredId && row.order === 0);
    assert.match(first.content, / Restore this note to keep them\. Otherwise the Trash deletes it in 1 day\.$/);
  });
});

describe('the recovered note, as the Design gate approved it', () => {
  const NOW = T0 + 100;

  /**
   * Note A with `a`'s fields, saved in another tab after the draft's base, and the note the
   * draft (`fields`) is recovered as, with `trashDays` the Trash's keeping time
   */
  async function recover({ a = {}, records = {}, trashDays = 30, ...fields } = {}) {
    const env = await page({ profile: { a: { updatedAt: T0 + 5, ...a }, records } });
    draftOfA(env, fields);
    const result = await apply(env, { now: () => NOW, trashDays: () => Promise.resolve(trashDays) });
    assert.equal(result.recovered.length, 1);
    const { recoveredId } = result.recovered[0];
    const after = await stored(env);
    const blocks = Object.values(after.blocks).filter((row) => row.canvasId === recoveredId).sort((x, y) => x.order - y.order);
    return { env, recovered: after.notes[recoveredId], blocks, after };
  }

  const SAVED_ELSEWHERE = 'That note was saved elsewhere too, so NewTabNote kept the changes here and left it as it is.';
  const ONLY_CHANGED = 'Below are only the blocks that tab changed.';
  const COPY = 'Copy what you need into that note, then delete this one.';

  it("its title is the original's and the edit's time, whose date wraps as one unit", async () => {
    assert.equal((await recover()).recovered.name, 'Recovered: Alpha plan (Oct\u00a031,\u00a09:41\u00a0PM)');
    const untitled = await recover({ a: { name: '' } });
    assert.equal(untitled.recovered.name, 'Recovered: Untitled (Oct\u00a031,\u00a09:41\u00a0PM)', 'named as the list names it');
    assert.equal(untitled.blocks[0].content.split('. ')[0], 'These changes to “Untitled” are from a tab that closed on Oct 31, 2026 at 9:41 PM, before they were saved');
  });

  it("sits in the original's folder while that folder exists, and in none once it's gone", async () => {
    const folder = { id: 'F', name: 'Work', parentId: null, createdAt: T0, updatedAt: T0 };
    assert.equal((await recover({ a: { folderId: 'F' }, records: { folders: [folder] } })).recovered.folderId, 'F');
    assert.equal((await recover({ a: { folderId: 'F-deleted' } })).recovered.folderId, null);
  });

  it("has the original's pin, except a template's or a trashed note's", async () => {
    assert.equal((await recover({ a: { pinned: true } })).recovered.pinned, true);
    assert.equal((await recover({ a: { pinned: true, isTemplate: true } })).recovered.pinned, false);
    assert.equal((await recover({ a: { pinned: true, trashed: true, trashedAt: T0 + 3 } })).recovered.pinned, false);
  });

  it("is archived with an archived original, its times and its archive time 1 ms before the original's", async () => {
    const { recovered } = await recover({ a: { createdAt: T0 - 50, archived: true, archivedAt: T0 + 3 } });
    assert.deepEqual([recovered.createdAt, recovered.updatedAt, recovered.archived, recovered.archivedAt], [T0 - 51, T0 + 4, true, T0 + 2]);
    assert.equal(recovered.trashed, undefined);
  });

  it('goes in the Trash with a trashed original, from this start, and out of Archive', async () => {
    const { recovered } = await recover({ a: { trashed: true, trashedAt: T0 + 3, archived: true, archivedAt: T0 + 2 } });
    assert.deepEqual([recovered.trashed, recovered.trashedAt, recovered.archived, recovered.archivedAt], [true, NOW, false, null]);
  });

  it("a Daily Note's or a template's changes become a regular note, whose first block says which it was", async () => {
    const daily = await recover({ a: { isDaily: true, dateStr: '2026-10-31' } });
    assert.deepEqual([daily.recovered.isDaily, daily.recovered.dateStr, daily.recovered.isTemplate], [false, null, false]);
    assert.equal(daily.blocks[0].content, `${CLOSED_A} That Daily Note was saved elsewhere too, so NewTabNote kept the changes here as a regular note`
      + ` and left it as it is. ${ONLY_CHANGED} Copy what you need into that Daily Note, then delete this one.`);
    const template = await recover({ a: { isTemplate: true } });
    assert.deepEqual([template.recovered.isDaily, template.recovered.isTemplate], [false, false]);
    assert.equal(template.blocks[0].content, `${CLOSED_A} That template was saved elsewhere too, so NewTabNote kept the changes here as a regular note`
      + ` and left it as it is. ${ONLY_CHANGED} Copy what you need into that template, then delete this one.`);
  });

  it("keeps the original's viewport and grid, and makes its copies at this start", async () => {
    const viewport = { scale: 1.5, offsetX: 10, offsetY: -20 };
    const settings = { gridType: 'lines', backgroundColor: '#101010' };
    const { recovered, blocks } = await recover({ a: { viewport, settings } });
    assert.deepEqual([recovered.viewport, recovered.settings], [viewport, settings]);
    assert.deepEqual(blocks.map((row) => [row.createdAt, row.updatedAt]), [[NOW, NOW], [NOW, NOW]]);
  });

  it('names the original once, and says what else that tab did: its deletes still there, and a new title', async () => {
    const elements = [block('a1', 'A', 0, 'alpha'), block('a2', 'A', 1, 'alpha two'), block('a3', 'A', 2, 'alpha three')];
    const { blocks } = await recover({
      records: { elements }, deletedBlockIds: ['a2', 'a3', 'gone-since'], name: 'Alpha plan, renamed', titleOrigin: 'typed',
    });
    assert.equal(blocks[0].content, `${CLOSED_A} ${SAVED_ELSEWHERE} ${ONLY_CHANGED} That tab also deleted 2 blocks, which are still in that note.`
      + ` That tab also renamed it “Alpha plan, renamed”. ${COPY}`);
    const cleared = await recover({ name: '', titleOrigin: 'typed' });
    assert.equal(cleared.blocks[0].content, `${CLOSED_A} ${SAVED_ELSEWHERE} ${ONLY_CHANGED} ${COPY}`, 'a cleared title is no new title');
  });

  it("escapes the first block's text, quotes too, and the list shows it as a save would", async () => {
    const { recovered, blocks } = await recover({
      a: { name: 'Q&A <b>"plan"</b>' },
      blocks: [block('t1', 'A', 4, 'Book the room', { type: 'todo', checked: true }), block('t2', 'A', 5, 'Send the notes', { type: 'todo' })],
    });
    assert.equal(blocks[0].content.split('. ')[0],
      'These changes to “Q&amp;A &lt;b&gt;&quot;plan&quot;&lt;/b&gt;” are from a tab that closed on Oct 31, 2026 at 9:41 PM, before they were saved');
    assert.deepEqual(blocks.map((row) => [row.type, row.content]), [
      ['callout', blocks[0].content], ['todo', 'Book the room'], ['todo', 'Send the notes'],
    ]);
    const meta = SidebarUtils.buildNoteSaveMetadata(blocks);
    assert.deepEqual([recovered.preview, recovered.todoProgress], [meta.preview, meta.todoProgress]);
    assert.deepEqual(recovered.todoProgress, { completed: 1, total: 2 });
  });

  it("a draft that renamed the note and changed no block keeps the typed name in a recovered note, under the original's title, in words of its own", async () => {
    const renamedOnly = { blocks: [], name: 'Alpha plan, renamed', titleOrigin: 'typed' };
    const RENAMED = 'A tab that closed on Oct 31, 2026 at 9:41 PM renamed “Alpha plan” to “Alpha plan, renamed” before the new name was saved.';
    const withDeletes = await recover({ ...renamedOnly, deletedBlockIds: ['a2'] });
    assert.equal(withDeletes.recovered.name, RECOVERED_A);
    assert.deepEqual(withDeletes.blocks.map((row) => row.type), ['callout']);
    assert.equal(withDeletes.blocks[0].content, `${RENAMED} That note was saved elsewhere too, so NewTabNote kept the new name here and left it as it is.`
      + ' That tab also deleted a block, which is still in that note. To use the new name, rename that note, then delete this one.');
    const alone = await recover(renamedOnly);
    assert.equal(alone.recovered.name, RECOVERED_A);
    assert.equal(alone.blocks[0].content, `${RENAMED} That note was saved elsewhere too, so NewTabNote kept the new name here and left it as it is.`
      + ' To use the new name, rename that note, then delete this one.');
    const template = await recover({ ...renamedOnly, a: { isTemplate: true } });
    assert.equal(template.blocks[0].content, `${RENAMED} That template was saved elsewhere too, so NewTabNote kept the new name here and left it as it is.`
      + ' To use the new name, rename that template, then delete this one.');
    const trashed = await recover({ ...renamedOnly, a: { trashed: true, trashedAt: T0 + 3 }, trashDays: 7 });
    assert.equal(trashed.blocks[0].content, `${RENAMED} That note is in the Trash, so NewTabNote kept the new name here and put this note in the Trash too.`
      + ' Restore this note to keep the new name. Otherwise the Trash deletes it in 7 days.');
    const kept = await recover({ ...renamedOnly, a: { trashed: true, trashedAt: T0 + 3 }, trashDays: 0 });
    assert.equal(kept.blocks[0].content, `${RENAMED} That note is in the Trash, so NewTabNote kept the new name here and put this note in the Trash too.`
      + ' Restore this note to keep the new name.', 'with the Trash keeping notes until emptied');
  });

  it('the toast says where both notes are, with the title cut at 40', () => {
    const env = createLegacyEnv();
    env.load('js/close-drafts.js');
    const { TEXT } = env.get('CloseDrafts');
    const told = (title, where = {}) => ({ title, archived: false, trashed: false, ...where });
    const one = 'Kept your changes to “Alpha plan” from a closed tab in a recovered note.';
    assert.equal(TEXT.toast([told('Alpha plan')]), one);
    assert.equal(TEXT.toast([told('Alpha plan', { archived: true })]), `${one} Both are in Archive.`);
    assert.equal(TEXT.toast([told('Alpha plan', { trashed: true })]), `${one} Both are in the Trash.`);
    assert.equal(TEXT.toast([told('Alpha plan'), told('Bravo', { archived: true })]), 'Kept your changes from closed tabs in 2 recovered notes.');
    assert.equal(TEXT.toast([told('Notes from the long planning meeting about the beta launch')]),
      'Kept your changes to “Notes from the long planning meeting ab…” from a closed tab in a recovered note.');
  });
});
