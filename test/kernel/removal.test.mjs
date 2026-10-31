// removeNotes (js/kernel/composition/removal.js): the order it runs a removal in, #46's, and
// what it does when the write doesn't commit, over a client and pane ports that record calls.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { createNoteRemoval } from '../../js/kernel/composition/removal.js';
import { bulk, committed, rejected, unavailable } from '../../js/kernel/core/contracts/outcomes.js';
import { testIds } from './support.mjs';

/**
 * A removal over a client that answers `answer` and ports that log each call, in order
 * @param {(command: any) => any} answer
 * @param {{leaveThrows?: boolean}} [options]
 */
function harness(answer, { leaveThrows = false } = {}) {
  /** @type {string[]} */
  const log = [];
  /** @type {any[]} */
  const warned = [];
  const client = /** @type {any} */ ({
    ids: testIds('r'),
    execute: async (/** @type {any} */ command) => {
      log.push(`execute ${command.type}${command.action ? ` ${command.action}` : ''}`);
      return answer(command);
    },
  });
  const removal = createNoteRemoval(client, {
    leave: async ids => {
      log.push(`leave ${ids.join(',')}`);
      if (leaveThrows) throw new Error('pane move broke');
      return {
        arrive: async left => {
          log.push(`arrive ${left.join(',')}`);
        },
        restore: async stayed => {
          log.push(`restore ${stayed.join(',')}`);
        },
      };
    },
    announce: ids => {
      log.push(`announce ${ids.join(',')}`);
    },
    settled: async () => {
      log.push('settled');
    },
    logger: { warn: (event, detail) => warned.push([event, detail.step]) },
  });
  return { removal, log, warned };
}

describe('removeNotes', () => {
  it('leaves before the write, then finishes the move, announces, and settles the lists', async () => {
    const { removal, log } = harness(() => committed('note-trashed', ['n1']));
    const outcome = await removal.removeNotes({ type: 'trashNote', noteId: 'n1' });
    assert.equal(outcome.kind, 'committed');
    assert.deepEqual(log, ['leave n1', 'execute trashNote', 'arrive n1', 'announce n1', 'settled']);
  });

  it('puts the panes back when the write fails, and tells no other tab', async () => {
    const { removal, log } = harness(() => unavailable('storage', 'transaction-failed', true));
    const outcome = await removal.removeNotes({ type: 'deleteNotePermanently', noteId: 'n1' });
    assert.equal(outcome.kind, 'unavailable');
    assert.deepEqual(log, ['leave n1', 'execute deleteNotePermanently', 'restore n1', 'settled']);
  });

  it('a note already gone has left: the panes finish moving off it, and no tab is told again', async () => {
    const { removal, log } = harness(() => rejected('not-found', 'note-not-found'));
    await removal.removeNotes({ type: 'archiveNote', noteId: 'n1' });
    assert.deepEqual(log, ['leave n1', 'execute archiveNote', 'arrive n1', 'settled']);
  });

  it('a bulk action that partly commits puts back the panes of the notes that stayed, then moves the ones that left', async () => {
    const { removal, log } = harness(command =>
      bulk(command.action, [
        { id: 'a', outcome: committed('note-trashed', ['a']) },
        { id: 'b', outcome: unavailable('storage', 'transaction-failed', true) },
      ]),
    );
    const outcome = await removal.removeNotes({ type: 'runBulkAction', action: 'trash', noteIds: ['a', 'b'] });
    assert.deepEqual(outcome.kind === 'bulk' && outcome.committedIds, ['a']);
    assert.deepEqual(log, [
      'leave a,b',
      'execute runBulkAction trash',
      'restore b',
      'arrive a',
      'announce a',
      'settled',
    ]);
  });

  it('a bulk restore brings notes in, so nothing leaves or is announced', async () => {
    const { removal, log } = harness(command =>
      bulk(command.action, [{ id: 'a', outcome: committed('note-restored', ['a']) }]),
    );
    await removal.removeNotes({ type: 'runBulkAction', action: 'restore', noteIds: ['a'] });
    assert.deepEqual(log, ['execute runBulkAction restore', 'settled']);
  });

  it('Empty trash leaves the notes the page lists in the trash, and announces the ones the kernel deleted', async () => {
    const { removal, log } = harness(() => committed('trash-emptied', ['t1', 't2', 't3']));
    await removal.removeNotes({ type: 'emptyTrash', noteIds: ['t1', 't2'] });
    assert.deepEqual(log, ['leave t1,t2', 'execute emptyTrash', 'arrive t1,t2,t3', 'announce t1,t2,t3', 'settled']);
  });

  it('Empty trash puts back the panes of a listed note another tab restored first, then moves the rest', async () => {
    const { removal, log } = harness(() => committed('trash-emptied', ['t1']));
    await removal.removeNotes({ type: 'emptyTrash', noteIds: ['t1', 't2'] });
    assert.deepEqual(log, ['leave t1,t2', 'execute emptyTrash', 'restore t2', 'arrive t1', 'announce t1', 'settled']);
  });

  it('trash retention writes first, then leaves the notes it deleted, so unsaved text there is kept', async () => {
    const { removal, log } = harness(() => committed('trash-cleaned', ['old']));
    await removal.removeNotes({ type: 'runTrashCleanup' });
    assert.deepEqual(log, ['execute runTrashCleanup', 'leave old', 'arrive old', 'announce old', 'settled']);
  });

  it('trash retention that deletes nothing moves no pane and tells no tab', async () => {
    const { removal, log } = harness(() => committed('trash-kept', []));
    await removal.removeNotes({ type: 'runTrashCleanup' });
    assert.deepEqual(log, ['execute runTrashCleanup', 'settled']);
  });

  it('a pane move that throws is reported with its step and ids, and the write still runs and answers', async () => {
    const { removal, log, warned } = harness(() => committed('note-trashed', ['n1']), { leaveThrows: true });
    const outcome = await removal.removeNotes({ type: 'trashNote', noteId: 'n1' });
    assert.equal(outcome.kind, 'committed');
    assert.deepEqual(log, ['leave n1', 'execute trashNote', 'announce n1', 'settled']);
    assert.deepEqual(warned, [['pane-move-failed', 'leave']]);
  });

  it('sends one command with a new commandId, and never a note record', async () => {
    /** @type {any[]} */
    const sent = [];
    const { removal } = harness(command => {
      sent.push(command);
      return committed('note-deleted', ['n1']);
    });
    await removal.removeNotes({ type: 'deleteNotePermanently', noteId: 'n1' });
    await removal.removeNotes({ type: 'emptyTrash', noteIds: ['t1'] });
    assert.deepEqual(sent, [
      { type: 'deleteNotePermanently', commandId: 'r-1', noteId: 'n1' },
      { type: 'emptyTrash', commandId: 'r-2' },
    ]);
  });
});
