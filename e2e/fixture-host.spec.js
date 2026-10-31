/**
 * The browser host for the storage fixture format (harness/fixture-host.js, #28 slice 3) in
 * Chromium: synthesized and recorded fixtures load into the built extension's service worker
 * and popup page, under names of their own so the app's databases are left alone, and dump
 * back as themselves, Blobs, typed values, a newer version and a store no release made
 * included. chrome.storage.local goes through the same host. This is the path
 * scripts/fixtures/record-release.mjs dumps each release through.
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
