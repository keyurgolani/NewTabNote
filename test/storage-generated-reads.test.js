'use strict';

// #28 slice 3: the reads the new tab makes, over the generated maximal and corrupt profiles
// (test/fixtures/storage/generate.mjs) at version 8. The new tab's root opens each without
// deleting or changing a record. The reads App makes on the tab's kernel since #17 PR 4a, the
// note lists, archive, trash, templates, folders, blocks, backlinks, themes, snapshots, and the
// wiki-link names, and the Storage global's exportAll, sync's upload, return what the
// generator's roles say, and the settings and the automatic backups stay where they were. The
// Daily Note lookup runs on the frozen v1.4.1 Storage, over the same profile, and finds an
// existing one among duplicates and makes none. js/storage.js's own reads went with #17 PR 4b,
// which made it the shell over the tab's kernel. Where production is wrong today, the step is an
// expected failure in test/known-defects.json.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { expectFailure } = require('./helpers/expect-failure.js');

const FILES = ['js/utils.js', 'js/core/storage-error.js', 'js/storage.js'];

let modules = null;
async function load() {
  if (!modules) {
    const [generate, inputs, support] = await Promise.all([
      import('./fixtures/storage/generate.mjs'),
      import('./kernel/generated-inputs.mjs'),
      import('./kernel/migration-support.mjs'),
    ]);
    const productionInputs = await inputs.productionInputs();
    modules = { generate, support, inputs: productionInputs };
  }
  return modules;
}

/** When the worker's transform runs in the cases after its run (#17 PR 3a), past every fixture time */
const TRANSFORMED_AT = Date.UTC(2026, 9, 31);

/**
 * The new tab on profile `of`, started as its root starts it, with the Storage global's shell
 * connected to its kernel (#17 PR 4b). `read` answers a query's data, or [] when it found
 * nothing, as App reads it.
 */
async function newTabOn(of) {
  const { support } = await load();
  const env = support.legacyEnv.createLegacyEnv({ indexedDB: of.real, chrome: of.chrome });
  env.load(...FILES);
  const Storage = env.get('Storage');
  /** Settles what `call` returns into {value} or {error}, so nothing rejects across the vm context */
  const settle = (call) => support.legacyEnv.runUntil(env, Promise.resolve().then(call).then(
    (value) => ({ value: value === undefined ? undefined : JSON.parse(JSON.stringify(value)) }),
    (error) => ({ error: { name: error && error.name, message: error && error.message } }),
  ));
  const started = await settle(() => support.legacyEnv.startNewTabKernel(env).then(() => undefined));
  assert.equal(started.error, undefined, `the new tab didn't start: ${JSON.stringify(started.error)}`);
  /** @param {object} query */
  const read = async (query) => {
    const state = await value(settle, () => env.kernel.query(query), query.type);
    if (state.kind === 'empty') return [];
    assert.equal(state.kind, 'ready', `${query.type}: ${JSON.stringify(state)}`);
    return state.data;
  };
  return { env, Storage, settle, read };
}

/**
 * The frozen v1.4.1 Storage (test/fixtures/storage/releases/) on profile `of`, opened with
 * init(), for the 1.4.x writers js/storage.js no longer has
 */
async function release141On(of) {
  const { support } = await load();
  const env = support.legacyEnv.createLegacyEnv({ indexedDB: of.real, chrome: of.chrome, worker: false });
  env.load('test/fixtures/storage/releases/v1.4.1/js/utils.js', 'test/fixtures/storage/releases/v1.4.1/js/storage.js');
  const Storage = env.get('Storage');
  const settle = (call) => support.legacyEnv.runUntil(env, Promise.resolve().then(call).then(
    (value) => ({ value: value === undefined ? undefined : JSON.parse(JSON.stringify(value)) }),
    (error) => ({ error: { name: error && error.name, message: error && error.message } }),
  ));
  const init = await settle(() => Storage.init());
  assert.equal(init.error, undefined, `v1.4.1 init() rejected: ${JSON.stringify(init.error)}`);
  return { Storage, settle };
}

/**
 * The new tab on a profile holding `fixture`, started as its root starts it, and the profile's
 * CanvasTabDB records and chrome.storage.local before it started
 */
