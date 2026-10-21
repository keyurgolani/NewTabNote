// Use cases taken apart: the order a unit issues its requests in, what a command does on an
// adapter that commits each of its units on its own, as the legacy adapter does, and on one
// that runs a command's units again after a commit that failed, as #17's adapter does. Then
// what the derived scope lets a unit write.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { createKernel } from '../../js/kernel/core/application/kernel.js';
import { noteCommands } from '../../js/kernel/core/application/notes.js';
import { derivedOnly } from '../../js/kernel/core/application/scopes.js';
import { UnavailableError } from '../../js/kernel/core/contracts/outcomes.js';
import { dailyDateStr } from '../../js/kernel/core/domain/note.js';
import { createMemoryAdapter } from '../../js/kernel/core/memory/adapter.js';
import { createBaselinePolicy } from '../../js/kernel/core/ports/policy.js';
import { CALLERS, NOW, testClock, testIds } from './support.mjs';

/** @typedef {import('../../js/kernel/core/ports/repository.js').KernelAdapter} KernelAdapter */
/** @typedef {import('../../js/kernel/core/ports/repository.js').Tx} Tx */
/** @typedef {import('../../js/kernel/core/ports/repository.js').Work} Work */
/** @typedef {import('../../js/kernel/core/application/work.js').UseCaseContext} UseCaseContext */

/**
 * A transaction that logs each request into `log` and reads from `records`.
 * @param {string[]} log
 * @param {Record<string, Record<string, Record<string, unknown>>>} records - store, then key
 * @returns {Tx}
 */
function spyTx(log, records) {
  /** @param {string} store */
  const all = store => Object.values(records[store] || {});
  return /** @type {Tx} */ ({
    get: async (store, key) => {
      log.push(`get ${store} ${key}`);
      return records[store]?.[key];
    },
    getAll: async store => {
      log.push(`getAll ${store}`);
      return all(store);
    },
    getAllByIndex: async (store, index, value) => {
      log.push(`getAllByIndex ${store} ${index}`);
      return all(store).filter(record => record[index] === value);
    },
    getKeysByIndex: async (store, index, value) => {
      log.push(`getKeysByIndex ${store} ${index}`);
      return all(store)
        .filter(record => record[index] === value)
        .map(record => String(record.id));
    },
    revision: (store, key) => {
      log.push(`revision ${store} ${key}`);
      return undefined;
    },
    put: (store, record) => {
      log.push(`put ${store} ${record.id ?? record.noteId}`);
    },
    delete: (store, key) => {
      log.push(`delete ${store} ${key}`);
    },
  });
}

/**
 * An adapter over `inner` that commits each of a command's units in its own commit, as the
 * legacy adapter commits each unit in its own transaction, and runs `between` after each one.
 * @param {KernelAdapter} inner
 * @param {(unitIndex: number) => Promise<void>} between
 * @returns {KernelAdapter}
 */
function unitAtATime(inner, between) {
  return {
    ...inner,
    name: 'unit-at-a-time',
    flags: Object.freeze({ atomicMultiStore: false, revisions: false, idempotency: false }),
    recall: () => undefined,
    async commit(work) {
      if (work.effect.kind !== 'units') return inner.commit(work);
      for (const [index, unit] of work.effect.units.entries()) {
        if (unit.when && !unit.when()) continue;
        const one = { ...unit, when: undefined };
        const result = await inner.commit({
          ...work,
          commandId: `${work.commandId}#${index}`,
          effect: { kind: 'units', units: [one] },
        });
        if (result.outcome.kind !== 'committed') return result;
        await between(index);
      }
      return { outcome: work.done(), replayed: false };
    },
  };
}

describe('saveNoteContent', () => {
  it('puts the blocks before it reads anything, in the task that runs it, so a page-hide flush stores them', async () => {
    /** @type {UseCaseContext} */
    const context = {
      adapter: createMemoryAdapter(),
      clock: testClock(),
      ids: testIds(),
      run: () => assert.fail('saveNoteContent runs no other command'),
    };
    /** @type {import('../../js/kernel/core/contracts/commands.js').CommandOf<'saveNoteContent'>} */
    const command = { type: 'saveNoteContent', commandId: 'c1', noteId: 'n1', blocks: [{ id: 'b1' }, { id: 'b2' }] };
    const work = /** @type {Work} */ (noteCommands.saveNoteContent(command, context));
    assert.equal(work.effect.kind, 'units');
    const [unit] = work.effect.kind === 'units' ? work.effect.units : [];
    /** @type {string[]} */
    const log = [];
    const running = unit.run(spyTx(log, { notes: { n1: { id: 'n1', name: 'Plan' } } }));
    // Nothing is awaited before the puts: they're in the log as soon as the unit starts
    assert.deepEqual(log, ['put blocks b1', 'put blocks b2', 'get notes n1']);
    await running;
    assert.deepEqual(log.slice(3), ['revision notes n1', 'put notes n1']);
  });
});

