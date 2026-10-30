// The IdempotencyLedger port suite (#13, "Idempotency and catch-up"). Any ledger can run it:
// idempotency-ledger.test.mjs runs it on the in-memory ledger, and #17 runs it on its durable
// one. The port is the read a client makes after a lost reply, so the suite holds that read to
// three answers by the command's key, committed, conflict, or absent, plus key reuse, and to
// writing nothing: a read never reserves a key, as the kernel adapter's recall does for a bulk
// command (#12 slice 3's verification), so a key read before its command ran still commits.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { committed, conflict, UnavailableError } from '../../js/kernel/core/contracts/outcomes.js';

/** @typedef {import('../../js/kernel/core/ports/idempotency-ledger.js').IdempotencyLedger} IdempotencyLedger */
/** @typedef {import('../../js/kernel/core/ports/idempotency-ledger.js').KeyedCommand} KeyedCommand */
/** @typedef {import('../../js/kernel/core/ports/idempotency-ledger.js').LedgerRead} LedgerRead */
/** @typedef {import('../../js/kernel/core/contracts/outcomes.js').Committed} Committed */
/** @typedef {import('../../js/kernel/core/contracts/outcomes.js').Conflict} Conflict */

/**
 * One run of the suite against one ledger
 * @typedef {object} LedgerContext
 * @property {IdempotencyLedger} ledger
 * @property {(command: KeyedCommand, outcome: Committed | Conflict) => Promise<LedgerRead>} record
 *   Keeps `outcome` for the command's key, as the ledger's adapter does in the transaction that
 *   commits the command, and answers what the ledger then holds for that command
 * @property {() => Promise<void>} [failNextRead] - makes the next read fail, from a fixture that can
 * @property {() => Promise<unknown>} stored - everything the ledger keeps, as it keeps it
 * @property {() => Promise<void>} close
 */

/**
 * @typedef {object} LedgerFixture
 * @property {string} name
 * @property {() => Promise<LedgerContext>} start
 */

/** @returns {KeyedCommand} */
const pin = (commandId = 'c1', pinned = true) => ({ type: 'setPinned', commandId, noteId: 'n1', pinned });

const pinned = committed('note-pinned', ['n1'], { revision: 3, commitSeq: 7 });

/**
 * Runs the suite against one ledger
 * @param {LedgerFixture} fixture
 */
export function describeIdempotencyLedger(fixture) {
  /**
   * @param {(context: LedgerContext) => Promise<void>} body
   */
  const using = body => async () => {
    const context = await fixture.start();
    try {
      await body(context);
    } finally {
      await context.close();
    }
  };

  describe(`the ${fixture.name} IdempotencyLedger (#13, "Idempotency and catch-up")`, () => {
    it(
      'reads a key it has no record of as absent',
      using(async ({ ledger }) => {
        assert.deepEqual(await ledger.read(pin()), { status: 'absent' });
      }),
    );

    it(
      'reads back the committed outcome a key was recorded with, commitSeq and revision included',
      using(async ({ ledger, record }) => {
        assert.deepEqual(await record(pin(), pinned), { status: 'committed', outcome: pinned });
        assert.deepEqual(await ledger.read(pin()), { status: 'committed', outcome: pinned });
      }),
    );

    it(
      'reads back a conflict as a conflict, with the revision the command lost to',
      using(async ({ ledger, record }) => {
        const lost = conflict('revision-mismatch', 4);
        await record(pin(), lost);
        assert.deepEqual(await ledger.read(pin()), { status: 'conflict', outcome: lost });
      }),
    );

    it(
      'answers key reuse for the same key with another command, by its canonical form, not its key order',
      using(async ({ ledger, record }) => {
        await record(pin(), pinned);
        assert.deepEqual(await ledger.read(pin('c1', false)), { status: 'key-reuse' });
        assert.deepEqual(await ledger.read({ pinned: true, noteId: 'n1', commandId: 'c1', type: 'setPinned' }), {
          status: 'committed',
          outcome: pinned,
        });
      }),
    );

    it(
      'keeps the first record for a key: a second one leaves it as it was',
      using(async ({ ledger, record }) => {
        await record(pin(), pinned);
        const other = committed('note-pinned', ['n1'], { revision: 9, commitSeq: 99 });
        assert.deepEqual(await record(pin(), other), { status: 'committed', outcome: pinned });
        assert.deepEqual(await record(pin('c1', false), other), { status: 'key-reuse' });
        assert.deepEqual(await ledger.read(pin()), { status: 'committed', outcome: pinned });
      }),
    );

    it(
      'writes nothing when it reads: a key read as absent is recorded by the first command that commits it',
      using(async ({ ledger, record }) => {
        assert.deepEqual(await ledger.read(pin('c1', false)), { status: 'absent' });
        assert.deepEqual(await ledger.read(pin()), { status: 'absent' });
        assert.deepEqual(await record(pin(), pinned), { status: 'committed', outcome: pinned });
      }),
    );

    it(
      'keeps keys apart, and answers copies the caller cannot change',
      using(async ({ ledger, record }) => {
        await record(pin('c1'), pinned);
        assert.deepEqual(await ledger.read(pin('c2')), { status: 'absent' });
        const read = /** @type {{outcome: Committed}} */ (await ledger.read(pin('c1')));
        read.outcome.changedIds.push('changed');
        assert.deepEqual(await ledger.read(pin('c1')), { status: 'committed', outcome: pinned });
      }),
    );

    it(
      'refuses a command without a key, with the adapter cause, and keeps no record of it',
      using(async ({ ledger, record }) => {
        for (const commandId of ['', undefined, 7]) {
          const command = /** @type {KeyedCommand} */ ({ ...pin(), commandId });
          await assert.rejects(ledger.read(command), error => {
            assert.ok(error instanceof UnavailableError);
            assert.deepEqual([error.unavailableCause, error.code], ['adapter', 'invalid-key']);
            return true;
          });
          await assert.rejects(record(command, pinned), UnavailableError);
        }
      }),
    );

    it(
      'keeps a digest of each command, never the command: no stored value holds what its payload says',
      using(async ({ ledger, record, stored }) => {
        const create = {
          type: 'createNote',
          commandId: 'c9',
          noteId: 'n9',
          name: 'A private title',
          blocks: [{ id: 'b9', content: 'Private words, ünïcödé' }],
        };
        const created = committed('note-created', ['n9'], { commitSeq: 1 });
        await record(create, created);
        assert.deepEqual(await ledger.read(create), { status: 'committed', outcome: created });
        const kept = JSON.stringify(await stored());
        for (const text of ['A private title', 'Private words', 'createNote', '"b9"', 'noteId']) {
          assert.equal(kept.includes(text), false, `the ledger keeps ${text}`);
        }
      }),
    );

    it(
      'rejects a read it could not make with an UnavailableError, never an answer',
      using(async context => {
        if (!context.failNextRead) return;
        await context.record(pin(), pinned);
        await context.failNextRead();
        await assert.rejects(context.ledger.read(pin()), UnavailableError);
        assert.deepEqual(await context.ledger.read(pin()), { status: 'committed', outcome: pinned });
      }),
    );
  });
}
