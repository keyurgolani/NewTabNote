// #17 slice 1 on the IndexedDB adapter: quota, corruption, abort, and concurrent-write
// failures produce typed outcomes, never report a write as saved, and never leave a promise
// pending. Blocked upgrades are in storage-open.test.mjs.

import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { failureOf } from '../../js/kernel/adapters/indexeddb/failures.js';
import { unitsWork } from '../../js/kernel/core/application/work.js';
import { UnavailableError, committed } from '../../js/kernel/core/contracts/outcomes.js';
import { adapterOn, closeAll, kernelOn, legacyEnv, profile } from './storage-fixture.mjs';
import { CALLERS, testClock, testIds } from './support.mjs';

/** @typedef {import('./storage-fixture.mjs').Profile} Profile */
/** @typedef {import('./storage-fixture.mjs').IndexedDbAdapter} IndexedDbAdapter */
/** @typedef {import('../../js/kernel/core/contracts/outcomes.js').Outcome} Outcome */
/** @typedef {import('../../js/kernel/core/contracts/outcomes.js').BulkOutcome} BulkOutcome */
/** @typedef {import('../../js/kernel/core/contracts/commands.js').Command} Command */
/** @typedef {import('../../js/kernel/core/ports/repository.js').Unit} Unit */

/** @type {Profile[]} */
const profiles = [];
after(() => profiles.forEach(closeAll));

/**
 * A profile, with a database made from `spec` first when given, which opens as it is, since
 * only the migration runner upgrades one (review R79)
 * @param {object} [spec] - for legacyEnv.createDatabase
 */
async function opened(spec) {
  const of = profile();
  profiles.push(of);
  if (spec) await legacyEnv.createDatabase(of.real, spec);
  const adapter = adapterOn(of, spec ? { mode: 'existing' } : {});
  await adapter.open();
  const runtime = { ids: testIds(), clock: testClock() };
  return { of, adapter, runtime, tab: kernelOn(adapter, runtime) };
}

/**
 * Another context of the same profile: its own adapter and kernel
 * @param {Profile} of
 * @param {import('./support.mjs').Caller} [caller]
 */
async function otherContext(of, caller = { surface: 'newtab', contextId: 'newtab-2' }) {
  const adapter = adapterOn(of);
  await adapter.open();
  return kernelOn(adapter, { ids: testIds('other'), clock: testClock() }, caller);
}

/**
 * @param {Outcome | BulkOutcome} outcome
 * @returns {unknown}
 */
const unavailableAs = outcome =>
  outcome.kind === 'unavailable' ? [outcome.cause, outcome.code, outcome.retryable] : outcome;

/**
 * The mode of each transaction opened since the `before`th
 * @param {Profile} of
 * @param {number} [before]
 */
const modesSince = (of, before = 0) => of.faults.transactions.slice(before).map(({ mode }) => mode);

