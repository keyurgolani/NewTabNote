/**
 * The network guard's refusals on their way to the diagnostic journal (#21 slice 1b, "Guard").
 * Only the guard's installer holds the handle its reports come through (network-guard.js), so
 * no later code can take them or keep them out:
 *
 * - a page and the offscreen document send each report to the service worker as a
 *   REFUSAL_MESSAGE, which the worker journals (refusalFields checks it first);
 * - the service worker journals its own through the handle network-guard-first.js exports.
 *
 * This module imports nothing, so the guard's code stays out of the graphs that read it.
 */

/** The message a context's guard sends the worker with a refusal report */
export const REFUSAL_MESSAGE = 'NETWORK_REFUSED';

/** The surfaces that send one: the pages */
const SURFACES = Object.freeze(['newtab', 'popup', 'sidepanel', 'offscreen']);

/** The error codes a report carries (network-guard.js's RefusalCode) */
const CODES = Object.freeze(['destination-refused', 'headers-refused', 'redirect-refused', 'registry-unreadable']);

/**
 * A page's refusal report as `network.request-refused`'s fields, or null for anything else
 * @param {unknown} report
 * @returns {{surface: string, errorCode: string, count: number} | null}
 */
export function refusalFields(report) {
  if (report === null || typeof report !== 'object') return null;
  const { surface, errorCode, count } = /** @type {Record<string, unknown>} */ (report);
  if (typeof surface !== 'string' || !SURFACES.includes(surface) || typeof errorCode !== 'string' || !CODES.includes(errorCode)) return null;
  if (!Number.isSafeInteger(count) || /** @type {number} */ (count) < 0) return null;
  return { surface, errorCode, count: /** @type {number} */ (count) };
}
