'use strict';

// 1.4.3 item 1 (#33): the close-time drafts' applier, on the notes database a root has open.
// A draft is applied as a save with its deletes, recovered as a note beside the original when
// another writer saved that note after the draft's base, dropped when its edit is already in
// or its note is gone, and kept when its transaction fails. One applier runs at a time across
// pages, and a permanent delete clears what a note left.

const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const {
  createLegacyEnv, createDatabase, dumpDatabase, recordsOf, createLocalStorage, createLockManager, note, block, plain,
} = require('./helpers/legacy-env');

const FILES = ['js/utils.js', 'js/core/storage-error.js', 'js/close-drafts.js', 'js/storage.js'];

const T0 = 1700000000000;
const EDITED_AT = Date.UTC(2026, 9, 31, 21, 41);

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
    const time = new Date(EDITED_AT).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true });
    assert.equal(recovered.name, `Recovered: Alpha plan (${time})`);
    assert.equal(recovered.titleManuallySet, true, 'set as a title, so auto-title leaves it');
    assert.equal(recovered.createdAt, original.createdAt - 1, 'beside the original by Created');
    assert.equal(recovered.updatedAt, original.updatedAt - 1, 'and by Recent');
    assert.equal(recovered.isDaily, false);
    assert.equal(recovered.isTemplate, false);
    const blocks = Object.values(after.blocks).filter((row) => row.canvasId === recoveredId).sort((x, y) => x.order - y.order);
    assert.deepEqual(blocks.map((row) => [row.type, row.order]), [['callout', 0], ['text', 1]]);
    assert.match(blocks[0].content, /^These changes to “Alpha plan” are from a tab that closed on /);
    assert.match(blocks[0].content, /That tab also deleted a block\. It's still in “Alpha plan”\./);
    assert.match(blocks[0].content, /Copy what you need into “Alpha plan”, then delete this note\.$/);
    assert.equal(blocks[1].content, 'alpha, edited as the tab closed');
    assert.notEqual(blocks[1].id, 'a1', 'a copy under a new ID, so no block moves notes');
    assert.equal(recovered.preview, blocks[0].content.slice(0, 119).trimEnd() + '…', 'the list shows what the note is');
    assert.equal(after.search[recoveredId].name, recovered.name);
    assert.deepEqual(plain(env.get('CloseDrafts').takeUntold(env.global.localStorage)), [{ id: recoveredId, of: 'A' }],
      'the next new tab tells about it, by IDs only');
    assert.deepEqual(draftKeys(env), []);
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

  it('a permanent delete clears that note\'s drafts and its untold recovered note', async () => {
    draftOfA(env);
    const CloseDrafts = env.get('CloseDrafts');
    const other = CloseDrafts.draftOf({
      noteId: 'B', base: { revision: null, updatedAt: T0, issued: [] }, blocks: [block('b1', 'B', 0, 'bravo, edited')],
      deletedBlockIds: [], preview: '', todoProgress: null, linkedNames: [],
    });
    CloseDrafts.write(env.global.localStorage, other);
    env.global.localStorage.setItem(CloseDrafts.UNTOLD_KEY, JSON.stringify([{ id: 'A', of: 'Z' }, { id: 'R', of: 'B' }]));

    await env.get('Storage').permanentlyDeleteNote('A');
    assert.deepEqual(draftKeys(env), [`ntn-close-draft:${other.id}`], "B's draft stays");
    assert.deepEqual(plain(CloseDrafts.takeUntold(env.global.localStorage)), [{ id: 'R', of: 'B' }]);
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

  it('moves no block between notes and deletes none of another note\'s', async () => {
    draftOfA(env, {
      blocks: [block('a1', 'A', 0, 'alpha, edited'), block('b1', 'A', 1, 'a block of B, as if it were A\'s')],
      deletedBlockIds: ['b1'],
    });
    await apply(env);
    const after = await stored(env);
    assert.equal(after.blocks.a1.content, 'alpha, edited');
    assert.deepEqual([after.blocks.b1.canvasId, after.blocks.b1.content], ['B', 'bravo']);
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
    assert.match(first.content, /“Alpha plan” is in the Trash, so NewTabNote kept the changes here and put this note in the Trash too\./);
    assert.match(first.content, /Restore this note to keep them\. Otherwise the Trash deletes it in 7 days\.$/);

    const untold = plain(env.get('CloseDrafts').takeUntold(env.global.localStorage));
    assert.deepEqual(untold, [{ id: recoveredId, of: 'A' }]);
    assert.equal(env.get('CloseDrafts').TEXT.toast([{ title: 'Alpha plan', trashed: true }]),
      'Kept your changes to “Alpha plan” from a closed tab in a recovered note. Both are in the Trash.');
  });

  it('with the Trash set to keep notes until it\'s emptied, says only how to keep them', async () => {
    const env = await page({ profile: { a: { trashed: true, trashedAt, updatedAt: T0 + 50 } } });
    env.chrome.local.setting_trashRetention = 0;
    draftOfA(env);
    const result = await apply(env);
    const { recoveredId } = result.recovered[0];
    const first = Object.values((await stored(env)).blocks).find((row) => row.canvasId === recoveredId && row.order === 0);
    assert.match(first.content, /Restore this note to keep them\.$/);
    assert.doesNotMatch(first.content, /deletes it in/);
  });
});