describe('failures on the IndexedDB adapter', () => {
  it('maps each IndexedDB failure to a cause and code, and only AbortError and UnknownError as transient', () => {
    /** @param {string} name */
    const as = name => {
      const { unavailableCause, code, retryable } = failureOf(new DOMException('x', name));
      return [unavailableCause, code, retryable];
    };
    assert.deepEqual(
      Object.fromEntries(
        [
          'QuotaExceededError',
          'VersionError',
          'TransactionInactiveError',
          'InvalidStateError',
          'ReadOnlyError',
          'DataCloneError',
          'DataError',
          'NotFoundError',
          'ConstraintError',
          'NotReadableError',
          'TimeoutError',
          'AbortError',
          'UnknownError',
          'OperationError',
        ].map(name => [name, as(name)]),
      ),
      {
        QuotaExceededError: ['quota', 'quota', false],
        VersionError: ['newer-schema', 'version-too-new', false],
        TransactionInactiveError: ['adapter', 'transaction-inactive', false],
        InvalidStateError: ['adapter', 'transaction-inactive', false],
        ReadOnlyError: ['adapter', 'write-in-readonly-transaction', false],
        DataCloneError: ['adapter', 'not-cloneable', false],
        DataError: ['adapter', 'invalid-key', false],
        NotFoundError: ['storage', 'store-unavailable', false],
        ConstraintError: ['storage', 'constraint', false],
        NotReadableError: ['storage', 'unreadable', false],
        TimeoutError: ['storage', 'timed-out', true],
        AbortError: ['storage', 'transaction-failed', true],
        UnknownError: ['storage', 'transaction-failed', true],
        OperationError: ['storage', 'transaction-failed', true],
      },
    );
    const own = new UnavailableError('storage', 'store-unavailable', false);
    assert.equal(failureOf(own), own);
    const bug = failureOf(new TypeError('a use case bug'));
    assert.deepEqual([bug.unavailableCause, bug.code], ['adapter', 'adapter-failed']);
  });

  it('a write refused for space answers quota, not retryable, at the request or as it commits, and is never retried', async () => {
    const { of, tab } = await opened();
    await tab.execute({ type: 'createNote', commandId: 'seed', noteId: 'n1', name: 'Plan' });
    const before = await legacyEnv.dumpDatabase(of.real);
    for (const inject of ['throwOnNextWrite', 'abortAfterNextWrite']) {
      /** @type {any} */ (of.faults)[inject]('canvases', 'QuotaExceededError');
      const opened = of.faults.transactions.length;
      const outcome = await tab.execute({ type: 'renameNote', commandId: `rename-${inject}`, noteId: 'n1', name: 'X' });
      assert.deepEqual(unavailableAs(outcome), ['quota', 'quota', false], inject);
      assert.deepEqual(modesSince(of, opened), ['readwrite'], `${inject}: one transaction, no retry`);
      assert.deepEqual(await legacyEnv.dumpDatabase(of.real), before, inject);
    }
    // And a setting chrome.storage.local refuses for space
    of.chrome.failNextSet();
    const setting = await tab.execute({ type: 'setPreferences', commandId: 's1', values: { theme: 'dark' } });
    assert.deepEqual(unavailableAs(setting), ['quota', 'quota', false]);
  });

  it('a transaction that aborts with an AbortError or an UnknownError runs once more, and commits once', async () => {
    const { of, runtime } = await opened();
    const worker = kernelOn(/** @type {IndexedDbAdapter} */ (of.adapters[0]), runtime, CALLERS['worker-internal']);
    const tab = kernelOn(/** @type {IndexedDbAdapter} */ (of.adapters[0]), runtime);
    for (const [index, name] of ['AbortError', 'UnknownError'].entries()) {
      // A capture that makes today's Daily Note, so the run again has to decide that again
      of.faults.abortAfterNextWrite('elements', name);
      const opened = of.faults.transactions.length;
      const capture = /** @type {const} */ ({ type: 'text', content: `Quote ${index}` });
      const outcome = await worker.execute({
        type: 'captureToDailyNote',
        commandId: `c${index}`,
        noteId: `d${index}`,
        blockId: `k${index}`,
        capture,
      });
      assert.equal(outcome.kind, 'committed', `${name}: ${JSON.stringify(outcome)}`);
      assert.deepEqual(modesSince(of, opened), ['readwrite', 'readwrite'], name);
    }
    const dailies = await tab.query({ type: 'listNotes', view: 'active' });
    assert.deepEqual(dailies.kind === 'ready' && dailies.data.map(note => note.id), ['d0']);
    const blocks = await tab.query({ type: 'getNoteBlocks', noteId: 'd0' });
    assert.deepEqual(blocks.kind === 'ready' && blocks.data.map(block => block.id), ['k0', 'k1']);
  });

  it('one that aborts again answers retries-exhausted, retryable, and stores nothing', async () => {
    const { of, tab } = await opened();
    await tab.execute({ type: 'createNote', commandId: 'seed', noteId: 'n1', name: 'Plan' });
    const before = await legacyEnv.dumpDatabase(of.real);
    of.faults.abortAfterNextWrite('search_index', 'UnknownError');
    of.faults.abortAfterNextWrite('search_index', 'AbortError');
    const outcome = await tab.execute({ type: 'renameNote', commandId: 'c1', noteId: 'n1', name: 'Renamed' });
    assert.deepEqual(unavailableAs(outcome), ['storage', 'retries-exhausted', true]);
    assert.deepEqual(await legacyEnv.dumpDatabase(of.real), before);
    // Storage recovered, and the same command goes again
    assert.equal(
      (await tab.execute({ type: 'renameNote', commandId: 'c1', noteId: 'n1', name: 'Renamed' })).kind,
      'committed',
    );
  });

  it("a store that can't be read back answers failed, and a damaged one missing an index fails what needs it", async () => {
    const { of, tab } = await opened({
      // Blocks without the canvasId index, as a damaged database can lack it
      omit: ['elements'],
      extraStores: { elements: { keyPath: 'id', indexes: [['type', 'type']] } },
      records: { canvases: [legacyEnv.note('n1', { name: 'Untitled' })] },
    });
    of.faults.failNextRead('canvases', 'NotReadableError');
    assert.deepEqual(await tab.query({ type: 'listNotes', view: 'active' }), {
      kind: 'failed',
      cause: 'storage',
      code: 'unreadable',
    });
    assert.equal((await tab.query({ type: 'listNotes', view: 'active' })).kind, 'ready');
    assert.deepEqual(await tab.query({ type: 'getNoteBlocks', noteId: 'n1' }), {
      kind: 'failed',
      cause: 'storage',
      code: 'store-unavailable',
    });
    // Deciding whether an untitled note is empty reads its blocks by note, so it can't trash it
    const before = await legacyEnv.dumpDatabase(of.real);
    const trashed = await tab.execute({ type: 'trashNote', commandId: 'c1', noteId: 'n1' });
    assert.deepEqual(unavailableAs(trashed), ['storage', 'store-unavailable', false]);
    assert.deepEqual(await legacyEnv.dumpDatabase(of.real), before);
  });

  // A command that waits for ever fails this test at its timeout, instead of holding up the run
  it(
    'a unit that awaits something other than its transaction answers transaction-ended-early, and never waits for ever',
    { timeout: 10000 },
    async () => {
      const { adapter, tab } = await opened();
      await tab.execute({ type: 'createNote', commandId: 'seed', noteId: 'n1', name: 'Plan' });
      const command = /** @type {Command} */ ({ type: 'renameNote', commandId: 'c1', noteId: 'n1', name: 'X' });
      /** @type {Array<(tx: import('../../js/kernel/core/ports/repository.js').Tx) => Promise<void>>} */
      const runs = [
        // Waits for something that never comes
        async tx => {
          await tx.get('notes', 'n1');
          await new Promise(() => {});
        },
        // Waits a moment, then writes on a transaction that has committed by then
        async tx => {
          const note = await tx.get('notes', 'n1');
          await new Promise(resolve => setTimeout(resolve, 5));
          if (note) tx.put('notes', { ...note, name: 'Late' });
        },
      ];
      for (const run of runs) {
        /** @type {Unit} */
        const unit = { stores: ['notes'], run };
        const { outcome } = await adapter.commit(unitsWork(command, [unit], () => committed('renamed', ['n1'])));
        assert.deepEqual(unavailableAs(outcome), ['adapter', 'transaction-ended-early', false]);
      }
      const note = await tab.query({ type: 'getNote', noteId: 'n1' });
      assert.equal(note.kind === 'ready' && note.data.note.name, 'Plan');
    },
  );

  it('a transaction that aborts while a unit awaits something else answers with why it aborted, and runs no more', async () => {
    const { of, adapter, tab } = await opened();
    await tab.execute({ type: 'createNote', commandId: 'seed', noteId: 'n1', name: 'Plan' });
    const command = /** @type {Command} */ ({ type: 'renameNote', commandId: 'c1', noteId: 'n1', name: 'X' });
    // An AbortError would run again anywhere else, but not while the unit may still be running
    /** @type {Array<[string, unknown]>} */
    const cases = [
      ['QuotaExceededError', ['quota', 'quota', false]],
      ['AbortError', ['storage', 'transaction-failed', true]],
    ];
    for (const [name, answer] of cases) {
      // The disk refuses the write while the unit is away, waiting until the adapter has heard
      const aborted = of.faults.abortAfterNextWrite('canvases', name);
      /** @type {Unit} */
      const unit = {
        stores: ['notes'],
        async run(tx) {
          const note = await tx.get('notes', 'n1');
          if (note) tx.put('notes', { ...note, name: 'X' });
          await aborted;
        },
      };
      const before = of.faults.transactions.length;
      const { outcome } = await adapter.commit(unitsWork(command, [unit], () => committed('renamed', ['n1'])));
      assert.deepEqual(unavailableAs(outcome), answer, name);
      assert.deepEqual(modesSince(of, before), ['readwrite'], name);
    }
    const note = await tab.query({ type: 'getNote', noteId: 'n1' });
    assert.equal(note.kind === 'ready' && note.data.note.name, 'Plan');
  });

  it("doesn't run a failed write again once this context sent a later one, so it can't land over the later one", async () => {
    const { of, tab } = await opened();
    await tab.execute({ type: 'createNote', commandId: 'seed', noteId: 'n1', blocks: [{ id: 'b1', content: 'v0' }] });
    /**
     * @param {string} commandId
     * @param {string} content
     */
    const save = (commandId, content) =>
      tab.execute({ type: 'saveNoteContent', commandId, noteId: 'n1', blocks: [{ id: 'b1', content }] });
    // The older save's transaction aborts after the newer one has opened its own
    of.faults.abortAfterNextWrite('canvases', 'UnknownError');
    const [older, newer] = await Promise.all([save('a', 'older'), save('b', 'newer')]);
    assert.deepEqual(unavailableAs(older), ['storage', 'transaction-failed', true]);
    assert.equal(newer.kind, 'committed');
    const blocks = await tab.query({ type: 'getNoteBlocks', noteId: 'n1' });
    assert.equal(blocks.kind === 'ready' && blocks.data[0].content, 'newer');
  });

  it('still runs a failed write again after a later one that shares none of its stores', async () => {
    const { of, tab } = await opened();
    await tab.execute({ type: 'createNote', commandId: 'seed', noteId: 'n1', blocks: [{ id: 'b1', content: 'v0' }] });
    // The save's transaction aborts after the folder's, which touches only folders, has opened
    of.faults.abortAfterNextWrite('canvases', 'UnknownError');
    const before = of.faults.transactions.length;
    const [saved, filed] = await Promise.all([
      tab.execute({ type: 'saveNoteContent', commandId: 'a', noteId: 'n1', blocks: [{ id: 'b1', content: 'saved' }] }),
      tab.execute({ type: 'createFolder', commandId: 'f', folderId: 'f1', name: 'Work', parentId: null }),
    ]);
    assert.equal(saved.kind, 'committed', JSON.stringify(saved));
    assert.equal(filed.kind, 'committed', JSON.stringify(filed));
    const folders = of.faults.transactions.slice(before).map(({ names }) => names.includes('folders'));
    assert.deepEqual(folders, [false, true, false], 'the save, the folder, then the save again');
    const blocks = await tab.query({ type: 'getNoteBlocks', noteId: 'n1' });
    assert.equal(blocks.kind === 'ready' && blocks.data[0].content, 'saved');
  });

  describe('two contexts of one profile at once', () => {
    it('both creating one note: one commits, and the other is refused with note-exists', async () => {
      const { of, tab } = await opened();
      const other = await otherContext(of);
      const outcomes = await Promise.all([
        tab.execute({ type: 'createNote', commandId: 'a', noteId: 'n1', name: 'From A' }),
        other.execute({ type: 'createNote', commandId: 'b', noteId: 'n1', name: 'From B' }),
      ]);
      assert.deepEqual(outcomes.map(outcome => outcome.kind).sort(), ['committed', 'rejected']);
      const refused = outcomes.find(outcome => outcome.kind === 'rejected');
      assert.equal(refused && refused.kind === 'rejected' && refused.code, 'note-exists');
      const won = outcomes[0].kind === 'committed' ? 'From A' : 'From B';
      const note = await tab.query({ type: 'getNote', noteId: 'n1' });
      assert.equal(note.kind === 'ready' && note.data.note.name, won);
    });

    it('both capturing to today: one Daily Note, with both captures, since making it and adding to it is one transaction', async () => {
      const { of, runtime, tab } = await opened();
      const worker = kernelOn(/** @type {IndexedDbAdapter} */ (of.adapters[0]), runtime, CALLERS['worker-internal']);
      // Only the worker captures (#35 slice 3), so the other is its kernel on a second connection
      const other = await otherContext(of, { surface: 'worker-internal', contextId: 'worker-2' });
      const capture = /** @type {const} */ ({ type: 'text', content: 'Quote' });
      const outcomes = await Promise.all([
        worker.execute({ type: 'captureToDailyNote', commandId: 'a', noteId: 'd-worker', blockId: 'k1', capture }),
        other.execute({ type: 'captureToDailyNote', commandId: 'b', noteId: 'd-other', blockId: 'k2', capture }),
      ]);
      assert.deepEqual(
        outcomes.map(outcome => outcome.kind),
        ['committed', 'committed'],
      );
      const notes = await tab.query({ type: 'listNotes', view: 'active' });
      const ids = notes.kind === 'ready' ? notes.data.map(note => note.id) : [];
      assert.equal(ids.length, 1, JSON.stringify(ids));
      const blocks = await tab.query({ type: 'getNoteBlocks', noteId: ids[0] });
      assert.deepEqual(blocks.kind === 'ready' && blocks.data.map(block => block.id).sort(), ['k1', 'k2']);
    });

    it("both saving one note's blocks: each save lands whole, and the one that commits later wins", async () => {
      const { of, tab } = await opened();
      const other = await otherContext(of);
      await tab.execute({ type: 'createNote', commandId: 'seed', noteId: 'n1' });
      /** @param {string} text */
      const blocks = text => ['b0', 'b1', 'b2'].map(id => ({ id, type: 'text', content: `${text} ${id}` }));
      const outcomes = await Promise.all([
        tab.execute({ type: 'saveNoteContent', commandId: 'a', noteId: 'n1', blocks: blocks('A'), preview: 'A' }),
        other.execute({ type: 'saveNoteContent', commandId: 'b', noteId: 'n1', blocks: blocks('B'), preview: 'B' }),
      ]);
      assert.deepEqual(
        outcomes.map(outcome => outcome.kind),
        ['committed', 'committed'],
      );
      const stored = await tab.query({ type: 'getNoteBlocks', noteId: 'n1' });
      const contents = stored.kind === 'ready' ? stored.data.map(block => block.content) : [];
      const note = await tab.query({ type: 'getNote', noteId: 'n1' });
      const preview = note.kind === 'ready' ? note.data.note.preview : undefined;
      assert.deepEqual(
        contents,
        blocks(String(preview)).map(block => block.content),
      );
    });

    it('both moving two folders into each other: one commits, and the other is refused', async () => {
      const { of, tab } = await opened();
      const other = await otherContext(of);
      for (const folderId of ['a', 'b']) {
        await tab.execute({
          type: 'createFolder',
          commandId: `create-${folderId}`,
          folderId,
          name: folderId,
          parentId: null,
        });
      }
      const outcomes = await Promise.all([
        tab.execute({ type: 'moveFolder', commandId: 'a-into-b', folderId: 'a', parentId: 'b' }),
        other.execute({ type: 'moveFolder', commandId: 'b-into-a', folderId: 'b', parentId: 'a' }),
      ]);
      assert.deepEqual(outcomes.map(outcome => outcome.kind).sort(), ['committed', 'rejected']);
      const refused = outcomes.find(outcome => outcome.kind === 'rejected');
      assert.equal(refused && refused.kind === 'rejected' && refused.code, 'folder-into-itself');
    });
  });
});

