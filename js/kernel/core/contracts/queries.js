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

import { MAX_MESSAGE_BYTES, QUERY_DEADLINE_MS, SMALL_MESSAGE_BYTES } from './limits.js';

/** @typedef {import('./surfaces.js').Surface} Surface */
/** @typedef {import('./fields.js').EntityType} EntityType */
/** @typedef {import('../domain/note.js').NoteRecord} NoteRecord */
/** @typedef {import('../domain/note.js').BlockRecord} BlockRecord */
/** @typedef {import('../domain/folder.js').FolderRecord} FolderRecord */
/** @typedef {import('../domain/session.js').WorkspaceSession} WorkspaceSession */
/** @typedef {import('./settings.js').PreferenceValues} PreferenceValues */
/** @typedef {import('../domain/note.js').SearchEntry} SearchEntry */

/** @typedef {import('./operations/list-notes.js').ListNotes} ListNotes */
/** @typedef {import('./operations/get-note.js').GetNote} GetNote */
/** @typedef {import('./operations/get-note-blocks.js').GetNoteBlocks} GetNoteBlocks */
/** @typedef {import('./operations/get-backlinks.js').GetBacklinks} GetBacklinks */
/** @typedef {import('./operations/get-note-list.js').GetNoteList} GetNoteList */
/** @typedef {import('./operations/get-notes-by-ids.js').GetNotesByIds} GetNotesByIds */
/** @typedef {import('./operations/list-search-entries.js').ListSearchEntries} ListSearchEntries */
/** @typedef {import('./operations/list-folders.js').ListFolders} ListFolders */
/** @typedef {import('./operations/get-preferences.js').GetPreferences} GetPreferences */
/** @typedef {import('./operations/get-workspace-session.js').GetWorkspaceSession} GetWorkspaceSession */
/** @typedef {import('./operations/get-popup-insights-enabled.js').GetPopupInsightsEnabled} GetPopupInsightsEnabled */
/** @typedef {import('./operations/get-insights-pending.js').GetInsightsPending} GetInsightsPending */
/** @typedef {import('./operations/get-job-runs.js').GetJobRuns} GetJobRuns */
/** @typedef {import('./operations/list-snapshots.js').ListSnapshots} ListSnapshots */
/** @typedef {import('./operations/get-snapshot.js').GetSnapshot} GetSnapshot */
/** @typedef {import('./operations/find-daily-note.js').FindDailyNote} FindDailyNote */
/** @typedef {import('./operations/get-workspace-data.js').GetWorkspaceData} GetWorkspaceData */
/** @typedef {import('./operations/list-themes.js').ListThemes} ListThemes */
/** @typedef {import('./operations/export-backup.js').ExportBackup} ExportBackup */
/** @typedef {import('./operations/profile-holds-content.js').ProfileHoldsContent} ProfileHoldsContent */
/** @typedef {import('./operations/list-links.js').ListLinks} ListLinks */
/** @typedef {import('./operations/list-vectors.js').ListVectors} ListVectors */
/** @typedef {import('./operations/get-sync-data.js').GetSyncData} GetSyncData */
/** @typedef {import('../ports/repository.js').ExportData} ExportData */
/** @typedef {import('../domain/note.js').LinkRecord} LinkRecord */
/** @typedef {import('../domain/note.js').VectorRecord} VectorRecord */
/** @typedef {import('./settings.js').WorkspaceDataValues} WorkspaceDataValues */
/** @typedef {import('./entities.js').ThemeEntity} ThemeEntity */
/** @typedef {import('../domain/snapshot.js').SnapshotRecord} SnapshotRecord */
/** @typedef {import('../domain/snapshot.js').SnapshotSummary} SnapshotSummary */

