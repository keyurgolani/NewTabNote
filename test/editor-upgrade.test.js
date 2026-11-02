'use strict';

// #14 slice 3, the upgrade from every 1.4.x profile, through the editor: each version-8
// fixture a release could leave that the upgrade migrates (the synthesized ones, and the
// recorded v1.3.0, v1.4.0 and v1.4.0.blocks) goes through the shipped worker's run and
// transforms, and then each of its notes opens in the editor and is saved untouched. Every
// field a block held is then as the upgrade left it, apart from the order a save gives it, and
// each block decode reads as known is at schemaVersion 1. A save adds to a known block only
// fields Block.serialize writes for its type, which a block another writer made (the
// onboarding note, a capture) can lack or hold as undefined, as 1.4.x's save added them. A
// block in a safe state, which v8.opaque-blocks holds one of each kind of, is as the upgrade
// left it, order included there, and so is every block of no note.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  createLegacyEnv, dumpDatabase, recordsOf, plain, startEditorClient, makeEditor, runUntil,
} = require('./helpers/legacy-env');
const { startWorker } = require('./helpers/load-background');

const FILES = ['js/utils.js', 'js/core/storage-error.js', 'js/storage.js', 'js/sidebar-utils.js', 'js/blocks.js', 'js/editor.js'];
const STORAGE = path.join(__dirname, 'fixtures', 'storage');
const OPTIONS = { timeout: 120_000 };

/** The version-8 fixtures in `dir`, by file */
const v8In = dir => fs.readdirSync(path.join(STORAGE, dir))
  .filter(file => file.startsWith('v8.') && file.endsWith('.json'))
  .sort()
  .map(file => JSON.parse(fs.readFileSync(path.join(STORAGE, dir, file), 'utf8')));

/**
 * Every version-8 fixture the upgrade migrates: all but one with no elements store, which no
 * step can supply, and one with a store no release made, both of which it leaves as they are
 */
const FIXTURES = [...v8In('synthesized'), ...v8In('recorded')]
  .filter(fixture => !fixture.header.degraded.some(part => part === 'missing-store:elements' || part.startsWith('extra-store:')));

/** `record` without the fields `names` */
const without = (record, ...names) => Object.fromEntries(Object.entries(record).filter(([name]) => !names.includes(name)));

/** A profile holding `fixture`, upgraded by the shipped worker: its run, its transforms and its purge */
async function upgraded(fixture) {
  const load = await import('./fixtures/storage/load-fixture.mjs');
  const worker = createLegacyEnv({ context: 'worker' });
  await load.loadFixture(fixture, { factory: worker.indexedDB, storage: worker.chrome.api.storage.local });
  await startWorker(worker);
  assert.equal((await worker.global.storageUpgrade).status, 'migrated', fixture.header.id);
  // The worker journals the upgrade after it (#20): that write lands before the page opens
  for (let round = 0; round < 10_000 && process.getActiveResourcesInfo().includes('Immediate'); round++) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.equal((await worker.global.storageTransforms).status, 'transformed', fixture.header.id);
  await worker.global.storagePurge;
  return worker;
}

describe('the upgrade from every 1.4.x profile keeps every block through the editor (#14 slice 3)', () => {
  it('holds each version-8 fixture the upgrade migrates, the one of blocks this build reads in a safe state among them', () => {
    const ids = FIXTURES.map(fixture => fixture.header.id);
    for (const id of ['v8.basic', 'v8.opaque-blocks', 'v8.block-types', 'v8.v1.3.0', 'v8.v1.4.0', 'v8.v1.4.0.blocks']) assert.ok(ids.includes(id), id);
  });

  for (const fixture of FIXTURES) {
    const { id } = fixture.header;
    it(`${id}: each note opened and saved untouched keeps its blocks, at schemaVersion 1 where decode reads them as known`, OPTIONS, async () => {
      const worker = await upgraded(fixture);
      const before = plain(recordsOf(await dumpDatabase(worker.indexedDB), 'elements'));
      const notes = Object.keys(recordsOf(await dumpDatabase(worker.indexedDB), 'canvases'));

      const page = createLegacyEnv({ indexedDB: worker.indexedDB, chrome: worker.chrome });
      page.load(...FILES);
      await startEditorClient(page);
      const editor = makeEditor(page);
      for (const noteId of notes) {
        assert.equal(await runUntil(page, editor.loadNote(noteId)), true, `${id}: ${noteId} opens`);
        await runUntil(page, editor.save());
      }

      const after = plain(recordsOf(await dumpDatabase(worker.indexedDB), 'elements'));
      const { decodeBlock } = page.global.BlockProjections;
      const Block = page.get('Block');
      const saved = new Set(notes);
      const has = (record, name) => Object.prototype.hasOwnProperty.call(record, name);
      let safe = 0;
      for (const [blockId, record] of Object.entries(before)) {
        assert.ok(has(after, blockId), `${id}: ${blockId} is kept`);
        const stored = after[blockId];
        const { state } = decodeBlock(record);
        const known = state === 'current' || state === 'upcast';
        if (!known) safe += 1;
        if (!saved.has(record.canvasId) || !known) {
          // Written back as loaded: only a save's order can differ, and in v8.opaque-blocks it doesn't
          const exact = id === 'v8.opaque-blocks' || !saved.has(record.canvasId);
          assert.deepEqual(exact ? stored : without(stored, 'order'), exact ? record : without(record, 'order'), `${id}: ${blockId}, ${state}`);
          continue;
        }
        for (const [name, value] of Object.entries(without(record, 'order'))) {
          // A field holding undefined reads as absent, as a missing one does (the capture's
          // bookmark with no title), and a save writes it at the type's default, as 1.4.x's did
          if (value === undefined) continue;
          assert.deepEqual(stored[name], value, `${id}: ${blockId} keeps ${name}`);
        }
        assert.equal(stored.schemaVersion, 1, `${id}: ${blockId}`);
        const written = new Set([...Object.keys(new Block({ type: record.type }).serialize()), 'canvasId', 'order']);
        for (const name of Object.keys(stored)) {
          assert.ok(has(record, name) || written.has(name), `${id}: ${blockId} gains only what a save writes for its type, not ${name}`);
        }
      }
      if (id === 'v8.opaque-blocks') assert.equal(safe, 4, 'a newer, an unknown, an invalid and a typeless block');
      else assert.equal(safe, 0, `${id}: 1.4.x's own blocks all decode as known`);
    });
  }
});
