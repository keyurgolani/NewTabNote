// #17 PR 1a, the 1.4.1-shaped export of a pre-migration point (legacy-export.js): the file
// loads through the frozen v1.4.1 Storage.importData (test/fixtures/storage/releases/v1.4.1/)
// in legacy-env, with folders, archived and template flags, and images intact, from a profile
// with an orphan block; nothing the point holds is left out of the file; and a point that
// doesn't verify is never exported.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';

import { exportPoint, exportablePoint } from '../../js/kernel/adapters/indexeddb/legacy-export.js';
import { ROWS_STORE, committed, openRecovery } from '../../js/kernel/adapters/indexeddb/recovery-points.js';
import {
  KeyRange,
  deleteAndPurge,
  legacyEnv,
  profileWith,
  run,
  synthesized,
  writeHistory,
} from './migration-support.mjs';
import { NOW } from './support.mjs';

/** @typedef {import('./migration-support.mjs').Profile} Profile */

const crypto = /** @type {any} */ (webcrypto);
const FIXTURES = synthesized();
const RELEASE = 'test/fixtures/storage/releases/v1.4.1/js';

/**
 * A profile from `id`, migrated, and its point's export as a file would carry it
 * @param {string} id
 */
async function exported(id) {
  const fixture = /** @type {any} */ (FIXTURES.get(id));
  const of = await profileWith(fixture);
  assert.equal((await run(of)).status, 'migrated');
  const pointId = await exportablePoint({ indexedDB: of.real });
  assert.equal(pointId, `pre-migration-${NOW}`);
  const data = await exportPoint({
    indexedDB: of.real,
    keyRange: KeyRange,
    crypto,
    clock: { now: () => NOW },
    pointId: /** @type {string} */ (pointId),
  });
  return { of, fixture, file: JSON.parse(JSON.stringify(data)) };
}

/**
 * The v1.4.1 Storage on a fresh 1.4.1 profile, as a user who reinstalled 1.4.1 has it
 * @returns {Promise<{env: any, Storage: any}>}
 */
async function release141() {
  const env = legacyEnv.createLegacyEnv();
  await legacyEnv.createDatabase(env.indexedDB, {});
  env.load(`${RELEASE}/utils.js`, `${RELEASE}/storage.js`);
  const Storage = env.get('Storage');
  await Storage.init();
  return { env, Storage };
}

/**
 * The fixture's records of `store`, as values
 * @param {any} fixture
 * @param {string} store
 * @returns {any[]}
 */
const valuesOf = (fixture, store) =>
  (fixture.databases[0].stores.find((/** @type {any} */ s) => s.name === store) || { records: [] }).records.map(
    (/** @type {any} */ r) => r.value,
  );

