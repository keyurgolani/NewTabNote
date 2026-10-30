'use strict';

// Known defects of production js/storage.js, on fake-indexeddb behind #17's fault-injecting
// wrapper (test/kernel/storage-faults.mjs). Each is an expected failure under its
// test/known-defects.json entry, so the run fails once the defect is fixed and the entry
// stays. A step that goes wrong for another reason throws a plain Error, which fails the test
// as it should, rather than an assertion that would read as the defect.

const assert = require('node:assert/strict');
const { IDBFactory } = require('fake-indexeddb');
const { createLegacyEnv, createDatabase, dumpDatabase, recordsOf, settle, plain, note, block } = require('./helpers/legacy-env');
const { expectFailure } = require('./helpers/expect-failure');

const FILES = ['js/utils.js', 'js/core/storage-error.js', 'js/storage.js'];

/**
 * Storage started on a database the wrapper watches. `real` is fake-indexeddb itself, for
 * reading what was stored without going through the wrapper.
 * @param {Object} [records] - Rows per store, as createDatabase takes them
 */
async function started(records) {
  const real = new IDBFactory();
  const { faultyFactory } = await import('./kernel/storage-faults.mjs');
  const faults = faultyFactory(real);
  if (records) await createDatabase(real, { records });
  const env = createLegacyEnv({ indexedDB: faults.factory, document: null });
  env.load(...FILES);
  const storage = env.get('Storage');
  await storage.init();
  return { env, real, faults, storage };
}

/**
 * Settle `promise` while the page's clock runs, so a write that retries after a wait gets to
 * retry. Resolves {value} or {error}.
 * @param {ReturnType<typeof createLegacyEnv>} env
 * @param {Promise<any>} promise
 */
async function outcomeOf(env, promise) {
  let outcome = null;
  promise.then((value) => { outcome = { value }; }, (error) => { outcome = { error }; });
  for (let i = 0; i < 200 && !outcome; i++) {
    env.clock.tick(500);
    await settle(2);
  }
  if (!outcome) throw new Error('the write never settled');
  return outcome;
}

expectFailure('KD-003 createNote resolves only once its note is stored', async () => {
  const { env, real, faults, storage } = await started();
  // The note's write succeeds, then its transaction aborts, as one the disk refuses at commit does
  const aborted = faults.abortAfterNextWrite('canvases', 'QuotaExceededError');
  const outcome = await outcomeOf(env, storage.createNote('Plan'));
  await aborted;
  // Rejecting is honest: the caller knows the note isn't there
  if (outcome.error) return;
  const stored = recordsOf(await dumpDatabase(real), 'canvases');
  const id = plain(outcome.value).id;
  assert.ok(id in stored, 'createNote resolved with a note its aborted transaction never stored');
});

expectFailure('KD-004 saveElement resolves only once its block is stored', async () => {
  const { env, real, faults, storage } = await started({ canvases: [note('N', { name: 'Groceries' })] });
  const aborted = faults.abortAfterNextWrite('elements', 'QuotaExceededError');
  const outcome = await outcomeOf(env, storage.saveElement(block('b1', 'N', 0, 'eggs')));
  await aborted;
  if (outcome.error) return;
  const stored = recordsOf(await dumpDatabase(real), 'elements');
  assert.ok('b1' in stored, 'saveElement resolved with a block its aborted transaction never stored');
});

expectFailure('KD-005 exportAll includes the links between notes', async () => {
  const { storage } = await started({
    canvases: [note('A', { name: 'Alpha' }), note('B', { name: 'Beta' })],
    links: [{ id: 'l1', fromNoteId: 'A', toNoteId: 'B', createdAt: 1 }],
  });
  const exported = plain(await storage.exportAll());
  const notes = exported.canvases.map((n) => n.id).sort();
  if (notes.join() !== 'A,B') throw new Error(`exportAll exported notes ${notes.join()}, not A and B`);
  assert.deepEqual((exported.links || []).map((l) => [l.id, l.fromNoteId, l.toNoteId]), [['l1', 'A', 'B']]);
});
