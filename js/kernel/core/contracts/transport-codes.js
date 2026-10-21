/**
 * Transport codes (#13, "Outcomes and authorization"): what a request gets when the router, a
 * transport, or the coordinator ends it before a handler answers, as #12's outcome union and
 * query states, so a caller handles one union however its request traveled.
 *
 * - A message the router can't accept is rejected with reason `validation`, and a sender or
 *   surface it won't serve with reason `policy`. Neither leaves an idempotency record, so a
 *   resend with the same key gets the same rejection.
 * - A command whose answer didn't come and that may have started is unknown, and the client
 *   resolves it by its commandId before it shows saved or failed. Any other request whose
 *   answer didn't come is unavailable, with cause `coordinator`, and retryable.
 * - A query fails with the same code, with cause `validation`, `policy`, or `coordinator`.
 *
 * `too-late` is only the reply to a cancel (contracts/envelope.js), and `resync-required` is
 * a CommitFeed result (#13 slice 3) that turns a projection stale. Domain codes, such as a
 * conflict or quota, pass through as their handlers return them.
 */

import { failed, rejected, unavailable, unknown } from './outcomes.js';

/** @typedef {import('./outcomes.js').Outcome} Outcome */
/** @typedef {import('./outcomes.js').Failed} Failed */

/** Codes for a message the router can't accept, which a resend can't fix */
export const VALIDATION_CODES = Object.freeze(
  /** @type {const} */ ([
    'invalid-payload',
    'payload-too-large',
    'unknown-operation',
    'unsupported-version',
    'idempotency-key-reuse',
    'cancelled',
  ]),
);

/** Codes for a sender, or a surface, the router won't serve */
export const POLICY_CODES = Object.freeze(/** @type {const} */ (['unauthorized-sender', 'forbidden-for-surface']));

/**
 * Codes for an answer that didn't come: the coordinator couldn't be reached or stopped
 * answering, a command's reply was lost, or a deadline passed
 */
export const NO_ANSWER_CODES = Object.freeze(
  /** @type {const} */ (['unavailable', 'outcome-unknown', 'deadline-exceeded']),
);

/**
 * @typedef {(typeof VALIDATION_CODES)[number] | (typeof POLICY_CODES)[number]
 *   | (typeof NO_ANSWER_CODES)[number]} TransportCode
 */

/**
 * @param {readonly string[]} codes
 * @param {string} code
 * @returns {boolean}
 */
const has = (codes, code) => codes.includes(code);

/**
 * @param {unknown} code
 * @returns {code is TransportCode}
 */
export function isTransportCode(code) {
  return (
    typeof code === 'string' && (has(VALIDATION_CODES, code) || has(POLICY_CODES, code) || has(NO_ANSWER_CODES, code))
  );
}

/**
 * The outcome a command gets for a transport code. `mayHaveStarted` is false only while the
 * command can't have reached the coordinator, or the coordinator said it never started it.
 * An answer that didn't come for a command that may have started is unknown whatever the
 * code, so a save that may have committed never shows failed. `outcome-unknown` always is.
 * @param {TransportCode} code
 * @param {{commandId: string, mayHaveStarted: boolean}} command
 * @returns {Outcome}
 */
export function commandOutcome(code, { commandId, mayHaveStarted }) {
  if (has(VALIDATION_CODES, code)) return rejected('validation', code);
  if (has(POLICY_CODES, code)) return rejected('policy', code);
  if (mayHaveStarted || code === 'outcome-unknown') return unknown(code, commandId);
  return unavailable('coordinator', code, true);
}

/**
 * The failed state a query gets for a transport code
 * @param {TransportCode} code
 * @returns {Failed}
 */
export function queryFailure(code) {
  if (has(VALIDATION_CODES, code)) return failed('validation', code);
  if (has(POLICY_CODES, code)) return failed('policy', code);
  return failed('coordinator', code);
}
