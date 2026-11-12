// #26 slice 1: the states contract's words and its cause family on #15's kit. A cause draws its
// state, a blocked state's reason, how it retries and its one action from the vocabulary's closed
// lists. The kit leaves a cause with a bad field unresolved, and causeProblems holds the rules that
// join two fields. The state matrix holds one descriptor per contribution, with a row for each
// state it can be in or the reason a state can't arise.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { HOSTS } from '../../js/kernel/registry/vocabulary.js';
import { cause, causeProblems, matrix } from '../../js/states/core/families.js';
import * as words from '../../js/states/core/vocabulary.js';
import { describeRegistryConformance, resolveOne } from './registry-conformance.mjs';

/** @typedef {import('../../js/kernel/registry/validate.js').Descriptor} Descriptor */

/** The kit's fields every sample shares, and what a sample cause says */
const SHARED = { version: 1, apiVersion: 1, group: 'kernel', hosts: [...HOSTS], label: 'A sample cause', owner: 26 };
const SAYS = { state: 'failed', retry: 'user', userCanFix: false, action: 'retry' };

/**
 * A valid cause to vary
 * @param {string} id
 * @param {number} rank
 * @returns {Descriptor}
 */
const sample = (id, rank) => ({ ...SHARED, ...SAYS, id, rank, messageKey: `cause.${id}` });

describeRegistryConformance('states causes', { family: cause, builtIns: [], sample });

/**
 * A descriptor's state and reason once resolved on its own, in the cause family unless named
 * @param {Descriptor} descriptor
 * @param {import('../../js/kernel/registry/family.js').Family} [family]
 */
const resolved = (descriptor, family = cause) => {
  const contribution = resolveOne(family, [descriptor], 'workspace').get(`${family.id}:${descriptor.id}`);
  return contribution ? [contribution.state, contribution.reason] : null;
};

/** A state row to vary */
const ROW = {
  messageKey: 'state.failed.headline',
  dataChanged: 'none',
  preserved: ['capture'],
  primaryAction: 'retry',
  politeness: 'assertive',
  placement: 'inline',
  atomicity: 'atomic',
  staleness: 'none',
};

/**
 * A valid matrix descriptor to vary: a command's failed row, and why it is never empty
 * @param {string} id
 * @param {number} rank
 * @returns {Descriptor}
 */
const matrixSample = (id, rank) => ({
  ...SHARED,
  group: 'command',
  id,
  rank,
  subject: id,
  states: { failed: ROW, empty: { notApplicable: 'A command reads nothing, so it is never empty' } },
});

describeRegistryConformance('states matrix', { family: matrix, builtIns: [], sample: matrixSample });

describe("the states contract's words (#26 slice 1)", () => {
  it('names the 11 view states, the 10 reasons a state is blocked, and 22 actions, with Inspect apart', () => {
    assert.deepEqual(words.STATES, [
      ...['idle', 'loading', 'refreshing', 'ready', 'empty', 'stale'],
      ...['offline', 'blocked', 'partial', 'failed', 'recovering'],
    ]);
    assert.deepEqual(words.BLOCKED_REASONS, [
      ...['permission', 'authentication', 'vault-locked', 'quota', 'policy', 'conflict'],
      ...['migration-pending', 'coordinator', 'update-required', 'not-found'],
    ]);
    assert.deepEqual(words.ACTIONS, [
      ...['retry', 'reconnect', 'grant', 'unlock', 'free-space', 'restore', 'recover', 'export', 'copy-text'],
      ...['clear-filters', 'new-note', 'continue', 'open', 'reopen', 'save-to-inbox', 'save-as-new-note'],
      ...['keep-mine', 'view-previous-value', 'resume', 'roll-back', 'create-verified-backup', 'load'],
    ]);
    assert.ok(!(/** @type {readonly string[]} */ (words.ACTIONS).includes(words.INSPECT)), 'Inspect is secondary');
    assert.deepEqual(words.RETRY, ['auto', 'user', 'never']);
    assert.deepEqual(words.NO_AUTO_RETRY, ['quota', 'permission', 'policy', 'update-required']);
    assert.deepEqual(words.CAUSE_GROUPS, ['kernel', 'transport', 'storage', 'coordinator', 'security', 'providers', 'blocks']);
    for (const list of [words.STATES, words.BLOCKED_REASONS, words.ACTIONS, words.NO_AUTO_RETRY, words.CAUSE_GROUPS])
      assert.ok(Object.isFrozen(list) && new Set(list).size === list.length);
  });

  it('keys a message in dotted kebab case, and Open goes to Archive, Recovery Center or a settings page', () => {
    for (const key of ['cause.payload-too-large', 'rejected.folder-exists', 'state.failed.headline'])
      assert.ok(words.isMessageKey(key), key);
    for (const key of ['Saved!', 'cause', 'cause.', '.cause', 'Cause.x', 'cause..x', `cause.${'x'.repeat(80)}`, 7])
      assert.ok(!words.isMessageKey(key), String(key));
    for (const where of ['archive', 'recovery-center', 'settings/intelligence', 'settings/data'])
      assert.ok(words.isOpenDestination(where), where);
    for (const where of ['settings', 'settings/', 'settings/Data', 'trash', 'https://example.test', null])
      assert.ok(!words.isOpenDestination(where), String(where));
  });
});

