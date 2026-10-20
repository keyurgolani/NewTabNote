/**
 * The surfaces a caller can be, named as #13 (message contracts) names the principal: the
 * page path for an extension page (`newtab` for every new tab, `popup`, `sidepanel`,
 * `offscreen`, and #35's `recovery`), and `worker-internal` for the service worker's own
 * code. Each catalog entry lists the surfaces allowed to run it, and a surface no entry lists
 * can run nothing.
 */

/** @typedef {'newtab' | 'popup' | 'sidepanel' | 'offscreen' | 'worker-internal' | 'recovery'} Surface */

/** @type {readonly Surface[]} */
export const SURFACES = Object.freeze(['newtab', 'popup', 'sidepanel', 'offscreen', 'worker-internal', 'recovery']);