async function opened(fixture) {
  const { support } = await load();
  const of = await support.profileWith(fixture);
  const before = await support.dump(of);
  const localBefore = JSON.parse(JSON.stringify(of.chrome.local));
  const tab = await newTabOn(of);
  return { of, before, localBefore, ...tab, dump: () => support.dump(of) };
}

/**
 * The new tab on a profile holding `fixture` once the worker's run and its transforms are in
 * (#17 PR 3a), at this build's version
 */
async function transformed(fixture) {
  const { support } = await load();
  const of = await support.profileWith(fixture);
  assert.equal((await support.run(of)).status, 'migrated');
  assert.equal((await support.transform(of, { clock: { now: () => TRANSFORMED_AT } })).status, 'transformed');
  return newTabOn(of);
}

/** The value `call` resolves with, failing the test when it rejects */
async function value(settle, call, label) {
  const settled = await settle(call);
  assert.equal(settled.error, undefined, `${label} rejected: ${JSON.stringify(settled.error)}`);
  return settled.value;
}

const ids = (rows) => rows.map((row) => row.id).sort();
const canvasDb = (dumped) => dumped.databases.filter((db) => db.name === 'CanvasTabDB');

describe('1.4.x reads on the maximal profile', () => {
  it("the new tab's root opens it and changes nothing; the lists, folders, blocks, links, themes, and snapshots are what it holds, and the settings and backups stay", async () => {
    const { generate, inputs } = await load();
    const { fixture, roles, records } = generate.maximalFixture(inputs);
    const { of, Storage, settle, read, before, localBefore, dump } = await opened(fixture);
    assert.deepStrictEqual(canvasDb(await dump()), canvasDb(before));

    const listed = [roles.plain, roles.foldered, roles.daily, roles.pinned, roles.popup, roles.blocks].sort();
    assert.deepStrictEqual(ids(await read({ type: 'listNotes', view: 'active' })), listed);
    assert.deepStrictEqual(ids(await read({ type: 'listNotes', view: 'withArchived' })), [...listed, roles.archived].sort());
    assert.deepStrictEqual(ids(await read({ type: 'listNotes', view: 'archived' })), [roles.archived]);
    assert.deepStrictEqual(ids(await read({ type: 'listNotes', view: 'trashed' })), [roles.trashed]);
    assert.deepStrictEqual(ids(await read({ type: 'listNotes', view: 'templates' })), [roles.template]);
    assert.deepStrictEqual(ids(await read({ type: 'listFolders' })), [roles.childFolder, roles.rootFolder].sort());
    assert.deepStrictEqual(
      ids(await read({ type: 'getNoteBlocks', noteId: roles.blocks })),
      ids(records.elements.filter((block) => block.canvasId === roles.blocks)),
    );
    assert.deepStrictEqual(ids(await read({ type: 'getBacklinks', noteId: roles.pinned })), [roles.plain]);
    assert.deepStrictEqual(ids(await read({ type: 'listThemes' })), ['theme-1']);
    assert.deepStrictEqual(ids(await read({ type: 'listSnapshots', noteId: roles.pinned })), ['snapshot-1']);
    // Every setting and automatic backup it held is still there, and the AI key reads where
    // llm.js reads it, through the Storage global's shell
    const localNow = JSON.parse(JSON.stringify(of.chrome.local));
    for (const prefix of ['setting_', 'auto_backup_']) {
      const held = Object.entries(localBefore).filter(([key]) => key.startsWith(prefix));
      assert.ok(held.length > 0, prefix);
      for (const [key, was] of held) assert.deepStrictEqual(localNow[key], was, key);
    }
    assert.equal(await value(settle, () => Storage.getSetting('llmApiKey'), 'getSetting'), 'canary-llm-api-key');
    const exported = await value(settle, () => Storage.exportAll(), 'exportAll');
    assert.deepStrictEqual(ids(exported.canvases), records.canvases.filter((note) => !note.trashed).map((note) => note.id).sort());
    // The Daily Note for its date is the one there, and none is made
    const old = await release141On(of);
    const daily = await value(old.settle, () => old.Storage.ensureDailyNoteForDate(generate.DAILY_DATE), 'ensureDailyNoteForDate');
    assert.equal(daily.id, roles.daily);
    assert.equal((await dump()).databases[0].stores.find((s) => s.name === 'canvases').records.length, records.canvases.length);
  });
});

