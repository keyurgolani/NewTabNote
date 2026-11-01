// The read-only integrity check on #17's adapter (js/kernel/adapters/indexeddb/integrity.js),
// held to frozen 1.4.1's, which its Storage.init ran at the end of each start: its
// validateDatabase, and the line it printed of what that found or of what stopped it. Since
// #17 PR 4a no test calls this build's Storage.validateDatabase, as none calls the other paths
// 4a ported, since 4b makes js/storage.js a facade. On the same database, the two report the
// same, word for word, by store, at version 8 and at this build's version through the runner,
// with stores missing, with nothing to report, and when a store can't be read. Both only
// report: nothing in the database changes.

import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { createIndexedDbAdapter } from '../../js/kernel/adapters/indexeddb/adapter.js';
import { WORKER_HANDLERS } from '../../js/kernel/core/application/handlers-worker.js';
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

/** Frozen 1.4.1's Storage, and the Utils it ran on, from the release fixtures */
const RELEASE_UTILS = 'test/fixtures/storage/releases/v1.4.1/js/utils.js';
const RELEASE_STORAGE = 'test/fixtures/storage/releases/v1.4.1/js/storage.js';

/**
 * The end of frozen 1.4.1's Storage.init, its read-only integrity check, as it reads: its
 * validateDatabase, and the line it printed of what that found or of what stopped it. Its init
 * opens at 8 only, so the tests open the connection and run this part of it, which a database
 * the runner took to this build's version can run too.
 */
const RELEASE_CHECK = (() => {
  const source = readFileSync(new URL(`../../${RELEASE_STORAGE}`, import.meta.url), 'utf8');
  const start = source.indexOf('    // Read-only integrity check: reports orphans, deletes nothing\n');
  const end = source.indexOf('\n  }\n', start);
  assert.ok(start > 0 && end > start, "1.4.1's init ends with its integrity check");
  return source.slice(start, end);
})();

/**
 * What frozen 1.4.1's startup integrity check says on `of`'s database, on a connection a page
 * opened to it as it is
 * @param {Profile} of
 * @param {{before?: (db: IDBDatabase) => Promise<void>}} [options] - runs on that connection
 *   first
 * @returns {Promise<Said[]>}
 */
async function storageSays(of, { before } = {}) {
  const env = legacyEnv.createLegacyEnv({ context: 'page', indexedDB: of.real, chrome: of.chrome, worker: false });
  env.load(RELEASE_UTILS, RELEASE_STORAGE);
  const storage = env.get('Storage');
  /** @type {IDBDatabase} */
  const db = await legacyEnv.requestToPromise(of.real.open('CanvasTabDB'));
  storage.db = db;
  try {
    if (before) await before(db);
    const logged = env.logs.length;
    await env.get(`(async function () {\n${RELEASE_CHECK}\n})`).call(storage);
    return env.logs.slice(logged).map((/** @type {{level: string, args: unknown[]}} */ log) => ({
      level: log.level,
      message: String(log.args[0]),
      detail: log.level === 'warn' ? nameOf(log.args[1]) : legacyEnv.plain(log.args[1]),
    }));
  } finally {
    db.close();
  }
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
  const client = kernelClient({ adapter, surface: 'worker-internal', handlers: WORKER_HANDLERS });
  const checked = await client.execute({ type: 'runIntegrityCheck', commandId: client.ids.next() });
  assert.deepEqual(checked.kind === 'committed' && [checked.code, checked.changedIds], ['integrity-checked', []]);
  adapter.close();
  return said;
}

/** @param {unknown} error */
const nameOf = error => (error && typeof error === 'object' && 'name' in error ? String(error.name) : String(error));

/**
 * A profile whose database holds `records`, at version 8, or at this build's version through
 * the runner
 * @param {Record<string, unknown[]>} records
 * @param {{migrated?: boolean, omit?: string[], extraStores?: Record<string, unknown>}} [options]
 * @returns {Promise<Profile>}
 */
async function profileHolding(records, { migrated = false, omit = [], extraStores = {} } = {}) {
  const of = newProfile();
  await legacyEnv.createDatabase(of.real, { records, omit, extraStores });
  if (migrated) assert.equal((await run(of)).status, 'migrated');
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

describe("#17's integrity check reports what frozen 1.4.1's reports (#17 PR 1b, #35 slice 1)", () => {
  for (const migrated of [false, true]) {
    it(`counts the same orphans in every store, at ${migrated ? "this build's version, through the runner" : 'version 8'}`, async () => {
      const of = await profileHolding(merged(KEPT, ORPHANED), { migrated });
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
    const clean = await profileHolding(KEPT, { migrated: true });
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

  it('warns and commits on a database another context deleted, as 1.4.1 does on a closed connection, and makes none', async () => {
    const of = await profileHolding(merged(KEPT, ORPHANED), { migrated: true });
    const deleted = () => legacyEnv.requestToPromise(of.real.deleteDatabase('CanvasTabDB'));

    // 1.4.1's page never closed its connection on versionchange, so a delete waited for it: its
    // check met the database gone only on a connection that had closed
    const fromStorage = await storageSays(of, {
      before: async db => {
        db.close();
        await deleted();
      },
    });
    assert.deepEqual(
      fromStorage.map(({ level, message }) => [level, message]),
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
    const client = kernelClient({ adapter, surface: 'worker-internal', handlers: WORKER_HANDLERS });
    assert.equal(await client.whenReady(), null);
    await deleted();
    const checked = await client.execute({ type: 'runIntegrityCheck', commandId: client.ids.next() });
    assert.deepEqual(checked.kind === 'committed' && checked.code, 'integrity-checked');
    assert.deepEqual(said, [['warn', 'Integrity check encountered an error:']]);
    const names = (await of.real.databases()).map((/** @type {IDBDatabaseInfo} */ db) => db.name);
    assert.ok(!names.includes('CanvasTabDB'), `the check made no notes database: ${names.join(', ')}`);
    adapter.close();
  });

  it("warns with what stopped it when a store can't be read, as 1.4.1 does, and still commits", async () => {
    // Blocks without the index both count them by
    const of = await profileHolding(merged(KEPT, ORPHANED), {
      extraStores: { elements: { keyPath: 'id', indexes: [['type', 'type']] } },
    });
    const fromStorage = await storageSays(of);
    assert.deepEqual(fromStorage, [{ level: 'warn', message: 'Integrity check encountered an error:', detail: 'NotFoundError' }]);
    assert.deepEqual(await adapterSays(of), fromStorage);
  });
});
