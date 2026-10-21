// #17 slice 1 on the IndexedDB adapter: every write commits in one strict transaction,
// opened in the task that sends it, and answers only once that transaction fires `complete`.
// On `abort`, even after every request in it succeeded, it answers a typed `unavailable`, and
// nothing it wrote is stored.

import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { unitsWork } from '../../js/kernel/core/application/work.js';
import { UnavailableError, committed, rejected } from '../../js/kernel/core/contracts/outcomes.js';
import { adapterOn, closeAll, kernelOn, legacyEnv, profile } from './storage-fixture.mjs';
import { CALLERS, testClock, testIds } from './support.mjs';

/** @typedef {import('./storage-fixture.mjs').Profile} Profile */
/** @typedef {import('../../js/kernel/core/contracts/commands.js').Command} Command */
/** @typedef {import('../../js/kernel/core/application/kernel.js').Kernel} Kernel */
/** @typedef {import('../../js/kernel/core/ports/repository.js').Unit} Unit */

/** @type {Profile[]} */
const profiles = [];
after(() => profiles.forEach(closeAll));

/** A profile with an open versioned adapter, and a new tab's and the worker's kernels over it */
async function opened() {
  const of = profile();
  profiles.push(of);
  const adapter = adapterOn(of);
  await adapter.open();
  const runtime = { ids: testIds(), clock: testClock() };
  return {
    of,
    adapter,
    tab: kernelOn(adapter, runtime),
    worker: kernelOn(adapter, runtime, CALLERS['worker-internal']),
  };
}

