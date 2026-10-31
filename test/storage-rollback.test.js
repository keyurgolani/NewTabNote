'use strict';

// #17 PR 1b, rolling back once version 9 ships (plan risk 1), version 10 since #17 PR 2a, and 11
// since #17 PR 3b: the shipped service worker (js/background.js, through
// test/helpers/load-background.js) migrates each storage fixture to 11 and, since #17 PR 3a, runs
// its transforms, so the notes carry placement, kind, and lifecycle beside their flags, and a
// Daily Note its local key, some moved off the UTC date 1.4.x gave them, with the daily index
// naming each date's, and then the frozen v1.4.0 and v1.4.1 Storage
// (test/fixtures/storage/releases/, the tags' own files) opens that profile. Neither deletes or changes anything: CanvasTabDB and
// NewTabNoteRecovery stay byte for byte, and no chrome.storage.local key goes, auto_backup_*
// and recovery_backup_* included. v1.4.1's #33 guard refuses with NEWER_SCHEMA, and v1.4.0
// fails with VersionError, since all ten legacy stores are there for its missing-store check.
//
// Going back to 1.4.1 for real means a file it imports: the pre-update copy Settings exports
// (Q8), and this build's own Export JSON, both through the frozen v1.4.1 importData into a
// fresh 1.4.1 profile.
//
// Since #17 PR 4a the new tab writes through #17's adapter too (the plan's section 7): a profile
// it wrote, with the version fields, ledger rows, and change rows that adds, is refused and left
// as it was by both releases, and its Export JSON, which #17's adapter makes, imports through
// the frozen v1.4.1.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { webcrypto } = require('node:crypto');
const {
  createLegacyEnv, createDatabase, dumpDatabase, recordsOf, runUntil, plain, waitFor, block,
} = require('./helpers/legacy-env');
const { startWorker } = require('./helpers/load-background');
const { loadPageModule } = require('./helpers/page-module');

const RELEASES = 'test/fixtures/storage/releases';
const CASES = ['v8.basic', 'v8.missing-themes', 'v7.basic', 'v2-idb-settings.basic', 'v8.evening-daily-notes'];
// The fields 1.4.x doesn't know (js/kernel/core/domain/placement.js's NEW_NOTE_FIELDS)
const NEW_NOTE_FIELDS = ['placement', 'kind', 'lifecycle', 'dailyKey', 'dailyTimeZone', 'dailyDuplicateOf'];
// Keys a profile may hold that a rollback mustn't lose
const KEPT_KEYS = {
  auto_backup_1760000000000: { canvases: [], elements: [], timestamp: 1760000000000 },
  recovery_backup_1760000000001: { recoveryBackup: true, reason: 'missing-stores', timestamp: 1760000000001 },
};

/** The fixture helpers, which are ES modules */
async function fixtures() {
  const support = await import('./kernel/migration-support.mjs');
  const load = await import('./fixtures/storage/load-fixture.mjs');
  return { support, load };
}

/**
 * A profile holding fixture `id`, with KEPT_KEYS, migrated by the shipped worker
 * @param {string} id
 */
async function migrated(id) {
  const { support, load } = await fixtures();
  const worker = createLegacyEnv({ context: 'worker' });
  await load.loadFixture(support.synthesized().get(id), { factory: worker.indexedDB, storage: worker.chrome.api.storage.local });
  await new Promise((resolve) => worker.chrome.api.storage.local.set(structuredClone(KEPT_KEYS), resolve));
  await startWorker(worker);
  const upgrade = await worker.global.storageUpgrade;
  assert.equal(upgrade.status, 'migrated', id);
  // The worker journals the upgrade in NewTabNoteTrust after it (#20): let that write land
  // before the profile is dumped, so the dump holds every database the worker made
  for (let round = 0; round < 10_000 && process.getActiveResourcesInfo().includes('Immediate'); round++) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.equal(worker.chrome.local.setting_storageUpgrade.status, 'migrated');
  // The transforms after the run, then the purge after them (#17 PR 3a), so nothing writes later
  assert.equal((await worker.global.storageTransforms).status, 'transformed', id);
  await worker.global.storagePurge;
  const dump = () => load.dumpFixture({ factory: worker.indexedDB, storage: worker.chrome.api.storage.local });
  const notes = Object.values(recordsOf(await dumpDatabase(worker.indexedDB), 'canvases'));
  for (const note of notes) assert.ok(note.placement && note.kind && note.lifecycle, `${id}: ${note.id} has its group`);
  for (const note of notes) if (note.isDaily && note.dateStr) assert.equal(note.dailyKey, note.dateStr, `${id}: ${note.id} has its key`);
  return { worker, dump };
}