describe('the cause family (#26 slice 1)', () => {
  const blocked = { ...sample('quota', 1), state: 'blocked', reason: 'quota', retry: 'never', action: 'free-space' };

  it('resolves a cause whose every field holds a word from the contract, with or without an action', () => {
    assert.deepEqual(resolved(sample('payload-too-large', 1)), ['enabled', 'ok']);
    assert.deepEqual(resolved(blocked), ['enabled', 'ok']);
    assert.deepEqual(resolved({ ...sample('nobody-can-fix', 1), action: null, retry: 'never' }), ['enabled', 'ok']);
  });

  it('leaves a cause unresolved when a field holds anything else, or one it needs is missing', () => {
    /** @type {Record<string, unknown[]>} */
    const bad = {
      state: ['saved', undefined],
      reason: ['busy'],
      retry: ['sometimes', undefined],
      userCanFix: ['yes'],
      messageKey: ['Saved!'],
      action: ['inspect', 'delete', undefined],
      destination: ['elsewhere'],
      owner: [0, undefined],
    };
    for (const [field, values] of Object.entries(bad)) {
      for (const value of values) {
        const descriptor = { ...sample('payload-too-large', 1), [field]: value };
        assert.deepEqual(resolved(descriptor), ['unresolved', 'invalid-field'], `${field}: ${String(value)}`);
      }
    }
  });

  it('holds the rules that join two fields, which the kit checks one field at a time', () => {
    assert.deepEqual(causeProblems(blocked), []);
    assert.deepEqual(causeProblems({ ...blocked, reason: undefined }), ['reason-missing']);
    assert.deepEqual(causeProblems({ ...sample('adapter-failed', 1), reason: 'quota' }), ['reason-not-blocked']);
    // Quota, permission, policy and an unsupported version never retry on their own (#26, "Registries")
    for (const reason of words.NO_AUTO_RETRY)
      assert.deepEqual(causeProblems({ ...blocked, reason, retry: 'auto' }), ['auto-retry'], reason);
    assert.deepEqual(causeProblems({ ...blocked, reason: 'coordinator', retry: 'auto', action: 'retry' }), []);
    const open = { ...sample('note-archived', 1), action: 'open', destination: 'archive' };
    assert.deepEqual(causeProblems(open), []);
    assert.deepEqual(causeProblems({ ...open, destination: undefined }), ['destination-missing']);
    assert.deepEqual(causeProblems({ ...sample('adapter-failed', 1), destination: 'archive' }), ['destination-not-open']);
  });
});

describe('the state matrix (#26 slice 1)', () => {
  const UNRESOLVED = ['unresolved', 'invalid-field'];
  const withStates = (/** @type {unknown} */ states) => resolved({ ...matrixSample('create-note', 1), states }, matrix);

  it("names a row's tokens: what changed, how it's announced, where it shows, how it commits and goes stale", () => {
    assert.deepEqual(words.SUBJECTS, ['command', 'query', 'route', 'job', 'surface']);
    assert.deepEqual(words.DATA_CHANGED, ['none', 'committed', 'unknown']);
    assert.deepEqual(words.POLITENESS, ['off', 'polite', 'assertive']);
    assert.deepEqual(words.PLACEMENTS, ['inline', 'region', 'recovery-center', 'notification']);
    assert.deepEqual(words.ATOMICITY, ['atomic', 'batch']);
    assert.deepEqual(words.STALENESS, ['revision', 'verified-at', 'none']);
    const lists = [words.SUBJECTS, words.DATA_CHANGED, words.POLITENESS, words.PLACEMENTS, words.ATOMICITY];
    for (const list of [...lists, words.STALENESS])
      assert.ok(Object.isFrozen(list) && new Set(list).size === list.length);
  });

  it('resolves a contribution whose rows hold words from the contract, or say why a state cannot arise', () => {
    const every = Object.fromEntries(words.STATES.map(state => [state, { ...ROW, deadlineMs: 15_000, e2e: true }]));
    for (const descriptor of [
      matrixSample('create-note', 1),
      { ...matrixSample('list-notes', 1), group: 'query', states: every },
      { ...matrixSample('workspace', 1), group: 'surface', states: { idle: { ...ROW, primaryAction: null } } },
      { ...matrixSample('today', 1), group: 'route', subject: 'workspace/today' },
    ])
      assert.deepEqual(resolved(descriptor, matrix), ['enabled', 'ok'], String(descriptor.id));
  });

  it('leaves it unresolved when a row strays from the contract, or a state is not one of the 11', () => {
    /** @type {Record<string, unknown[]>} */
    const bad = {
      messageKey: ['Saved!', undefined],
      dataChanged: ['some', undefined],
      preserved: ['capture', ['Capture'], ['capture', 'capture'], undefined],
      primaryAction: ['inspect', 'delete', undefined],
      politeness: ['loud'],
      placement: ['toast'],
      atomicity: ['mostly'],
      staleness: ['hourly'],
      deadlineMs: [0, 1.5, 600_001, '15000'],
      e2e: [false, 'yes'],
      icon: ['check'],
    };
    for (const [field, values] of Object.entries(bad))
      for (const value of values)
        assert.deepEqual(withStates({ failed: { ...ROW, [field]: value } }), UNRESOLVED, `${field}: ${String(value)}`);
    const strays = [
      {},
      { saved: ROW },
      { empty: {} },
      { empty: { notApplicable: ' ' } },
      { empty: { notApplicable: 'x'.repeat(161) } },
      { empty: { ...ROW, notApplicable: 'A command reads nothing' } },
    ];
    for (const states of strays) assert.deepEqual(withStates(states), UNRESOLVED, JSON.stringify(states));
    assert.deepEqual(resolved({ ...matrixSample('create-note', 1), subject: 'Create Note' }, matrix), UNRESOLVED);
    assert.deepEqual(resolved({ ...matrixSample('create-note', 1), owner: 0 }, matrix), UNRESOLVED);
  });
});
