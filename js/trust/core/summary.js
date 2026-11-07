/**
 * How the trust core reads health (#20 slice 4c): a receipt's status at a time, the worst of
 * several statuses, and problems worst first. They move here from checks.js, next-action.js and
 * the use cases, for trust.summary to read with no checks module, Valibot or payload schema.
 */

import { SEVERITIES, STATUS_ORDER } from './vocabulary.js';

/** @typedef {import('./vocabulary.js').ProviderStatus} ProviderStatus */

/**
 * A receipt's status as it reads at `now`: `stale` once it's past its window or dated in the
 * future, otherwise what it stored
 * @param {{status: string, verifiedAt: number, freshnessMs: number}} receipt
 * @param {number} now
 * @returns {ProviderStatus}
 */
export function effectiveStatus(receipt, now) {
  if (receipt.verifiedAt > now || now - receipt.verifiedAt > receipt.freshnessMs) return 'stale';
  return /** @type {ProviderStatus} */ (receipt.status);
}

/**
 * The worst of `statuses`, or `unverified` when there are none
 * @param {readonly ProviderStatus[]} statuses
 * @returns {ProviderStatus}
 */
export function worstStatus(statuses) {
  if (statuses.length === 0) return 'unverified';
  return /** @type {ProviderStatus} */ (
    STATUS_ORDER[Math.min(...statuses.map(status => STATUS_ORDER.indexOf(/** @type {any} */ (status))))]
  );
}

/**
 * `incidents` worst first: severity, then most recently seen
 * @template {{severity: string, lastSeenAt: number}} T
 * @param {readonly T[]} incidents
 * @returns {T[]}
 */
export const worstFirst = incidents =>
  [...incidents].sort(
    (a, b) =>
      SEVERITIES.indexOf(/** @type {any} */ (a.severity)) - SEVERITIES.indexOf(/** @type {any} */ (b.severity)) ||
      b.lastSeenAt - a.lastSeenAt,
  );