/**
 * `tag`'s own Storage.init() on `worker`'s profile, sharing its IndexedDB and chrome.storage.local.
 * Resolves what init threw, or null, and the Storage.
 */
async function rollBack(worker, tag) {
  const env = createLegacyEnv({ indexedDB: worker.indexedDB, chrome: worker.chrome, worker: false });
  env.load(`${RELEASES}/${tag}/js/utils.js`, `${RELEASES}/${tag}/js/storage.js`);
  const Storage = env.get('Storage');
  const ended = Storage.init().then(() => null, (error) => error);
  return { error: await runUntil(env, ended), Storage };
}

/**
 * Captures a page through the worker's context menu, as a user does, which #17's adapter commits
 * with its ledger row, its change, and the Daily Note's versions (#17 PR 2a)
 */
async function capture(worker) {
  const count = worker.chrome.notifications.length;
  const tab = { id: 7, windowId: 1, url: 'https://example.test/page', title: 'Example page' };
  worker.chrome.api.contextMenus.onClicked.listeners[0]({ menuItemId: 'capture-page' }, tab);
  await waitFor(() => worker.chrome.notifications.length === count + 1, { withinMs: 10000, message: 'the capture notification' });
  assert.equal(worker.chrome.notifications[count].title, 'Captured to New Tab Note');
}

/**
 * The new tab on `worker`'s profile, as its root opens it since #17 PR 4a: #17's adapter, with
 * the holders' Storage beside it, once it's ready
 */
async function newTab(worker) {
  const page = createLegacyEnv({ indexedDB: worker.indexedDB, chrome: worker.chrome });
  page.load('js/utils.js', 'js/core/storage-error.js', 'js/storage.js');
  const root = await loadPageModule(page, 'js/kernel/composition/newtab.js');
  const host = root.newTabHost();
  const adapter = root.createNewTabAdapter(host);
  const client = root.createNewTabClient(adapter, host);
  const failure = await runUntil(page, client.whenReady());
  assert.equal(failure, null, JSON.stringify(plain(failure)));
  /** Closes both of the tab's connections, as closing the tab does */
  const close = () => {
    adapter.close();
    const { db } = page.get('Storage');
    if (db) db.close();
  };
  return { page, adapter, client, close };
}

/** Export JSON's file, as the new tab makes it on #17's adapter */
async function exportJson(client) {
  const state = await client.query({ type: 'exportBackup', backup: false });
  assert.equal(state.kind, 'ready', JSON.stringify(plain(state)));
  return JSON.parse(await state.data.text());
}

/**
 * What a user does in the new tab after the update, each through #17's adapter, which commits it
 * with its ledger row, its changes, and its notes' versions: a note typed into and pinned, filed
 * in a new folder, and a second note made and moved to trash
 */
async function writeInNewTab(client) {
  const run = async (command) => {
    const outcome = plain(await client.execute(command));
    assert.equal(outcome.kind, 'committed', `${command.type}: ${JSON.stringify(outcome)}`);
  };
  await run({ type: 'createNote', commandId: 'tab-1', noteId: 'tab-note', name: 'Written in the new tab' });
  await run({
    type: 'saveNoteContent',
    commandId: 'tab-2',
    noteId: 'tab-note',
    blocks: [block('tab-b1', 'tab-note', 0, 'typed after the update')],
  });
  await run({ type: 'setPinned', commandId: 'tab-3', noteId: 'tab-note', pinned: true });
  await run({ type: 'createFolder', commandId: 'tab-4', folderId: 'tab-folder', name: 'After the update', parentId: null });
  await run({ type: 'moveNoteToFolder', commandId: 'tab-5', noteId: 'tab-note', folderId: 'tab-folder' });
  await run({ type: 'createNote', commandId: 'tab-6', noteId: 'tab-gone', name: 'Trashed in the new tab' });
  await run({ type: 'trashNote', commandId: 'tab-7', noteId: 'tab-gone' });
}