/**
 * A readwrite transaction of the case's own over `store`, an IndexedDB store of `of`'s CanvasTabDB,
 * kept open by a chain of counts until `release`, as another context's long write holds a store: a
 * transaction the adapter opens over it waits until this one ends to start (#247)
 * @param {Profile} of
 * @param {string} store
 */
function holdStore(of, store) {
  let held = true;
  /** @type {() => void} */
  let started = () => {};
  /** @type {Promise<void>} once the hold's transaction has started */
  const holding = new Promise(resolve => {
    started = () => resolve();
  });
  /** @type {Promise<void>} once the hold's transaction has committed */
  const done = new Promise((resolve, reject) => {
    const open = of.real.open('CanvasTabDB');
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const db = open.result;
      const tx = db.transaction([store], 'readwrite');
      const spin = () => {
        tx.objectStore(store).count().onsuccess = () => {
          started();
          if (held) spin();
        };
      };
      spin();
      tx.oncomplete = () => {
        db.close();
        resolve();
      };
      tx.onabort = () => {
        db.close();
        reject(tx.error);
      };
    };
  });
  return { holding, done, release: () => void (held = false) };
}

/**
 * The adapter's commit of `work` with the turn's `live`, which the port takes since #247
 * @param {IndexedDbAdapter} adapter
 * @param {import('../../js/kernel/core/ports/repository.js').Work} work
 * @param {() => boolean} live
 * @returns {Promise<import('../../js/kernel/core/ports/repository.js').CommitResult>}
 */
