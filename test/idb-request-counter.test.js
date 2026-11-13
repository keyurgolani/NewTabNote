'use strict';

// The IndexedDB request counter (#28 slice 4, #301), test/support/faults/idb-requests.js, over the
// pinned fake-indexeddb, whose classes stand in for a page's. e2e/idb-request-counter.spec.js runs
// the same installer in Chromium, as a page's init script and in the service worker.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { IDBFactory, IDBObjectStore, IDBIndex, IDBCursor } = require('fake-indexeddb');
const { installIdbRequestCounter, countIdbRequests } = require('./support/faults');

const done = (request) => new Promise((resolve, reject) => {
  request.onsuccess = () => resolve(request.result);
  request.onerror = () => reject(request.error);
});

/** Runs `requests` on the `notes` store in a new transaction, and resolves once it commits */
const run = (db, mode, requests) => new Promise((resolve, reject) => {
  const tx = db.transaction('notes', mode);
  tx.oncomplete = () => resolve();
  tx.onabort = () => reject(tx.error);
  requests(tx.objectStore('notes'));
});

/** A new database `counted`: a `notes` store keyed by id, with a `byTitle` index, holding a, b and c */
async function notes() {
  const open = new IDBFactory().open('counted', 1);
  open.onupgradeneeded = () => open.result.createObjectStore('notes', { keyPath: 'id' }).createIndex('byTitle', 'title');
  const db = await done(open);
  await run(db, 'readwrite', (store) => ['a', 'b', 'c'].forEach((id) => store.put({ id, title: id.toUpperCase() })));
  return db;
}

/** A counter over fake-indexeddb's classes, as a page's globals hold them, taken out when the test ends */
function counted(t) {
  const scope = { IDBObjectStore, IDBIndex, IDBCursor, performance };
  installIdbRequestCounter(scope);
  t.after(() => scope.__ntnIdbRequests && scope.__ntnIdbRequests.uninstall());
  return scope.__ntnIdbRequests;
}

const shape = ({ at, ...rest }) => rest;
const entry = (kind, method, index = null) => ({ kind, method, database: 'counted', store: 'notes', index });
const step = (method, index = null) => ({ method, database: 'counted', store: 'notes', index });
const READS = ['get', 'getKey', 'getAll', 'getAllKeys', 'getAllRecords', 'count', 'openCursor', 'openKeyCursor'];

