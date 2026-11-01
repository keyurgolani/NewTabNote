/**
 * The browser host for the storage fixture format (harness/fixture-host.js, #28 slice 3) in
 * Chromium: synthesized and recorded fixtures load into the built extension's service worker
 * and popup page, under names of their own so the app's databases are left alone, and dump
 * back as themselves, Blobs, typed values, a newer version and a store no release made
 * included. chrome.storage.local goes through the same host. This is the path
 * scripts/fixtures/record-release.mjs dumps each release through. Since #17 PR 1b, a 1.4.x
 * fixture loaded over the CanvasTabDB the install made has the extension updated in place, so
 * its new worker upgrades the fixture, and a run at install that didn't migrate fails the load.
 */

const fs = require('fs');
const path = require('path');
const { test, expect, expectNoUncaught } = require('./harness');
const { fixtureHost } = require('./harness/fixture-host');

const FIXTURES = path.join(__dirname, '..', 'test', 'fixtures', 'storage');
const PREFIX = 'ntn-fixture-host-';
const CASES = [
  ['synthesized/v8.data-urls.json', 'worker'],
  ['synthesized/v9.newer.json', 'popup'],
  ['synthesized/v2-local-settings.basic.json', 'worker'],
  ['recorded/v8.v1.4.0.json', 'popup'],
];

const read = file => JSON.parse(fs.readFileSync(path.join(FIXTURES, file), 'utf8'));

test('fixtures load into the extension and dump back as themselves, in its worker and its popup', async ({ extension }) => {
  const { fillCanaries } = await import('../test/fixtures/storage/load-fixture.mjs');
  const popup = await extension.openSurface('popup');
  for (const [file, where] of CASES) {
    const fixture = read(file);
    const host = fixtureHost(where === 'worker' ? extension.worker : popup);
    const names = Object.fromEntries(fixture.databases.map(db => [db.name, `${PREFIX}${db.name}`]));
    await host.loadFixture(fixture, { names, storage: false });
    const dumped = await host.dumpFixture({ storage: false, header: fixture.header });
    const ours = dumped.databases
      .filter(db => db.name.startsWith(PREFIX))
      .map(db => ({ ...db, name: db.name.slice(PREFIX.length) }));
    expect(ours, `${file} in the ${where}`).toEqual(fillCanaries(fixture).databases);
    await (where === 'worker' ? extension.worker : popup).evaluate(
      list => Promise.all(list.map(name => new Promise((resolve, reject) => {
        const request = indexedDB.deleteDatabase(name);
        request.onsuccess = () => resolve();
        request.onerror = () => reject(request.error);
      }))),
      Object.values(names),
    );
  }

  const probe = {
    format: 'ntn-storage-fixture/1',
    header: {},
    databases: [],
    chromeStorageLocal: { [`${PREFIX}probe`]: { canary: '{{CANARY:probe}}', list: [1, 'two'] } },
  };
  await fixtureHost(extension.worker).loadFixture(probe, { canaries: { probe: 'placed' } });
  const local = (await fixtureHost(popup).dumpFixture({})).chromeStorageLocal;
  expect(local[`${PREFIX}probe`]).toEqual({ canary: 'placed', list: [1, 'two'] });
  await expect(fixtureHost(popup).dumpFixture({ factory: {} })).rejects.toThrow(/the target's own/);

  await expectNoUncaught(extension, popup);
});

/**
 * CanvasTabDB in the worker now: the run its worker published, its version, and how many notes
 * it holds
 */
function heldNow(worker) {
  return worker.evaluate(async () => {
    const run = await self.storageUpgrade;
    const listed = (await indexedDB.databases()).find(db => db.name === 'CanvasTabDB');
    const db = await new Promise((resolve, reject) => {
      const request = indexedDB.open('CanvasTabDB');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    try {
      const notes = await new Promise((resolve, reject) => {
        const request = db.transaction('canvases').objectStore('canvases').count();
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      return { status: run ? run.status : null, version: listed ? listed.version : null, notes };
    } finally {
      db.close();
    }
  });
}

test("a 1.4.x fixture over the install's CanvasTabDB: the extension updates in place, and its new worker upgrades the fixture (#17 PR 1b)", async ({ extension }) => {
  const fixture = read('recorded/v8.v1.4.0.json');
  const notes = fixture.databases[0].stores.find(store => store.name === 'canvases').records.length;
  const installed = extension.worker;
  expect((await heldNow(installed)).version).toBeGreaterThan(8);
  await fixtureHost(installed).loadFixture(fixture);
  expect(extension.worker).not.toBe(installed);
  const held = await heldNow(extension.worker);
  expect(held.status).toBe('migrated');
  expect(held.version).toBeGreaterThan(8);
  expect(held.notes).toBe(notes);
  await expectNoUncaught(extension);
});

test("a run at install that didn't migrate fails the load, and the install's CanvasTabDB stays (#17 PR 1b)", async ({ extension }) => {
  const installed = await heldNow(extension.worker);
  expect(installed.status).toBe('migrated');
  // The worker publishes its run as failed (background.js defines storageUpgrade configurable)
  await extension.worker.evaluate(() => {
    Object.defineProperty(self, 'storageUpgrade', { get: () => Promise.resolve({ status: 'failed' }), configurable: true });
  });
  await expect(fixtureHost(extension.worker).loadFixture(read('recorded/v8.v1.4.0.json'))).rejects.toThrow(
    /answered "failed", not "migrated", so CanvasTabDB stays/,
  );
  expect(await heldNow(extension.worker)).toEqual({ ...installed, status: 'failed' });
});
