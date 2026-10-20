/**
 * The policy port (#12, "Policy"). Every use case asks it before any adapter runs. The
 * caller is `{surface, contextId}` from the composition root, never from a payload, so a
 * page can't claim another surface. #21 (security and scopes) replaces the baseline policy
 * behind the same port.
 *
 * Both methods answer synchronously, so saveNoteContent can open its transaction in the
 * task that calls it.
 */

import { isCommandType } from '../contracts/commands.js';
import { isQueryType } from '../contracts/queries.js';

/** @typedef {import('../contracts/commands.js').CommandType} CommandType */
/** @typedef {import('../contracts/queries.js').QueryType} QueryType */

/** @typedef {'newtab' | 'popup' | 'sidepanel' | 'worker'} Surface */
/** @typedef {{surface: Surface, contextId: string}} Caller */
/** @typedef {{allowed: true} | {allowed: false, code: string}} Decision */

/**
 * @typedef {object} PolicyPort
 * @property {(command: {type?: unknown}, caller: Caller) => Decision} authorize
 * @property {(query: {type?: unknown}, caller: Caller) => Decision} authorizeQuery
 */

/** @type {readonly Surface[]} */
export const SURFACES = Object.freeze(['newtab', 'popup', 'sidepanel', 'worker']);

/**
 * What each surface could do before the kernel: everything from the new-tab page, a quick
 * note and reads from Popup, reads from Side Panel, and capture plus startup maintenance from
 * the service worker.
 * @type {Readonly<Record<Surface, Readonly<{commands: 'all' | readonly CommandType[], queries: 'all' | readonly QueryType[]}>>>}
 */
export const BASELINE_CAPABILITIES = Object.freeze({
  newtab: Object.freeze({ commands: 'all', queries: 'all' }),
  popup: Object.freeze({ commands: commandList(['createNote']), queries: 'all' }),
  sidepanel: Object.freeze({ commands: commandList([]), queries: 'all' }),
  worker: Object.freeze({
    commands: commandList(['captureToDailyNote', 'runStartupMaintenance']),
    queries: Object.freeze(/** @type {QueryType[]} */ ([])),
  }),
});

/**
 * @param {CommandType[]} types
 * @returns {readonly CommandType[]}
 */
function commandList(types) {
  return Object.freeze(types);
}

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
 * The baseline policy: exactly BASELINE_CAPABILITIES. A request the catalog doesn't have,
 * one outside the caller's surface, and any request from a caller that isn't one of the four
 * surfaces are denied.
 * @returns {PolicyPort}
 */
export function createBaselinePolicy() {
  /**
   * @param {{type?: unknown}} request
   * @param {Caller} caller
   * @param {'commands' | 'queries'} kind
   * @returns {Decision}
   */
  const decide = (request, caller, kind) => {
    if (!isCaller(caller)) return deny('unknown-caller');
    const type = request !== null && typeof request === 'object' ? request.type : undefined;
    const known = kind === 'commands' ? isCommandType(type) : isQueryType(type);
    if (!known) return deny(kind === 'commands' ? 'unknown-command' : 'unknown-query');
    const allowed = BASELINE_CAPABILITIES[caller.surface][kind];
    if (allowed === 'all' || /** @type {readonly unknown[]} */ (allowed).includes(type)) return ALLOW;
    return deny('not-on-surface');
  };
  return Object.freeze({
    authorize: (command, caller) => decide(command, caller, 'commands'),
    authorizeQuery: (query, caller) => decide(query, caller, 'queries'),
  });
}
