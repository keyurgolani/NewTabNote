// #28 slice 3, the generated fixtures (test/fixtures/storage/generate.mjs, never committed) on
// #17's production code: the maximal profile holds every store, block type, default setting,
// and backup key the production build has, and its check fails when one goes; it loads and
// dumps back as itself past the copy bounds; it migrates to 9 with a verified point that counts
// every record; its legacy export holds every note outside trash, every block and media row,
// and the folders; and that file restores through the frozen v1.4.1 importData, a complete
// backup round trip. Each corrupt profile (truncated, mistyped, dangling, oversized, duplicate
// Daily Notes) migrates with a verified point too, and its export restores in 1.4.1. Every
// expected value is derived from the generator's roles, not read back from the code under test.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';

import { exportPoint, exportablePoint } from '../../js/kernel/adapters/indexeddb/legacy-export.js';
import { listPoints, openRecovery, verifyPoint, DEFAULT_LIMITS } from '../../js/kernel/adapters/indexeddb/recovery-points.js';
import { schemaAt } from '../../js/kernel/adapters/indexeddb/registry.js';
import { dumpFixture, fillCanaries, loadFixture } from '../fixtures/storage/load-fixture.mjs';
import {
  BATCH_BYTES,
  BATCH_RECORDS,
  UNKNOWN_TYPE,
  corruptFixtures,
  maximalFixture,
  maximalProblems,
} from '../fixtures/storage/generate.mjs';
import { productionInputs } from './generated-inputs.mjs';
import { KeyRange, dump, legacyEnv, newProfile, profileWith, recordsIn, run } from './migration-support.mjs';
import { NOW } from './support.mjs';

/** @typedef {import('./migration-support.mjs').Profile} Profile */

const crypto = /** @type {any} */ (webcrypto);
const RELEASE = 'test/fixtures/storage/releases/v1.4.1/js';
const INPUTS = await productionInputs();
const MAXIMAL = maximalFixture(INPUTS);
const CORRUPT = corruptFixtures(INPUTS);

/**
 * The values of `store` in a generated fixture
 * @param {any} fixture
 * @param {string} store
 * @returns {any[]}
 */
const valuesOf = (fixture, store) => recordsIn(fixture, 'CanvasTabDB', store).map(record => record.value);

/** @param {any[]} rows */
const idsOf = rows => rows.map(row => row.id).sort();

/**
 * `fixture` migrated, and its point's export as a file carries it
 * @param {any} fixture
 */
async function migratedAndExported(fixture) {
  const of = await profileWith(fixture);
  const outcome = await run(of);
  assert.equal(outcome.status, 'migrated', JSON.stringify(outcome));
  const pointId = /** @type {string} */ (await exportablePoint({ indexedDB: of.real }));
  assert.equal(pointId, `pre-migration-${NOW}`);
  const file = JSON.parse(
    JSON.stringify(
      await exportPoint({ indexedDB: of.real, keyRange: KeyRange, crypto, clock: { now: () => NOW }, pointId }),
    ),
  );
  return { of, pointId, file };
}

/**
 * The point `pointId` of `of`, read back and verified again
 * @param {Profile} of
 * @param {string} pointId
 */
async function verifiedPoint(of, pointId) {
  const recovery = /** @type {IDBDatabase} */ (await openRecovery(of.real, { create: false }));
  try {
    const point = /** @type {any} */ ((await listPoints(recovery)).find(candidate => candidate.id === pointId));
    const verdict = await verifyPoint({ recovery, point, io: { keyRange: KeyRange, crypto, limits: DEFAULT_LIMITS } });
    return { point, verdict };
  } finally {
    recovery.close();
  }
}

/**
 * The export file through the frozen v1.4.1 Storage.importData, on a fresh 1.4.1 profile
 * @param {any} file
 */
async function restoredIn141(file) {
  const env = legacyEnv.createLegacyEnv();
  await legacyEnv.createDatabase(env.indexedDB, {});
  env.load(`${RELEASE}/utils.js`, `${RELEASE}/storage.js`);
  const Storage = env.get('Storage');
  await legacyEnv.runUntil(env, Storage.init());
  const settled = await legacyEnv.runUntil(
    env,
    Promise.resolve()
      .then(() => Storage.importData(file, 'merge'))
      .then(
        (/** @type {any} */ result) => ({ result }),
        (/** @type {any} */ error) => ({ error }),
      ),
  );
  if (settled.error) throw new Error(`1.4.1 refused the file: ${settled.error.code} ${settled.error.message}`);
  const stored = await legacyEnv.dumpDatabase(env.indexedDB);
  return { result: JSON.parse(JSON.stringify(settled.result)), stored };
}

/**
 * The export a point of `fixture` makes, derived from the fixture: notes in trash apart, the
 * other notes' blocks, every other block an orphan
 * @param {any} fixture
 */