const commitIn = (adapter, work, live) => /** @type {any} */ (adapter).commit(work, { live });

describe("the turn's live inside a command's transaction on the IndexedDB adapter (#247)", () => {
  const rename = /** @type {Command} */ ({ type: 'renameNote', commandId: 'c1', noteId: 'n1', name: 'X' });

  /** @type {Unit} the rename's write */
  const renaming = {
    stores: ['notes'],
    async run(tx) {
      const note = await tx.get('notes', 'n1');
      if (note) tx.put('notes', { ...note, name: 'X' });
    },
  };

  /** @param {Awaited<ReturnType<typeof opened>>['tab']} tab */
  const nameOf = async tab => {
    const note = await tab.query({ type: 'getNote', noteId: 'n1' });
    return note.kind === 'ready' && note.data.note.name;
  };

  it('runs no unit of a command whose turn is cut while its transaction waits to start, and commits nothing', async () => {
    const { of, adapter, tab } = await opened();
    await tab.execute({ type: 'createNote', commandId: 'seed', noteId: 'n1', name: 'Plan' });
    const hold = holdStore(of, 'canvases');
    await hold.holding;
    let cut = false;
    let ran = false;
    /** @type {Unit} */
    const unit = {
      stores: ['notes'],
      async run(tx) {
        ran = true;
        await renaming.run(tx);
      },
    };
    const work = unitsWork(rename, [unit], () => committed('renamed', ['n1']));
    const committing = commitIn(adapter, work, () => !cut);
    // The queue cuts the turn while the commit's transaction waits behind the held store
    await new Promise(resolve => setTimeout(resolve, 20));
    cut = true;
    hold.release();
    await hold.done;
    const { outcome } = await committing;
    assert.deepEqual(unavailableAs(outcome), ['coordinator', 'turn-exceeded', true]);
    assert.equal(ran, false, 'no unit ran');
    assert.equal(await nameOf(tab), 'Plan');
  });

  it('runs no later unit once the turn is cut, and commits nothing of the ones before', async () => {
    const { adapter, tab } = await opened();
    await tab.execute({ type: 'createNote', commandId: 'seed', noteId: 'n1', name: 'Plan' });
    let cut = false;
    let second = false;
    /** @type {Unit[]} */
    const units = [
      {
        stores: ['notes'],
        async run(tx) {
          await renaming.run(tx);
          // The queue cuts the turn while this unit runs
          cut = true;
        },
      },
      {
        stores: ['notes'],
        async run() {
          second = true;
        },
      },
    ];
    const work = unitsWork(rename, units, () => committed('renamed', ['n1']));
    const { outcome } = await commitIn(adapter, work, () => !cut);
    assert.deepEqual(unavailableAs(outcome), ['coordinator', 'turn-exceeded', true]);
    assert.equal(second, false, 'the second unit never ran');
    assert.equal(await nameOf(tab), 'Plan');
  });

  it('commits nothing of a command whose turn is cut while its last unit runs, since it checks once more before the bookkeeping', async () => {
    const { adapter, tab } = await opened();
    await tab.execute({ type: 'createNote', commandId: 'seed', noteId: 'n1', name: 'Plan' });
    let cut = false;
    /** @type {Unit} */
    const unit = {
      stores: ['notes'],
      async run(tx) {
        await renaming.run(tx);
        cut = true;
      },
    };
    const work = unitsWork(rename, [unit], () => committed('renamed', ['n1']));
    const { outcome } = await commitIn(adapter, work, () => !cut);
    assert.deepEqual(unavailableAs(outcome), ['coordinator', 'turn-exceeded', true]);
    assert.equal(await nameOf(tab), 'Plan');
  });
});
