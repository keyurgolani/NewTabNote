// #17 PR 4a, Q9: the read-only integrity check js/storage.js ran at each new tab's start
// (validateDatabase) moves to the service worker's start, at most once a day, since the new tab
// now opens #17's adapter (adapters/indexeddb/integrity.js). It counts what Storage counted on
// the same profile, changes no record, and keeps only when it ran, in `meta`.

import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  INTEGRITY_CHECK_EVERY_MS,
  INTEGRITY_KEY,
  orphansIn,
  readIntegrity,
} from '../../js/kernel/adapters/indexeddb/integrity.js';
import { adapterOn, closeAll, legacyEnv, profile, recordsOf } from './storage-fixture.mjs';

/** @typedef {import('./storage-fixture.mjs').Profile} Profile */

/** @type {Profile[]} */
const profiles = [];
after(() => profiles.forEach(closeAll));

const { note, block } = legacyEnv;

/** Notes A and B, and one record that names a note that's gone in each store that names one */
const RECORDS = () => ({
  canvases: [note('A'), note('B')],
  elements: [block('a1', 'A', 0, 'kept'), block('x1', 'GONE', 0, 'orphan')],
  search_index: [
    { noteId: 'A', name: 'A', content: 'kept' },
    { noteId: 'GONE', name: 'Gone', content: 'orphan' },
  ],
  links: [
    { id: 'l1', fromNoteId: 'A', toNoteId: 'B' },
    { id: 'l2', fromNoteId: 'A', toNoteId: 'GONE' },
  ],
  vectors: [
    { id: 'A', noteId: 'A', vector: [1] },
    { id: 'GONE', noteId: 'GONE', vector: [2] },
  ],
  snapshots: [
    { id: 's1', noteId: 'A', createdAt: 1 },
    { id: 's2', noteId: 'GONE', createdAt: 1 },
  ],
  media: [
    { id: 'm1', canvasId: 'A', blob: new Blob(['x']), type: 'text/plain', createdAt: 1 },
    { id: 'm2', canvasId: 'GONE', blob: new Blob(['y']), type: 'text/plain', createdAt: 1 },
  ],
});

/**
 * A connection of its own to `of`'s CanvasTabDB
 * @param {Profile} of
 * @returns {Promise<IDBDatabase>}
 */
const openDb = of => legacyEnv.requestToPromise(of.real.open('CanvasTabDB'));

/**
 * js/storage.js's validateDatabase on `of`'s profile, in a page that opened it
 * @param {Profile} of
 */
async function storageReport(of) {
  const env = legacyEnv.createLegacyEnv({ context: 'page', indexedDB: of.real, chrome: of.chrome, worker: false });
  env.load('js/utils.js', 'js/storage.js');
  const storage = env.get('Storage');
  await storage.open();
  try {
    return legacyEnv.plain(await storage.validateDatabase());
  } finally {
    storage.db.close();
  }
}

/**
 * A profile at this build's version, as the worker's run leaves it, holding RECORDS
 * @returns {Promise<Profile>}
 */
async function latest() {
  const of = profile();
  profiles.push(of);
  const worker = adapterOn(of);
  await worker.open();
  worker.close();
  const db = await openDb(of);
  const records = RECORDS();
  const tx = db.transaction(Object.keys(records), 'readwrite');
  for (const [store, rows] of Object.entries(records)) for (const row of rows) tx.objectStore(store).put(row);
  await new Promise((resolve, reject) => {
    tx.oncomplete = resolve;
    tx.onabort = () => reject(tx.error);
  });
  db.close();
  return of;
}

describe("the integrity check on #17's adapter (#17 PR 4a, Q9)", () => {
  it("counts what Storage's validateDatabase counts on the same profile, store by store", async () => {
    const of = profile();
    profiles.push(of);
    await legacyEnv.createDatabase(of.real, { records: RECORDS() });
    const db = await openDb(of);
    const report = await readIntegrity(db);
    db.close();
    assert.deepEqual(report, await storageReport(of));
    assert.deepEqual(orphansIn(report), {
      orphanedElements: 1,
      orphanedSearchIndex: 1,
      orphanedLinks: 1,
      orphanedVectors: 1,
      orphanedSnapshots: 1,
      orphanedMedia: 1,
    });

    // A database without some stores counts none in them, and names them, as Storage does
    const without = profile();
    profiles.push(without);
    const { media, snapshots, ...records } = RECORDS();
    await legacyEnv.createDatabase(without.real, { omit: ['media', 'snapshots'], records });
    const thin = await openDb(without);
    const thinReport = await readIntegrity(thin);
    thin.close();
    assert.deepEqual(thinReport, await storageReport(without));
    assert.deepEqual(thinReport.missingStores, ['media', 'snapshots']);
  });

  it('checks once a day at most, keeping only when it ran in meta, and changes no record', async () => {
    const of = await latest();
    let now = 1_760_000_000_000;
    const adapter = adapterOn(of, { clock: { now: () => now } });
    await adapter.open();
    const before = await legacyEnv.dumpDatabase(of.real);

    const first = await adapter.checkIntegrity();
    assert.equal(first.checked, true);
    assert.deepEqual(first.checked && orphansIn(first.report), {
      orphanedElements: 1,
      orphanedSearchIndex: 1,
      orphanedLinks: 1,
      orphanedVectors: 1,
      orphanedSnapshots: 1,
      orphanedMedia: 1,
    });
    assert.deepEqual(
      (await recordsOf(of, 'meta')).filter(record => record.key === INTEGRITY_KEY),
      [{ key: INTEGRITY_KEY, checkedAt: now }],
    );
    now += INTEGRITY_CHECK_EVERY_MS - 1;
    assert.deepEqual(await adapter.checkIntegrity(), { checked: false });
    now += 1;
    assert.equal((await adapter.checkIntegrity()).checked, true);
    adapter.close();

    // Every store but meta is as it was
    const after = await legacyEnv.dumpDatabase(of.real);
    const { meta: metaBefore, ...restBefore } = before.stores;
    const { meta: metaAfter, ...restAfter } = after.stores;
    assert.deepEqual(restAfter, restBefore);
    assert.ok(metaBefore && metaAfter);
  });

  it("doesn't check a database without meta, which the worker's run never got in, and writes nothing", async () => {
    const of = profile();
    profiles.push(of);
    await legacyEnv.createDatabase(of.real, { records: RECORDS() });
    const before = await legacyEnv.dumpDatabase(of.real);
    const adapter = adapterOn(of, { mode: 'existing' });
    await adapter.open();
    assert.deepEqual(await adapter.checkIntegrity(), { checked: false });
    adapter.close();
    assert.deepEqual(await legacyEnv.dumpDatabase(of.real), before);
  });
});
