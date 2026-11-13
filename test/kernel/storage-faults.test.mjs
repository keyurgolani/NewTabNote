// #17's fault-injecting wrapper (test/support/faults/storage-faults.mjs) over fake-indexeddb: a
// read fault planted on a store fails that store's next read, whichever read production makes. A
// store's count (health.js's vectors check) and an index's openKeyCursor (integrity.js's orphan
// scan) are reads too, so each fails with the planned DOMException.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

import { faultyFactory } from '../support/faults/storage-faults.mjs';

/** @type {{IDBFactory: new () => IDBFactory}} */
const { IDBFactory } = createRequire(import.meta.url)('fake-indexeddb');

/**
 * A database with one store, `elements`, indexed by `canvasId`, and one record in it
 * @param {IDBFactory} factory
 * @returns {Promise<IDBDatabase>}
 */
function seeded(factory) {
  return new Promise((resolve, reject) => {
    const request = factory.open('CanvasTabDB', 1);
    request.onupgradeneeded = () => {
      const store = request.result.createObjectStore('elements', { keyPath: 'id' });
      store.createIndex('canvasId', 'canvasId', { unique: false });
      store.put({ id: 'b1', canvasId: 'n1' });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

/**
 * What `read` answers: its result, or its error's name
 * @param {IDBRequest} read
 * @returns {Promise<{result: unknown} | {error: string}>}
 */
function outcomeOf(read) {
  return new Promise(resolve => {
    read.onsuccess = () => resolve({ result: read.result });
    read.onerror = () => resolve({ error: read.error ? read.error.name : 'no error' });
  });
}

describe("the fault wrapper's planned read faults", () => {
  it("fail a store's next count, as health.js counts vectors", async () => {
    const faults = faultyFactory(new IDBFactory());
    const db = await seeded(faults.factory);
    assert.deepEqual(await outcomeOf(db.transaction(['elements'], 'readonly').objectStore('elements').count()), { result: 1 });
    faults.failNextRead('elements', 'NotReadableError');
    assert.deepEqual(await outcomeOf(db.transaction(['elements'], 'readonly').objectStore('elements').count()), { error: 'NotReadableError' });
    db.close();
  });

  it("fail an index's next openKeyCursor, as integrity.js scans for orphans", async () => {
    const faults = faultyFactory(new IDBFactory());
    const db = await seeded(faults.factory);
    faults.failNextRead('elements', 'UnknownError');
    const scan = db.transaction(['elements'], 'readonly').objectStore('elements').index('canvasId').openKeyCursor();
    assert.deepEqual(await outcomeOf(scan), { error: 'UnknownError' });
    db.close();
  });
});
