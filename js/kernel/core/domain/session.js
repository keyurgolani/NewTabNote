/**
 * The workspace session (#12, "State ownership"). TabController owns the tabs while a new
 * tab is open and persists them with saveWorkspaceSession: the open notes, the active tab,
 * split view and its second note, and the note the last tab showed.
 */

import { isId, isIdOrNull, isRecord } from '../contracts/checks.js';

/**
 * @typedef {object} WorkspaceSession
 * @property {Array<{noteId: string} & Record<string, unknown>> | null} openTabs
 * @property {number} activeTabIndex
 * @property {boolean} splitViewEnabled
 * @property {string | null} secondaryNoteId
 * @property {string | null} lastOpenedNoteId
 */

/** @typedef {keyof WorkspaceSession} WorkspaceSessionKey */

/** @type {readonly WorkspaceSessionKey[]} */
export const WORKSPACE_SESSION_KEYS = Object.freeze([
  'openTabs',
  'activeTabIndex',
  'splitViewEnabled',
  'secondaryNoteId',
  'lastOpenedNoteId',
]);

/**
 * The values Storage.initializeDefaultSettings gives these keys on first run. Startup
 * maintenance writes them where nothing is stored yet, as it does the default preferences.
 * @type {Readonly<Partial<WorkspaceSession>>}
 */
export const DEFAULT_SESSION = Object.freeze({ openTabs: null, activeTabIndex: 0 });

/** @type {Readonly<Record<WorkspaceSessionKey, (value: unknown) => boolean>>} */
const VALID = Object.freeze({
  openTabs: value => value === null || (Array.isArray(value) && value.every(tab => isRecord(tab) && isId(tab.noteId))),
  activeTabIndex: value => Number.isInteger(value),
  splitViewEnabled: value => typeof value === 'boolean',
  secondaryNoteId: isIdOrNull,
  lastOpenedNoteId: isIdOrNull,
});

/**
 * The first key of a partial session that the session doesn't have, or whose value has the
 * wrong type. Null when every key is fine.
 * @param {Record<string, unknown>} values
 * @returns {string | null}
 */
export function sessionIssue(values) {
  for (const [key, value] of Object.entries(values)) {
    if (!Object.hasOwn(VALID, key) || !VALID[/** @type {WorkspaceSessionKey} */ (key)](value)) return key;
  }
  return null;
}
