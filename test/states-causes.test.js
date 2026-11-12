'use strict';

// #26 slice 1: #12's and #13's causes. Every code #13's transport answers, every branch of #12's
// outcome union and of its failed queries, and #12's named codes have a cause on the states family,
// and each says what #13's mapping means: a request the router can't accept failed and isn't
// retried, one it won't serve is blocked by policy, a command whose answer didn't come is checked
// by its key before anything else shows, and one that couldn't have started waits on the
// coordinator. What a person sees of a cause comes from the presenter, later in this slice.

const { describe, it, before } = require('node:test');
const assert = require('node:assert/strict');

/** @type {any} */ let causes;
/** @type {any} */ let families;
/** @type {any} */ let outcomes;
/** @type {any} */ let transport;
/** @type {any} */ let kit;
/** @type {any} */ let conformance;
before(async () => {
  causes = await import('../js/states/core/causes.js');
  families = await import('../js/states/core/families.js');
  outcomes = await import('../js/kernel/core/contracts/outcomes.js');
  transport = await import('../js/kernel/core/contracts/transport-codes.js');
  kit = await import('../js/kernel/registry/vocabulary.js');
  conformance = await import('./kernel/registry-conformance.mjs');
});

/** The cause an outcome or a failed query presents through, as its state, reason, retry and action */
const said = (/** @type {any} */ result) => {
  const found = causes.KERNEL_CAUSES.find((/** @type {any} */ c) => c.id === causes.causeIdFor(result));
  return found ? [found.state, found.reason, found.retry, found.action] : null;
};
const asCommand = (/** @type {string} */ code, mayHaveStarted = true) =>
  transport.commandOutcome(code, { commandId: 'command-1', mayHaveStarted });

describe("#12's and #13's causes (#26 slice 1)", () => {
  it('has one cause per id, each the family resolves on every host and whose joined fields keep their rules', () => {
    const ids = causes.KERNEL_CAUSES.map((/** @type {any} */ c) => c.id);
    assert.equal(new Set(ids).size, ids.length);
    for (const host of kit.HOSTS) {
      const resolved = conformance.resolveOne(families.cause, causes.KERNEL_CAUSES, host);
      for (const id of ids) assert.deepEqual([resolved.get(`cause:${id}`)?.state, host], ['enabled', host], id);
    }
    for (const c of causes.KERNEL_CAUSES) {
      assert.deepEqual(families.causeProblems(c), [], c.id);
      assert.equal(c.messageKey, `cause.${c.id}`);
      assert.equal(c.owner, c.group === 'transport' ? 13 : 12, c.id);
      assert.ok(['transport', 'kernel'].includes(c.group), c.id);
    }
  });

  it('has a cause of its own for each of the 13 codes #13 answers', () => {
    const codes = [...transport.VALIDATION_CODES, ...transport.POLICY_CODES, ...transport.NO_ANSWER_CODES];
    for (const code of [...codes, 'too-late', 'resync-required']) {
      const own = causes.KERNEL_CAUSES.find((/** @type {any} */ c) => c.id === code);
      assert.deepEqual([own?.group, own?.owner], ['transport', 13], code);
    }
    assert.equal(codes.length + 2, 13);
  });

  it('fails a request the router cannot accept and never retries it, and blocks one it will not serve on policy', () => {
    for (const code of transport.VALIDATION_CODES) {
      for (const result of [asCommand(code), transport.queryFailure(code)]) {
        const [state, reason, retry, action] = /** @type {any[]} */ (said(result));
        if (code === 'unsupported-version') assert.deepEqual([state, reason, retry, action], ['blocked', 'update-required', 'never', 'reopen']);
        else if (code === 'cancelled') assert.deepEqual([state, retry, action], ['idle', 'user', null]);
        else assert.deepEqual([state, retry], ['failed', 'never'], code);
      }
    }
    for (const code of transport.POLICY_CODES)
      for (const result of [asCommand(code), transport.queryFailure(code)])
        assert.deepEqual(said(result)?.slice(0, 3), ['blocked', 'policy', 'never'], code);
  });

  it('checks a command whose answer did not come by its key first, and blocks one that could not have started', () => {
    for (const code of transport.NO_ANSWER_CODES) {
      // Rule 6: no Retry until the key resolves, whatever the code
      assert.deepEqual(said(asCommand(code)), ['loading', undefined, 'auto', null], code);
      assert.deepEqual(said(transport.queryFailure(code)), ['blocked', 'coordinator', 'auto', 'retry'], code);
      if (code !== 'outcome-unknown')
        assert.deepEqual(said(asCommand(code, false)), ['blocked', 'coordinator', 'auto', 'retry'], code);
    }
    const by = (/** @type {string} */ id) => said({ kind: 'failed', cause: 'coordinator', code: id });
    assert.deepEqual(by('too-late'), ['recovering', undefined, 'never', null]);
    assert.deepEqual(by('resync-required'), ['stale', undefined, 'auto', null]);
  });

  it("has a cause for every branch of #12's outcomes and failed queries, and for its four named codes", () => {
    const code = 'a-domain-code';
    /** @type {Record<string, unknown[]>} */
    const means = {
      validation: ['failed', undefined, 'never', null],
      policy: ['blocked', 'policy', 'never', null],
      'not-found': ['blocked', 'not-found', 'never', null],
      storage: ['failed', undefined, 'user', 'retry'],
      quota: ['blocked', 'quota', 'never', 'free-space'],
      'newer-schema': ['blocked', 'update-required', 'never', 'reopen'],
      adapter: ['failed', undefined, 'user', 'retry'],
      coordinator: ['blocked', 'coordinator', 'auto', 'retry'],
    };
    for (const reason of outcomes.REJECT_REASONS) assert.deepEqual(said(outcomes.rejected(reason, code)), means[reason], reason);
    for (const cause of outcomes.UNAVAILABLE_CAUSES)
      assert.deepEqual(said(outcomes.unavailable(cause, code, true)), means[cause], cause);
    for (const cause of outcomes.FAIL_CAUSES) assert.deepEqual(said(outcomes.failed(cause, code)), means[cause], cause);
    assert.deepEqual(said(outcomes.conflict(code, 3)), ['blocked', 'conflict', 'never', 'keep-mine']);
    assert.deepEqual(said(outcomes.unknown(code, 'command-1')), ['loading', undefined, 'auto', null]);
    assert.equal(causes.causeIdFor(outcomes.committed('saved', ['note-1'])), null);

    // Nothing of a cut turn landed, so the person sends it again
    assert.deepEqual(said(outcomes.unavailable('coordinator', outcomes.TURN_EXCEEDED, true)), ['failed', undefined, 'user', 'retry']);
    assert.deepEqual(said(outcomes.unavailableFrom(new Error('a port threw'))), ['failed', undefined, 'user', 'retry']);
    for (const named of ['revision-conflict', 'placement-conflict'])
      assert.deepEqual(said(outcomes.conflict(named, 3)), ['blocked', 'conflict', 'never', 'keep-mine'], named);
    for (const named of [outcomes.TURN_EXCEEDED, 'adapter-failed', 'revision-conflict', 'placement-conflict'])
      assert.ok(causes.CODE_CAUSES.has(named), named);
  });
});
