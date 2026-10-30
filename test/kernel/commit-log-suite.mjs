// The CommitLog port suite (#13, "Idempotency and catch-up"): the cursor read over #17's
// change log that the refined body calls CommitFeed, kept apart by name from #12's in-process
// `{aggregate, ids}` publisher. Any log can run it: commit-log.test.mjs runs it on the
// in-memory one, and #17 runs it on its durable one. A page reads it from its cursor after a
// hint, a reconnect, or a reload, so the suite holds it to every commit after the cursor, in
// order, never half a commit, and to `resync-required` for a cursor it can't serve.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { UnavailableError } from '../../js/kernel/core/contracts/outcomes.js';

/** @typedef {import('../../js/kernel/core/ports/commit-log.js').CommitLog} CommitLog */
/** @typedef {import('../../js/kernel/core/ports/commit-log.js').Change} Change */

/**
 * One run of the suite against one log
 * @typedef {object} CommitLogContext
 * @property {CommitLog} log
 * @property {(changes: Change[]) => Promise<number>} append
 *   Appends one commit's changes, as the log's adapter does in the commit's transaction, and
 *   answers its commitSeq
 * @property {(through: number) => Promise<void>} prune
 *   Drops every commit up to `through`, as #19's retention will, which raises the floor
 * @property {() => Promise<void>} [failNextRead]
 * @property {() => Promise<void>} close
 */

/**
 * @typedef {object} CommitLogFixture
 * @property {string} name
 * @property {() => Promise<CommitLogContext>} start
 */

/**
 * A change to note `id`
 * @param {string} id
 * @param {number} [revision]
 * @returns {Change}
 */
const note = (id, revision = 1) => ({ entityType: 'note', entityId: id, revision });

/**
 * Runs the suite against one log
 * @param {CommitLogFixture} fixture
 */
export function describeCommitLog(fixture) {
  /** @param {(context: CommitLogContext) => Promise<void>} body */
  const using = body => async () => {
    const context = await fixture.start();
    try {
      await body(context);
    } finally {
      await context.close();
    }
  };

  describe(`the ${fixture.name} CommitLog (#13, "Idempotency and catch-up")`, () => {
    it(
      'starts empty: its head is 0, and a read from 0 has nothing',
      using(async ({ log }) => {
        assert.equal(await log.head(), 0);
        assert.deepEqual(await log.readChangesSince(0, 10), { kind: 'changes', entries: [], cursor: 0, more: false });
      }),
    );

    it(
      'numbers each commit from 1, one commitSeq for all of its changes',
      using(async ({ log, append }) => {
        assert.equal(await append([note('n1')]), 1);
        assert.equal(await append([note('n2', 3), { entityType: 'folder', entityId: 'f1', revision: 0 }]), 2);
        assert.equal(await log.head(), 2);
        assert.deepEqual(await log.readChangesSince(0, 10), {
          kind: 'changes',
          entries: [
            { commitSeq: 1, ...note('n1') },
            { commitSeq: 2, ...note('n2', 3) },
            { commitSeq: 2, entityType: 'folder', entityId: 'f1', revision: 0 },
          ],
          cursor: 2,
          more: false,
        });
      }),
    );

    it(
      'answers only the commits after the cursor, and nothing at its head',
      using(async ({ log, append }) => {
        for (const id of ['n1', 'n2', 'n3']) await append([note(id)]);
        assert.deepEqual(await log.readChangesSince(1, 10), {
          kind: 'changes',
          entries: [
            { commitSeq: 2, ...note('n2') },
            { commitSeq: 3, ...note('n3') },
          ],
          cursor: 3,
          more: false,
        });
        assert.deepEqual(await log.readChangesSince(3, 10), { kind: 'changes', entries: [], cursor: 3, more: false });
      }),
    );

    it(
      'reads at most `limit` commits at a time, never half of one, and says when more follow',
      using(async ({ log, append }) => {
        await append([note('n1')]);
        await append([note('n2'), note('n3')]);
        await append([note('n4')]);
        const first = await log.readChangesSince(0, 2);
        assert.deepEqual(first, {
          kind: 'changes',
          entries: [
            { commitSeq: 1, ...note('n1') },
            { commitSeq: 2, ...note('n2') },
            { commitSeq: 2, ...note('n3') },
          ],
          cursor: 2,
          more: true,
        });
        assert.deepEqual(await log.readChangesSince(first.kind === 'changes' ? first.cursor : -1, 2), {
          kind: 'changes',
          entries: [{ commitSeq: 3, ...note('n4') }],
          cursor: 3,
          more: false,
        });
      }),
    );

    it(
      'answers resync-required for a cursor below its floor, and serves the floor itself',
      using(async ({ log, append, prune }) => {
        for (const id of ['n1', 'n2', 'n3', 'n4']) await append([note(id)]);
        await prune(2);
        assert.deepEqual(await log.readChangesSince(1, 10), { kind: 'resync-required', floor: 2, head: 4 });
        assert.deepEqual(await log.readChangesSince(0, 10), { kind: 'resync-required', floor: 2, head: 4 });
        assert.deepEqual(await log.readChangesSince(2, 10), {
          kind: 'changes',
          entries: [
            { commitSeq: 3, ...note('n3') },
            { commitSeq: 4, ...note('n4') },
          ],
          cursor: 4,
          more: false,
        });
        assert.equal(await log.head(), 4);
      }),
    );

    it(
      'answers resync-required for a cursor past its head, as when the log was replaced under a page',
      using(async ({ log, append }) => {
        await append([note('n1')]);
        assert.deepEqual(await log.readChangesSince(5, 10), { kind: 'resync-required', floor: 0, head: 1 });
      }),
    );

    it(
      'refuses a cursor or a limit that is no count, with the adapter cause',
      using(async ({ log }) => {
        for (const [cursor, limit, code] of /** @type {Array<[unknown, unknown, string]>} */ ([
          [-1, 10, 'invalid-cursor'],
          [1.5, 10, 'invalid-cursor'],
          ['0', 10, 'invalid-cursor'],
          [0, 0, 'invalid-limit'],
          [0, Number.POSITIVE_INFINITY, 'invalid-limit'],
          [0, undefined, 'invalid-limit'],
        ])) {
          await assert.rejects(
            log.readChangesSince(/** @type {number} */ (cursor), /** @type {number} */ (limit)),
            error => {
              assert.ok(error instanceof UnavailableError);
              assert.deepEqual([error.unavailableCause, error.code], ['adapter', code]);
              return true;
            },
          );
        }
      }),
    );

    it(
      'answers copies the caller cannot change',
      using(async ({ log, append }) => {
        await append([note('n1')]);
        const read = await log.readChangesSince(0, 10);
        if (read.kind === 'changes') /** @type {any} */ (read.entries[0]).entityId = 'changed';
        assert.deepEqual(await log.readChangesSince(0, 10), {
          kind: 'changes',
          entries: [{ commitSeq: 1, ...note('n1') }],
          cursor: 1,
          more: false,
        });
      }),
    );

    it(
      'rejects a read it could not make with an UnavailableError',
      using(async context => {
        if (!context.failNextRead) return;
        await context.append([note('n1')]);
        await context.failNextRead();
        await assert.rejects(context.log.readChangesSince(0, 10), UnavailableError);
        assert.equal((await context.log.readChangesSince(0, 10)).kind, 'changes');
      }),
    );
  });
}
