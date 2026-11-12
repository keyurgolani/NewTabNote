'use strict';

// #26 slice 1: the presenter, one pure function from what happened, the contribution's rows and the
// surface to the state a person sees. None of AC4's nine fixtures shows a success token or word; a
// failed read is never empty (rule 1); "nothing changed" needs a refusal, a request that never
// reached the coordinator, or a read; an unknown command shows Retry only once its key allows one
// resend, with the same key (rule 6; #13's client resolving the key and committing once is
// test/kernel/outcome-resolution.test.mjs); Moment has no offline state and the presenter reaches
// no strings; one primary action at most, and Inspect holds only its five fields; no input's own
// text gets through (AC8); and #20's provider statuses map as #26's View states say.

const { describe, it, before } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const CANARY = 'canary-7f3a, a note title or an error message';

/** @type {any} */ let presenter;
/** @type {any} */ let outcomes;
/** @type {any} */ let transport;
/** @type {any} */ let words;
/** @type {any} */ let catalog;
/** @type {any} */ let causes;
/** @type {any} */ let trust;
/** @type {any} */ let kit;
/** @type {any} */ let graph;
/** @type {any} */ let kernelChunk;
/** @type {Record<string, string>} */
let strings = {};
before(async () => {
  presenter = await import('../js/states/core/presenter.js');
  outcomes = await import('../js/kernel/core/contracts/outcomes.js');
  transport = await import('../js/kernel/core/contracts/transport-codes.js');
  words = await import('../js/states/core/vocabulary.js');
  catalog = await import('../js/states/core/catalog.js');
  causes = await import('../js/states/core/causes.js');
  trust = await import('../js/trust/core/vocabulary.js');
  kit = await import('../js/kernel/registry/vocabulary.js');
  graph = await import('./kernel/import-graph.mjs');
  kernelChunk = (await import('../js/states/catalog/chunks.js')).CHUNKS.find((/** @type {any} */ c) => c.id === 'kernel');
  strings = (await kernelChunk.load()).default;
});

/** A row to vary: a list's empty state, which offers New note */
const ROW = {
  messageKey: 'state.empty.headline',
  dataChanged: 'none',
  preserved: ['capture'],
  primaryAction: 'new-note',
  politeness: 'polite',
  placement: 'region',
  atomicity: 'atomic',
  staleness: 'revision',
};

const show = (/** @type {any} */ input, rows = {}, surface = { host: 'workspace' }) =>
  presenter.present(input, rows, surface);

/** The words a view shows and announces, its headline and its message, formatted from the kernel chunk */
const wordsOf = (/** @type {any} */ view, /** @type {string} */ host) =>
  [view.headline, view.message]
    .filter(Boolean)
    .map(key => catalog.format(strings[key], kernelChunk.parameters[key] ?? {}, view.params, host));

const unit = (/** @type {string} */ id, saved = true) => ({
  id,
  outcome: saved ? outcomes.committed('archived', [id]) : outcomes.unavailable('storage', 'write-failed', true),
});

