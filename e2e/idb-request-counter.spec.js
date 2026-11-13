/**
 * The IndexedDB request counter (test/support/faults/idb-requests.js, #28 slice 4, #301) in
 * Chromium, where #300's IndexedDB reads before interaction-ready read it. As the context's init
 * script it counts an extension page's requests from the page's first script, and evaluated in the
 * service worker it counts the worker's from then on, both on the epoch clock. Each runs a planted
 * sequence on a database of its own, so the app's requests stay apart by name.
 * test/idb-request-counter.test.js runs the same installer over fake-indexeddb.
 */

const { test, expect, expectNoUncaught } = require('./harness');
const { countIdbRequests, countRequestsIn, interactionReadyAt, readIdbRequests } = require('../test/support/faults');

/**
 * In a page or the worker: makes database `name`, runs the planted requests on it, deletes it, and
 * answers when that started and ended on the epoch clock. Each transaction's requests go out from
 * its own callbacks, so nothing waits on a promise while a transaction is open.
 */
async function plant(name) {
  const now = () => performance.timeOrigin + performance.now();
  const done = (request) => new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  const run = (db, mode, requests) => new Promise((resolve, reject) => {
    const tx = db.transaction('notes', mode);
    tx.oncomplete = () => resolve();
    tx.onabort = () => reject(tx.error);
    requests(tx.objectStore('notes'));
  });
  const started = now();
  const open = indexedDB.open(name, 1);
  open.onupgradeneeded = () => open.result.createObjectStore('notes', { keyPath: 'id' }).createIndex('byTitle', 'title');
  const db = await done(open);
  await run(db, 'readwrite', (store) => {
    store.put({ id: 'a', title: 'A' });
    store.put({ id: 'b', title: 'B' });
    store.add({ id: 'c', title: 'C' });
  });
  await run(db, 'readonly', (store) => {
    store.get('a');
    store.getAll();
    store.count();
    store.index('byTitle').get('B');
    const walk = store.openCursor();
    walk.onsuccess = () => walk.result && walk.result.continue();
  });
  await run(db, 'readwrite', (store) => {
    const edit = store.openCursor();
    edit.onsuccess = () => {
      const cursor = edit.result;
      if (cursor.key === 'a') {
        cursor.update({ ...cursor.value, title: 'A2' });
        cursor.advance(2);
      } else {
        cursor.delete();
        store.clear();
      }
    };
  });
  db.close();
  await done(indexedDB.deleteDatabase(name));
  return { started, ended: now() };
}

/** What plant(name) asks for, in order, as [kind, method, index] */
const PLANTED = [
  ['write', 'put', null], ['write', 'put', null], ['write', 'add', null],
  ['read', 'get', null], ['read', 'getAll', null], ['read', 'count', null], ['read', 'get', 'byTitle'], ['read', 'openCursor', null],
  ['read', 'openCursor', null], ['write', 'update', null], ['write', 'delete', null], ['write', 'clear', null],
];
const STEPS = ['continue', 'continue', 'continue', 'advance'];

test("counts a page's requests from its first script and the worker's once installed, on one clock", async ({ extension }) => {
  await extension.seedOnboarded();
  await countRequestsIn(extension.context);
  await countRequestsIn(extension.worker);
  const page = await extension.openSurface('newtab');
  await expect.poll(() => interactionReadyAt(page), { message: "the new tab's interaction-ready mark" }).not.toBeNull();
  const runs = [
    { where: 'page', target: page, name: 'ntn-counter-page', span: await page.evaluate(plant, 'ntn-counter-page') },
    { where: 'worker', target: extension.worker, name: 'ntn-counter-worker', span: await extension.worker.evaluate(plant, 'ntn-counter-worker') },
  ];

  for (const { where, target, name, span } of runs) {
    const record = await readIdbRequests(target);
    const entries = record.entries.filter((entry) => entry.database === name);
    const steps = record.cursorSteps.filter((step) => step.database === name);
    expect(entries.map(({ at, ...entry }) => entry), `the ${where}'s planted requests`)
      .toEqual(PLANTED.map(([kind, method, index]) => ({ kind, method, database: name, store: 'notes', index })));
    expect(steps.map(({ at, ...step }) => step), `the ${where}'s cursor steps`)
      .toEqual(STEPS.map((method) => ({ method, database: name, store: 'notes', index: null })));
    for (const { at } of [...entries, ...steps]) {
      expect(at >= span.started && at <= span.ended, `${at} falls in the ${where}'s run, from ${span.started} to ${span.ended}`).toBe(true);
    }
    expect(countIdbRequests({ entries, cursorSteps: steps })).toEqual({
      reads: 6, writes: 6, cursorSteps: 4, byStore: { [`${name}/notes`]: { reads: 6, writes: 6, cursorSteps: 4 } },
    });
  }
  expect(runs[0].span.ended <= runs[1].span.started, "the page's run ends before the worker's starts, on the same clock").toBe(true);

  // The new tab's own start, counted from its first script: reads on the app's databases before its mark
  const ready = await interactionReadyAt(page);
  const start = (await readIdbRequests(page)).entries.filter((entry) => entry.database !== 'ntn-counter-page');
  expect(countIdbRequests({ entries: start, cursorSteps: [] }, { until: ready }).reads, "the new tab's reads before its mark").toBeGreaterThan(0);
  await expectNoUncaught(extension, page);
});