describe('commits on the IndexedDB adapter', () => {
  it('every write runs in one readwrite transaction with durability strict, opened in the task that sends it', async () => {
    const { of, tab, worker } = await opened();
    await tab.execute({ type: 'createNote', commandId: 'seed', noteId: 'n1', name: 'Plan' });
    await tab.execute({ type: 'createFolder', commandId: 'f1', folderId: 'f1', name: 'Work', parentId: null });
    await tab.execute({ type: 'createFolder', commandId: 'f2', folderId: 'f2', name: 'Home', parentId: null });
    const block = { id: 'b1', type: 'text', content: 'Milk' };
    /** @type {Array<[Kernel, Command]>} */
    const commands = [
      [tab, { type: 'createNote', commandId: 'c1', noteId: 'n2', name: 'Filed', folderId: 'f1', blocks: [block] }],
      [tab, { type: 'renameNote', commandId: 'c2', noteId: 'n1', name: 'Renamed' }],
      [tab, { type: 'setPinned', commandId: 'c3', noteId: 'n1', pinned: true }],
      [tab, { type: 'archiveNote', commandId: 'c4', noteId: 'n1' }],
      [tab, { type: 'unarchiveNote', commandId: 'c5', noteId: 'n1' }],
      [tab, { type: 'saveNoteContent', commandId: 'c6', noteId: 'n1', blocks: [{ ...block, id: 'b2' }] }],
      [tab, { type: 'applyDerivedTitle', commandId: 'c7', noteId: 'n2', name: 'Groceries' }],
      [tab, { type: 'attachInsights', commandId: 'c8', noteId: 'n1', insights: { todos: [] } }],
      [tab, { type: 'trashNote', commandId: 'c9', noteId: 'n1' }],
      [tab, { type: 'restoreNote', commandId: 'c10', noteId: 'n1' }],
      [tab, { type: 'moveFolder', commandId: 'c11', folderId: 'f1', parentId: 'f2' }],
      [
        worker,
        {
          type: 'captureToDailyNote',
          commandId: 'c12',
          noteId: 'd1',
          blockId: 'k1',
          capture: { type: 'text', content: 'Quote' },
        },
      ],
    ];
    for (const [kernel, command] of commands) {
      const before = of.faults.transactions.length;
      const pending = kernel.execute(command);
      // A capture reads the Daily Note template setting first, so its transaction opens after that
      if (command.type !== 'captureToDailyNote') {
        assert.equal(of.faults.transactions.length, before + 1, `${command.type} opens its transaction as it's sent`);
      }
      const outcome = await pending;
      assert.equal(outcome.kind, 'committed', `${command.type}: ${JSON.stringify(outcome)}`);
      assert.deepEqual(
        of.faults.transactions.slice(before).map(({ mode, durability }) => [mode, durability]),
        [['readwrite', 'strict']],
        command.type,
      );
    }
  });

  it('a command answers only after its transaction fires complete', async () => {
    const { of, tab } = await opened();
    /** @type {string[]} */
    const log = [];
    const pending = tab.execute({ type: 'createNote', commandId: 'c1', noteId: 'n1' }).then(outcome => {
      log.push(`answered ${outcome.kind}`);
    });
    /** @type {any} */ (of.faults.transactions.at(-1)).tx.addEventListener('complete', () => log.push('complete'));
    await pending;
    assert.deepEqual(log, ['complete', 'answered committed']);
  });

  it('a transaction that aborts after its requests succeeded answers unavailable, and stores none of them', async () => {
    const { of, tab, worker } = await opened();
    await tab.execute({ type: 'createNote', commandId: 'seed', noteId: 'n1', name: 'Plan', blocks: [{ id: 'b0' }] });
    /** @type {Array<[Kernel, Command, string]>} */
    const cases = [
      // Each fails on the last request it makes, so every other request has succeeded by then
      [tab, { type: 'createNote', commandId: 'c1', noteId: 'n2', name: 'New' }, 'search_index'],
      [tab, { type: 'renameNote', commandId: 'c2', noteId: 'n1', name: 'Renamed' }, 'search_index'],
      [
        tab,
        { type: 'saveNoteContent', commandId: 'c3', noteId: 'n1', blocks: [{ id: 'b0', content: 'x' }] },
        'canvases',
      ],
      [tab, { type: 'setPinned', commandId: 'c4', noteId: 'n1', pinned: true }, 'canvases'],
      [tab, { type: 'trashNote', commandId: 'c5', noteId: 'n1' }, 'canvases'],
      [
        worker,
        {
          type: 'captureToDailyNote',
          commandId: 'c6',
          noteId: 'd1',
          blockId: 'k1',
          capture: { type: 'text', content: 'Quote' },
        },
        'elements',
      ],
    ];
    for (const [kernel, command, store] of cases) {
      const before = await legacyEnv.dumpDatabase(of.real);
      of.faults.abortAfterNextWrite(store, 'QuotaExceededError');
      const outcome = await kernel.execute(command);
      assert.deepEqual(
        outcome.kind === 'unavailable' && [outcome.cause, outcome.code, outcome.retryable],
        ['quota', 'quota', false],
        `${command.type}: ${JSON.stringify(outcome)}`,
      );
      assert.deepEqual(await legacyEnv.dumpDatabase(of.real), before, command.type);
    }
  });

  it('a command whose later unit stops it or throws aborts its transaction, so nothing an earlier unit wrote stays', async () => {
    const { of, adapter, tab } = await opened();
    await tab.execute({ type: 'createNote', commandId: 'seed', noteId: 'n1', name: 'Plan' });
    const command = /** @type {Command} */ ({ type: 'createNote', commandId: 'c1', noteId: 'n2' });
    /** @type {Unit} */
    const writes = {
      stores: ['notes', 'blocks'],
      async run(tx) {
        tx.put('notes', { id: 'n2', name: 'Written first' });
        tx.put('blocks', { id: 'b2', canvasId: 'n2' });
      },
    };
    /** @type {Array<[Unit, string]>} */
    const lasts = [
      [{ stores: ['folders'], run: async () => rejected('not-found', 'folder-not-found') }, 'rejected'],
      [
        {
          stores: ['folders'],
          run: async () => {
            throw new UnavailableError('storage', 'store-unavailable', false);
          },
        },
        'unavailable',
      ],
    ];
    for (const [last, kind] of lasts) {
      const before = await legacyEnv.dumpDatabase(of.real);
      const { outcome } = await adapter.commit(unitsWork(command, [writes, last], () => committed('created', ['n2'])));
      assert.equal(outcome.kind, kind, JSON.stringify(outcome));
      assert.deepEqual(await legacyEnv.dumpDatabase(of.real), before, kind);
    }
  });
});
