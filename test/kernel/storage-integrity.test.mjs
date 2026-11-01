// The read-only integrity check on #17's adapter (js/kernel/adapters/indexeddb/integrity.js),
// held to 1.4.x's Storage.runIntegrityCheck, which the worker ran until #17 PR 1b put its
// kernel on #17's adapter: on the same database, the two report the same, word for word, by
// store, at version 8 and at 9 through the runner, with stores missing, with nothing to report,
// and when a store can't be read. Both only report: nothing in the database changes.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { createIndexedDbAdapter } from '../../js/kernel/adapters/indexeddb/adapter.js';
import { kernelClient } from '../../js/kernel/composition/host.js';
import { legacyEnv, newProfile, run } from './migration-support.mjs';

/** @typedef {import('./migration-support.mjs').Profile} Profile */

/** What each check said: its console level, its words, and what it named */
/** @typedef {{level: string, message: string, detail: unknown}} Said */

/** A note, and one record of each kind that names it */
const KEPT = Object.freeze({
  canvases: [legacyEnv.note('A'), legacyEnv.note('B')],
  elements: [legacyEnv.block('a1', 'A', 0)],
  search_index: [{ noteId: 'A', text: 'alpha' }],
  links: [{ id: 'l1', fromNoteId: 'A', toNoteId: 'B' }],
  vectors: [{ id: 'A', vector: [0.5] }],
  snapshots: [{ id: 's1', noteId: 'A', timestamp: 1 }],
  media: [{ id: 'm1', canvasId: 'A' }],
});

/** Records whose note isn't there: a different count in each store */
const ORPHANED = Object.freeze({
  elements: [legacyEnv.block('x1', 'gone', 0), legacyEnv.block('x2', 'gone', 1), legacyEnv.block('x3', 'also-gone', 0)],
  search_index: [{ noteId: 'gone', text: 'lost' }],
  // From a note that's gone, to one, and both
  links: [
    { id: 'l2', fromNoteId: 'gone', toNoteId: 'A' },
    { id: 'l3', fromNoteId: 'A', toNoteId: 'gone' },
    { id: 'l4', fromNoteId: 'gone', toNoteId: 'also-gone' },
    { id: 'l5', fromNoteId: 'B', toNoteId: 'A' },
  ],
  vectors: [{ id: 'gone', vector: [0.25] }, { id: 'also-gone', vector: [0.75] }],
  snapshots: [{ id: 's2', noteId: 'gone', timestamp: 2 }],
  media: [{ id: 'm2', canvasId: 'gone' }, { id: 'm3', canvasId: 'gone' }],
});

/**
 * Rows of both, store by store
 * @param {Record<string, unknown[]>} a
 * @param {Record<string, unknown[]>} b
 * @returns {Record<string, unknown[]>}
 */
const merged = (a, b) =>
  Object.fromEntries([...new Set([...Object.keys(a), ...Object.keys(b)])].map(store => [store, [...(a[store] || []), ...(b[store] || [])]]));

/**
 * What Storage.runIntegrityCheck says on `of`'s database, as a page opens it
 * @param {Profile} of
 * @returns {Promise<Said[]>}
 */
async function storageSays(of) {
  const env = legacyEnv.createLegacyEnv({ context: 'page', indexedDB: of.real, chrome: of.chrome });
  env.load('js/utils.js', 'js/storage.js');
  const storage = env.get('Storage');
  await storage.openExisting();
  const before = env.logs.length;
  await storage.runIntegrityCheck();
  storage.db.close();
  return env.logs.slice(before).map((/** @type {{level: string, args: unknown[]}} */ log) => ({
    level: log.level,
    message: String(log.args[0]),
    detail: log.level === 'warn' ? nameOf(log.args[1]) : legacyEnv.plain(log.args[1]),
  }));
}

/**
 * What #17's adapter says on `of`'s database, run as the worker runs it, on a kernel whose
 * caller is the worker's
 * @param {Profile} of
 * @returns {Promise<Said[]>}
 */
async function adapterSays(of) {
  /** @type {Said[]} */
  const said = [];
  const adapter = createIndexedDbAdapter({
    indexedDB: of.real,
    settings: of.chrome.api.storage.local,
    mode: 'existing',
    integrityLog: {
      info: (message, detail) => said.push({ level: 'info', message, detail: structuredClone(detail) }),
      warn: (message, error) => said.push({ level: 'warn', message, detail: nameOf(error) }),
    },
  });
  const client = kernelClient({ adapter, surface: 'worker-internal' });
  const checked = await client.execute({ type: 'runIntegrityCheck', commandId: client.ids.next() });
  assert.deepEqual(checked.kind === 'committed' && [checked.code, checked.changedIds], ['integrity-checked', []]);
  adapter.close();
  return said;
}

/** @param {unknown} error */
const nameOf = error => (error && typeof error === 'object' && 'name' in error ? String(error.name) : String(error));

