// #17 PR 4a: the storage guard's raw export, moved from js/storage.js's exportRawStores to
// adapters/indexeddb/raw-export.js, which the new tab's Recovery now calls. It writes the file
// Storage's wrote, for each database the guard shows its screen for, and every other one, and
// changes nothing.

import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { exportRawStores } from '../../js/kernel/adapters/indexeddb/raw-export.js';
import { DB_VERSION } from '../../js/kernel/adapters/indexeddb/schema.js';
import { closeAll, legacyEnv, profile } from './storage-fixture.mjs';

/** @typedef {import('./storage-fixture.mjs').Profile} Profile */

/** @type {Profile[]} */
const profiles = [];
after(() => profiles.forEach(closeAll));

const SECRET = 'sk-raw-export-canary';
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
const { note, block } = legacyEnv;

/** Notes, a block, an image, a folder, and the AI key 1.1.2 kept in `settings` */
const RECORDS = () => ({
  canvases: [note('A', { name: 'Alpha' }), note('B', { name: 'Beta', trashed: true, trashedAt: 5 })],
  elements: [block('a1', 'A', 0, 'alpha one')],
  media: [{ id: 'm1', canvasId: 'A', blob: new Blob([PNG], { type: 'image/png' }), type: 'image/png', createdAt: 1 }],
  folders: [{ id: 'F1', name: 'Work', parentId: null }],
  settings: [{ key: 'llmApiKey', value: SECRET }],
});

/** RECORDS but the blocks, for a database without its `elements` store */
const withoutBlocks = () => {
  const { elements, ...rest } = RECORDS();
  return rest;
};

/**
 * A profile whose CanvasTabDB createDatabase makes from `spec`
 * @param {object} spec
 * @returns {Promise<Profile>}
 */
async function made(spec) {
  const of = profile();
  profiles.push(of);
  await legacyEnv.createDatabase(of.real, spec);
  return of;
}

/**
 * js/storage.js's raw export of `of`'s database, as the guard's page made it before #17 PR 4a
 * @param {Profile} of
 */
async function storageExport(of) {
  const env = legacyEnv.createLegacyEnv({ context: 'page', indexedDB: of.real, chrome: of.chrome, worker: false });
  env.load('js/utils.js', 'js/storage.js');
  return legacyEnv.plain(await env.get('Storage').exportRawStores());
}

const at = { now: () => 1_760_000_000_000 };

describe("the storage guard's raw export on #17's side (#17 PR 4a)", () => {
  for (const [label, spec] of /** @type {Array<[string, object]>} */ ([
    ['a complete version-8 database', { records: RECORDS() }],
    [
      'a version-8 database without its blocks, whose guard says it is incomplete',
      { omit: ['elements'], records: withoutBlocks() },
    ],
    [
      "a database a newer build upgraded, past this build's version, with a store its schema has",
      {
        version: DB_VERSION + 1,
        extraStores: { meta: { keyPath: null, indexes: [] } },
        records: { ...RECORDS(), meta: [{ key: 'schemaVersion', value: DB_VERSION + 1 }] },
      },
    ],
  ])) {
    it(`writes what Storage's wrote, for ${label}, and never the settings store`, async () => {
      const of = await made(spec);
      const before = await legacyEnv.dumpDatabase(of.real);
      const raw = await exportRawStores({ indexedDB: of.faults.factory, clock: at });
      assert.deepEqual({ ...raw, exportedAt: 0 }, { ...(await storageExport(of)), exportedAt: 0 });
      assert.deepEqual([raw.rawExport, raw.exportedAt, raw.onDiskVersion], [true, at.now(), before.version]);
      assert.equal('settings' in raw.stores, false);
      assert.ok(!JSON.stringify(raw).includes(SECRET), 'the AI key 1.1.2 kept stays out');
      // The image as a data URL
      const [media] = /** @type {Array<{blob: string}>} */ (raw.stores.media);
      assert.equal(media.blob, `data:image/png;base64,${PNG.toString('base64')}`);
      // It changed nothing
      assert.deepEqual(await legacyEnv.dumpDatabase(of.real), before);
    });
  }

  it('keeps the keys of a store without a key path, as Storage did', async () => {
    const of = await made({
      version: DB_VERSION + 1,
      extraStores: { meta: { keyPath: null, indexes: [] } },
      records: { ...RECORDS(), meta: [{ key: 'schemaVersion', value: 9 }] },
    });
    const raw = await exportRawStores({ indexedDB: of.faults.factory, clock: at });
    assert.deepEqual(raw.stores.meta, [{ key: 'schemaVersion', value: 9 }]);
  });

  it("rejects in Storage's words on a profile with no database, and makes none", async () => {
    const of = profile();
    profiles.push(of);
    await assert.rejects(exportRawStores({ indexedDB: of.faults.factory, clock: at }), {
      message: "couldn't open the notes database",
    });
    assert.deepEqual(await of.real.databases(), []);
  });
});
