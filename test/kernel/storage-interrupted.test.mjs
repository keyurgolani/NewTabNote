// #28 slice 3, the fixture loader and dumper cut off (storage-faults.mjs): a load the disk
// refuses at commit, or one a record's missing key stops partway through a transaction,
// rejects and leaves that transaction's store as it was, with every earlier transaction whole;
// loading again ends at the fixture. A load whose upgrade fails leaves no stores. A dump whose
// read fails rejects, returns no partial fixture, and leaves the database as it was; dumping
// again reads it whole. Each case says where it was cut.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { dumpFixture, fillCanaries, loadFixture } from '../fixtures/storage/load-fixture.mjs';
import { newProfile, recordsIn, synthesized } from './migration-support.mjs';

/** @typedef {import('../fixtures/storage/load-fixture.mjs').Fixture} Fixture */

const FIXTURES = synthesized();
const BASIC = /** @type {Fixture} */ (FIXTURES.get('v8.basic'));

/**
 * What a profile holds, read through the plain factory
 * @param {import('./migration-support.mjs').Profile} of
 */
const held = of => dumpFixture({ factory: of.real, storage: of.chrome.api.storage.local, header: BASIC.header });

/**
 * `fixture` as `held` reads it when exactly `loaded` of its stores hold their records
 * @param {Fixture} fixture
 * @param {string[]} loaded
 */
function partly(fixture, loaded) {
  const filled = fillCanaries(fixture);
  return {
    ...filled,
    header: BASIC.header,
    databases: filled.databases.map(db => ({
      ...db,
      stores: db.stores.map(store => (loaded.includes(store.name) ? store : { ...store, records: [] })),
    })),
    // chrome.storage.local is written last, after every store
    chromeStorageLocal: {},
  };
}

/** @param {Fixture} fixture */
const storeNames = fixture => fixture.databases[0].stores.map(store => store.name);

describe('a load cut off', () => {
  it('at commit, by the disk refusing the elements batch: rejects, elements empty, the stores before it whole', async () => {
    const of = newProfile();
    const aborted = of.faults.abortAfterNextWrite('elements', 'QuotaExceededError');
    await assert.rejects(
      loadFixture(BASIC, { factory: of.faults.factory, storage: of.chrome.api.storage.local }),
      /** @param {any} error */ error => error.name === 'QuotaExceededError',
    );
    await aborted;
    const names = storeNames(BASIC);
    const before = names.slice(0, names.indexOf('elements'));
    assert.deepStrictEqual(await held(of), partly(BASIC, before));
    assert.deepStrictEqual(recordsIn(await held(of), 'CanvasTabDB', 'elements'), []);
  });

  it('then loaded again: ends at the fixture, as a load that was never cut', async () => {
    const of = newProfile();
    const aborted = of.faults.abortAfterNextWrite('links', 'UnknownError');
    await assert.rejects(loadFixture(BASIC, { factory: of.faults.factory, storage: of.chrome.api.storage.local }));
    await aborted;
    await loadFixture(BASIC, { factory: of.real, storage: of.chrome.api.storage.local });
    assert.deepStrictEqual(await held(of), { ...fillCanaries(BASIC), header: BASIC.header });
  });

  it("partway through a transaction, by a record whose value has no key: rejects, and none of that transaction's records stay", async () => {
    const fixture = structuredClone(BASIC);
    const elements = /** @type {any} */ (fixture.databases[0].stores.find(store => store.name === 'elements'));
    assert.ok(elements.records.length >= 3);
    // The second record's value lost its key path field, so its put throws DataError at once
    delete elements.records[1].value.id;
    const of = newProfile();
    await assert.rejects(
      loadFixture(fixture, { factory: of.real, storage: of.chrome.api.storage.local }),
      /** @param {any} error */ error => error.name === 'DataError',
    );
    // The first record's put was in the same transaction, so it's gone with it
    assert.deepStrictEqual(recordsIn(await held(of), 'CanvasTabDB', 'elements'), []);
    const names = storeNames(BASIC);
    assert.deepStrictEqual(await held(of), partly(BASIC, names.slice(0, names.indexOf('elements'))));
  });

  it('in its upgrade, by an index it can\'t make: rejects, and leaves no store', async () => {
    const fixture = structuredClone(BASIC);
    const canvases = /** @type {any} */ (fixture.databases[0].stores.find(store => store.name === 'canvases'));
    // A multi-entry index on a compound key path is refused with InvalidAccessError
    canvases.indexes.push({ name: 'broken', keyPath: ['a', 'b'], unique: false, multiEntry: true });
    const of = newProfile();
    await assert.rejects(loadFixture(fixture, { factory: of.real }));
    const left = await dumpFixture({ factory: of.real });
    for (const db of left.databases) assert.deepStrictEqual(db.stores, [], `${db.name} kept a store`);
  });
});

describe('a dump cut off', () => {
  for (const store of ['canvases', 'media', 'vectors']) {
    it(`by a read of ${store} failing: rejects with no partial fixture, and the database is as it was`, async () => {
      const of = newProfile();
      await loadFixture(BASIC, { factory: of.real, storage: of.chrome.api.storage.local });
      const whole = await held(of);
      of.faults.failNextRead(store, 'NotReadableError');
      /** @type {unknown} */
      let partial;
      await assert.rejects(
        (async () => {
          partial = await dumpFixture({ factory: of.faults.factory, storage: of.chrome.api.storage.local });
        })(),
        // The failed request's error, or, where the transaction finished first, that the read
        // of the store ended before its cursor did
        /** @param {any} error */ error => error.name === 'NotReadableError' || error.message === `the read of ${store} ended early`,
      );
      assert.equal(partial, undefined);
      assert.deepStrictEqual(await held(of), whole);
      // And no write reached the database while it dumped
      assert.deepStrictEqual(
        of.faults.transactions.filter(tx => tx.mode !== 'readonly'),
        [],
      );
    });
  }

  it('by the open failing: rejects, and nothing is created or changed', async () => {
    const of = newProfile();
    await loadFixture(BASIC, { factory: of.real, storage: of.chrome.api.storage.local });
    const whole = await held(of);
    of.faults.failNextOpen('CanvasTabDB', 'UnknownError');
    await assert.rejects(dumpFixture({ factory: of.faults.factory }), /** @param {any} error */ error => error.name === 'UnknownError');
    assert.deepStrictEqual(await held(of), whole);
    assert.deepStrictEqual(of.faults.deletes, []);
  });
});
