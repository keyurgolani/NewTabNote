// #13's catch-up (core/messaging/catch-up.js; #13, "Idempotency and catch-up"): a page
// subscribes to hints first, then reads its projection and the projection's asOfCommitSeq,
// then applies the commit log's entries after it, and reads the projection again on
// resync-required. Hints at or below its cursor are duplicates or out of order, and dropped.
// After its client reconnects, lazily, on its next request, it reads the projection again.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { UnavailableError } from '../../js/kernel/core/contracts/outcomes.js';
import { createCatchUp } from '../../js/kernel/core/messaging/catch-up.js';
import { createMemoryCommitLog } from '../../js/kernel/core/memory/commit-log.js';
import { settle } from './messaging-support.mjs';

/** @typedef {import('../../js/kernel/core/messaging/hints.js').Hint} Hint */
/** @typedef {import('../../js/kernel/core/ports/commit-log.js').ChangeEntry} ChangeEntry */
/** @typedef {import('../../js/kernel/core/messaging/client.js').ConnectionState} ConnectionState */

/**
 * A page's projection over a commit log: what it read, what it applied, and the hints it hears
 * @param {{project?: () => Promise<void>}} [options] - runs inside each projection read
 */
function page({ project = async () => {} } = {}) {
  const log = createMemoryCommitLog();
  /** @type {Set<(hint: Hint) => void>} */
  const listeners = new Set();
  /** @type {string[]} */
  const happened = [];
  /** @type {ChangeEntry[]} */
  const applied = [];
  let reads = 0;
  const catchUp = createCatchUp({
    subscribe(listener) {
      happened.push('subscribed');
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    commitLog: {
      readChangesSince(cursor, limit) {
        happened.push(`read ${cursor}`);
        return log.readChangesSince(cursor, limit);
      },
      head: () => log.head(),
    },
    async project() {
      reads += 1;
      happened.push('projected');
      // The cursor is read no later than what it covers
      const asOf = await log.head();
      await project();
      return asOf;
    },
    apply(entries) {
      applied.push(...entries);
    },
    limit: 2,
  });
  /**
   * A commit to note `id`, and its hint to every page
   * @param {string} id
   */
  const commit = id => {
    const commitSeq = log.append([{ entityType: 'note', entityId: id, revision: 1 }]);
    return { entityType: /** @type {const} */ ('note'), entityId: id, revision: 1, commitSeq };
  };
  /** @param {Hint} hint */
  const hint = hint => {
    for (const listener of [...listeners]) listener(hint);
  };
  return {
    log,
    catchUp,
    commit,
    hint,
    happened,
    applied,
    get reads() {
      return reads;
    },
    get listening() {
      return listeners.size;
    },
  };
}

/** @param {ChangeEntry[]} entries */
const seqs = entries => entries.map(entry => `${entry.entityId}@${entry.commitSeq}`);

describe('catch-up from the commit log (#13, "Idempotency and catch-up")', () => {
  it('subscribes to hints first, then reads the projection, then applies what committed after its asOfCommitSeq', async () => {
    /** @type {() => void} */
    let release = () => {};
    const gate = new Promise(resolve => {
      release = () => resolve(undefined);
    });
    const view = page({ project: () => gate });
    view.commit('n1');
    const started = view.catchUp.start();
    await settle();
    assert.deepEqual(view.happened, ['subscribed', 'projected']);
    // Committed while the projection was being read, which already covered commit 1
    view.hint(view.commit('n2'));
    release();
    await started;
    await settle();
    assert.deepEqual(seqs(view.applied), ['n2@2']);
    assert.equal(view.catchUp.cursor(), 2);
  });

  it('applies each commit once, in order, and drops a hint at or below its cursor without reading the log', async () => {
    const view = page();
    await view.catchUp.start();
    const first = view.commit('n1');
    const second = view.commit('n2');
    view.hint(second);
    await settle();
    assert.deepEqual(seqs(view.applied), ['n1@1', 'n2@2']);
    const reads = view.happened.filter(event => event.startsWith('read')).length;
    view.hint(first);
    view.hint(second);
    await settle();
    assert.deepEqual(seqs(view.applied), ['n1@1', 'n2@2']);
    assert.equal(view.happened.filter(event => event.startsWith('read')).length, reads);
  });

  it('reads the log in pages of its limit until nothing more follows, and coalesces hints that come while it reads', async () => {
    const view = page();
    await view.catchUp.start();
    view.happened.length = 0;
    const hints = ['n1', 'n2', 'n3', 'n4', 'n5'].map(id => view.commit(id));
    for (const hint of hints) view.hint(hint);
    await settle();
    assert.deepEqual(seqs(view.applied), ['n1@1', 'n2@2', 'n3@3', 'n4@4', 'n5@5']);
    assert.deepEqual(
      view.happened.filter(event => event.startsWith('read')),
      ['read 0', 'read 2', 'read 4'],
    );
  });

  it('reads the projection again on resync-required, and applies what committed after its new asOfCommitSeq', async () => {
    const view = page();
    await view.catchUp.start();
    view.commit('n1');
    view.commit('n2');
    view.log.prune(2);
    view.hint(view.commit('n3'));
    await settle();
    assert.equal(view.reads, 2);
    assert.deepEqual(seqs(view.applied), []);
    assert.equal(view.catchUp.cursor(), 3);
  });

  it('catches up from a cursor a reloaded page kept, without reading the projection, unless the cursor is below the floor', async () => {
    const view = page();
    view.commit('n1');
    view.commit('n2');
    view.commit('n3');
    await view.catchUp.start(1);
    assert.equal(view.reads, 0);
    assert.deepEqual(seqs(view.applied), ['n2@2', 'n3@3']);

    const below = page();
    below.commit('n1');
    below.commit('n2');
    below.log.prune(2);
    await below.catchUp.start(1);
    assert.equal(below.reads, 1);
    assert.deepEqual(seqs(below.applied), []);
    assert.equal(below.catchUp.cursor(), 2);
  });

  it('reads the projection again when its client reconnects, never on its first connection', async () => {
    const view = page();
    /** @type {Set<(state: ConnectionState) => void>} */
    const states = new Set();
    const client = {
      /** @param {(state: ConnectionState) => void} listener */
      subscribe(listener) {
        states.add(listener);
        return () => states.delete(listener);
      },
    };
    /** @param {ConnectionState} state */
    const tell = state => {
      for (const listener of states) listener(state);
    };
    const withClient = createCatchUp({
      subscribe: () => () => {},
      commitLog: view.log,
      project: async () => {
        view.happened.push('projected');
        return view.log.head();
      },
      apply: () => {},
      client,
    });
    await withClient.start();
    for (const state of /** @type {ConnectionState[]} */ (['connecting', 'connected'])) tell(state);
    await settle();
    assert.equal(view.happened.filter(event => event === 'projected').length, 1);
    for (const state of /** @type {ConnectionState[]} */ (['idle', 'connecting', 'connected'])) tell(state);
    await settle();
    assert.equal(view.happened.filter(event => event === 'projected').length, 2);
    withClient.stop();
    for (const state of /** @type {ConnectionState[]} */ (['idle', 'connecting', 'connected'])) tell(state);
    await settle();
    assert.equal(view.happened.filter(event => event === 'projected').length, 2);
  });

  it('keeps its cursor when the log or an apply fails, so the next hint catches up from where it was', async () => {
    let failRead = false;
    let failApply = false;
    const log = createMemoryCommitLog();
    /** @type {Set<(hint: Hint) => void>} */
    const listeners = new Set();
    /** @type {string[]} */
    const applied = [];
    const catchUp = createCatchUp({
      subscribe: listener => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      commitLog: {
        readChangesSince: async (cursor, limit) => {
          if (failRead) {
            failRead = false;
            throw new UnavailableError('storage', 'read-failed', true);
          }
          return log.readChangesSince(cursor, limit);
        },
        head: () => log.head(),
      },
      project: () => log.head(),
      apply: entries => {
        if (failApply) {
          failApply = false;
          throw new Error('a projection that failed to apply');
        }
        applied.push(...entries.map(entry => entry.entityId));
      },
    });
    await catchUp.start();
    /** @param {string} id */
    const hint = id => {
      const commitSeq = log.append([{ entityType: 'note', entityId: id, revision: 1 }]);
      for (const listener of listeners) listener({ entityType: 'note', entityId: id, revision: 1, commitSeq });
    };
    failRead = true;
    hint('n1');
    await settle();
    assert.equal(catchUp.cursor(), 0);
    failApply = true;
    hint('n2');
    await settle();
    assert.deepEqual([applied, catchUp.cursor()], [[], 0]);
    hint('n3');
    await settle();
    assert.deepEqual([applied, catchUp.cursor()], [['n1', 'n2', 'n3'], 3]);
  });

  it('hears nothing once stopped', async () => {
    const view = page();
    await view.catchUp.start();
    view.catchUp.stop();
    assert.equal(view.listening, 0);
    view.hint(view.commit('n1'));
    await settle();
    assert.deepEqual(view.applied, []);
  });
});
