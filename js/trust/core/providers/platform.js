/**
 * The platform providers (#20, "Providers", Messaging, contributions, block types):
 *
 * - Messaging asks #13's coordinator for `system.messagingHealth` through the context's client,
 *   a real round trip over whichever transport its root chose. `verified` when it answers with
 *   counters its schema takes, and `degraded` with an `unreachable` incident when the
 *   coordinator doesn't answer or refuses: in R1 no page sends anything else through it, so
 *   capture, editing, and reading don't depend on it.
 * - Contributions reads #15's resolution report over each registry root the context names,
 *   after its probes and loaders answered. `verified` when no contribution is `unresolved` or
 *   `temporarily-unavailable`, and `degraded` with a `contribution-unavailable` incident when
 *   any is. The other states (turned off, doesn't apply here, needs setup or a permission, not
 *   built yet) are each contribution's own, and the report explains them.
 * - Block types reads the same report for #14's block family, and is `not-configured` until a
 *   root registers that family. #14's block-health query joins it in #14's PR.
 */

import * as v from '../../../lib/valibot/index.mjs';
import { messagingHealth } from '../../../kernel/core/contracts/operations/system-messaging-health.js';
import { resolutionReport } from '../../../kernel/registry/report.js';
import { failureEvidence, portOf } from './context.js';

/** @typedef {import('../checks.js').CheckResult} CheckResult */
/** @typedef {import('../../../kernel/registry/report.js').ReportRow} ReportRow */

/** The family #14's block definitions register in (#14, "Contract shape") */
export const BLOCK_FAMILY = 'block';

/** The states that mean a contribution meant to run can't */
const UNAVAILABLE_STATES = Object.freeze(['unresolved', 'temporarily-unavailable']);

/** What still works while the coordinator can't be reached, in R1 */
const WITHOUT_COORDINATOR = Object.freeze(['capture', 'editing', 'reading']);

export const messaging = Object.freeze({
  /**
   * @param {Readonly<Record<string, unknown>>} context
   * @returns {Promise<CheckResult>}
   */
  async check(context) {
    const client = portOf(context, 'messaging');
    const answer = await client.query({ type: 'system.messagingHealth' });
    if (answer.kind === 'ready' && v.is(messagingHealth, answer.data)) {
      const health = v.parse(messagingHealth, answer.data);
      return { status: 'verified', evidence: { count: health.handshakes, attempts: health.reconnects } };
    }
    // A failed query is the coordinator's answer that it can't: unreachable, refused, or late
    if (answer.kind === 'failed') {
      return {
        status: 'degraded',
        evidence: failureEvidence(answer),
        consequenceKey: 'platform.coordinator-unreachable',
        preserved: [...WITHOUT_COORDINATOR],
        faults: [{ faultCode: 'unreachable', subjectId: null, severity: 'degraded', preserved: [...WITHOUT_COORDINATOR] }],
      };
    }
    // An answer its schema refuses, or one still loading: nothing was verified
    return { status: 'unverified', evidence: { errorCode: 'invalid-check-result' } };
  },
});

/**
 * Every row of every root's resolution report, for `family` when given
 * @param {Readonly<Record<string, unknown>>} context
 * @param {string} [family]
 * @returns {{rows: ReportRow[], families: Set<string>}}
 */
function reportOf(context, family) {
  const resolutions = portOf(context, 'resolutions')();
  /** @type {ReportRow[]} */
  const rows = [];
  /** @type {Set<string>} */
  const families = new Set();
  for (const resolution of resolutions) {
    for (const info of resolution.families) families.add(info.id);
    for (const row of resolutionReport(resolution)) if (family === undefined || row.family === family) rows.push(row);
  }
  return { rows, families };
}

/**
 * What a set of report rows says
 * @param {readonly ReportRow[]} rows
 * @param {string} group
 * @returns {CheckResult}
 */
function fromRows(rows, group) {
  const unavailable = rows.filter(row => /** @type {readonly string[]} */ (UNAVAILABLE_STATES).includes(row.state));
  const evidence = { records: rows.length, count: unavailable.length };
  if (unavailable.length === 0) return { status: 'verified', evidence };
  return {
    status: 'degraded',
    evidence,
    consequenceKey: `${group}.contribution-unavailable`,
    faults: [{ faultCode: 'contribution-unavailable', subjectId: null, severity: 'degraded' }],
  };
}

export const contributions = Object.freeze({
  /**
   * @param {Readonly<Record<string, unknown>>} context
   * @returns {CheckResult}
   */
  check(context) {
    return fromRows(reportOf(context).rows, 'platform');
  },
});

export const blockTypes = Object.freeze({
  /**
   * @param {Readonly<Record<string, unknown>>} context
   * @returns {CheckResult}
   */
  check(context) {
    const { rows, families } = reportOf(context, BLOCK_FAMILY);
    if (!families.has(BLOCK_FAMILY)) return { status: 'not-configured', evidence: { records: 0 } };
    return fromRows(rows, 'platform');
  },
});
