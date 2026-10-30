// The IdempotencyLedger port suite on the in-memory ledger, and what only the in-memory one
// does: refusing to record an outcome that leaves no record.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

import { rejected, UnavailableError, unavailable, unknown } from '../../js/kernel/core/contracts/outcomes.js';
import { digestOf } from '../../js/kernel/core/memory/fingerprint.js';
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
      stored: async () => ledger.stored(),
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

describe("the in-memory ledger's digest", () => {
  it('is the SHA-256 of the canonical JSON, keys sorted, as #17 computes it, for any text', () => {
    const values = [
      {},
      { b: 1, a: [2, { d: null, c: 'x' }] },
      { text: 'ünïcödé 日本語 😀 \u0000 "quoted"' },
      { long: 'x'.repeat(100_000) },
      ...[0, 1, 55, 56, 63, 64, 65, 119, 120].map(length => ({ s: 'y'.repeat(length) })),
    ];
    /**
     * @param {unknown} value
     * @returns {unknown}
     */
    const sorted = value => {
      if (Array.isArray(value)) return value.map(sorted);
      if (value === null || typeof value !== 'object') return value;
      const record = /** @type {Record<string, unknown>} */ (value);
      return Object.fromEntries(
        Object.keys(record)
          .sort()
          .map(key => [key, sorted(record[key])]),
      );
    };
    for (const value of values) {
      const expected = createHash('sha256')
        .update(JSON.stringify(sorted(value)), 'utf8')
        .digest('hex');
      assert.equal(digestOf(value), expected);
    }
    assert.equal(digestOf({ a: 1, b: 2 }), digestOf({ b: 2, a: 1 }));
  });
});
