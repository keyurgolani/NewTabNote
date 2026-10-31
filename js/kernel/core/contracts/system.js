/**
 * The coordinator's own queries (#13, "Query"): what only the coordinator holds, so a page asks
 * it over the port instead of reading a repository in-process. The router answers
 * `system.messagingHealth` itself, and #35's coordinator `system.coordinatorHealth`.
 *
 * Each entry is a query entry like the kernel's (contracts/queries.js), and names its schema
 * module under contracts/operations/ the same way, a dot written as a hyphen. The kernel never
 * dispatches these, so the baseline policy reads their surfaces from here too
 * (ports/policy.js).
 */

import { QUERY_DEADLINE_MS, SMALL_MESSAGE_BYTES } from './limits.js';

/** @typedef {import('./queries.js').QueryEntry} QueryEntry */
/** @typedef {import('./surfaces.js').Surface} Surface */

/**
 * The surfaces that show coordinator state today and once #20's Trust Center lists it: the new
 * tab, Popup, Side Panel, and #35's recovery page
 */
const PAGES = Object.freeze(/** @type {Surface[]} */ (['newtab', 'popup', 'sidepanel', 'recovery']));

/**
 * A system query's entry: one the pages ask, small, and cancellable at any time
 * @param {string} schema
 * @returns {QueryEntry}
 */
const systemQuery = schema =>
  Object.freeze({
    kind: /** @type {const} */ ('query'),
    version: 1,
    schema,
    surfaces: PAGES,
    maxBytes: SMALL_MESSAGE_BYTES,
    deadlineMs: QUERY_DEADLINE_MS,
    cancellable: /** @type {const} */ ('any-time'),
    idempotency: /** @type {const} */ ('none'),
    journaled: /** @type {const} */ (false),
    entityTypes: Object.freeze([]),
    destinations: Object.freeze([]),
  });

/** @type {Readonly<Record<'system.messagingHealth' | 'system.coordinatorHealth', QueryEntry>>} */
export const SYSTEM_QUERIES = Object.freeze({
  'system.messagingHealth': systemQuery('./operations/system-messaging-health.js'),
  'system.coordinatorHealth': systemQuery('./operations/system-coordinator-health.js'),
});

/** @typedef {keyof typeof SYSTEM_QUERIES} SystemQueryType */
