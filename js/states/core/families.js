/**
 * The causes registry and the state matrix, families on #15's kit (#26, "Registries"), as #20's
 * families are. A cause is
 * `{code, state, reason?, retry, userCanFix, messageKey, action}`, with its code as its id and the
 * issue that owns it: the state a code puts a view in, what a blocked one waits on, how it retries,
 * whether the person can fix it, its catalog message, and its one primary action from the closed
 * list, or none when nobody can fix it and its message says why. Open names where it goes.
 *
 * Causes and matrix rows are static data, so neither family has a loader. The kit checks each field alone and leaves a
 * cause with a bad value unresolved. causeProblems holds the rules that join two fields, which those
 * checks can't see, and the tests and `npm run check:states` hold every registered cause to them.
 */

import { defineFamily } from '../../kernel/registry/family.js';
import { isId } from '../../kernel/registry/ids.js';
import {
  ACTIONS, ATOMICITY, BLOCKED_REASONS, CAUSE_GROUPS, DATA_CHANGED, NO_AUTO_RETRY, PLACEMENTS, POLITENESS, RETRY,
  STALENESS, STATES, SUBJECTS, isMessageKey, isOpenDestination,
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

/** The longest wait a row may give a loading state that no operation backs (rule 5), ten minutes */
const MAX_DEADLINE_MS = 600_000;

/**
 * Whether a row's deadline is a whole number of milliseconds, up to the longest a row may give
 * @param {unknown} value
 */
const isDeadline = value =>
  typeof value === 'number' && Number.isSafeInteger(value) && value > 0 && value <= MAX_DEADLINE_MS;

/** A state row's fields, of which `deadlineMs` and `e2e` are optional */
const ROW_FIELDS = Object.freeze([
  'messageKey', 'dataChanged', 'preserved', 'primaryAction', 'politeness', 'placement', 'atomicity', 'staleness',
  'deadlineMs', 'e2e',
]);

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
const isRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value);

/**
 * Whether `value` is one state's row: the body's fields, each a word from the vocabulary, or
 * `{notApplicable}` with the reason the state can't arise. `preserved` lists the capabilities the
 * state keeps working, and `e2e: true` asks for a #30 spec that names the row.
 * @param {unknown} value
 */
const isRow = value => {
  if (!isRecord(value)) return false;
  const keys = Object.keys(value);
  if (keys.includes('notApplicable')) {
    const why = value.notApplicable;
    return keys.length === 1 && typeof why === 'string' && why.trim() !== '' && why.length <= 160;
  }
  const { preserved, primaryAction, deadlineMs, e2e } = value;
  return (
    keys.every(key => ROW_FIELDS.includes(key)) &&
    isMessageKey(value.messageKey) &&
    oneOf(DATA_CHANGED)(value.dataChanged) &&
    Array.isArray(preserved) && preserved.every(item => isId(item)) && new Set(preserved).size === preserved.length &&
    (primaryAction === null || oneOf(ACTIONS)(primaryAction)) &&
    oneOf(POLITENESS)(value.politeness) &&
    oneOf(PLACEMENTS)(value.placement) &&
    oneOf(ATOMICITY)(value.atomicity) &&
    oneOf(STALENESS)(value.staleness) &&
    (deadlineMs === undefined || isDeadline(deadlineMs)) &&
    (e2e === undefined || e2e === true)
  );
};

/**
 * The state matrix: one descriptor per contribution, since 97 of them by 11 states is past the
 * kit's 512. Its group is the contribution's kind, its subject the contribution's id, and `states`
 * holds a row for each state the contribution can be in, or `{notApplicable}` with why it can't. A
 * state with neither is a missing row, which `npm run check:states` holds to its baseline.
 */
export const matrix = defineFamily({
  id: 'matrix',
  apiVersion: 1,
  groups: SUBJECTS,
  loader: 'none',
  fields: {
    subject: value => isId(value, { paths: true }),
    states: value =>
      isRecord(value) &&
      Object.keys(value).length > 0 &&
      Object.entries(value).every(([state, row]) => oneOf(STATES)(state) && isRow(row)),
    owner: isOwner,
  },
});