describe('trashNote on an adapter that commits each unit on its own', () => {
  it('never deletes a note whose content another context saved while the trash ran, nor orphans its blocks', async () => {
    // Fire the other context's save after each unit the trash commits in turn
    for (let after = 0; after < 6; after++) {
      const inner = createMemoryAdapter();
      const clock = testClock();
      const ids = testIds();
      const policy = createBaselinePolicy();
      const otherTab = createKernel({ adapter: inner, policy, caller: CALLERS.newtab, ids, clock });
      await otherTab.execute({ type: 'createNote', commandId: 'c1', noteId: 'n1', blocks: [{ id: 'b0' }] });

      /** @type {import('../../js/kernel/core/contracts/outcomes.js').Outcome | undefined} */
      let saved;
      const save = async () => {
        saved = await otherTab.execute({
          type: 'saveNoteContent',
          commandId: 'c2',
          noteId: 'n1',
          blocks: [{ id: 'typed', type: 'text', content: '<p>Milk</p>' }],
        });
      };
      const adapter = unitAtATime(inner, async index => {
        if (index === after) await save();
      });
      const tab = createKernel({ adapter, policy, caller: CALLERS.newtab, ids, clock });
      await tab.execute({ type: 'trashNote', commandId: 'c3', noteId: 'n1' });
      if (!saved) await save();

      const note = await otherTab.query({ type: 'getNote', noteId: 'n1' });
      const blocks = await otherTab.query({ type: 'getNoteBlocks', noteId: 'n1' });
      const blockIds = blocks.kind === 'ready' ? blocks.data.map(block => block.id) : [];
      if (blockIds.length > 0)
        assert.equal(note.kind, 'ready', `after unit ${after}: blocks ${blockIds} lost their note`);
      if (saved?.kind === 'committed') {
        assert.ok(blockIds.includes('typed'), `after unit ${after}: the save committed but its block is gone`);
      }
    }
  });
});

describe('units an adapter runs again', () => {
  /** @type {UseCaseContext} */
  const context = {
    adapter: createMemoryAdapter(),
    clock: testClock(),
    ids: testIds(),
    run: () => assert.fail('no other command runs'),
  };

  /**
   * Runs the work's units the way an adapter does, over `records`
   * @param {Work} work
   * @param {Record<string, Record<string, Record<string, unknown>>>} records
   */
  const runUnits = async (work, records) => {
    /** @type {string[]} */
    const log = [];
    for (const unit of work.effect.kind === 'units' ? work.effect.units : []) {
      if (unit.when && !unit.when()) continue;
      const stop = await unit.run(spyTx(log, records));
      if (stop) return { stop, log };
    }
    return { stop: undefined, log };
  };

  it('a derived title decides afresh on each run whether the title was set by hand', async () => {
    const command = /** @type {const} */ ({
      type: 'applyDerivedTitle',
      commandId: 'c1',
      noteId: 'n1',
      name: 'Derived',
    });
    const work = /** @type {Work} */ (noteCommands.applyDerivedTitle(command, context));
    // The first transaction finds the title set by hand, then fails to commit. By the run that
    // commits, the user had cleared it.
    await runUnits(work, { notes: { n1: { id: 'n1', name: 'Mine', titleManuallySet: true } } });
    const { log } = await runUnits(work, {
      notes: { n1: { id: 'n1', name: 'Untitled', titleManuallySet: false } },
      searchIndex: { n1: { noteId: 'n1', name: 'Untitled' } },
    });
    assert.deepEqual(log, ['get notes n1', 'put notes n1', 'get searchIndex n1', 'put searchIndex n1']);
    assert.deepEqual([work.done().code, work.revised && work.revised()], ['title-derived', true]);
  });

  it("a capture decides afresh on each run whether it makes today's Daily Note", async () => {
    const command = /** @type {const} */ ({
      type: 'captureToDailyNote',
      commandId: 'c1',
      noteId: 'new-daily',
      blockId: 'k1',
      capture: { type: 'text', content: 'Quote' },
    });
    const work = /** @type {Work} */ (await noteCommands.captureToDailyNote(command, context));
    // The first run makes the Daily Note and fails to commit. Before the run that commits,
    // another context made today's.
    await runUnits(work, { notes: {} });
    const today = { id: 'their-daily', name: 'Daily Note', isDaily: true, dateStr: dailyDateStr(NOW), updatedAt: NOW };
    const { log } = await runUnits(work, { notes: { 'their-daily': today } });
    assert.deepEqual(log, ['getAll notes', 'put blocks k1']);
    assert.deepEqual(work.done().changedIds, ['their-daily']);
    assert.deepEqual(work.primary && work.primary(), { store: 'notes', key: 'their-daily' });
  });
});

describe('the derived scope', () => {
  /**
   * Runs `run` as a derived unit over a transaction holding `note`
   * @param {Record<string, unknown> & {id: string}} note
   * @param {(tx: Tx) => Promise<void>} run
   */
  const runDerived = async (note, run) => {
    /** @type {string[]} */
    const log = [];
    /** @type {unknown} */
    let error;
    try {
      await derivedOnly({ stores: ['notes'], run }).run(spyTx(log, { notes: { [note.id]: note } }));
    } catch (caught) {
      error = caught;
    }
    return { log, error };
  };

  it('takes a write whose other fields are copies of what it read, since their content is the same', async () => {
    const note = { id: 'n1', name: 'Plan', viewport: { scale: 1, offsetX: 0 }, tags: ['a'], seenAt: new Date(NOW) };
    const { log, error } = await runDerived(note, async tx => {
      const read = await tx.get('notes', 'n1');
      if (read) tx.put('notes', { ...structuredClone(read), preview: 'P' });
    });
    assert.equal(error, undefined);
    assert.deepEqual(log, ['get notes n1', 'put notes n1']);
  });

  it("refuses a note with a field it can't compare, such as a Map, even for a write that keeps it", async () => {
    const note = { id: 'n1', name: 'Plan', extra: new Map([['a', 1]]) };
    const { log, error } = await runDerived(note, async tx => {
      const read = await tx.get('notes', 'n1');
      if (read) tx.put('notes', { ...read, preview: 'P' });
    });
    assert.deepEqual(error instanceof UnavailableError && [error.unavailableCause, error.code], [
      'adapter',
      'write-outside-scope',
    ]);
    assert.deepEqual(log, ['get notes n1']);
  });
});
