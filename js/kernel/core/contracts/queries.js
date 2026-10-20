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

/** @typedef {import('./operations/list-notes.js').ListNotes} ListNotes */
/** @typedef {import('./operations/get-note.js').GetNote} GetNote */
/** @typedef {import('./operations/get-note-blocks.js').GetNoteBlocks} GetNoteBlocks */
/** @typedef {import('./operations/list-folders.js').ListFolders} ListFolders */
/** @typedef {import('./operations/get-preferences.js').GetPreferences} GetPreferences */
/** @typedef {import('./operations/get-workspace-session.js').GetWorkspaceSession} GetWorkspaceSession */

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

/**
 * A version 1 entry
 * @param {string} module - the schema module's name under contracts/operations/
 * @param {EntityType[]} entityTypes
 * @returns {QueryEntry}
 */
const entry = (module, entityTypes) =>
  Object.freeze({
    kind: /** @type {const} */ ('query'),
    version: 1,
    schema: `./operations/${module}.js`,
    surfaces: READERS,
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
  listFolders: entry('list-folders', []),
  getPreferences: entry('get-preferences', []),
  getWorkspaceSession: entry('get-workspace-session', []),
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
