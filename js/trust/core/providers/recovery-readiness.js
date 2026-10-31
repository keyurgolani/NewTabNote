/**
 * Recovery readiness (#20, "Providers"): whether a verified #17 recovery point stands behind
 * the notes, checked by reading the newest verified point of each kind back and matching it
 * against its manifest (#17's verifyPoint, which writes nothing). It's `local-expensive`, since
 * that hashes every row, so it runs on Verify now and idle work, never on open.
 *
 * - `verified` when the newest verified point of every kind re-verifies;
 * - `degraded` when one doesn't, with a `point-unverified` incident: the point is still kept,
 *   since only #17's own run discards a point, and the Recovery Center decides what to do;
 * - `unverified` with no verified point, whatever 1.4.x's legacy copies (`auto_backup_*` and
 *   `recovery_backup_*` in chrome.storage.local) hold: they're counted as `records`, labelled
 *   as kept in this browser profile, and never verified.
 *
 * #61 makes only `pre-migration` points, and no shipped root runs its migrations yet, so on a
 * profile today this reads `unverified`. Points of the kinds #17's PR 2 adds are read the same
 * way when they land.
 */

import { portOf } from './context.js';
import { ERROR_CODES } from '../codes.js';

/** @typedef {import('../checks.js').CheckResult} CheckResult */
/** @typedef {import('./context.js').PointSummary} PointSummary */

/** The chrome.storage.local keys 1.4.x keeps a legacy copy under (js/storage.js) */
export const LEGACY_COPY_KEY = /^(?:auto|recovery)_backup_[0-9]{10,16}$/;

/**
 * How many legacy copies the settings area holds, or null when it can't list its keys without
 * reading every value (chrome.storage.local.getKeys, Chrome 130), which this never does
 * @param {unknown} settings
 * @returns {Promise<number | null>}
 */
export async function countLegacyCopies(settings) {
  const getKeys = settings && /** @type {{getKeys?: unknown}} */ (settings).getKeys;
  if (typeof getKeys !== 'function') return null;
  const keys = await /** @type {() => Promise<unknown>} */ (getKeys).call(settings);
  if (!Array.isArray(keys)) return null;
  return keys.filter(key => typeof key === 'string' && LEGACY_COPY_KEY.test(key)).length;
}

/**
 * The newest verified point of each kind
 * @param {readonly PointSummary[]} points
 * @returns {PointSummary[]}
 */
export function newestVerified(points) {
  /** @type {Map<string, PointSummary>} */
  const newest = new Map();
  for (const point of points) {
    if (point.status !== 'verified' || typeof point.verifiedAt !== 'number') continue;
    const held = newest.get(point.kind);
    if (!held || /** @type {number} */ (held.verifiedAt) < point.verifiedAt) newest.set(point.kind, point);
  }
  return [...newest.values()];
}

/** What it looked at once the points were listed and each verified: the point-unverified fault */
const LOOKED = () => [{ faultCode: 'point-unverified', subjectId: 'NewTabNoteRecovery' }];

/** What the recovery reader answers for a point that's no longer there */
const DISCARDED = 'point-discarded';

export const recoveryReadiness = Object.freeze({
  /**
   * @param {Readonly<Record<string, unknown>>} context
   * @returns {Promise<CheckResult>}
   */
  async check(context) {
    const recovery = portOf(context, 'recovery');
    const legacyCopies = context.settings ? await countLegacyCopies(context.settings) : null;
    const legacy = legacyCopies === null ? {} : { records: legacyCopies };
    const listed = /** @type {unknown} */ (await recovery.points());
    if (!Array.isArray(listed)) throw new TypeError('not a list of points');
    /** @type {PointSummary[]} */
    const points = [];
    /** @type {string | null} */
    let failedCode = null;
    let failed = 0;
    for (const point of newestVerified(listed)) {
      const verdict = /** @type {{ok: boolean, code?: string}} */ (await recovery.verify(point.id));
      // Discarded since it was listed, by #17's run after its own verification: it's gone, not failed
      if (!verdict.ok && verdict.code === DISCARDED) continue;
      points.push(point);
      if (!verdict.ok) {
        failed += 1;
        if (failedCode === null && typeof verdict.code === 'string') failedCode = verdict.code;
      }
    }
    if (points.length === 0) {
      return { status: 'unverified', evidence: { count: 0, ...legacy }, consequenceKey: 'recovery.no-verified-point', looked: LOOKED() };
    }
    const newestAt = Math.max(...points.map(point => /** @type {number} */ (point.verifiedAt)));
    if (failed > 0) {
      return {
        status: 'degraded',
        evidence: {
          count: points.length - failed,
          attempts: points.length,
          ...(failedCode !== null && ERROR_CODES.includes(failedCode) ? { errorCode: failedCode } : {}),
          ...legacy,
        },
        consequenceKey: 'recovery.point-unverified',
        looked: LOOKED(),
        preserved: ['capture', 'editing', 'reading'],
        faults: [
          {
            faultCode: 'point-unverified',
            subjectId: 'NewTabNoteRecovery',
            severity: 'data-risk',
            affected: ['restore'],
            preserved: ['capture', 'editing', 'reading'],
          },
        ],
      };
    }
    return { status: 'verified', evidence: { count: points.length, verifiedAt: newestAt, ...legacy }, looked: LOOKED() };
  },
});
