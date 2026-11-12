// #26 slice 1: the states contract's words and its cause family on #15's kit. A cause draws its
// state, a blocked state's reason, how it retries and its one action from the vocabulary's closed
// lists. The kit leaves a cause with a bad field unresolved, and causeProblems holds the rules that
// join two fields. #12's and #13's causes come in the next PR.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { HOSTS } from '../../js/kernel/registry/vocabulary.js';
import { cause, causeProblems } from '../../js/states/core/families.js';
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
 * A cause's state and reason once resolved on its own
 * @param {Descriptor} descriptor
 */
const resolved = descriptor => {
  const contribution = resolveOne(cause, [descriptor], 'workspace').get(`cause:${descriptor.id}`);
  return contribution ? [contribution.state, contribution.reason] : null;
};

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
