'use strict';

// #28 slice 3: the read paths 1.4.x code takes, on production js/storage.js, over the generated
// maximal and corrupt profiles (test/fixtures/storage/generate.mjs) at version 8. The new tab's
// root opens each, Storage beside #17's adapter as it has since #17 PR 4a, without deleting or
// changing a record; the note lists, archive, trash, templates,
// folders, blocks, backlinks, settings, auto backups, and exportAll return what the generator's
// roles say; and the Daily Note lookup finds an existing one among duplicates and makes none.
// Where production is wrong today, the step is an expected failure in test/known-defects.json.
// The Daily Note lookup and the wiki-link save run on the frozen v1.4.1 Storage, over the same
// profile: js/storage.js's copies had no caller once the new tab wrote through #17's adapter,
// and went with #17 PR 4a.

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
 * Production Storage on profile `of`, opened as the new tab's root opens it, beside #17's
 * adapter (#17 PR 4a)
 */
async function storageOn(of) {
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
  return { Storage, settle };
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
 * Production Storage on a profile holding `fixture`, opened as the new tab's root opens it, and
 * the profile's CanvasTabDB records before it opened
 */
async function opened(fixture) {
  const { support } = await load();
  const of = await support.profileWith(fixture);
  const before = await support.dump(of);
  const { Storage, settle } = await storageOn(of);
  return { of, before, Storage, settle, dump: () => support.dump(of) };
}

/**
 * Production Storage on a profile holding `fixture` once the worker's run and its transforms
 * are in (#17 PR 3a), at this build's version
 */
async function transformed(fixture) {
  const { support } = await load();
  const of = await support.profileWith(fixture);
  assert.equal((await support.run(of)).status, 'migrated');
  assert.equal((await support.transform(of, { clock: { now: () => TRANSFORMED_AT } })).status, 'transformed');
  return storageOn(of);
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
  it("the new tab's root opens it and changes nothing; the lists, folders, blocks, links, settings, and backups are what it holds", async () => {
    const { generate, inputs } = await load();
    const { fixture, roles, records } = generate.maximalFixture(inputs);
    const { of, Storage, settle, before, dump } = await opened(fixture);
    assert.deepStrictEqual(canvasDb(await dump()), canvasDb(before));

    const listed = [roles.plain, roles.foldered, roles.daily, roles.pinned, roles.popup, roles.blocks].sort();
    assert.deepStrictEqual(ids(await value(settle, () => Storage.getAllNotes(), 'getAllNotes')), listed);
    assert.deepStrictEqual(ids(await value(settle, () => Storage.getAllNotes(true), 'getAllNotes(true)')), [...listed, roles.archived].sort());
    assert.deepStrictEqual(ids(await value(settle, () => Storage.getArchivedNotes(), 'getArchivedNotes')), [roles.archived]);
    assert.deepStrictEqual(ids(await value(settle, () => Storage.getTrashedNotes(), 'getTrashedNotes')), [roles.trashed]);
    assert.deepStrictEqual(ids(await value(settle, () => Storage.getTemplates(), 'getTemplates')), [roles.template]);
    assert.deepStrictEqual(ids(await value(settle, () => Storage.getAllFolders(), 'getAllFolders')), [roles.childFolder, roles.rootFolder].sort());
    assert.deepStrictEqual(
      ids(await value(settle, () => Storage.getElementsByNote(roles.blocks), 'getElementsByNote')),
      ids(records.elements.filter((block) => block.canvasId === roles.blocks)),
    );
    assert.deepStrictEqual(ids(await value(settle, () => Storage.getBacklinks(roles.pinned), 'getBacklinks')), [roles.plain]);
    assert.deepStrictEqual(ids(await value(settle, () => Storage.getCustomThemes(), 'getCustomThemes')), ['theme-1']);
    assert.deepStrictEqual(ids(await value(settle, () => Storage.getSnapshots(roles.pinned), 'getSnapshots')), ['snapshot-1']);
    const settings = await value(settle, () => Storage.getAllSettings(), 'getAllSettings');
    assert.deepStrictEqual(
      Object.keys(settings).sort(),
      Object.keys(fixture.chromeStorageLocal).filter((key) => key.startsWith('setting_')).map((key) => key.slice(8)).sort(),
    );
    assert.equal(settings.llmApiKey, 'canary-llm-api-key');
    const backups = await value(settle, () => Storage.getAutoBackups(), 'getAutoBackups');
    assert.deepStrictEqual(backups.map((backup) => backup.key), Object.keys(fixture.chromeStorageLocal).filter((key) => key.startsWith('auto_backup_')));
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
      const { Storage, settle, before, dump } = await opened(fixture);
      assert.deepStrictEqual(canvasDb(await dump()), canvasDb(before));
      await value(settle, () => Storage.getAllNotes(true), 'getAllNotes');
      await value(settle, () => Storage.getElementsByNote('note-a'), 'getElementsByNote');
      await value(settle, () => Storage.getAllFolders(), 'getAllFolders');
      await value(settle, () => Storage.getTrashedNotes(), 'getTrashedNotes');
      await value(settle, () => Storage.exportAll(), 'exportAll');
      assert.deepStrictEqual(canvasDb(await dump()), canvasDb(before), 'a read wrote');
    });
  }

  it('truncated: a block with only its note is among the note\'s blocks, and a note with no updatedAt is still stored', async () => {
    const { generate, inputs } = await load();
    const { fixture, roles } = generate.corruptFixtures(inputs).get('truncated');
    const { Storage, settle } = await opened(fixture);
    assert.deepStrictEqual(ids(await value(settle, () => Storage.getElementsByNote('note-a'), 'getElementsByNote')), ['block-a1', roles.truncatedBlock]);
    assert.equal((await value(settle, () => Storage.getNote(roles.truncatedNote), 'getNote')).id, roles.truncatedNote);
  });

  // getAllNotes reads the updatedAt index, which skips a note without updatedAt (KD-011). Since
  // #17 PR 3a the worker's transform fills it (from createdAt, else the newest block's time, else
  // the run's start), so Storage lists the note once the run is in, and the kernel lists it by
  // its createdAt, else last, until then (domain/note.js's notesInView).
  it('a note with no updatedAt is listed with the other notes once the worker\'s run and its transform are in, at the time the transform gave it (#17 PR 3a, KD-011)', async () => {
    const { generate, inputs } = await load();
    const { fixture, roles } = generate.corruptFixtures(inputs).get('truncated');
    const { Storage, settle } = await transformed(fixture);
    const notes = await value(settle, () => Storage.getAllNotes(true), 'getAllNotes');
    assert.deepStrictEqual(ids(notes), ['note-a', 'note-b', roles.truncatedNote].sort());
    // An id and nothing else: no createdAt and no block, so the run's start, the newest time
    // here, and the index lists it first
    assert.deepStrictEqual([notes[0].id, notes[0].updatedAt], [roles.truncatedNote, TRANSFORMED_AT]);
  });

  it('exportAll includes the note with no updatedAt once the worker\'s run and its transform are in (#17 PR 3a)', async () => {
    const { generate, inputs } = await load();
    const { fixture, roles } = generate.corruptFixtures(inputs).get('truncated');
    const { Storage, settle } = await transformed(fixture);
    const exported = await value(settle, () => Storage.exportAll(), 'exportAll');
    assert.deepStrictEqual(ids(exported.canvases), ['note-a', 'note-b', roles.truncatedNote].sort());
  });

  // _readExport builds the backup from getAllNotes(true), so the note, its blocks, and its media
  // go missing from the user's own backup on a profile no run has reached. #17's point export
  // keeps them, and the transform fills the field once the run is in (the case above).
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
    const { Storage, settle } = await opened(fixture);
    assert.deepStrictEqual(ids(await value(settle, () => Storage.getAllNotes(), 'getAllNotes')), ['note-a', 'note-b']);
    assert.deepStrictEqual(ids(await value(settle, () => Storage.getArchivedNotes(), 'getArchivedNotes')), [roles.mistypedNote]);
  });

  expectFailure('KD-010 a note whose name isn\'t text leaves the other notes\' names for wiki-link autocomplete', async () => {
    const { generate, inputs } = await load();
    const { fixture } = generate.corruptFixtures(inputs).get('mistyped');
    const { Storage, settle } = await opened(fixture);
    const names = await value(settle, () => Storage.getNoteNames(), 'getNoteNames');
    assert.deepStrictEqual([...names].sort(), ['Alpha', 'Beta']);
  });

  expectFailure('KD-010 a note whose name isn\'t text doesn\'t stop another note\'s wiki links from saving', async () => {
    const { generate, inputs } = await load();
    const { fixture } = generate.corruptFixtures(inputs).get('mistyped');
    const { of, dump } = await opened(fixture);
    const old = await release141On(of);
    await value(old.settle, () => old.Storage.updateNoteLinks('note-a', ['Beta']), 'updateNoteLinks');
    const links = (await dump()).databases[0].stores.find((s) => s.name === 'links').records.map((r) => r.value);
    assert.deepStrictEqual(links.map((link) => [link.fromNoteId, link.toNoteId]), [['note-a', 'note-b']]);
  });

  it('dangling: the note filed in a folder that\'s gone still lists, and the orphan block, media, and folder are kept', async () => {
    const { generate, inputs } = await load();
    const { fixture, roles } = generate.corruptFixtures(inputs).get('dangling');
    const { Storage, settle } = await opened(fixture);
    assert.ok(ids(await value(settle, () => Storage.getAllNotes(), 'getAllNotes')).includes(roles.filedNowhere));
    assert.deepStrictEqual(ids(await value(settle, () => Storage.getAllFolders(), 'getAllFolders')), [roles.orphanFolder]);
    assert.deepStrictEqual(ids(await value(settle, () => Storage.getElementsByNote('note-gone'), 'getElementsByNote')), [roles.orphanBlock]);
    assert.deepStrictEqual(ids(await value(settle, () => Storage.getBacklinks('note-gone'), 'getBacklinks')), ['note-a']);
  });

  it('oversized: the block over a batch of bytes and the 64 KiB title read back whole', async () => {
    const { generate, inputs } = await load();
    const { fixture, roles } = generate.corruptFixtures(inputs).get('oversized');
    const { Storage, settle } = await opened(fixture);
    const [block] = await value(settle, () => Storage.getElementsByNote(roles.oversizedNote), 'getElementsByNote');
    assert.equal(block.content.length, generate.BATCH_BYTES + 512 * 1024);
    assert.equal((await value(settle, () => Storage.getNote(roles.oversizedNote), 'getNote')).name.length, 64 * 1024);
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