/**
 * @typedef {ListNotes | GetNote | GetNoteBlocks | GetBacklinks | GetNoteList | GetNotesByIds | ListSearchEntries
 *   | ListFolders
 *   | GetPreferences | GetWorkspaceSession | GetPopupInsightsEnabled | GetInsightsPending | GetJobRuns
 *   | ListSnapshots | GetSnapshot | FindDailyNote
 *   | GetWorkspaceData | ListThemes | ExportBackup | ProfileHoldsContent | ListLinks | ListVectors | GetSyncData} Query
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
 * @property {{note: NoteRecord, revision?: number, placementVersion?: number}} getNote
 * @property {BlockRecord[]} getNoteBlocks
 * @property {NoteRecord[]} getBacklinks
 * @property {{notes: NoteRecord[], folders: FolderRecord[], searchEntries: SearchEntry[]}} getNoteList
 * @property {{notes: NoteRecord[], searchEntries: SearchEntry[]}} getNotesByIds
 * @property {SearchEntry[]} listSearchEntries
 * @property {FolderRecord[]} listFolders
 * @property {PreferenceValues} getPreferences
 * @property {Partial<WorkspaceSession>} getWorkspaceSession
 * @property {{insightsEnabled: boolean}} getPopupInsightsEnabled
 * @property {{since: number | null}} getInsightsPending
 * @property {{lastAutoTitleRun: number, lastInsightsRun: number}} getJobRuns
 * @property {SnapshotSummary[]} listSnapshots
 * @property {SnapshotRecord} getSnapshot
 * @property {{note: NoteRecord}} findDailyNote
 * @property {WorkspaceDataValues} getWorkspaceData
 * @property {ThemeEntity[]} listThemes
 * @property {Blob} exportBackup
 * @property {boolean} profileHoldsContent
 * @property {LinkRecord[]} listLinks
 * @property {VectorRecord[]} listVectors
 * @property {ExportData} getSyncData
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
 * @param {number} [maxBytes] - for a request that carries a list as long as the user makes it
 * @returns {QueryEntry}
 */
const entry = (module, entityTypes, surfaces = READERS, maxBytes = SMALL_MESSAGE_BYTES) =>
  Object.freeze({
    kind: /** @type {const} */ ('query'),
    version: 1,
    schema: `./operations/${module}.js`,
    surfaces,
    maxBytes,
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
  getNoteList: entry('get-note-list', [], NEW_TAB),
  getNotesByIds: entry('get-notes-by-ids', ['note'], NEW_TAB, MAX_MESSAGE_BYTES),
  listSearchEntries: entry('list-search-entries', [], NEW_TAB),
  listFolders: entry('list-folders', []),
  getPreferences: entry('get-preferences', []),
  getWorkspaceSession: entry('get-workspace-session', []),
  // Only Popup has read it, and #4 replaces it
  getPopupInsightsEnabled: entry('get-popup-insights-enabled', [], Object.freeze(/** @type {Surface[]} */ (['popup']))),
  // The new tab's auto-title and insights jobs, and its editor, read their bookkeeping
  getInsightsPending: entry('get-insights-pending', ['note'], NEW_TAB),
  getJobRuns: entry('get-job-runs', [], NEW_TAB),
  // Only the new tab's editor has shown version history
  listSnapshots: entry('list-snapshots', ['note'], NEW_TAB),
  getSnapshot: entry('get-snapshot', ['snapshot'], NEW_TAB),
  // The new tab reads the Daily Note it opens after ensureDailyNote
  findDailyNote: entry('find-daily-note', [], NEW_TAB),
  // The new tab's controllers read back what slice 6's commands write (#12 slice 7)
  getWorkspaceData: entry('get-workspace-data', [], NEW_TAB),
  listThemes: entry('list-themes', [], NEW_TAB),
  // Export JSON and Create Backup. The file is a Blob, which only an in-page kernel hands over
  exportBackup: entry('export-backup', [], NEW_TAB),
  // The export notice decides once whether the profile has anything to export
  profileHoldsContent: entry('profile-holds-content', [], NEW_TAB),
  // The graph view's links and #22's embeddings, which only the new tab reads (#17 PR 4b)
  listLinks: entry('list-links', [], NEW_TAB),
  listVectors: entry('list-vectors', [], NEW_TAB),
  // What #19's sync uploads, which only the new tab's sync service reads (#17 PR 4b)
  getSyncData: entry('get-sync-data', [], NEW_TAB),
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
