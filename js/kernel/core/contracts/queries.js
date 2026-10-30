/**
 * The query catalog. Queries read committed state through the same adapter commands write
 * to, and return a query state (contracts/outcomes.js). Each query's data is a copy the
 * caller can keep.
 *
 * Each entry declares its query once, as the command catalog's entries do (#13, "Desired
 * behavior"): its catalog version, its schema module under contracts/operations/, the
 * surfaces allowed to run it, the most its request may encode to, its deadline, and the
 * entity types its ids may name. A query can be cancelled until it answers, and has no
 * idempotency key. Each query's type comes from its schema, through JSDoc.
 */

import { QUERY_DEADLINE_MS, SMALL_MESSAGE_BYTES } from './limits.js';

/** @typedef {import('./surfaces.js').Surface} Surface */
/** @typedef {import('./fields.js').EntityType} EntityType */
/** @typedef {import('../domain/note.js').NoteRecord} NoteRecord */
/** @typedef {import('../domain/note.js').BlockRecord} BlockRecord */
/** @typedef {import('../domain/folder.js').FolderRecord} FolderRecord */
/** @typedef {import('../domain/session.js').WorkspaceSession} WorkspaceSession */
/** @typedef {import('./settings.js').PreferenceValues} PreferenceValues */

/** @typedef {import('./operations/list-notes.js').ListNotes} ListNotes */
/** @typedef {import('./operations/get-note.js').GetNote} GetNote */
/** @typedef {import('./operations/get-note-blocks.js').GetNoteBlocks} GetNoteBlocks */
/** @typedef {import('./operations/get-backlinks.js').GetBacklinks} GetBacklinks */
/** @typedef {import('./operations/list-folders.js').ListFolders} ListFolders */
/** @typedef {import('./operations/get-preferences.js').GetPreferences} GetPreferences */
/** @typedef {import('./operations/get-workspace-session.js').GetWorkspaceSession} GetWorkspaceSession */
/** @typedef {import('./operations/get-popup-insights-enabled.js').GetPopupInsightsEnabled} GetPopupInsightsEnabled */
/** @typedef {import('./operations/get-insights-pending.js').GetInsightsPending} GetInsightsPending */
/** @typedef {import('./operations/get-job-runs.js').GetJobRuns} GetJobRuns */

/**
 * @typedef {ListNotes | GetNote | GetNoteBlocks | GetBacklinks | ListFolders | GetPreferences
 *   | GetWorkspaceSession | GetPopupInsightsEnabled | GetInsightsPending | GetJobRuns} Query
 */
/** @typedef {Query['type']} QueryType */

/**
 * @template {QueryType} T
 * @typedef {Extract<Query, {type: T}>} QueryOf
 */

/**
 * What each query's `ready` state holds. test/kernel/schemas.test.mjs holds each to what its
 * result schema accepts.
 * @typedef {object} QueryData
 * @property {NoteRecord[]} listNotes
 * @property {{note: NoteRecord, revision?: number}} getNote
 * @property {BlockRecord[]} getNoteBlocks
 * @property {NoteRecord[]} getBacklinks
 * @property {FolderRecord[]} listFolders
 * @property {PreferenceValues} getPreferences
 * @property {Partial<WorkspaceSession>} getWorkspaceSession
 * @property {{insightsEnabled: boolean}} getPopupInsightsEnabled
 * @property {{since: number | null}} getInsightsPending
 * @property {{lastAutoTitleRun: number, lastInsightsRun: number}} getJobRuns
 */

/**
 * A query's catalog entry. `maxBytes` caps its encoded request, envelope included, and
 * `deadlineMs` runs from when the request is sent.
 * @typedef {Readonly<{
 *   kind: 'query',
 *   version: number,
 *   schema: string,
 *   surfaces: readonly Surface[],
 *   maxBytes: number,
 *   deadlineMs: number,
 *   cancellable: 'any-time',
 *   idempotency: 'none',
 *   journaled: false,
 *   entityTypes: readonly EntityType[],
 *   destinations: readonly string[],
 * }>} QueryEntry
 */

/**
 * The new tab, Popup, and Side Panel read notes, folders, and preferences today, and the
 * service worker reads nothing through the kernel.
 */
const READERS = Object.freeze(/** @type {Surface[]} */ (['newtab', 'popup', 'sidepanel']));

/** Only the new tab reads it */
const NEW_TAB = Object.freeze(/** @type {Surface[]} */ (['newtab']));

/**
 * A version 1 entry
 * @param {string} module - the schema module's name under contracts/operations/
 * @param {EntityType[]} entityTypes
 * @param {readonly Surface[]} [surfaces]
 * @returns {QueryEntry}
 */
const entry = (module, entityTypes, surfaces = READERS) =>
  Object.freeze({
    kind: /** @type {const} */ ('query'),
    version: 1,
    schema: `./operations/${module}.js`,
    surfaces,
    maxBytes: SMALL_MESSAGE_BYTES,
    deadlineMs: QUERY_DEADLINE_MS,
    cancellable: /** @type {const} */ ('any-time'),
    idempotency: /** @type {const} */ ('none'),
    journaled: /** @type {const} */ (false),
    entityTypes: Object.freeze(entityTypes),
    destinations: Object.freeze([]),
  });

/** @type {Readonly<Record<QueryType, QueryEntry>>} */
export const QUERIES = Object.freeze({
  listNotes: entry('list-notes', []),
  getNote: entry('get-note', ['note']),
  getNoteBlocks: entry('get-note-blocks', ['note']),
  // Only the new tab's editor has shown backlinks
  getBacklinks: entry('get-backlinks', ['note'], NEW_TAB),
  listFolders: entry('list-folders', []),
  getPreferences: entry('get-preferences', []),
  getWorkspaceSession: entry('get-workspace-session', []),
  // Only Popup has read it, and #4 replaces it
  getPopupInsightsEnabled: entry('get-popup-insights-enabled', [], Object.freeze(/** @type {Surface[]} */ (['popup']))),
  // The new tab's auto-title and insights jobs, and its editor, read their bookkeeping
  getInsightsPending: entry('get-insights-pending', ['note'], NEW_TAB),
  getJobRuns: entry('get-job-runs', [], NEW_TAB),
});

/** @type {readonly QueryType[]} */
export const QUERY_TYPES = Object.freeze(/** @type {QueryType[]} */ (Object.keys(QUERIES)));

/**
 * @param {unknown} type
 * @returns {type is QueryType}
 */
export function isQueryType(type) {
  return typeof type === 'string' && Object.hasOwn(QUERIES, type);
}