/**
 * A profile whose database holds `records`, at version 8, or at 9 through the runner
 * @param {Record<string, unknown[]>} records
 * @param {{nine?: boolean, omit?: string[], extraStores?: Record<string, unknown>}} [options]
 * @returns {Promise<Profile>}
 */
async function profileHolding(records, { nine = false, omit = [], extraStores = {} } = {}) {
  const of = newProfile();
  await legacyEnv.createDatabase(of.real, { records, omit, extraStores });
  if (nine) assert.equal((await run(of)).status, 'migrated');
  return of;
}

/** The orphan counts the check reports for ORPHANED */
const REPORTED = Object.freeze({
  orphanedElements: 3,
  orphanedSearchIndex: 1,
  orphanedLinks: 3,
  orphanedVectors: 2,
  orphanedSnapshots: 1,
  orphanedMedia: 2,
});

describe("#17's integrity check reports what Storage's reports (#17 PR 1b, #35 slice 1)", () => {
  for (const nine of [false, true]) {
    it(`counts the same orphans in every store, at version ${nine ? '9, through the runner' : 8}`, async () => {
      const of = await profileHolding(merged(KEPT, ORPHANED), { nine });
      const before = await legacyEnv.dumpDatabase(of.real);
      const fromStorage = await storageSays(of);
      assert.deepEqual(fromStorage, [
        { level: 'info', message: 'Integrity check (read-only) found orphaned records:', detail: REPORTED },
      ]);
      assert.deepEqual(await adapterSays(of), fromStorage);
      assert.deepEqual(await legacyEnv.dumpDatabase(of.real), before, 'and both change nothing');
    });
  }

  it('says nothing when nothing is orphaned, and only what a store has when others are missing', async () => {
    const clean = await profileHolding(KEPT, { nine: true });
    assert.deepEqual(await storageSays(clean), []);
    assert.deepEqual(await adapterSays(clean), []);

    const partial = await profileHolding(
      merged({ canvases: KEPT.canvases, elements: KEPT.elements }, { elements: ORPHANED.elements, links: ORPHANED.links }),
      { omit: ['media', 'vectors', 'snapshots', 'search_index'] },
    );
    const fromStorage = await storageSays(partial);
    assert.deepEqual(fromStorage, [
      {
        level: 'info',
        message: 'Integrity check (read-only) found orphaned records:',
        detail: { orphanedElements: 3, orphanedLinks: 3 },
      },
    ]);
    assert.deepEqual(await adapterSays(partial), fromStorage);
  });

  it('warns and commits on a database another context deleted, as Storage does, and makes none', async () => {
    const of = await profileHolding(merged(KEPT, ORPHANED), { nine: true });
    const deleted = () => legacyEnv.requestToPromise(of.real.deleteDatabase('CanvasTabDB'));

    const env = legacyEnv.createLegacyEnv({ context: 'page', indexedDB: of.real, chrome: of.chrome });
    env.load('js/utils.js', 'js/storage.js');
    const storage = env.get('Storage');
    await storage.openExisting();
    await deleted();
    const before = env.logs.length;
    await storage.runIntegrityCheck();
    assert.deepEqual(
      env.logs.slice(before).map((/** @type {{level: string, args: unknown[]}} */ log) => [log.level, String(log.args[0])]),
      [['warn', 'Integrity check encountered an error:']],
    );

    await legacyEnv.createDatabase(of.real, { records: merged(KEPT, ORPHANED) });
    /** @type {Array<[string, string]>} */
    const said = [];
    const adapter = createIndexedDbAdapter({
      indexedDB: of.real,
      settings: of.chrome.api.storage.local,
      mode: 'existing',
      integrityLog: {
        info: message => said.push(['info', message]),
        warn: message => said.push(['warn', message]),
      },
    });
    const client = kernelClient({ adapter, surface: 'worker-internal' });
    assert.equal(await client.whenReady(), null);
    await deleted();
    const checked = await client.execute({ type: 'runIntegrityCheck', commandId: client.ids.next() });
    assert.deepEqual(checked.kind === 'committed' && checked.code, 'integrity-checked');
    assert.deepEqual(said, [['warn', 'Integrity check encountered an error:']]);
    const names = (await of.real.databases()).map((/** @type {IDBDatabaseInfo} */ db) => db.name);
    assert.ok(!names.includes('CanvasTabDB'), `the check made no notes database: ${names.join(', ')}`);
    adapter.close();
  });

  it("warns with what stopped it when a store can't be read, as Storage does, and still commits", async () => {
    // Blocks without the index both count them by
    const of = await profileHolding(merged(KEPT, ORPHANED), {
      extraStores: { elements: { keyPath: 'id', indexes: [['type', 'type']] } },
    });
    const fromStorage = await storageSays(of);
    assert.deepEqual(fromStorage, [{ level: 'warn', message: 'Integrity check encountered an error:', detail: 'NotFoundError' }]);
    assert.deepEqual(await adapterSays(of), fromStorage);
  });
});
