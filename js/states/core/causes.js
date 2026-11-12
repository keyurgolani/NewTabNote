/**
 * #12's and #13's causes (#26, "Inputs" and "Registries"): one for each code #13's transport
 * answers, for each branch of #12's outcome union and failed queries, and for #12's four named
 * codes, so any outcome presents through its class until its owner registers its own codes
 * (slice 3). causeIdFor picks the cause an outcome or a failed query presents through.
 *
 * Their message keys are `cause.<id>`, and their words are provisional: they go through the Design
 * gate with slice 2's component.
 */

import { FAIL_CAUSES, REJECT_REASONS, TURN_EXCEEDED, UNAVAILABLE_CAUSES } from '../../kernel/core/contracts/outcomes.js';
import { HOSTS } from '../../kernel/registry/vocabulary.js';

/**
 * What a cause says: its state, a blocked state's reason, how it retries, whether the person can
 * fix it, and its one action, or none
 * @typedef {[string, string | undefined, string, boolean, string | null]} Says
 */
/** @typedef {[string, ...Says]} Row */

/**
 * #13's codes ("Outcomes and authorization"), each its own cause
 * @type {Row[]}
 */
const TRANSPORT = [
  ['invalid-payload', 'failed', undefined, 'never', false, null],
  ['payload-too-large', 'failed', undefined, 'never', true, 'copy-text'],
  ['unknown-operation', 'failed', undefined, 'never', false, null],
  // A worker newer than the page: "NewTabNote was updated. Reopen this page."
  ['unsupported-version', 'blocked', 'update-required', 'never', true, 'reopen'],
  ['idempotency-key-reuse', 'failed', undefined, 'never', false, null],
  // A cancel #13 confirmed goes back to the state before it, and is never an error
  ['cancelled', 'idle', undefined, 'user', true, null],
  ['unauthorized-sender', 'blocked', 'policy', 'never', false, null],
  ['forbidden-for-surface', 'blocked', 'policy', 'never', false, null],
  // No answer, for a request that couldn't have started or a read: it waits on the coordinator
  ['unavailable', 'blocked', 'coordinator', 'auto', false, 'retry'],
  ['outcome-unknown', 'blocked', 'coordinator', 'auto', false, 'retry'],
  ['deadline-exceeded', 'blocked', 'coordinator', 'auto', false, 'retry'],
  // A cancel past the commit point: "Finishing, can't be stopped safely"
  ['too-late', 'recovering', undefined, 'never', false, null],
  ['resync-required', 'stale', undefined, 'auto', false, null],
];

/**
 * #12's named codes: a turn the queue cut, an adapter's own failure, and the two conflicts
 * @type {Row[]}
 */
const NAMED = [
  [TURN_EXCEEDED, 'failed', undefined, 'user', false, 'retry'],
  ['adapter-failed', 'failed', undefined, 'user', false, 'retry'],
  ['revision-conflict', 'blocked', 'conflict', 'never', true, 'keep-mine'],
  ['placement-conflict', 'blocked', 'conflict', 'never', true, 'keep-mine'],
];

/**
 * What each of #12's reasons and causes says, for a code with no cause of its own
 * @type {Readonly<Record<string, Says>>}
 */
const BY_CLASS = {
  validation: ['failed', undefined, 'never', false, null],
  policy: ['blocked', 'policy', 'never', false, null],
  'not-found': ['blocked', 'not-found', 'never', false, null],
  storage: ['failed', undefined, 'user', false, 'retry'],
  quota: ['blocked', 'quota', 'never', true, 'free-space'],
  'newer-schema': ['blocked', 'update-required', 'never', true, 'reopen'],
  adapter: ['failed', undefined, 'user', false, 'retry'],
  coordinator: ['blocked', 'coordinator', 'auto', false, 'retry'],
};

/**
 * #12's branches: rejected by reason, conflict, unavailable by cause, unknown, and failed by cause
 * @type {Row[]}
 */
const BRANCHES = [
  ...REJECT_REASONS.map(reason => /** @type {Row} */ ([`rejected-${reason}`, ...BY_CLASS[reason]])),
  ['conflict', 'blocked', 'conflict', 'never', true, 'keep-mine'],
  ...UNAVAILABLE_CAUSES.map(cause => /** @type {Row} */ ([`unavailable-${cause}`, ...BY_CLASS[cause]])),
  // Checked by its idempotency key before Retry shows (rule 6): "Checking whether this saved"
  ['unknown', 'loading', undefined, 'auto', false, null],
  ...FAIL_CAUSES.map(cause => /** @type {Row} */ ([`failed-${cause}`, ...BY_CLASS[cause]])),
];

/**
 * @param {string} group
 * @param {number} owner
 * @returns {(row: Row, index: number) => Readonly<Record<string, unknown>>}
 */
const causeIn = (group, owner) => ([id, state, reason, retry, userCanFix, action], index) =>
  Object.freeze({
    id, version: 1, apiVersion: 1, group, rank: index + 1, hosts: HOSTS, owner,
    label: `${id[0].toUpperCase()}${id.slice(1).split('-').join(' ')}`,
    state, ...(reason === undefined ? {} : { reason }), retry, userCanFix, messageKey: `cause.${id}`, action,
  });

/** The causes #26 registers for #12 and #13, on the cause family */
export const KERNEL_CAUSES = Object.freeze([
  ...TRANSPORT.map(causeIn('transport', 13)),
  ...[...NAMED, ...BRANCHES].map(causeIn('kernel', 12)),
]);

/** The codes with a cause of their own, which a result with that code presents through */
export const CODE_CAUSES = new Set([...TRANSPORT, ...NAMED].map(([id]) => id));

/**
 * The id of the cause an outcome or a failed query presents through: an unknown command's is
 * `unknown`, since its key is checked first whatever its code; any other's is its code's own cause,
 * or else its branch's. A committed command and a bulk have none.
 * @param {{kind: string, code: string, reason?: string, cause?: string}} result
 * @returns {string | null}
 */
export function causeIdFor({ kind, code, reason, cause }) {
  if (kind === 'unknown') return 'unknown';
  if (kind === 'committed' || kind === 'bulk') return null;
  if (CODE_CAUSES.has(code)) return code;
  if (kind === 'conflict') return 'conflict';
  return `${kind}-${kind === 'rejected' ? reason : cause}`;
}
