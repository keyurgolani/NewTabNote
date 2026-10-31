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

/** The pages that send one, by the file the sender's URL names */
const PAGE = /^chrome-extension:\/\/[^/]+\/(newtab|popup|sidepanel|offscreen)\.html$/;

/** The error codes a report carries (network-guard.js's RefusalCode) */
const CODES = Object.freeze(['destination-refused', 'headers-refused', 'redirect-refused', 'registry-unreadable']);

/**
 * A page's refusal report as `network.request-refused`'s fields, or null for anything else.
 * The surface is the page the sender's URL names, whatever the report says.
 * @param {unknown} report
 * @param {unknown} senderUrl - the message sender's URL
 * @returns {{surface: string, errorCode: string, count: number} | null}
 */
export function refusalFields(report, senderUrl) {
  if (report === null || typeof report !== 'object' || typeof senderUrl !== 'string') return null;
  const page = PAGE.exec(senderUrl.split(/[?#]/)[0]);
  if (!page) return null;
  const { errorCode, count } = /** @type {Record<string, unknown>} */ (report);
  if (typeof errorCode !== 'string' || !CODES.includes(errorCode)) return null;
  if (!Number.isSafeInteger(count) || /** @type {number} */ (count) < 0) return null;
  return { surface: page[1], errorCode, count: /** @type {number} */ (count) };
}
