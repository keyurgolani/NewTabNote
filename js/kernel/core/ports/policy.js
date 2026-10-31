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
 * A row a root adds for a request type no catalog here lists (#13): the surfaces it's
 * accepted from and, where the row narrows it further, which of those requests it accepts
 * (`allows`, given the request). recovery.html's root passes the trust operations' rows
 * (js/trust/core/router-rows.js), so kernel core never imports the trust catalog.
 * @typedef {Readonly<{
 *   surfaces: readonly Surface[],
 *   allows?: (request: {type?: unknown} & Readonly<Record<string, unknown>>) => boolean,
 * }>} PolicyRow
 */

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
 * The baseline policy: each catalog entry's `surfaces`, and for a type no catalog lists, its
 * row in `rows` when the root passes one. A request neither has, one from a surface its entry
 * or row doesn't list, one its row's `allows` refuses, and any request from a caller that
 * isn't a known surface are denied. A row never widens a catalog entry: the entry decides
 * for its own type.
 * @param {{rows?: Readonly<Record<string, PolicyRow>>}} [options]
 * @returns {PolicyPort}
 */
export function createBaselinePolicy({ rows = {} } = {}) {
  return Object.freeze({
    authorize(request, caller) {
      if (!isCaller(caller)) return deny('unknown-caller');
      const type = request !== null && typeof request === 'object' ? request.type : undefined;
      const surfaces = allowedSurfaces(type);
      if (surfaces) return surfaces.includes(caller.surface) ? ALLOW : deny('not-on-surface');
      const row = typeof type === 'string' && Object.hasOwn(rows, type) ? rows[type] : undefined;
      if (!row) return deny('unknown-operation');
      if (!row.surfaces.includes(caller.surface)) return deny('not-on-surface');
      return !row.allows || row.allows(/** @type {{type?: unknown} & Record<string, unknown>} */ (request))
        ? ALLOW
        : deny('not-on-surface');
    },
  });
}