function expectedExport(fixture) {
  const notes = valuesOf(fixture, 'canvases');
  const kept = notes.filter(note => !note.trashed);
  const keptIds = new Set(kept.map(note => note.id));
  const blocks = valuesOf(fixture, 'elements');
  return {
    canvases: idsOf(kept),
    trashedCanvases: idsOf(notes.filter(note => note.trashed)),
    elements: idsOf(blocks.filter(block => keptIds.has(block.canvasId))),
    orphanElements: idsOf(blocks.filter(block => !keptIds.has(block.canvasId))),
    media: idsOf(valuesOf(fixture, 'media')),
    folders: idsOf(valuesOf(fixture, 'folders')),
    // What 1.4.1's import takes from that file: media whose note is in it
    restoredMedia: valuesOf(fixture, 'media').filter(row => keptIds.has(row.canvasId)).length,
  };
}

describe('the maximal profile', () => {
  const { fixture, roles } = MAXIMAL;

  it('holds every store, block type, default setting, and backup key the production build has', () => {
    assert.deepStrictEqual(maximalProblems(fixture, INPUTS), []);
    // Spelled out, so a generator that drifts with its check still fails
    assert.equal(INPUTS.blockTypes.length >= 18, true);
    assert.ok(Object.keys(INPUTS.defaultSettings).includes('setting_llmApiKey'));
    assert.ok(valuesOf(fixture, 'elements').some(block => block.type === UNKNOWN_TYPE));
  });

  it('the check fails on a missing store, key, block type, or default setting', () => {
    /** @param {(copy: any) => void} change */
    const without = change => {
      const copy = structuredClone(fixture);
      change(copy);
      return maximalProblems(copy, INPUTS);
    };
    const store = (/** @type {any} */ copy, /** @type {string} */ name) =>
      copy.databases[0].stores.find((/** @type {any} */ s) => s.name === name);
    assert.deepStrictEqual(
      without(copy => {
        store(copy, 'themes').records = [];
      }),
      ['store themes holds nothing'],
    );
    assert.deepStrictEqual(
      without(copy => {
        const elements = store(copy, 'elements');
        elements.records = elements.records.filter((/** @type {any} */ r) => r.value.type !== 'table');
      }),
      ['no table block'],
    );
    assert.deepStrictEqual(
      without(copy => {
        delete copy.chromeStorageLocal.setting_trashRetention;
      }),
      ['no setting_trashRetention'],
    );
    assert.deepStrictEqual(
      without(copy => {
        for (const key of Object.keys(copy.chromeStorageLocal)) {
          if (key.startsWith('recovery_backup_')) delete copy.chromeStorageLocal[key];
        }
      }),
      ['no recovery_backup_* key'],
    );
    assert.deepStrictEqual(
      maximalProblems(fixture, { ...INPUTS, blockTypes: [...INPUTS.blockTypes, 'kanban'] }),
      ['no kanban block'],
    );
    assert.deepStrictEqual(
      maximalProblems(fixture, { ...INPUTS, defaultSettings: { ...INPUTS.defaultSettings, setting_newOne: 1 } }),
      ['no setting_newOne'],
    );
  });

  it('goes past the copy bounds: more blocks than a batch, and one block over a batch of bytes', () => {
    const blocks = valuesOf(fixture, 'elements');
    assert.ok(blocks.length > BATCH_RECORDS);
    assert.ok(blocks.some(block => JSON.stringify(block).length > BATCH_BYTES));
  });

  it('loads and dumps back as itself', async () => {
    const of = newProfile();
    await loadFixture(fixture, { factory: of.real, storage: of.chrome.api.storage.local });
    assert.deepStrictEqual(
      await dumpFixture({ factory: of.real, storage: of.chrome.api.storage.local, header: fixture.header }),
      fillCanaries(fixture),
    );
  });

  it('migrates to 9 with every store, and a verified point that counts every record but the settings store', async () => {
    const { of, pointId } = await migratedAndExported(fixture);
    const after = await dump(of);
    const db = /** @type {any} */ (after.databases.find(candidate => candidate.name === 'CanvasTabDB'));
    assert.equal(db.version, 9);
    assert.deepStrictEqual(db.stores.map((/** @type {any} */ s) => s.name), Object.keys(/** @type {object} */ (schemaAt(9))).sort());
    // The ten legacy stores keep every record as it was
    for (const store of fixture.databases[0].stores) {
      assert.deepStrictEqual(recordsIn(after, 'CanvasTabDB', store.name), fillCanaries(store.records), store.name);
    }
    const { point, verdict } = await verifiedPoint(of, pointId);
    assert.equal(verdict.ok, true, JSON.stringify(verdict));
    assert.equal(point.status, 'verified');
    const counts = Object.fromEntries(Object.entries(point.manifest).map(([name, entry]) => [name, /** @type {any} */ (entry).count]));
    assert.deepStrictEqual(
      counts,
      Object.fromEntries(
        fixture.databases[0].stores
          .filter((/** @type {any} */ s) => s.name !== 'settings')
          .map((/** @type {any} */ s) => [s.name, s.records.length]),
      ),
    );
    // The AI key's canary stays out of the point: chrome.storage.local isn't copied
    assert.doesNotMatch(JSON.stringify(recordsIn(after, 'NewTabNoteRecovery', 'rows')), /canary-llm-api-key/);
  });

  it('its export holds every note outside trash, their blocks, every other block as an orphan, media, and folders', async () => {
    const { file } = await migratedAndExported(fixture);
    const want = expectedExport(fixture);
    assert.deepStrictEqual(idsOf(file.canvases), want.canvases);
    assert.deepStrictEqual(idsOf(file.trashedCanvases), [roles.trashed]);
    assert.deepStrictEqual(idsOf(file.elements), want.elements);
    assert.deepStrictEqual(idsOf(file.orphanElements), want.orphanElements);
    assert.deepStrictEqual(idsOf(file.media), want.media);
    assert.deepStrictEqual(idsOf(file.folders), want.folders);
    // Every block type, as production's Block serialized it, with each field intact
    const blocks = new Map(valuesOf(fixture, 'elements').map(block => [block.id, block]));
    for (const block of file.elements) assert.deepStrictEqual(block, blocks.get(block.id), block.id);
    for (const type of INPUTS.blockTypes) assert.ok(file.elements.some((/** @type {any} */ b) => b.type === type), type);
    // Media Blobs become data URLs of the same bytes
    const media = new Map(valuesOf(fixture, 'media').map(row => [row.id, row]));
    for (const row of file.media) {
      const source = media.get(row.id);
      assert.equal(row.blob, `data:${source.blob.mime};base64,${source.blob.base64}`, row.id);
    }
  });

  it('its export restores through the frozen v1.4.1 importData: every note, block, folder, and media row of a note in it', async () => {
    const { file } = await migratedAndExported(fixture);
    const want = expectedExport(fixture);
    const { result, stored } = await restoredIn141(file);
    assert.deepStrictEqual(
      [result.notes, result.blocks, result.folders, result.media, result.skippedMedia],
      [want.canvases.length, want.elements.length, want.folders.length, want.restoredMedia, want.media.length - want.restoredMedia],
    );
    // Under new IDs, so compared by name and content
    const names = (/** @type {any[]} */ notes) => notes.map(note => note.name).sort();
    assert.deepStrictEqual(names(Object.values(legacyEnv.recordsOf(stored, 'canvases'))), names(file.canvases));
    const contents = (/** @type {any[]} */ blocks) => blocks.map(block => JSON.stringify([block.type, block.content])).sort();
    assert.deepStrictEqual(contents(Object.values(legacyEnv.recordsOf(stored, 'elements'))), contents(file.elements));
  });
});

