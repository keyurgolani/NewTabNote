/**
 * The causes registry, a family on #15's kit (#26, "Registries"), as #20's families are. A cause is
 * `{code, state, reason?, retry, userCanFix, messageKey, action}`, with its code as its id and the
 * issue that owns it: the state a code puts a view in, what a blocked one waits on, how it retries,
 * whether the person can fix it, its catalog message, and its one primary action from the closed
 * list, or none when nobody can fix it and its message says why. Open names where it goes.
 *
 * A cause is static data, so the family has no loader. The kit checks each field alone and leaves a
 * cause with a bad value unresolved. causeProblems holds the rules that join two fields, which those
 * checks can't see, and the tests and `npm run check:states` hold every registered cause to them.
 */

import { defineFamily } from '../../kernel/registry/family.js';
import {
  ACTIONS, BLOCKED_REASONS, CAUSE_GROUPS, NO_AUTO_RETRY, RETRY, STATES, isMessageKey, isOpenDestination,
} from './vocabulary.js';

/**
 * A check that `value` is one of `list`
 * @param {readonly string[]} list
 * @returns {(value: unknown) => boolean}
 */
const oneOf = list => value => typeof value === 'string' && list.includes(value);

/**
 * The issue that owns a cause, as a number such as 13
 * @param {unknown} value
 */
const isOwner = value => typeof value === 'number' && Number.isSafeInteger(value) && value > 0 && value < 1000;

export const cause = defineFamily({
  id: 'cause',
  apiVersion: 1,
  groups: CAUSE_GROUPS,
  loader: 'none',
  fields: {
    state: oneOf(STATES),
    reason: value => value === undefined || oneOf(BLOCKED_REASONS)(value),
    retry: oneOf(RETRY),
    userCanFix: value => typeof value === 'boolean',
    messageKey: isMessageKey,
    action: value => value === null || oneOf(ACTIONS)(value),
    destination: value => value === undefined || isOpenDestination(value),
    owner: isOwner,
  },
});

/**
 * What's wrong with a cause across its fields: a `blocked` one without its reason, a reason on any
 * other, a quota, permission, policy or unsupported-version cause that retries on its own, Open
 * without its destination, and a destination on any other action. Empty when it keeps them all.
 * @param {Readonly<Record<string, unknown>>} descriptor
 * @returns {string[]}
 */
export function causeProblems(descriptor) {
  const { state, reason, retry, action, destination } = descriptor;
  /** @type {string[]} */
  const problems = [];
  if (state === 'blocked' && reason === undefined) problems.push('reason-missing');
  if (state !== 'blocked' && reason !== undefined) problems.push('reason-not-blocked');
  if (retry === 'auto' && oneOf(NO_AUTO_RETRY)(reason)) problems.push('auto-retry');
  if (action === 'open' && destination === undefined) problems.push('destination-missing');
  if (action !== 'open' && destination !== undefined) problems.push('destination-not-open');
  return problems;
}
