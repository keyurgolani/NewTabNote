'use strict';

// The new tab on fake-indexeddb behind #17's fault-injecting wrapper
// (test/kernel/storage-faults.mjs): its writes answer committed only for what they stored, and
// the Storage global's exportAll, sync's upload, exports what the database holds. The writes are
// the kernel's createNote and saveNoteContent, which App makes where 1.4.x called Storage's
// createNote and saveElement, so KD-003 and KD-004 closed with js/storage.js's own code (#17 PR
// 4b). KD-005 is an expected failure under its test/known-defects.json entry, so the run fails
// once it's fixed and its entry stays. A step that goes wrong for another reason throws a plain
// Error, which fails the test as it should, rather than an assertion that would read as the defect.

const test = require('node:test');
const assert = require('node:assert/strict');
const { IDBFactory } = require('fake-indexeddb');
const {
  createLegacyEnv, createDatabase, workerRun, dumpDatabase, recordsOf, settle, plain, note, startNewTabKernel,
} = require('./helpers/legacy-env');
const { expectFailure } = require('./helpers/expect-failure');

const FILES = ['js/utils.js', 'js/core/storage-error.js', 'js/storage.js'];
const FAULT = 'QuotaExceededError';

/**
 * The new tab started on a database the wrapper watches, as its root opens it, with the Storage
 * global's shell connected to its kernel (#17 PR 4b). `real` is fake-indexeddb itself, for
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
  await startNewTabKernel(env);
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
 * The write either commits what it stored, or answers the injected abort as the kernel words
 * it, not retryable, having stored nothing. Any other answer, or a commit of a record that
 * isn't stored, fails.
 * @param {{value?: any, error?: any}} settled - What the kernel's execute settled with
 * @param {Object<string, any>} stored - The store's rows by key, read after the abort
 * @param {string} key - The key of the record the write wrote
 * @param {string} what - The write, for the messages
 */
function assertAnsweredHonestly(settled, stored, key, what) {
  if (settled.error) throw settled.error;
  const outcome = plain(settled.value);
  if (outcome.kind === 'committed') {
    assert.ok(key in stored, `${what} committed a record its aborted transaction never stored`);
    return;
  }
  assert.deepEqual(
    [outcome.kind, outcome.cause, outcome.code, outcome.retryable],
    ['unavailable', 'quota', 'quota', false],
    `${what} answered ${JSON.stringify(outcome)}`,
  );
  assert.equal(key in stored, false, `${what} answered ${outcome.code}, and stored the record anyway`);
}

/**
 * Runs `command` on the new tab's kernel, as App sends it
 * @param {ReturnType<typeof createLegacyEnv>} env
 * @param {Object} command
 */
const send = (env, command) => env.kernel.execute(command);

/** A save of note N's one block, as the editor sends it */
const SAVE = { type: 'saveNoteContent', commandId: 's1', noteId: 'N', blocks: [{ id: 'b1', type: 'text', content: 'eggs' }] };

// Storage's createNote and saveElement answered before their transactions committed (KD-003,
// KD-004). The new tab has written through the kernel since #17 PR 4a, and they went with
// js/storage.js's own code in #17 PR 4b.
test('createNote and saveNoteContent commit what they wrote, when nothing fails', async () => {
  const { env, real } = await started({ canvases: [note('N', { name: 'Groceries' })] });
  const created = await outcomeOf(env, send(env, { type: 'createNote', commandId: 'c1', noteId: 'n1', name: 'Plan' }));
  if (created.error) throw created.error;
  assert.equal(plain(created.value).kind, 'committed');
  const saved = await outcomeOf(env, send(env, SAVE));
  if (saved.error) throw saved.error;
  assert.equal(plain(saved.value).kind, 'committed');
  const dump = await dumpDatabase(real);
  assert.equal(recordsOf(dump, 'canvases').n1.name, 'Plan');
  assert.equal(recordsOf(dump, 'elements').b1.content, 'eggs');
});

test('createNote answers committed only once its note is stored', async () => {
  const { env, real, faults } = await started();
  // The note's write succeeds, then its transaction aborts, as one the disk refuses at commit does
  const aborted = faults.abortAfterNextWrite('canvases', FAULT);
  const outcome = await outcomeOf(env, send(env, { type: 'createNote', commandId: 'c1', noteId: 'n1', name: 'Plan' }));
  await aborted;
  assertAnsweredHonestly(outcome, recordsOf(await dumpDatabase(real), 'canvases'), 'n1', 'createNote');
});

test('saveNoteContent answers committed only once its block is stored', async () => {
  const { env, real, faults } = await started({ canvases: [note('N', { name: 'Groceries' })] });
  const aborted = faults.abortAfterNextWrite('elements', FAULT);
  const outcome = await outcomeOf(env, send(env, SAVE));
  await aborted;
  assertAnsweredHonestly(outcome, recordsOf(await dumpDatabase(real), 'elements'), 'b1', 'saveNoteContent');
});

/**
 * What the Storage global's exportAll, sync's upload, exports from a database holding two
 * linked notes, a theme, and a snapshot
 */
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