describe('the corrupt profiles', () => {
  it('are the five kinds: truncated, mistyped, dangling, oversized, and duplicate Daily Notes', () => {
    assert.deepStrictEqual([...CORRUPT.keys()], ['truncated', 'mistyped', 'dangling', 'oversized', 'daily-duplicates']);
  });

  for (const [id, { fixture }] of CORRUPT) {
    it(`${id}: migrates to 9 with a verified point of every record, and leaves the records as they were`, async () => {
      const { of, pointId } = await migratedAndExported(fixture);
      const after = await dump(of);
      for (const store of fixture.databases[0].stores) {
        assert.deepStrictEqual(recordsIn(after, 'CanvasTabDB', store.name), store.records, store.name);
      }
      const { point, verdict } = await verifiedPoint(of, pointId);
      assert.equal(verdict.ok, true, JSON.stringify(verdict));
      for (const store of fixture.databases[0].stores) {
        if (store.name === 'settings') continue;
        assert.equal(point.manifest[store.name].count, store.records.length, store.name);
      }
    });

    it(`${id}: its export holds every note, block, and media row, and restores through the frozen v1.4.1 importData`, async () => {
      const { file } = await migratedAndExported(fixture);
      const want = expectedExport(fixture);
      assert.deepStrictEqual(idsOf(file.canvases), want.canvases);
      assert.deepStrictEqual(idsOf(file.trashedCanvases), want.trashedCanvases);
      assert.deepStrictEqual(idsOf(file.elements), want.elements);
      assert.deepStrictEqual(idsOf(file.orphanElements), want.orphanElements);
      assert.deepStrictEqual(idsOf(file.media), want.media);
      const { result } = await restoredIn141(file);
      assert.deepStrictEqual(
        [result.notes, result.blocks, result.media],
        [want.canvases.length, want.elements.length, want.restoredMedia],
      );
    });
  }
});
