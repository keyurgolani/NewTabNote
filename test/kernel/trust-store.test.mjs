// NewTabNoteTrust and the memory trust store through the trust store suite
// (trust-store-suite.mjs), then NewTabNoteTrust's own rules: its layout at version 1, #17's
// transaction rules, and a newer database left alone.

import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  TRUST_DB_NAME,
  TRUST_DB_STORES,
  TRUST_DB_VERSION,
  createTrustDatabase,
} from '../../js/kernel/adapters/indexeddb/trust.js';
import { TRUST_STORES, createMemoryTrustStore } from '../../js/trust/core/memory-store.js';
import { describeTrustStore } from './trust-store-suite.mjs';
import { databaseOn, dumpTrustDatabase, fakeKeyRange, openRecords, trustProfile } from './trust-support.mjs';

/** @typedef {import('../../js/trust/core/ports.js').TrustStore} TrustStore */

/** @type {TrustStore[]} */
const opened = [];
after(() => opened.forEach(store => store.close()));

describeTrustStore('memory', { make: () => createMemoryTrustStore() });
describeTrustStore('NewTabNoteTrust (fake-indexeddb)', {
  make: profile => createTrustDatabase({ indexedDB: profile.faults.factory, keyRange: fakeKeyRange }),
});

describe('NewTabNoteTrust (#20 slice 1, "Records")', () => {
  it('has the layout the memory store keeps, at version 1', async () => {
    assert.deepEqual(TRUST_DB_STORES, TRUST_STORES);
    const profile = trustProfile();
    const store = databaseOn(profile);
    opened.push(store);
    await store.open();
    const db = /** @type {IDBDatabase} */ (
      await new Promise(resolve => {
        const request = profile.real.open(TRUST_DB_NAME);
        request.onsuccess = () => resolve(request.result);
      })
    );
    assert.equal(db.version, TRUST_DB_VERSION);
    assert.equal(TRUST_DB_VERSION, 1);
    /** @type {Record<string, {keyPath: unknown, autoIncrement: boolean, indexes: string[], unique: string[]}>} */
    const layout = {};
    const tx = db.transaction([...db.objectStoreNames]);
    for (const name of db.objectStoreNames) {
      const objectStore = tx.objectStore(name);
      const indexes = [...objectStore.indexNames];
      layout[name] = {
        keyPath: objectStore.keyPath,
        autoIncrement: objectStore.autoIncrement,
        indexes: Object.keys(TRUST_DB_STORES).includes(name)
          ? /** @type {any} */ (TRUST_DB_STORES)[name].indexes.filter((/** @type {string} */ index) =>
              indexes.includes(index),
            )
          : indexes,
        unique: indexes.filter(index => objectStore.index(index).unique),
      };
    }
    db.close();
    assert.deepEqual(layout, JSON.parse(JSON.stringify(TRUST_DB_STORES)));
  });

  it('writes in one strict readwrite transaction over the stores a unit names', async () => {
    const profile = trustProfile();
    const store = databaseOn(profile);
    opened.push(store);
    const { records } = await openRecords(store, profile);
    profile.faults.transactions.length = 0;
    await records.raise({ providerId: 'storage', faultCode: 'open-failed', severity: 'degraded' });
    assert.deepEqual(
      profile.faults.transactions.map(({ names, mode, durability }) => [names, mode, durability]),
      [[['incidents'], 'readwrite', 'strict']],
    );
  });

  it('reports nothing stored when the commit aborts, and keeps the incident in the fallback', async () => {
    const profile = trustProfile();
    const store = databaseOn(profile);
    opened.push(store);
    const { records } = await openRecords(store, profile);
    const aborted = profile.faults.abortAfterNextWrite('incidents', 'QuotaExceededError');
    const raised = await records.raise({ providerId: 'storage', faultCode: 'quota', severity: 'capture-risk' });
    await aborted;
    assert.equal(raised.held, true);
    assert.equal(records.state(), 'fallback');
    assert.equal(records.failureCode(), 'quota');
    // The storage incident survives the context
    const stored = /** @type {any} */ (profile.settings.items.get('trust.lastStorageIncident'));
    assert.deepEqual(stored.entries.map((/** @type {any} */ entry) => entry.key).sort(), [
      'storage/quota/-',
      'storage/write-failed/-',
    ]);
    // and nothing committed
    assert.deepEqual(JSON.parse(await dumpTrustDatabase(profile.real)).incidents, []);
    // until the next open reconciles it
    const again = databaseOn(profile);
    opened.push(again);
    const second = await openRecords(again, profile);
    assert.equal(second.opened.ok, true);
    assert.deepEqual((await second.records.incidents()).map(incident => incident.key).sort(), [
      'storage/quota/-',
      'storage/write-failed/-',
    ]);
    assert.equal(profile.settings.items.get('trust.lastStorageIncident'), null);
  });

  it('runs a unit once more after a transient abort, and commits it once', async () => {
    const profile = trustProfile();
    const store = databaseOn(profile);
    opened.push(store);
    const { records } = await openRecords(store, profile);
    const aborted = profile.faults.abortAfterNextWrite('incidents', 'UnknownError');
    const raised = await records.raise({ providerId: 'index', faultCode: 'lagging', severity: 'degraded' });
    await aborted;
    assert.equal(raised.held, false);
    const all = await records.incidents();
    assert.equal(all.length, 1);
    assert.equal(all[0].occurrences, 1);
  });

  it('refuses a newer database and leaves it as it was', async () => {
    const profile = trustProfile();
    await new Promise(resolve => {
      const request = profile.real.open(TRUST_DB_NAME, 2);
      request.onupgradeneeded = () => request.result.createObjectStore('future');
      request.onsuccess = () => {
        request.result.close();
        resolve(undefined);
      };
    });
    const store = createTrustDatabase({ indexedDB: profile.faults.factory });
    await assert.rejects(store.open(), { code: 'version-too-new' });
    const db = /** @type {IDBDatabase} */ (
      await new Promise(resolve => {
        const request = profile.real.open(TRUST_DB_NAME);
        request.onsuccess = () => resolve(request.result);
      })
    );
    assert.equal(db.version, 2);
    assert.deepEqual([...db.objectStoreNames], ['future']);
    db.close();
  });
});
