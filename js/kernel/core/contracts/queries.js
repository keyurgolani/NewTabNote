/**
 * The query catalog. Queries read committed state through the same adapter commands write
 * to, and return a query state (contracts/outcomes.js). Each query's data is a copy the
 * caller can keep.
 *
 * Each entry names the surfaces allowed to run the query, as the command catalog's entries
 * do, and #13 (message contracts) adds versions and validators to these entries.
 */

/** @typedef {import('./surfaces.js').Surface} Surface */
/** @typedef {import('../domain/note.js').NoteRecord} NoteRecord */
/** @typedef {import('../domain/note.js').BlockRecord} BlockRecord */
/** @typedef {import('../domain/note.js').NoteView} NoteView */
/** @typedef {import('../domain/folder.js').FolderRecord} FolderRecord */
/** @typedef {import('../domain/session.js').WorkspaceSession} WorkspaceSession */

/** @typedef {{type: 'listNotes', view: NoteView}} ListNotes */

/**
 * A note, with its revision from an adapter with revisions, for saveNoteContent's
 * `expectedRevision`.
 * @typedef {{type: 'getNote', noteId: string}} GetNote
 */

/** @typedef {{type: 'getNoteBlocks', noteId: string}} GetNoteBlocks */
/** @typedef {{type: 'listFolders'}} ListFolders */

/**
 * Stored preferences, all of them unless `keys` names some. A key with nothing stored is
 * left out, and the caller applies its default.
 * @typedef {{type: 'getPreferences', keys?: string[]}} GetPreferences
 */

/** @typedef {{type: 'getWorkspaceSession'}} GetWorkspaceSession */

/** @typedef {ListNotes | GetNote | GetNoteBlocks | ListFolders | GetPreferences | GetWorkspaceSession} Query */
/** @typedef {Query['type']} QueryType */

/**
 * @template {QueryType} T
 * @typedef {Extract<Query, {type: T}>} QueryOf
 */

/**
 * What each query's `ready` state holds.
 * @typedef {object} QueryData
 * @property {NoteRecord[]} listNotes
 * @property {{note: NoteRecord, revision?: number}} getNote
 * @property {BlockRecord[]} getNoteBlocks
 * @property {FolderRecord[]} listFolders
 * @property {Record<string, unknown>} getPreferences
 * @property {Partial<WorkspaceSession>} getWorkspaceSession
 */

/**
 * A query's catalog entry: the surfaces allowed to run it.
 * @typedef {Readonly<{surfaces: readonly Surface[]}>} QueryEntry
 */

/**
 * The new tab, Popup, and Side Panel read notes, folders, and preferences today, and the
 * service worker reads nothing through the kernel.
 */
const READERS = Object.freeze(/** @type {Surface[]} */ (['newtab', 'popup', 'sidepanel']));

/** @type {Readonly<Record<QueryType, QueryEntry>>} */
export const QUERIES = Object.freeze({
  listNotes: Object.freeze({ surfaces: READERS }),
  getNote: Object.freeze({ surfaces: READERS }),
  getNoteBlocks: Object.freeze({ surfaces: READERS }),
  listFolders: Object.freeze({ surfaces: READERS }),
  getPreferences: Object.freeze({ surfaces: READERS }),
  getWorkspaceSession: Object.freeze({ surfaces: READERS }),
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