describe('the states presenter (#26 slice 1)', () => {
  it('shows no success token or word for any of the nine fixtures on any host, and in partial only the committed list claims one', () => {
    const fixtures = {
      // An interim provider or a stub connector, which hasn't verified
      placeholder: { kind: 'provider', status: 'unverified' },
      // A command that ran and changed nothing
      skipped: outcomes.committed('saved', [], { severity: 'info' }),
      // A fallback answered in the provider's place
      'fallback-used': { kind: 'provider', status: 'degraded' },
      partial: outcomes.bulk('archive-notes', [unit('a'), unit('b'), unit('c', false)]),
      // Configured, and waiting on the person
      'configured-only': { kind: 'provider', status: 'action-required' },
      // Handed to the coordinator, with no answer yet
      'handed-off': { kind: 'pending' },
      // No error, and no proof yet
      'no-error-without-proof': { kind: 'provider', status: 'checking' },
      stale: outcomes.stale(1, []),
      unknown: outcomes.unknown('outcome-unknown', 'command-1'),
    };
    for (const host of kit.HOSTS) {
      for (const [name, input] of Object.entries(fixtures)) {
        const view = show(input, {}, { host });
        assert.notEqual(view.tone, 'sage', `${name} on ${host}`);
        for (const text of wordsOf(view, host)) {
          assert.notEqual(text, null, `${name} on ${host}: a string without its parameters`);
          assert.ok(!catalog.claimsSuccess(text), `${name} on ${host}: ${text}`);
        }
      }
    }
    const { units } = show(fixtures.partial);
    assert.deepEqual([units.committed.ids, units.failed.ids], [['a', 'b'], ['c']]);
    assert.ok(catalog.claimsSuccess(strings[units.committed.label]));
    assert.ok(!catalog.claimsSuccess(strings[units.failed.label]));
  });

  it('presents a failed read as failed or blocked, never empty, and an empty list in a repair points to Recovery Center', () => {
    for (const cause of outcomes.FAIL_CAUSES) {
      const { state } = show(outcomes.failed(cause, 'read-failed'), { empty: ROW });
      assert.ok(['failed', 'blocked'].includes(state), `${cause}: ${state}`);
    }
    const empty = outcomes.empty(1);
    assert.deepEqual(show(empty, { empty: ROW }).primary, { action: 'new-note' });
    const repairing = show(empty, { empty: ROW }, { host: 'workspace', incident: true });
    assert.deepEqual([repairing.state, repairing.primary], ['empty', { action: 'open', destination: 'recovery-center' }]);
    assert.deepEqual(show(empty, { empty: ROW }, { host: 'workspace', filters: 2 }).primary, { action: 'clear-filters' });
  });

  it('says nothing changed only for a refused command, one that never reached the coordinator, or a read', () => {
    const changed = (/** @type {any} */ input) => show(input).dataChanged;
    assert.equal(changed(outcomes.rejected('validation', 'invalid-payload')), 'none');
    assert.equal(changed(outcomes.conflict('revision-conflict', 3)), 'none');
    assert.equal(changed(transport.commandOutcome('unavailable', { commandId: 'command-1', mayHaveStarted: false })), 'none');
    assert.equal(changed(outcomes.failed('storage', 'read-failed')), 'none');
    assert.equal(changed(outcomes.unknown('deadline-exceeded', 'command-1')), 'unknown');
    assert.equal(changed(outcomes.unavailableFrom(new Error('a port threw'))), 'unknown');
    assert.equal(changed(outcomes.committed('saved', ['note-1'])), 'committed');
  });

  it('shows an unknown command as loading with no Retry while its key is checked, and Retry with that key once it may resend', () => {
    const lost = outcomes.unknown('outcome-unknown', 'command-7');
    const checking = show(lost);
    assert.deepEqual([checking.state, checking.primary, strings[checking.message]], ['loading', null, 'Checking whether this saved']);
    const cleared = show({ ...lost, resend: true });
    assert.deepEqual([cleared.state, cleared.primary], ['failed', { action: 'retry', commandId: 'command-7' }]);
  });

  it('gives Moment no offline state, and reaches no catalog chunk, trust core or DOM module', () => {
    const offline = { id: 'host-unreachable', state: 'offline', retry: 'auto', messageKey: 'cause.host-unreachable', action: 'reconnect' };
    const input = { kind: 'unavailable', cause: 'adapter', code: 'host-unreachable', retryable: true, host: 'localhost:11434' };
    const registered = [...causes.KERNEL_CAUSES, offline];
    assert.equal(presenter.present(input, {}, { host: 'moment' }, registered), null);
    const elsewhere = presenter.present(input, {}, { host: 'workspace' }, registered);
    assert.deepEqual([elsewhere.state, elsewhere.params], ['offline', { host: 'localhost:11434' }]);
    const reached = [...graph.importGraph(path.join(ROOT, 'js/states/core/presenter.js'))].map(file => path.relative(ROOT, file));
    assert.deepEqual(reached.filter(file => !/^js\/(states\/core|kernel\/core|kernel\/registry)\//.test(file)), []);
  });

  it('offers one primary action at most, from the list, and Inspect only as secondary with the five fields it may hold', () => {
    const codes = [...transport.VALIDATION_CODES, ...transport.POLICY_CODES, ...transport.NO_ANSWER_CODES];
    const inputs = [
      ...codes.map(code => transport.commandOutcome(code, { commandId: 'command-1', mayHaveStarted: false })),
      ...codes.map(code => transport.queryFailure(code)),
      ...outcomes.UNAVAILABLE_CAUSES.map((/** @type {string} */ cause) => outcomes.unavailable(cause, 'x', true)),
      ...Object.keys(presenter.PROVIDER_STATES).map(status => ({ kind: 'provider', status })),
      { kind: 'pending' },
      outcomes.loading(),
      outcomes.ready(1, []),
      outcomes.empty(1),
    ];
    for (const input of inputs) {
      const view = show({ ...input, subsystem: 'sync', provider: 'webdav', httpStatus: 503, correlationId: 'c-1' });
      assert.ok(words.STATES.includes(view.state), view.state);
      if (view.primary) assert.ok(words.ACTIONS.includes(view.primary.action), view.primary.action);
      assert.deepEqual(view.secondary, [words.INSPECT]);
      assert.deepEqual(Object.keys(view.inspect).filter(field => !presenter.INSPECTED.includes(field)), []);
    }
  });

  it("lets no input's own text through: a canary in an extra field, an error's message or a provider's body shows nowhere", () => {
    const refused = { ...outcomes.rejected('policy', 'not-yours'), message: CANARY };
    for (const input of [
      { ...outcomes.rejected('validation', 'invalid-payload'), message: CANARY, error: { message: CANARY } },
      { ...outcomes.unavailableFrom(new Error(CANARY)), detail: CANARY },
      { kind: 'provider', status: 'failed', body: CANARY, message: CANARY },
      { ...outcomes.bulk('archive-notes', [unit('a'), { id: 'b', outcome: refused }]), note: CANARY },
    ])
      assert.ok(!JSON.stringify(show(input)).includes(CANARY), JSON.stringify(show(input)));
  });

  it("maps each of #20's provider statuses as #26 says, and keys exactly #20's statuses", () => {
    assert.deepEqual(Object.keys(presenter.PROVIDER_STATES), [...trust.PROVIDER_STATUSES]);
    const at = (/** @type {string} */ status, rows = {}) => {
      const view = show({ kind: 'provider', status }, rows);
      return [view.state, view.reason, view.tone];
    };
    assert.deepEqual(at('checking'), ['refreshing', undefined, 'sand']);
    assert.deepEqual(at('verified'), ['ready', undefined, 'sage']);
    for (const status of ['unverified', 'stale', 'degraded']) assert.deepEqual(at(status), ['stale', undefined, 'clay'], status);
    for (const status of ['off', 'not-configured']) assert.equal(at(status)[0], 'idle', status);
    assert.deepEqual(at('locked'), ['blocked', 'vault-locked', 'clay']);
    for (const status of ['unsupported', 'action-required']) assert.equal(at(status)[0], 'blocked', status);
    assert.equal(at('degraded', { partial: ROW })[0], 'partial');
    assert.equal(at('failed')[0], 'failed');
  });
});
