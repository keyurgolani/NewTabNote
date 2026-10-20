/**
 * The query catalog. Queries read committed state through the same adapter commands write
 * to, and return a query state (contracts/outcomes.js). Each query's data is a copy the
 * caller can keep.
 */

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

/** @type {readonly QueryType[]} */
export const QUERY_TYPES = Object.freeze([
  'listNotes',
  'getNote',
  'getNoteBlocks',
  'listFolders',
  'getPreferences',
  'getWorkspaceSession',
]);

/**
 * @param {unknown} type
 * @returns {type is QueryType}
 */
export function isQueryType(type) {
  return typeof type === 'string' && QUERY_TYPES.includes(/** @type {QueryType} */ (type));
}