describe('1.4.x reads on the corrupt profiles', () => {
  for (const id of ['truncated', 'mistyped', 'dangling', 'oversized', 'daily-duplicates']) {
    it(`${id}: the new tab's root opens it, deletes and changes nothing, and the note list, blocks, folders, and exportAll still answer`, async () => {
      const { generate, inputs } = await load();
      const { fixture } = generate.corruptFixtures(inputs).get(id);
      const { Storage, settle, read, before, dump } = await opened(fixture);
      assert.deepStrictEqual(canvasDb(await dump()), canvasDb(before));
      await read({ type: 'listNotes', view: 'withArchived' });
      await read({ type: 'getNoteBlocks', noteId: 'note-a' });
      await read({ type: 'listFolders' });
      await read({ type: 'listNotes', view: 'trashed' });
      await value(settle, () => Storage.exportAll(), 'exportAll');
      assert.deepStrictEqual(canvasDb(await dump()), canvasDb(before), 'a read wrote');
    });
  }

  it('truncated: a block with only its note is among the note\'s blocks, and a note with no updatedAt is still stored', async () => {
    const { generate, inputs } = await load();
    const { fixture, roles } = generate.corruptFixtures(inputs).get('truncated');
    const { read } = await opened(fixture);
    assert.deepStrictEqual(ids(await read({ type: 'getNoteBlocks', noteId: 'note-a' })), ['block-a1', roles.truncatedBlock]);
    assert.equal((await read({ type: 'getNote', noteId: roles.truncatedNote })).note.id, roles.truncatedNote);
  });

  // The kernel lists a note without updatedAt by its createdAt, else last (domain/note.js's
  // notesInView), where Storage's getAllNotes read the updatedAt index, which skips it (KD-011).
  // Since #17 PR 3a the worker's transform fills the field (from createdAt, else the newest
  // block's time, else the run's start), and the kernel lists the note by it once the run is in.
  it('a note with no updatedAt is listed with the other notes once the worker\'s run and its transform are in, at the time the transform gave it (#17 PR 3a, KD-011)', async () => {
    const { generate, inputs } = await load();
    const { fixture, roles } = generate.corruptFixtures(inputs).get('truncated');
    const { read } = await transformed(fixture);
    const notes = await read({ type: 'listNotes', view: 'withArchived' });
    assert.deepStrictEqual(ids(notes), ['note-a', 'note-b', roles.truncatedNote].sort());
    // An id and nothing else: no createdAt and no block, so the run's start, the newest time
    // here, and the list has it first
    assert.deepStrictEqual([notes[0].id, notes[0].updatedAt], [roles.truncatedNote, TRANSFORMED_AT]);
  });

  it('exportAll includes the note with no updatedAt once the worker\'s run and its transform are in (#17 PR 3a)', async () => {
    const { generate, inputs } = await load();
    const { fixture, roles } = generate.corruptFixtures(inputs).get('truncated');
    const { Storage, settle } = await transformed(fixture);
    const exported = await value(settle, () => Storage.exportAll(), 'exportAll');
    assert.deepStrictEqual(ids(exported.canvases), ['note-a', 'note-b', roles.truncatedNote].sort());
  });

  // Sync's upload, the Storage global's exportAll, leaves the note out on a profile no run has
  // reached, with its blocks and media. #17's point export keeps them, and the transform fills
  // the field once the run is in (the case above).
  expectFailure('KD-005 exportAll includes notes without updatedAt', async () => {
    const { generate, inputs } = await load();
    const { fixture, roles } = generate.corruptFixtures(inputs).get('truncated');
    const { Storage, settle } = await opened(fixture);
    const exported = await value(settle, () => Storage.exportAll(), 'exportAll');
    assert.deepStrictEqual(ids(exported.canvases), ['note-a', 'note-b', roles.truncatedNote].sort());
  });

  it('mistyped, as 1.4.x reads it (a characterization, not a rule): archived "no" reads as archived, so the note lists only with archived ones', async () => {
    const { generate, inputs } = await load();
    const { fixture, roles } = generate.corruptFixtures(inputs).get('mistyped');
    const { read } = await opened(fixture);
    assert.deepStrictEqual(ids(await read({ type: 'listNotes', view: 'active' })), ['note-a', 'note-b']);
    assert.deepStrictEqual(ids(await read({ type: 'listNotes', view: 'archived' })), [roles.mistypedNote]);
  });

  // Storage.getNoteNames and 1.4.1's updateNoteLinks threw on a name that isn't text (KD-010).
  // The editor reads the names from its document client, and saveNoteContent writes the
  // links, since #17 PR 4a, and js/storage.js's copy went with #17 PR 4b.
  it('a note whose name isn\'t text leaves the other notes\' names for wiki-link autocomplete', async () => {
    const { generate, inputs } = await load();
    const { fixture } = generate.corruptFixtures(inputs).get('mistyped');
    const { env, settle } = await opened(fixture);
    const names = await value(settle, () => env.documentClient.noteNames(), 'noteNames');
    assert.deepStrictEqual([...names].sort(), ['Alpha', 'Beta']);
  });

  it('a note whose name isn\'t text doesn\'t stop another note\'s wiki links from saving', async () => {
    const { generate, inputs } = await load();
    const { fixture } = generate.corruptFixtures(inputs).get('mistyped');
    const { env, settle, read, dump } = await opened(fixture);
    // Beta's one block, which the profile keeps as 1.4.x wrote it, with a link to Alpha typed in
    const [block] = await read({ type: 'getNoteBlocks', noteId: 'note-b' });
    const saved = await value(settle, () => env.kernel.execute({
      type: 'saveNoteContent',
      commandId: 'save-links',
      noteId: 'note-b',
      blocks: [{ id: block.id, type: 'text', content: `${block.content}, see [[Alpha]]` }],
      linkedNames: ['Alpha'],
    }), 'saveNoteContent');
    assert.equal(saved.kind, 'committed', JSON.stringify(saved));
    const links = (await dump()).databases[0].stores.find((s) => s.name === 'links').records.map((r) => r.value);
    assert.deepStrictEqual(links.map((link) => [link.fromNoteId, link.toNoteId]), [['note-b', 'note-a']]);
  });

  it('dangling: the note filed in a folder that\'s gone still lists, and the orphan block, media, and folder are kept', async () => {
    const { generate, inputs } = await load();
    const { fixture, roles } = generate.corruptFixtures(inputs).get('dangling');
    const { read } = await opened(fixture);
    assert.ok(ids(await read({ type: 'listNotes', view: 'active' })).includes(roles.filedNowhere));
    assert.deepStrictEqual(ids(await read({ type: 'listFolders' })), [roles.orphanFolder]);
    assert.deepStrictEqual(ids(await read({ type: 'getNoteBlocks', noteId: 'note-gone' })), [roles.orphanBlock]);
    assert.deepStrictEqual(ids(await read({ type: 'getBacklinks', noteId: 'note-gone' })), ['note-a']);
  });

  it('oversized: the block over a batch of bytes and the 64 KiB title read back whole', async () => {
    const { generate, inputs } = await load();
    const { fixture, roles } = generate.corruptFixtures(inputs).get('oversized');
    const { read } = await opened(fixture);
    const [block] = await read({ type: 'getNoteBlocks', noteId: roles.oversizedNote });
    assert.equal(block.content.length, generate.BATCH_BYTES + 512 * 1024);
    assert.equal((await read({ type: 'getNote', noteId: roles.oversizedNote })).note.name.length, 64 * 1024);
  });

  it('daily-duplicates: the lookup for that day finds the newest Daily Note outside trash and makes none', async () => {
    const { generate, inputs } = await load();
    const { fixture } = generate.corruptFixtures(inputs).get('daily-duplicates');
    const { of, dump } = await opened(fixture);
    const old = await release141On(of);
    const daily = await value(old.settle, () => old.Storage.ensureDailyNoteForDate(generate.DAILY_DATE), 'ensureDailyNoteForDate');
    // getAllNotes(true) lists by updatedAt, newest first, outside trash
    assert.equal(daily.id, 'note-daily-2');
    const canvases = (await dump()).databases[0].stores.find((s) => s.name === 'canvases').records;
    assert.equal(canvases.length, fixture.databases[0].stores.find((s) => s.name === 'canvases').records.length);
  });
});