/** The v1.4.1 Storage on a fresh 1.4.1 profile, as a user who reinstalled 1.4.1 has it */
async function release141() {
  const env = createLegacyEnv({ worker: false });
  await createDatabase(env.indexedDB, {});
  env.load(`${RELEASES}/v1.4.1/js/utils.js`, `${RELEASES}/v1.4.1/js/storage.js`);
  const Storage = env.get('Storage');
  await Storage.init();
  return { env, Storage };
}

describe('a profile the shipped worker migrated to 11, opened by a 1.4.x build', () => {
  for (const id of CASES) {
    for (const tag of ['v1.4.0', 'v1.4.1']) {
      it(`${id}, then ${tag}: refused, and nothing changed or deleted`, async () => {
        const { worker, dump } = await migrated(id);
        const before = await dump();
        assert.ok(before.databases.some((db) => db.name === 'NewTabNoteRecovery'), 'the worker made its recovery point');
        if (id === 'v8.evening-daily-notes') {
          // Moved Daily Notes, a duplicate, and the index, all of which 1.4.x leaves as they are
          const canvas = before.databases.find((db) => db.name === 'CanvasTabDB');
          const records = (name) => canvas.stores.find((store) => store.name === name).records.map((record) => record.value);
          const notes = Object.fromEntries(records('canvases').map((note) => [note.id, note]));
          assert.deepStrictEqual(
            [notes['daily-oct-7-evening'].dateStr, notes['daily-oct-10-b'].dailyDuplicateOf],
            ['2025-10-07', 'daily-oct-10-a'],
          );
          assert.equal(records('daily_index').length, 5);
        }
        const { error, Storage } = await rollBack(worker, tag);
        if (tag === 'v1.4.0') {
          assert.equal(error && error.name, 'VersionError', String(error));
        } else {
          assert.equal(error && error.code, 'NEWER_SCHEMA', String(error));
          assert.equal(Storage.openState, 'newer-version');
        }
        const after = await dump();
        assert.deepStrictEqual(after.databases, before.databases);
        for (const [key, value] of Object.entries(before.chromeStorageLocal)) {
          assert.deepStrictEqual(after.chromeStorageLocal[key], value, key);
        }
        for (const key of Object.keys(KEPT_KEYS)) assert.ok(Object.hasOwn(after.chromeStorageLocal, key), key);
      });
    }
  }
});

describe('a profile the shipped worker migrated to 11 and captured into, opened by a 1.4.x build (#17 PR 2a)', () => {
  for (const tag of ['v1.4.0', 'v1.4.1']) {
    it(`v8.basic with a capture at 11, then ${tag}: refused, and nothing changed or deleted`, async () => {
      const { worker, dump } = await migrated('v8.basic');
      await capture(worker);
      const before = await dump();
      const canvas = before.databases.find((db) => db.name === 'CanvasTabDB');
      for (const store of ['operations', 'changes', 'daily_index']) {
        assert.ok(canvas.stores.find((found) => found.name === store).records.length > 0, `the capture left ${store} rows`);
      }
      const { error } = await rollBack(worker, tag);
      if (tag === 'v1.4.0') assert.equal(error && error.name, 'VersionError', String(error));
      else assert.equal(error && error.code, 'NEWER_SCHEMA', String(error));
      const after = await dump();
      assert.deepStrictEqual(after.databases, before.databases);
      assert.deepStrictEqual(after.chromeStorageLocal, before.chromeStorageLocal);
    });
  }
});

