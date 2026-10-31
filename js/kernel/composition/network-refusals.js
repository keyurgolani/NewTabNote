/**
 * The network guard's refusals into a context's diagnostic journal (#21 slice 1b, "Guard"):
 * the guard (network-guard.js) installed first in the context counts each call it refuses,
 * and journalRefusals hands its reports to the context's failure events as
 * `network.request-refused` (event-codes.js), the ones it held until now first. This module
 * imports nothing, so the guard's own code stays out of the graph that reads it: a page's
 * guard is a script of its own.
 */

/** The guard's mark, where its handle is on the context (network-guard.js's GUARD) */
const GUARD = Symbol.for('ntn.networkGuard');

/**
 * Hand the guard's refusal reports on `scope` to `events`. A context without the guard has none
 * to hand. Never throws.
 * @param {any} scope
 * @param {{event(code: string, fields?: Record<string, unknown>): unknown}} events
 * @returns {boolean} whether there was a guard to listen to
 */
export function journalRefusals(scope, events) {
  try {
    const handle = scope && scope[GUARD];
    if (!handle || typeof handle.onRefused !== 'function') return false;
    handle.onRefused((/** @type {Record<string, unknown>} */ report) => {
      try {
        events.event('network.request-refused', report);
      } catch {
        // The journal is best effort
      }
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Have the guard on `scope` refuse every destination from now on, as the service worker does
 * when the destination client finds a problem with the registry. Reported once. Never throws.
 * @param {any} scope
 */
export function refuseEveryDestination(scope) {
  try {
    const handle = scope && scope[GUARD];
    if (handle && typeof handle.refuseAll === 'function') handle.refuseAll();
  } catch {
    // The client refuses every request on its own
  }
}
