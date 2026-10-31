'use strict';

// #28 slice 3: the read paths 1.4.x code takes, on production js/storage.js, over the generated
// maximal and corrupt profiles (test/fixtures/storage/generate.mjs) at version 8. init() opens
// each without deleting or changing a record; the note lists, archive, trash, templates,
// folders, blocks, backlinks, settings, auto backups, and exportAll return what the generator's
// roles say; and the Daily Note lookup finds an existing one among duplicates and makes none.
// Where production is wrong today, the step is an expected failure in test/known-defects.json.

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

/**
 * Production Storage on a profile holding `fixture`, opened with init(), and the profile's
 * CanvasTabDB records before it opened
 */
async function opened(fixture) {
  const { support } = await load();
  const of = await support.profileWith(fixture);
  const before = await support.dump(of);
  const env = support.legacyEnv.createLegacyEnv({ indexedDB: of.real, chrome: of.chrome });
  env.load(...FILES);
  const Storage = env.get('Storage');
  /** Settles what `call` returns into {value} or {error}, so nothing rejects across the vm context */
  const settle = (call) => support.legacyEnv.runUntil(env, Promise.resolve().then(call).then(
    (value) => ({ value: value === undefined ? undefined : JSON.parse(JSON.stringify(value)) }),
    (error) => ({ error: { name: error && error.name, message: error && error.message } }),
  ));
  const init = await settle(() => Storage.init());
  assert.equal(init.error, undefined, `init() rejected: ${JSON.stringify(init.error)}`);
  return { of, before, Storage, settle, dump: () => support.dump(of) };
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
  it('init() opens it and changes nothing; the lists, folders, blocks, links, settings, and backups are what it holds', async () => {
    const { generate, inputs } = await load();
    const { fixture, roles, records } = generate.maximalFixture(inputs);
    const { Storage, settle, before, dump } = await opened(fixture);
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
    const daily = await value(settle, () => Storage.ensureDailyNoteForDate(generate.DAILY_DATE), 'ensureDailyNoteForDate');
    assert.equal(daily.id, roles.daily);
    assert.equal((await dump()).databases[0].stores.find((s) => s.name === 'canvases').records.length, records.canvases.length);
  });
});

describe('1.4.x reads on the corrupt profiles', () => {
  for (const id of ['truncated', 'mistyped', 'dangling', 'oversized', 'daily-duplicates']) {
    it(`${id}: init() opens it, deletes and changes nothing, and the note list, blocks, folders, and exportAll still answer`, async () => {
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

  it('truncated: a block with only its note is among the note\'s blocks; a note with no updatedAt is kept but listed nowhere (the updatedAt index skips it)', async () => {
    const { generate, inputs } = await load();
    const { fixture, roles } = generate.corruptFixtures(inputs).get('truncated');
    const { Storage, settle } = await opened(fixture);
    assert.deepStrictEqual(ids(await value(settle, () => Storage.getElementsByNote('note-a'), 'getElementsByNote')), ['block-a1', roles.truncatedBlock]);
    assert.deepStrictEqual(ids(await value(settle, () => Storage.getAllNotes(true), 'getAllNotes')), ['note-a', 'note-b']);
    assert.equal((await value(settle, () => Storage.getNote(roles.truncatedNote), 'getNote')).id, roles.truncatedNote);
    // exportAll reads the same index, so 1.4.x's own backup leaves it out; #17's point export keeps it
    assert.deepStrictEqual(ids((await value(settle, () => Storage.exportAll(), 'exportAll')).canvases), ['note-a', 'note-b']);
  });

  it('mistyped: archived "no" reads as archived, so the note lists only with archived ones', async () => {
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
    const { Storage, settle, dump } = await opened(fixture);
    await value(settle, () => Storage.updateNoteLinks('note-a', ['Beta']), 'updateNoteLinks');
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
    const { Storage, settle, dump } = await opened(fixture);
    const daily = await value(settle, () => Storage.ensureDailyNoteForDate(generate.DAILY_DATE), 'ensureDailyNoteForDate');
    // getAllNotes(true) lists by updatedAt, newest first, outside trash
    assert.equal(daily.id, 'note-daily-2');
    const canvases = (await dump()).databases[0].stores.find((s) => s.name === 'canvases').records;
    assert.equal(canvases.length, fixture.databases[0].stores.find((s) => s.name === 'canvases').records.length);
  });
});