describe("a profile the new tab wrote through #17's adapter after the update, opened by a 1.4.x build (#17 PR 4a, section 7)", () => {
  for (const tag of ['v1.4.0', 'v1.4.1']) {
    it(`v8.basic, written in the new tab at 11, then ${tag}: refused, and nothing changed or deleted`, async () => {
      const { worker, dump } = await migrated('v8.basic');
      const tab = await newTab(worker);
      await writeInNewTab(tab.client);
      tab.close();
      const before = await dump();
      const canvas = before.databases.find((db) => db.name === 'CanvasTabDB');
      const rows = (name) => canvas.stores.find((found) => found.name === name).records;
      for (const store of ['operations', 'changes']) assert.ok(rows(store).length > 0, `the new tab left ${store} rows`);
      const written = rows('canvases').find((record) => record.key === 'tab-note').value;
      assert.deepStrictEqual([written.pinned, written.folderId, typeof written.revision], [true, 'tab-folder', 'number']);
      const { error } = await rollBack(worker, tag);
      if (tag === 'v1.4.0') assert.equal(error && error.name, 'VersionError', String(error));
      else assert.equal(error && error.code, 'NEWER_SCHEMA', String(error));
      const after = await dump();
      assert.deepStrictEqual(after.databases, before.databases);
      assert.deepStrictEqual(after.chromeStorageLocal, before.chromeStorageLocal);
    });
  }

  it("its Export JSON, which #17's adapter makes, holds what the new tab wrote, and imports through the frozen v1.4.1 importData", async () => {
    const { worker } = await migrated('v8.basic');
    const tab = await newTab(worker);
    await writeInNewTab(tab.client);
    const file = await exportJson(tab.client);
    tab.close();
    const written = file.canvases.find((note) => note.id === 'tab-note');
    assert.deepStrictEqual([written.pinned, written.folderId], [true, 'tab-folder']);
    assert.ok(!file.canvases.some((note) => note.id === 'tab-gone'), 'the trashed note stays out');
    assert.ok(file.folders.some((folder) => folder.id === 'tab-folder'));
    for (const note of file.canvases) {
      for (const field of NEW_NOTE_FIELDS) assert.equal(field in note, false, `${note.id}: ${field}`);
    }
    const { env, Storage } = await release141();
    const check = Storage.validateImport(file);
    assert.equal(check.ok, true, check.reason);
    const result = plain(await Storage.importData(file, 'merge'));
    assert.equal(result.notes, file.canvases.length);
    assert.equal(result.blocks, file.elements.length);
    const imported = Object.values(recordsOf(await dumpDatabase(env.indexedDB), 'canvases'));
    assert.deepStrictEqual(imported.map((n) => n.name).sort(), file.canvases.map((n) => n.name).sort());
    const copy = imported.find((n) => n.name === 'Written in the new tab');
    assert.equal(recordsOf(await dumpDatabase(env.indexedDB), 'folders')[copy.folderId].name, 'After the update');
    const blocks = Object.values(recordsOf(await dumpDatabase(env.indexedDB), 'elements')).filter((el) => el.canvasId === copy.id);
    assert.deepStrictEqual(blocks.map((el) => el.content), ['typed after the update']);
  });
});

