'use strict';

// Production js/storage.js on fake-indexeddb behind #17's fault-injecting wrapper
// (test/kernel/storage-faults.mjs): writes answer only for what they stored, and exportAll
// exports what the database holds. The known defects are expected failures under their
// test/known-defects.json entries, so the run fails once one is fixed and its entry stays.
// A step that goes wrong for another reason throws a plain Error, which fails the test as it
// should, rather than an assertion that would read as the defect.

const test = require('node:test');
const assert = require('node:assert/strict');
const { IDBFactory } = require('fake-indexeddb');
const { createLegacyEnv, createDatabase, workerRun, dumpDatabase, recordsOf, settle, plain, note, block } = require('./helpers/legacy-env');
const { expectFailure } = require('./helpers/expect-failure');

const FILES = ['js/utils.js', 'js/core/storage-error.js', 'js/storage.js'];
const FAULT = 'QuotaExceededError';

/**
 * Storage started on a database the wrapper watches. `real` is fake-indexeddb itself, for
 * reading what was stored without going through the wrapper.
 * @param {Object} [records] - Rows per store, as createDatabase takes them
 */
async function started(records) {
  const real = new IDBFactory();
  const { faultyFactory } = await import('./kernel/storage-faults.mjs');
  const faults = faultyFactory(real);
  // With no records, the database the worker's run makes on a fresh profile (#17 PR 1b)
  if (records) await createDatabase(real, { records });
  else await workerRun(real);
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

/**
 * Whether `error`, or an error it wraps (StorageError's `cause`), is the fault the test
 * injected
 * @param {any} error
 */
function isInjectedFault(error) {
  for (let current = error; current; current = current.cause) {
    if (current.name === FAULT) return true;
  }
  return false;
}

/**
 * The write either answers with what it stored, or rejects with the injected abort. A
 * rejection for any other reason, or an answer for a record that isn't stored, fails.
 * @param {{value?: any, error?: any}} outcome
 * @param {Object<string, any>} stored - The store's rows by key, read after the abort
 * @param {(value: any) => string} keyOf - The key of the record the write answered with
 * @param {string} what - The write, for the messages
 */
function assertAnsweredHonestly(outcome, stored, keyOf, what) {
  if (outcome.error) {
    assert.ok(isInjectedFault(outcome.error), `${what} rejected, but not with the aborted transaction's error: ${outcome.error && outcome.error.message}`);
    return;
  }
  assert.ok(keyOf(plain(outcome.value)) in stored, `${what} resolved with a record its aborted transaction never stored`);
}

test('createNote and saveElement resolve once what they wrote is stored, when nothing fails', async () => {
  const { env, real, storage } = await started({ canvases: [note('N', { name: 'Groceries' })] });
  const created = await outcomeOf(env, storage.createNote('Plan'));
  if (created.error) throw created.error;
  const saved = await outcomeOf(env, storage.saveElement(block('b1', 'N', 0, 'eggs')));
  if (saved.error) throw saved.error;
  const dump = await dumpDatabase(real);
  assert.equal(recordsOf(dump, 'canvases')[plain(created.value).id].name, 'Plan');
  assert.equal(recordsOf(dump, 'elements').b1.content, 'eggs');
});

expectFailure('KD-003 createNote resolves only once its note is stored', async () => {
  const { env, real, faults, storage } = await started();
  // The note's write succeeds, then its transaction aborts, as one the disk refuses at commit does
  const aborted = faults.abortAfterNextWrite('canvases', FAULT);
  const outcome = await outcomeOf(env, storage.createNote('Plan'));
  await aborted;
  assertAnsweredHonestly(outcome, recordsOf(await dumpDatabase(real), 'canvases'), (n) => n.id, 'createNote');
});

expectFailure('KD-004 saveElement resolves only once its block is stored', async () => {
  const { env, real, faults, storage } = await started({ canvases: [note('N', { name: 'Groceries' })] });
  const aborted = faults.abortAfterNextWrite('elements', FAULT);
  const outcome = await outcomeOf(env, storage.saveElement(block('b1', 'N', 0, 'eggs')));
  await aborted;
  assertAnsweredHonestly(outcome, recordsOf(await dumpDatabase(real), 'elements'), (b) => b.id, 'saveElement');
});

/** What exportAll exports from a database holding two linked notes, a theme, and a snapshot */
async function exported() {
  const { storage } = await started({
    canvases: [note('A', { name: 'Alpha' }), note('B', { name: 'Beta' })],
    links: [{ id: 'l1', fromNoteId: 'A', toNoteId: 'B', createdAt: 1 }],
    themes: [{ id: 't1', name: 'Dusk', updatedAt: 2, colors: { accent: '#335577' } }],
    snapshots: [{ id: 's1', noteId: 'A', timestamp: 3, title: 'Alpha', blocks: [{ id: 'x1', type: 'text', content: 'draft' }] }],
  });
  const data = plain(await storage.exportAll());
  const notes = data.canvases.map((n) => n.id).sort();
  if (notes.join() !== 'A,B') throw new Error(`exportAll exported notes ${notes.join()}, not A and B`);
  return data;
}

expectFailure('KD-005 exportAll includes the links between notes', async () => {
  assert.deepEqual(((await exported()).links || []).map((l) => [l.id, l.fromNoteId, l.toNoteId]), [['l1', 'A', 'B']]);
});

expectFailure('KD-005 exportAll includes custom themes', async () => {
  assert.deepEqual(((await exported()).themes || []).map((t) => [t.id, t.name]), [['t1', 'Dusk']]);
});

expectFailure('KD-005 exportAll includes note snapshots', async () => {
  assert.deepEqual(((await exported()).snapshots || []).map((s) => [s.id, s.noteId, s.blocks.length]), [['s1', 'A', 1]]);
});