describe('the IndexedDB request counter', () => {
  it('counts each read on a store or an index once, with its database, store, index and time', async (t) => {
    const counter = counted(t);
    const db = await notes();
    counter.reset();
    const before = Date.now();
    await run(db, 'readonly', (store) => {
      for (const method of READS) store[method](method.startsWith('get') && !method.startsWith('getAll') ? 'a' : undefined);
      const index = store.index('byTitle');
      for (const method of READS) index[method](method.startsWith('get') && !method.startsWith('getAll') ? 'A' : undefined);
    });
    const after = Date.now();
    assert.deepEqual(counter.entries().map(shape), [...READS.map((method) => entry('read', method)), ...READS.map((method) => entry('read', method, 'byTitle'))]);
    for (const { at } of counter.entries()) {
      assert.ok(at >= before - 50 && at <= after + 50, `${at} is on the epoch clock, between ${before} and ${after}`);
    }
    assert.deepEqual(counter.cursorSteps(), []);
  });

  it("counts writes, a cursor's among them, and a cursor's steps apart from its reads", async (t) => {
    const counter = counted(t);
    const db = await notes();
    counter.reset();
    await run(db, 'readonly', (store) => {
      const walk = store.index('byTitle').openCursor();
      walk.onsuccess = () => walk.result.primaryKey === 'a' && walk.result.continuePrimaryKey('C', 'c');
    });
    await run(db, 'readwrite', (store) => {
      store.put({ id: 'd', title: 'D' });
      store.add({ id: 'e', title: 'E' });
      const edit = store.openCursor();
      edit.onsuccess = () => {
        const cursor = edit.result;
        if (cursor.key === 'a') {
          cursor.update({ ...cursor.value, title: 'A2' });
          cursor.advance(2);
        } else if (cursor.key === 'c') {
          cursor.delete();
          cursor.continue();
        } else {
          store.delete('e');
          store.clear();
        }
      };
    });
    assert.deepEqual(counter.entries().map(shape), [
      entry('read', 'openCursor', 'byTitle'), entry('write', 'put'), entry('write', 'add'), entry('read', 'openCursor'),
      entry('write', 'update'), entry('write', 'delete'), entry('write', 'delete'), entry('write', 'clear'),
    ]);
    assert.deepEqual(counter.cursorSteps().map(shape), [step('continuePrimaryKey', 'byTitle'), step('advance'), step('continue')]);
  });

  it('counts nothing for a call that throws', async (t) => {
    const counter = counted(t);
    const db = await notes();
    counter.reset();
    const tx = db.transaction('notes');
    const store = tx.objectStore('notes');
    const ended = new Promise((resolve) => (tx.oncomplete = resolve));
    assert.throws(() => store.put({ id: 'x' }), { name: 'ReadOnlyError' });
    assert.throws(() => store.get({}), { name: 'DataError' });
    await ended;
    assert.throws(() => store.get('a'), { name: 'TransactionInactiveError' });
    assert.deepEqual(counter.entries(), []);
  });

  it('installs once over the same classes, and its uninstall puts every method back', async (t) => {
    const originals = [IDBObjectStore.prototype.get, IDBIndex.prototype.count, IDBCursor.prototype.continue, IDBCursor.prototype.update];
    const scope = { IDBObjectStore, IDBIndex, IDBCursor, performance };
    t.after(() => scope.__ntnIdbRequests && scope.__ntnIdbRequests.uninstall());
    assert.equal(installIdbRequestCounter(scope), true);
    const counter = scope.__ntnIdbRequests;
    assert.equal(installIdbRequestCounter(scope), true);
    assert.ok(scope.__ntnIdbRequests === counter, 'a second install keeps the first counter');
    const db = await notes();
    counter.reset();
    await done(db.transaction('notes').objectStore('notes').get('a'));
    assert.equal(counter.entries().length, 1, 'one get counts once');
    counter.uninstall();
    assert.equal(scope.__ntnIdbRequests, undefined);
    assert.deepEqual([IDBObjectStore.prototype.get, IDBIndex.prototype.count, IDBCursor.prototype.continue, IDBCursor.prototype.update], originals);
    await done(db.transaction('notes').objectStore('notes').get('a'));
    assert.equal(counter.entries().length, 1, 'nothing counts once the counter is out');
  });

  it('counts a record up to a time, by kind and by store', () => {
    const at = (kind, store, time) => ({ kind, method: kind === 'read' ? 'get' : 'put', database: 'CanvasTabDB', store, index: null, at: time });
    const record = {
      entries: [at('read', 'canvases', 10), at('read', 'elements', 20), at('write', 'elements', 30), at('read', 'canvases', 40)],
      cursorSteps: [25, 45].map((time) => ({ method: 'continue', database: 'CanvasTabDB', store: 'elements', index: null, at: time })),
    };
    assert.deepEqual(countIdbRequests(record), {
      reads: 3, writes: 1, cursorSteps: 2,
      byStore: { 'CanvasTabDB/canvases': { reads: 2, writes: 0, cursorSteps: 0 }, 'CanvasTabDB/elements': { reads: 1, writes: 1, cursorSteps: 2 } },
    });
    assert.deepEqual(countIdbRequests(record, { until: 30 }), {
      reads: 2, writes: 1, cursorSteps: 1,
      byStore: { 'CanvasTabDB/canvases': { reads: 1, writes: 0, cursorSteps: 0 }, 'CanvasTabDB/elements': { reads: 1, writes: 1, cursorSteps: 1 } },
    });
  });
});