describe('going back to 1.4.1 with a file it imports', () => {
  it("the pre-update copy Settings exports imports through the frozen v1.4.1 importData", async () => {
    const { worker } = await migrated('v8.basic');
    const page = createLegacyEnv({ indexedDB: worker.indexedDB, chrome: worker.chrome, worker: false });
    const { createPreUpdateCopy } = await loadPageModule(page, 'js/kernel/composition/newtab.js');
    const { IDBKeyRange } = require('fake-indexeddb');
    const copy = createPreUpdateCopy({ indexedDB: worker.indexedDB, keyRange: IDBKeyRange, crypto: webcrypto });
    const point = await copy.find();
    assert.ok(point && typeof point.createdAt === 'number');
    const file = JSON.parse(JSON.stringify(await copy.export(point.id)));
    const { env, Storage } = await release141();
    assert.equal(Storage.validateImport(file).ok, true);
    const result = await Storage.importData(file, 'merge');
    assert.equal(result.notes, file.canvases.length);
    assert.ok(result.notes > 0);
    const names = Object.values(recordsOf(await dumpDatabase(env.indexedDB), 'canvases')).map((n) => n.name).sort();
    assert.deepStrictEqual(names, file.canvases.map((n) => n.name).sort());
  });

  it('a point taken after the transform exports each note as 1.4.1 stores one, and that file imports through the frozen v1.4.1 importData (#17 PR 3a)', async () => {
    const { worker } = await migrated('v8.basic');
    const { IDBKeyRange } = require('fake-indexeddb');
    // In the page's realm, as the export reads it, so a Blob hashes alike both ways
    const page = createLegacyEnv({ indexedDB: worker.indexedDB, chrome: worker.chrome, worker: false });
    const points = await loadPageModule(page, 'js/kernel/adapters/indexeddb/recovery-points.js');
    const { openWithoutUpgrade } = await loadPageModule(page, 'js/kernel/adapters/indexeddb/shapes.js');
    // A point a later run takes, as a later build's step past 11 will, holds the notes with their group and keys
    const io = { keyRange: IDBKeyRange, crypto: webcrypto, limits: points.DEFAULT_LIMITS };
    const source = await openWithoutUpgrade(worker.indexedDB, 'CanvasTabDB');
    const recovery = await points.openRecovery(worker.indexedDB, { create: false });
    const createdAt = Date.now() + 60 * 1000;
    const { point, progress } = await points.startPoint(recovery, {
      id: `pre-migration-${createdAt}`, kind: 'pre-migration', sourceShape: 'current', sourceVersion: source.version,
      structuralVersion: 11, logicalVersion: 3, target: 12, stores: points.storesToCopy(source), createdAt,
    });
    await points.copyPoint({ source, recovery, point, progress, io });
    const stored = (await points.listPoints(recovery)).find((found) => found.id === point.id);
    assert.equal((await points.verifyPoint({ recovery, point: stored, io })).ok, true);
    await points.keepVerified({ recovery, point: stored, clock: { now: () => createdAt }, io });
    source.close();
    recovery.close();

    const { createPreUpdateCopy } = await loadPageModule(page, 'js/kernel/composition/newtab.js');
    const copy = createPreUpdateCopy({ indexedDB: worker.indexedDB, keyRange: IDBKeyRange, crypto: webcrypto });
    const file = JSON.parse(JSON.stringify(await copy.export(point.id)));
    assert.ok(file.canvases.length > 0);
    for (const note of [...file.canvases, ...file.trashedCanvases]) {
      for (const field of NEW_NOTE_FIELDS) assert.equal(field in note, false, `${note.id}: ${field}`);
    }
    const { env, Storage } = await release141();
    const check = Storage.validateImport(file);
    assert.equal(check.ok, true, check.reason);
    const result = plain(await Storage.importData(file, 'merge'));
    assert.equal(result.notes, file.canvases.length);
    const imported = Object.values(recordsOf(await dumpDatabase(env.indexedDB), 'canvases'));
    assert.deepStrictEqual(imported.map((n) => n.name).sort(), file.canvases.map((n) => n.name).sort());
    for (const note of imported) assert.equal('placement' in note, false, note.name);
  });

  it("this build's Export JSON, taken after the upgrade, holds no field 1.4.x doesn't know, and imports through the frozen v1.4.1 importData too", async () => {
    const { worker } = await migrated('v8.evening-daily-notes');
    // The new tab's Export JSON, which #17's adapter makes since #17 PR 4a, on the version-11 database
    const tab = await newTab(worker);
    assert.equal(tab.adapter.upgraded(), true);
    const file = await exportJson(tab.client);
    tab.close();
    assert.ok(file.canvases.length > 0);
    for (const note of file.canvases) {
      for (const field of NEW_NOTE_FIELDS) assert.equal(field in note, false, `${note.id}: ${field}`);
    }
    // A Daily Note logical 3 moved goes out under its new date, the one its name gives
    assert.equal(file.canvases.find((note) => note.id === 'daily-oct-7-evening').dateStr, '2025-10-07');
    const { env, Storage } = await release141();
    const check = Storage.validateImport(file);
    assert.equal(check.ok, true, check.reason);
    const result = plain(await Storage.importData(file, 'merge'));
    assert.equal(result.notes, file.canvases.length);
    assert.equal(result.blocks, file.elements.length);
    const imported = Object.values(recordsOf(await dumpDatabase(env.indexedDB), 'canvases')).map((n) => n.name).sort();
    assert.deepStrictEqual(imported, file.canvases.map((n) => n.name).sort());
  });

  it("this build's Export JSON, with a note #17's adapter gave versions, imports through the frozen v1.4.1 importData (#17 PR 2a)", async () => {
    const { worker } = await migrated('v8.basic');
    await capture(worker);
    // The new tab's Export JSON, which #17's adapter makes since #17 PR 4a
    const tab = await newTab(worker);
    const file = await exportJson(tab.client);
    tab.close();
    const daily = file.canvases.find((note) => note.isDaily);
    assert.deepStrictEqual([daily.revision, daily.placementVersion, daily.sourceRevision], [1, 0, 0]);
    const { env, Storage } = await release141();
    const check = Storage.validateImport(file);
    assert.equal(check.ok, true, check.reason);
    const result = plain(await Storage.importData(file, 'merge'));
    assert.equal(result.notes, file.canvases.length);
    const imported = Object.values(recordsOf(await dumpDatabase(env.indexedDB), 'canvases')).map((n) => n.name).sort();
    assert.deepStrictEqual(imported, file.canvases.map((n) => n.name).sort());
  });
});
