// The outcome union, the query states, and the copy every value takes into and out of the
// kernel.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';

import { NotCloneableError, clone } from '../../js/kernel/core/contracts/clone.js';
import {
  OUTCOME_KINDS,
  QUERY_STATES,
  UnavailableError,
  bulk,
  committed,
  conflict,
  empty,
  failed,
  failedFrom,
  isOutcome,
  loading,
  ready,
  rejected,
  stale,
  unavailable,
  unavailableFrom,
  unknown,
} from '../../js/kernel/core/contracts/outcomes.js';

describe('outcomes', () => {
  it('each kind has its fields, a messageKey, and a severity', () => {
    assert.deepEqual(committed('note-created', ['n1'], { revision: 3 }), {
      kind: 'committed',
      code: 'note-created',
      changedIds: ['n1'],
      revision: 3,
      messageKey: 'committed.note-created',
      severity: 'success',
    });
    assert.deepEqual(committed('title-kept', [], { severity: 'info' }).severity, 'info');
    assert.deepEqual(rejected('policy', 'not-on-surface'), {
      kind: 'rejected',
      reason: 'policy',
      code: 'not-on-surface',
      messageKey: 'rejected.not-on-surface',
      severity: 'error',
    });
    assert.equal(rejected('validation', 'folder-into-itself').severity, 'warning');
    assert.equal(rejected('not-found', 'note-not-found').severity, 'warning');
    assert.deepEqual(conflict('revision-conflict', 4), {
      kind: 'conflict',
      code: 'revision-conflict',
      currentRevision: 4,
      messageKey: 'conflict.revision-conflict',
      severity: 'warning',
    });
    assert.deepEqual(unavailable('quota', 'quota-exceeded', false), {
      kind: 'unavailable',
      cause: 'quota',
      code: 'quota-exceeded',
      retryable: false,
      messageKey: 'unavailable.quota-exceeded',
      severity: 'error',
    });
    assert.deepEqual(unknown('no-answer', 'c1'), {
      kind: 'unknown',
      code: 'no-answer',
      commandId: 'c1',
      messageKey: 'unknown.no-answer',
      severity: 'warning',
    });
    assert.deepEqual(OUTCOME_KINDS, ['committed', 'rejected', 'conflict', 'unavailable', 'unknown']);
  });

  it('a bulk outcome lists each item and counts only the committed ones', () => {
    const ok = committed('note-trashed', ['a']);
    const missing = rejected('not-found', 'note-not-found');
    const all = bulk('trash', [{ id: 'a', outcome: ok }]);
    const some = bulk('trash', [
      { id: 'a', outcome: ok },
      { id: 'b', outcome: missing },
    ]);
    const none = bulk('trash', [{ id: 'b', outcome: missing }]);
    assert.deepEqual(
      [all, some, none].map(result => [result.committedIds, result.severity]),
      [
        [['a'], 'success'],
        [['a'], 'warning'],
        [[], 'error'],
      ],
    );
    assert.deepEqual([some.kind, some.messageKey, some.items.length], ['bulk', 'bulk.trash', 2]);
  });

  it('isOutcome knows the five kinds and nothing else', () => {
    assert.ok(isOutcome(committed('x', [])));
    assert.ok(isOutcome(unknown('x', 'c')));
    for (const value of [null, undefined, 'committed', {}, { kind: 'bulk' }, { kind: 'ready' }])
      assert.ok(!isOutcome(value));
  });

  it('turns an UnavailableError into its outcome, and anything else into an adapter failure', () => {
    assert.deepEqual(
      unavailableFrom(new UnavailableError('storage', 'write-failed', true)),
      unavailable('storage', 'write-failed', true),
    );
    assert.deepEqual(unavailableFrom(new TypeError('boom')), unavailable('adapter', 'adapter-failed', true));
    assert.deepEqual(
      failedFrom(new UnavailableError('newer-schema', 'newer-schema', false)),
      failed('newer-schema', 'newer-schema'),
    );
    assert.equal(new UnavailableError('quota', 'quota-exceeded', false).message, 'quota: quota-exceeded');
  });

  it('query states', () => {
    assert.deepEqual(
      [loading(), ready(5, [1]), empty(5), stale(4, [1]), failed('policy', 'not-on-surface')],
      [
        { kind: 'loading' },
        { kind: 'ready', asOf: 5, data: [1] },
        { kind: 'empty', asOf: 5 },
        { kind: 'stale', asOf: 4, data: [1] },
        { kind: 'failed', cause: 'policy', code: 'not-on-surface' },
      ],
    );
    assert.deepEqual(QUERY_STATES, ['loading', 'ready', 'empty', 'stale', 'failed']);
  });
});

describe('clone', () => {
  it('copies plain objects, arrays, Dates, and primitives, nested', () => {
    const value = { a: [1, 'two', null, undefined, { b: true }], at: new Date(5), nested: { deep: { n: -0 } } };
    const copy = clone(value);
    assert.deepEqual(copy, value);
    assert.notEqual(copy.a, value.a);
    assert.notEqual(copy.at, value.at);
    assert.ok(copy.at instanceof Date);
    assert.equal(copy.a.length, 5);
  });

  it("copies another realm's plain objects, as the legacy scripts make them", () => {
    const foreign = vm.runInNewContext('({ list: [1, 2], when: new Date(3) })');
    assert.deepEqual(JSON.stringify(clone(foreign)), JSON.stringify(foreign));
  });

  it('refuses what structured clone refuses, and what the kernel never stores', () => {
    const cycle = /** @type {Record<string, unknown>} */ ({});
    cycle.self = cycle;
    class Note {}
    for (const value of [() => 1, Symbol('x'), cycle, { at: new Note() }, new Map(), [Promise.resolve()]]) {
      assert.throws(() => clone(value), NotCloneableError);
    }
    // The same object twice is fine, as long as it doesn't contain itself
    const shared = { x: 1 };
    assert.deepEqual(clone({ a: shared, b: shared }), { a: { x: 1 }, b: { x: 1 } });
  });
});
