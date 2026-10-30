// The IdempotencyLedger port suite on the in-memory ledger, and what only the in-memory one
// does: refusing to record an outcome that leaves no record.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { rejected, UnavailableError, unavailable, unknown } from '../../js/kernel/core/contracts/outcomes.js';
import { createMemoryLedger } from '../../js/kernel/core/memory/ledger.js';
import { describeIdempotencyLedger } from './idempotency-ledger-suite.mjs';

describeIdempotencyLedger({
  name: 'in-memory',
  async start() {
    let failing = false;
    const ledger = createMemoryLedger({
      beforeRead() {
        if (!failing) return;
        failing = false;
        throw new UnavailableError('storage', 'read-failed', true);
      },
    });
    return {
      ledger,
      record: async (command, outcome) => ledger.record(command, outcome),
      failNextRead: async () => {
        failing = true;
      },
      close: async () => {},
    };
  },
});

describe('the in-memory IdempotencyLedger', () => {
  it('records only committed and conflict outcomes, since a rejection or an unanswered command leaves no record', async () => {
    const ledger = createMemoryLedger();
    const command = { type: 'setPinned', commandId: 'c1', noteId: 'n1', pinned: true };
    for (const outcome of [
      rejected('validation', 'invalid-payload'),
      unavailable('storage', 'write-failed', true),
      unknown('outcome-unknown', 'c1'),
    ]) {
      assert.throws(() => ledger.record(command, /** @type {any} */ (outcome)), TypeError);
    }
    assert.deepEqual(await ledger.read(command), { status: 'absent' });
  });
});
