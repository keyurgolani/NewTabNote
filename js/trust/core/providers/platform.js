/**
 * The platform providers (#20, "Providers", Messaging, contributions, block types; #35's
 * coordinator):
 *
 * - Coordinator asks #35's coordinator for `system.coordinatorHealth` through the context's
 *   client. `verified` when it's ready, and `degraded` with a `start-failed` incident when the
 *   worker couldn't build its kernel, so no capture is saved. One whose database won't open is
 *   `degraded` with no incident of its own, since the storage provider reports that one. No
 *   answer is `unreachable`, as for messaging, and one still starting is `unverified`.
 * - Messaging asks #13's coordinator for `system.messagingHealth` through the context's client,
 *   a real round trip over whichever transport its root chose. `verified` when it answers with
 *   counters its schema takes, and `degraded` with an `unreachable` incident when the
 *   coordinator doesn't answer or refuses: in R1 no page sends anything else through it, so
 *   capture, editing, and reading don't depend on it.
 * - Contributions reads #15's resolution report over each registry root the context names,
 *   after its probes and loaders answered. `verified` when no contribution is `unresolved` or
 *   `temporarily-unavailable`, `degraded` with a `contribution-unavailable` incident when any
 *   is, and `not-configured` with no root or no contribution to read. The other states (turned off, doesn't apply here, needs setup or a permission, not
 *   built yet) are each contribution's own, and the report explains them.
 * - Block types reads the same report for #14's block family, and is `not-configured` until a
 *   root registers that family. Where the root passes #14's block-health query (`blocks`), its
 *   counts join the report's: a type the kit resolved but whose model the block contract
 *   refuses is disabled too, so the check counts the types either one disables, and the
 *   query's own count when that's higher. Both are content-free counts.
 */

import * as v from '../../../lib/valibot/index.mjs';
import { coordinatorHealth } from '../../../kernel/core/contracts/operations/system-coordinator-health.js';
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

/** What still works while the worker can't build its kernel, in R1: each page commits in its own context */
const WITHOUT_COORDINATOR_KERNEL = Object.freeze(['editing', 'reading']);

/** The registered error code each reason the coordinator's database didn't open is evidence as */
const STORAGE_REASONS = Object.freeze({
  'newer-schema': 'version-too-new',
  'missing-core-stores': 'missing-core-stores',
  'storage-unavailable': 'storage-unavailable',
});

/**
 * A failed query: the coordinator's answer that it can't, unreachable, refused, or late
 * @param {{cause?: unknown, code?: unknown}} answer
 * @returns {CheckResult}
 */
const unreachable = answer => ({
  status: 'degraded',
  evidence: failureEvidence(answer),
  consequenceKey: 'platform.coordinator-unreachable',
  preserved: [...WITHOUT_COORDINATOR],
  faults: [{ faultCode: 'unreachable', subjectId: null, severity: 'degraded', preserved: [...WITHOUT_COORDINATOR] }],
  looked: [{ faultCode: 'unreachable', subjectId: null }],
});

