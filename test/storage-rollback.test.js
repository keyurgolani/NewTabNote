'use strict';

// #17 PR 1b, rolling back once version 9 ships (plan risk 1), and version 10 since #17 PR 2a:
// the shipped service worker (js/background.js, through test/helpers/load-background.js)
// migrates each storage fixture to 10, and then the frozen v1.4.0 and v1.4.1 Storage
// (test/fixtures/storage/releases/, the tags' own files) opens that profile. Neither deletes or changes anything: CanvasTabDB and
// NewTabNoteRecovery stay byte for byte, and no chrome.storage.local key goes, auto_backup_*
// and recovery_backup_* included. v1.4.1's #33 guard refuses with NEWER_SCHEMA, and v1.4.0
// fails with VersionError, since all ten legacy stores are there for its missing-store check.
//
// Going back to 1.4.1 for real means a file it imports: the pre-update copy Settings exports
// (Q8), and this build's own Export JSON, both through the frozen v1.4.1 importData into a
// fresh 1.4.1 profile.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { webcrypto } = require('node:crypto');
const { createLegacyEnv, createDatabase, dumpDatabase, recordsOf, runUntil, plain } = require('./helpers/legacy-env');
const { startWorker } = require('./helpers/load-background');
const { loadPageModule } = require('./helpers/page-module');

const RELEASES = 'test/fixtures/storage/releases';
const CASES = ['v8.basic', 'v8.missing-themes', 'v7.basic', 'v2-idb-settings.basic'];
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
  const dump = () => load.dumpFixture({ factory: worker.indexedDB, storage: worker.chrome.api.storage.local });
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

/** The v1.4.1 Storage on a fresh 1.4.1 profile, as a user who reinstalled 1.4.1 has it */
async function release141() {
  const env = createLegacyEnv({ worker: false });
  await createDatabase(env.indexedDB, {});
  env.load(`${RELEASES}/v1.4.1/js/utils.js`, `${RELEASES}/v1.4.1/js/storage.js`);
  const Storage = env.get('Storage');
  await Storage.init();
  return { env, Storage };
}

describe('a profile the shipped worker migrated to 10, opened by a 1.4.x build', () => {
  for (const id of CASES) {
    for (const tag of ['v1.4.0', 'v1.4.1']) {
      it(`${id}, then ${tag}: refused, and nothing changed or deleted`, async () => {
        const { worker, dump } = await migrated(id);
        const before = await dump();
        assert.ok(before.databases.some((db) => db.name === 'NewTabNoteRecovery'), 'the worker made its recovery point');
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

  it("this build's Export JSON, taken after the upgrade, imports through the frozen v1.4.1 importData too", async () => {
    const { worker } = await migrated('v8.basic');
    // The new tab's own Storage, on the version-10 database
    const page = createLegacyEnv({ indexedDB: worker.indexedDB, chrome: worker.chrome });
    page.load('js/utils.js', 'js/core/storage-error.js', 'js/storage.js');
    const Current = page.get('Storage');
    await Current.init();
    assert.equal(Current.db.version, 10);
    const blob = await Current.exportAllAsBlob();
    const file = JSON.parse(await blob.text());
    assert.ok(file.canvases.length > 0);
    const { env, Storage } = await release141();
    const check = Storage.validateImport(file);
    assert.equal(check.ok, true, check.reason);
    const result = plain(await Storage.importData(file, 'merge'));
    assert.equal(result.notes, file.canvases.length);
    assert.equal(result.blocks, file.elements.length);
    const imported = Object.values(recordsOf(await dumpDatabase(env.indexedDB), 'canvases')).map((n) => n.name).sort();
    assert.deepStrictEqual(imported, file.canvases.map((n) => n.name).sort());
  });
});