describe('a pre-migration point exported for 1.4.1', () => {
  it('imports through the frozen v1.4.1 importData with folders, flags, and images intact, past one orphan block', async () => {
    const { file, fixture } = await exported('v8.orphans');
    assert.deepStrictEqual(Object.keys(file).sort(), [
      'canvases',
      'elements',
      'exportedAt',
      'folders',
      'media',
      'orphanElements',
      'trashedCanvases',
      'version',
    ]);
    assert.equal(file.version, 1);
    assert.equal(file.exportedAt, NOW);

    const { env, Storage } = await release141();
    const check = Storage.validateImport(file);
    assert.equal(check.ok, true, check.reason);
    const result = await Storage.importData(file, 'merge');
    assert.equal(result.notes, file.canvases.length);
    assert.equal(result.blocks, file.elements.length);

    const dumped = await legacyEnv.dumpDatabase(env.indexedDB);
    const notes = Object.values(legacyEnv.recordsOf(dumped, 'canvases'));
    const byName = (/** @type {string} */ name) =>
      /** @type {any} */ (notes.find((/** @type {any} */ n) => n.name === name));
    // Every note 1.4.1's own export would hold: outside trash, archived and templates included
    const source = valuesOf(fixture, 'canvases');
    assert.deepStrictEqual(
      notes.map((/** @type {any} */ n) => n.name).sort(),
      source
        .filter(n => !n.trashed)
        .map(n => n.name)
        .sort(),
    );
    assert.equal(byName('Old plans').archived, true);
    assert.equal(byName('Meeting template').isTemplate, true);
    // The folder came along, and the note filed in it still is
    const folders = Object.values(legacyEnv.recordsOf(dumped, 'folders'));
    assert.deepStrictEqual(
      folders.map((/** @type {any} */ f) => f.name),
      ['Home'],
    );
    assert.equal(byName('Groceries').folderId, /** @type {any} */ (folders[0]).id);
    // The image, byte for byte, on its note
    const media = Object.values(legacyEnv.recordsOf(dumped, 'media'));
    assert.equal(media.length, 1);
    const sourceMedia = valuesOf(fixture, 'media').find(m => m.canvasId !== 'note-gone');
    assert.deepStrictEqual(/** @type {any} */ (media[0]).blob, { __blob: sourceMedia.blob.base64, type: 'image/png' });
    assert.equal(/** @type {any} */ (media[0]).canvasId, byName('Groceries').id);
    // The orphan block stays out of 1.4.1 and in the file
    const blocks = Object.values(legacyEnv.recordsOf(dumped, 'elements'));
    assert.equal(
      blocks.some((/** @type {any} */ b) => b.content === 'Left behind'),
      false,
    );
    assert.ok(file.orphanElements.some((/** @type {any} */ b) => b.content === 'Left behind'));
    assert.equal(result.skippedMedia, 1);
  });

  it("still exports the pinned point, as it was, once #17's adapter has kept history at 10 (#17 PR 2a)", async () => {
    const fixture = /** @type {any} */ (FIXTURES.get('v8.basic'));
    const of = await profileWith(fixture);
    assert.equal((await run(of)).status, 'migrated');
    assert.ok((await writeHistory(of)).includes('conflict'));
    const pointId = await exportablePoint({ indexedDB: of.real });
    assert.equal(pointId, `pre-migration-${NOW}`);
    const file = JSON.parse(
      JSON.stringify(
        await exportPoint({
          indexedDB: of.real,
          keyRange: KeyRange,
          crypto,
          clock: { now: () => NOW },
          pointId: /** @type {string} */ (pointId),
        }),
      ),
    );
    // The point holds the profile as it was before the upgrade, so nothing written since is in it
    const ids = (/** @type {any[]} */ rows) => rows.map(row => row.id).sort();
    assert.deepStrictEqual(ids([...file.canvases, ...file.trashedCanvases]), ids(valuesOf(fixture, 'canvases')));
    const { Storage } = await release141();
    assert.equal(Storage.validateImport(file).ok, true);
    const result = await Storage.importData(file, 'merge');
    assert.equal(result.notes, file.canvases.length);
  });

  it('once a note and a folder are deleted for good and purged, exports the point without them, and 1.4.1 imports it (#17 PR 2b)', async () => {
    const fixture = /** @type {any} */ (FIXTURES.get('v8.basic'));
    const of = await profileWith(fixture);
    assert.equal((await run(of)).status, 'migrated');
    const { noteId, folderId, purged } = await deleteAndPurge(of);
    assert.equal(purged.status, 'purged');
    const pointId = /** @type {string} */ (await exportablePoint({ indexedDB: of.real }));
    const file = JSON.parse(
      JSON.stringify(
        await exportPoint({
          indexedDB: of.real,
          keyRange: KeyRange,
          crypto,
          clock: { now: () => NOW },
          pointId,
          locks: legacyEnv.createLockManager(),
        }),
      ),
    );
    const ids = (/** @type {any[]} */ rows) => rows.map(row => row.id).sort();
    assert.deepStrictEqual(
      ids([...file.canvases, ...file.trashedCanvases]),
      ids(valuesOf(fixture, 'canvases')).filter(id => id !== noteId),
    );
    assert.deepStrictEqual(
      ids([...file.elements, ...file.orphanElements]),
      ids(valuesOf(fixture, 'elements').filter(block => block.canvasId !== noteId)),
    );
    assert.deepStrictEqual(
      ids(file.folders),
      ids(valuesOf(fixture, 'folders')).filter(id => id !== folderId),
    );
    assert.equal(
      file.media.some((/** @type {any} */ media) => media.canvasId === noteId),
      false,
    );
    const { Storage } = await release141();
    assert.equal(Storage.validateImport(file).ok, true);
    const result = await Storage.importData(file, 'merge');
    assert.equal(result.notes, file.canvases.length);
  });

  it('leaves nothing the point holds out of the file', async () => {
    const { file, fixture } = await exported('v8.basic');
    const ids = (/** @type {any[]} */ rows) => rows.map(r => r.id).sort();
    assert.deepStrictEqual(ids([...file.canvases, ...file.trashedCanvases]), ids(valuesOf(fixture, 'canvases')));
    assert.deepStrictEqual(ids([...file.elements, ...file.orphanElements]), ids(valuesOf(fixture, 'elements')));
    assert.deepStrictEqual(ids(file.media), ids(valuesOf(fixture, 'media')));
    assert.deepStrictEqual(ids(file.folders), ids(valuesOf(fixture, 'folders')));
    assert.ok(file.trashedCanvases.every((/** @type {any} */ n) => n.trashed));
    // Blobs as data URLs, so the file is plain JSON
    assert.match(file.media[0].blob, /^data:image\/png;base64,/);
  });

  it('keeps inline images and files as the data URLs blocks hold, and imports them', async () => {
    const { file } = await exported('v8.data-urls');
    const { env, Storage } = await release141();
    await Storage.importData(file, 'merge');
    const blocks = Object.values(legacyEnv.recordsOf(await legacyEnv.dumpDatabase(env.indexedDB), 'elements'));
    assert.ok(
      blocks.some((/** @type {any} */ b) => b.type === 'image' && b.imageUrl.startsWith('data:image/png;base64,')),
    );
    assert.ok(
      blocks.some(
        (/** @type {any} */ b) =>
          b.type === 'file' && b.fileData === `data:text/plain;base64,${Buffer.from('hello').toString('base64')}`,
      ),
    );
  });

  it('a v2 profile (v1.0.0 to v1.1.2) exports and imports too, its IndexedDB settings left out', async () => {
    const { file } = await exported('v2-idb-settings.idb-settings-secret');
    assert.equal(JSON.stringify(file).includes('canary-llm-api-key'), false);
    assert.deepStrictEqual(file.folders, []);
    const { Storage } = await release141();
    assert.equal(Storage.validateImport(file).ok, true);
    await Storage.importData(file, 'merge');
  });

  it('refuses a point that no longer verifies, and a profile with no point', async () => {
    const { of } = await exported('v8.basic');
    const pointId = `pre-migration-${NOW}`;
    const recovery = /** @type {IDBDatabase} */ (await openRecovery(of.real, { create: false }));
    const tx = recovery.transaction(ROWS_STORE, 'readwrite');
    const done = committed(tx);
    const store = tx.objectStore(ROWS_STORE);
    const request = store.getAll(KeyRange.bound([pointId, 'canvases'], [pointId, 'canvases\u0000'], false, true), 1);
    request.onsuccess = () => {
      const [row] = request.result;
      store.put({ ...row, value: { ...row.value, name: 'damaged' } });
    };
    await done;
    recovery.close();
    const options = { indexedDB: of.real, keyRange: KeyRange, crypto, clock: { now: () => NOW }, pointId };
    await assert.rejects(exportPoint(options), { code: 'recovery-point-unverified' });

    const empty = await profileWith(/** @type {any} */ (FIXTURES.get('none.basic')));
    await run(empty);
    assert.equal(await exportablePoint({ indexedDB: empty.real }), null);
    await assert.rejects(exportPoint({ ...options, indexedDB: empty.real }), { code: 'no-recovery-point' });
  });
});
