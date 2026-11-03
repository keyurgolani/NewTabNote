'use strict';

// #14 slice 3, the upgrade from every 1.4.x profile, through the editor: each version-8
// fixture a release could leave that the upgrade migrates (the synthesized ones, and the
// recorded v1.3.0, v1.4.0 and v1.4.0.blocks) goes through the shipped worker's run and
// transforms, and then each of its notes opens in the editor, gets an edit to its first block
// decode reads as known, and is saved. A save writes only the blocks its pane changed (#17, the
// per-pane save), so the edited block keeps every other field it held, is at schemaVersion 1,
// and gains only fields Block.serialize writes for its type, which a block another writer made
// (the onboarding note, a capture) can lack or hold as undefined, as 1.4.x's save added them.
// Every other block is as the upgrade left it, apart from the order a save may give it: the
// save doesn't rewrite it, so it gains no schemaVersion. A block in a safe state, which
// v8.opaque-blocks holds one of each kind of, is as the upgrade left it, order included there,
// and so is every block of no note.

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
    it(`${id}: each note opened, its first known block edited, and saved keeps its blocks: that one at schemaVersion 1, and every other as stored`, OPTIONS, async () => {
      const worker = await upgraded(fixture);
      const before = plain(recordsOf(await dumpDatabase(worker.indexedDB), 'elements'));
      const notes = Object.keys(recordsOf(await dumpDatabase(worker.indexedDB), 'canvases'));

      const page = createLegacyEnv({ indexedDB: worker.indexedDB, chrome: worker.chrome });
      page.load(...FILES);
      await startEditorClient(page);
      const editor = makeEditor(page);
      /** @type {Map<string, string>} The text each edited block was given, by its id */
      const edited = new Map();
      for (const noteId of notes) {
        assert.equal(await runUntil(page, editor.loadNote(noteId)), true, `${id}: ${noteId} opens`);
        // The first block that edits as usual and is stored, not the empty one a note with none shows
        const first = editor.blocks.find(b => !b.safeState() && Object.prototype.hasOwnProperty.call(before, b.id));
        if (first) {
          first.content = `${first.content || ''} (edited)`;
          edited.set(first.id, first.content);
        }
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
        if (!edited.has(blockId)) {
          // Not rewritten, or a card written back as loaded: only the order a save gives it can
          // differ, and in v8.opaque-blocks or on a note no editor saved it doesn't
          const exact = id === 'v8.opaque-blocks' || !saved.has(record.canvasId);
          assert.deepEqual(exact ? stored : without(stored, 'order'), exact ? record : without(record, 'order'), `${id}: ${blockId}, ${state}, as stored`);
          continue;
        }
        assert.equal(stored.content, edited.get(blockId), `${id}: ${blockId}'s edit`);
        for (const [name, value] of Object.entries(without(record, 'order', 'content'))) {
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