export const coordinator = Object.freeze({
  /**
   * @param {Readonly<Record<string, unknown>>} context
   * @returns {Promise<CheckResult>}
   */
  async check(context) {
    const client = portOf(context, 'messaging');
    const answer = await client.query({ type: 'system.coordinatorHealth' });
    if (answer.kind === 'failed') return unreachable(answer);
    // An answer its schema refuses, or one still loading: nothing was verified
    if (answer.kind !== 'ready' || !v.is(coordinatorHealth, answer.data)) {
      return { status: 'unverified', evidence: { errorCode: 'invalid-check-result' } };
    }
    const health = v.parse(coordinatorHealth, answer.data);
    /** @type {CheckResult['looked']} it answered, so it was reached, and whether it was built shows */
    const looked = [
      { faultCode: 'start-failed', subjectId: null },
      { faultCode: 'unreachable', subjectId: null },
    ];
    if (health.status === 'ready') {
      const count = health.commands.reduce((sum, outcome) => sum + outcome.count, 0);
      return {
        status: 'verified',
        evidence: health.startedAt === null ? { count } : { count, since: health.startedAt },
        looked,
      };
    }
    if (health.reason === 'coordinator-unavailable') {
      return {
        status: 'degraded',
        evidence: { errorCode: 'coordinator-unavailable' },
        consequenceKey: 'platform.coordinator-start-failed',
        preserved: [...WITHOUT_COORDINATOR_KERNEL],
        faults: [
          {
            faultCode: 'start-failed',
            subjectId: null,
            severity: 'capture-risk',
            affected: ['capture'],
            preserved: [...WITHOUT_COORDINATOR_KERNEL],
          },
        ],
        looked,
      };
    }
    if (health.reason !== undefined && Object.prototype.hasOwnProperty.call(STORAGE_REASONS, health.reason)) {
      return {
        status: 'degraded',
        evidence: { errorCode: STORAGE_REASONS[/** @type {keyof typeof STORAGE_REASONS} */ (health.reason)] },
        consequenceKey: 'storage.unavailable',
        looked,
      };
    }
    // Still starting, or a reason this build doesn't know yet: nothing was verified
    return health.reason === 'starting'
      ? { status: 'unverified', evidence: { errorCode: 'open-pending' } }
      : { status: 'unverified' };
  },
});

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
      return {
        status: 'verified',
        evidence: { count: health.handshakes, attempts: health.reconnects },
        looked: [{ faultCode: 'unreachable', subjectId: null }],
      };
    }
    if (answer.kind === 'failed') return unreachable(answer);
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
  const resolutions = /** @type {unknown} */ (portOf(context, 'resolutions')());
  if (!Array.isArray(resolutions)) throw new TypeError('not a list of resolutions');
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
  // No root, or no contribution in any, is nothing to verify
  const looked = [{ faultCode: 'contribution-unavailable', subjectId: null }];
  if (rows.length === 0) return { status: 'not-configured', evidence: { records: 0 }, looked };
  const unavailable = rows.filter(row => /** @type {readonly string[]} */ (UNAVAILABLE_STATES).includes(row.state));
  const evidence = { records: rows.length, count: unavailable.length };
  if (unavailable.length === 0) return { status: 'verified', evidence, looked };
  return {
    status: 'degraded',
    evidence,
    consequenceKey: `${group}.contribution-unavailable`,
    faults: [{ faultCode: 'contribution-unavailable', subjectId: null, severity: 'degraded' }],
    looked,
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
    if (!families.has(BLOCK_FAMILY)) {
      return { status: 'not-configured', evidence: { records: 0 }, looked: [{ faultCode: 'contribution-unavailable', subjectId: null }] };
    }
    const health = blockHealthOf(context);
    if (health === null) return fromRows(rows, 'platform');
    const unavailable = rows.filter(row => /** @type {readonly string[]} */ (UNAVAILABLE_STATES).includes(row.state)).length;
    const records = Math.max(rows.length, health.types);
    const count = Math.max(unavailable, health.disabled);
    const looked = [{ faultCode: 'contribution-unavailable', subjectId: null }];
    if (records === 0) return { status: 'not-configured', evidence: { records: 0 }, looked };
    if (count === 0) return { status: 'verified', evidence: { records, count }, looked };
    return {
      status: 'degraded',
      evidence: { records, count },
      consequenceKey: 'platform.contribution-unavailable',
      faults: [{ faultCode: 'contribution-unavailable', subjectId: null, severity: 'degraded' }],
      looked,
    };
  },
});

/**
 * The block-health query's counts, or null when the root passes none. An answer that isn't
 * counts throws, so the check records `unverified`.
 * @param {Readonly<Record<string, unknown>>} context
 * @returns {{types: number, disabled: number} | null}
 */
function blockHealthOf(context) {
  const blocks = /** @type {{blocks?: unknown}} */ (context).blocks;
  if (blocks === undefined) return null;
  const health = /** @type {{health(): unknown}} */ (portOf(context, 'blocks')).health();
  const isCount = (/** @type {unknown} */ value) => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
  const answer = /** @type {Record<string, unknown> | null} */ (health !== null && typeof health === 'object' ? health : null);
  if (!answer || !isCount(answer.types) || !isCount(answer.disabled) || /** @type {number} */ (answer.disabled) > /** @type {number} */ (answer.types)) {
    throw new TypeError('not a block-health answer');
  }
  return { types: /** @type {number} */ (answer.types), disabled: /** @type {number} */ (answer.disabled) };
}
