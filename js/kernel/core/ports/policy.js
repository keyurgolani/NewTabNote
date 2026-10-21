/**
 * The policy port (#12, "Policy"). Every command and query asks it the same question before
 * any adapter runs: may this caller run this catalog entry? The caller is
 * `{surface, contextId}` from the composition root, never from a payload, so a page can't
 * claim another surface. #13 (message contracts) passes the principal it verified as the
 * caller, and #21 (security and scopes) replaces the baseline policy behind the same port.
 *
 * It answers synchronously, so saveNoteContent can open its transaction in the task that
 * calls it.
 */

import { COMMANDS } from '../contracts/commands.js';
import { QUERIES } from '../contracts/queries.js';
import { SURFACES } from '../contracts/surfaces.js';
import { SYSTEM_QUERIES } from '../contracts/system.js';

/** @typedef {import('../contracts/surfaces.js').Surface} Surface */
/** @typedef {{surface: Surface, contextId: string}} Caller */
/** @typedef {{allowed: true} | {allowed: false, code: string}} Decision */

/**
 * @typedef {object} PolicyPort
 * @property {(request: {type?: unknown}, caller: Caller) => Decision} authorize
 *   For a command or a query, by its `type`
 */

export { SURFACES };

/** @type {Decision} */
const ALLOW = Object.freeze({ allowed: true });

/**
 * @param {string} code
 * @returns {Decision}
 */
function deny(code) {
  return { allowed: false, code };
}

/**
 * @param {unknown} caller
 * @returns {caller is Caller}
 */
function isCaller(caller) {
  if (caller === null || typeof caller !== 'object') return false;
  const { surface, contextId } = /** @type {{surface?: unknown, contextId?: unknown}} */ (caller);
  return SURFACES.includes(/** @type {Surface} */ (surface)) && typeof contextId === 'string' && contextId !== '';
}

/**
 * The surfaces a catalog entry allows, or undefined when no entry has that type: the kernel's
 * commands and queries, and the coordinator's own queries, which the router answers
 * (contracts/system.js)
 * @param {unknown} type
 * @returns {readonly Surface[] | undefined}
 */
function allowedSurfaces(type) {
  if (typeof type !== 'string') return undefined;
  if (Object.hasOwn(COMMANDS, type)) return COMMANDS[/** @type {keyof typeof COMMANDS} */ (type)].surfaces;
  if (Object.hasOwn(QUERIES, type)) return QUERIES[/** @type {keyof typeof QUERIES} */ (type)].surfaces;
  if (Object.hasOwn(SYSTEM_QUERIES, type)) {
    return SYSTEM_QUERIES[/** @type {keyof typeof SYSTEM_QUERIES} */ (type)].surfaces;
  }
  return undefined;
}

/**
 * The baseline policy: each catalog entry's `surfaces`. A request the catalog doesn't have,
 * one from a surface its entry doesn't list, and any request from a caller that isn't a known
 * surface are denied.
 * @returns {PolicyPort}
 */
export function createBaselinePolicy() {
  return Object.freeze({
    authorize(request, caller) {
      if (!isCaller(caller)) return deny('unknown-caller');
      const surfaces = allowedSurfaces(request !== null && typeof request === 'object' ? request.type : undefined);
      if (!surfaces) return deny('unknown-operation');
      return surfaces.includes(caller.surface) ? ALLOW : deny('not-on-surface');
    },
  });
}
