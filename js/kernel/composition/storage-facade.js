/**
 * js/storage.js's calls as a facade (#17 PR 4b, Q7): what #22's and #19's holders still call
 * on it, each a command or a query on the new tab's kernel client, under the names they have
 * always called. NotesManager writes the search entries its indexer makes and each note's
 * embedding (updateSearchIndex, saveVector), and reads the embeddings back (listVectors).
 * GraphView reads the notes and links it draws (listNotes, listLinks). SyncService reads what
 * it uploads (getSyncData). hasStore answers from the database as the adapter opened it.
 *
 * Each answers what Storage's answered, but where the kernel's rules for derived records
 * (application/indexing.js) differ:
 * - an entry or an embedding for a note deleted since the indexer read it isn't kept, and
 *   saveVector answers false for it, as for a database without the store;
 * - setSearchIndex drops the entry of every note that's gone, and a batch that names a note
 *   twice keeps the last entry, as Storage's puts one after another did;
 * - a write that doesn't commit rejects with a StorageFacadeError, which names the command
 *   and its outcome's kind and code, never what it carried, as Storage rejected when
 *   IndexedDB failed.
 *
 * The holders send no sourceRevision yet (the lead's AC1 call on #17 PR 4b), so each write
 * lands as it did. #22's pipeline sends one when it moves the indexer.
 */

import { STORE_SCHEMAS } from '../adapters/indexeddb/schema.js';

/** @typedef {import('./host.js').Client} Client */
/** @typedef {import('../core/contracts/commands.js').Command} Command */
/** @typedef {import('../core/contracts/queries.js').QueryType} QueryType */
/** @typedef {import('../core/contracts/outcomes.js').Outcome} Outcome */
/** @typedef {import('../core/domain/note.js').NoteRecord} NoteRecord */
/** @typedef {import('../core/domain/note.js').VectorRecord} VectorRecord */
/** @typedef {import('../core/ports/repository.js').ExportData} ExportData */

/**
 * @template {QueryType} T
 * @typedef {import('../core/contracts/queries.js').QueryOf<T>} QueryOf
 */

/**
 * @template {QueryType} T
 * @typedef {import('../core/contracts/queries.js').QueryData[T]} QueryData
 */

/**
 * What the facade reads of the tab's database outside the kernel: whether it's open, and which
 * of the stores js/storage.js has always kept it lacks (newtab.js, StorageState)
 * @typedef {Readonly<{openState: string, missingStores: readonly string[]}>} OpenDatabase
 */

/**
 * A search entry as the indexer makes it (js/workers/indexer.js), one a note
 * @typedef {Record<string, unknown> & {noteId: string}} IndexEntry
 */

/**
 * The calls #22's and #19's holders make, each on the tab's kernel
 * @typedef {object} StorageFacade
 * @property {(name: string) => boolean} hasStore
 *   Whether the database is open with the store, one of those js/storage.js has always kept,
 *   by its IndexedDB name, as Storage.hasStore answered
 * @property {(entries: readonly IndexEntry[]) => Promise<void>} setSearchIndex - the whole index
 * @property {(entry: IndexEntry) => Promise<void>} setSearchIndexEntry - one note's entry
 * @property {(noteId: string) => Promise<void>} removeSearchIndexEntry
 * @property {() => Promise<VectorRecord[]>} getAllVectors
 * @property {(noteId: string, vector: number[]) => Promise<boolean>} saveVector
 *   Whether it was saved: false where the store is missing, or the note is gone
 * @property {(includeArchived?: boolean) => Promise<NoteRecord[]>} getAllNotes
 *   The active notes, newest first, or with `includeArchived` the archived ones too
 * @property {() => Promise<Record<string, unknown>[]>} listLinks - every link record
 * @property {() => Promise<ExportData>} exportAll
 *   What sync uploads: every note outside trash with its blocks and media, and every folder
 */

/**
 * A write the facade ran that didn't commit, or a read that failed. Its message names the
 * command or query, the outcome's kind or the read's cause, and its code, never what it carried.
 */
export class StorageFacadeError extends Error {
  /**
   * @param {string} type - the command's or query's
   * @param {string} kind - the outcome's kind, or the failed read's cause
   * @param {string} code
   * @param {unknown} [cause] - the outcome or query state, which carries codes only
   */
  constructor(type, kind, code, cause) {
    super(`NewTabNote couldn't run ${type} (${kind}: ${code})`, { cause });
    this.name = 'StorageFacadeError';
    /** @type {string} */
    this.kind = kind;
    /** @type {string} */
    this.code = code;
  }
}

/**
 * The entries in `entries`, one a note: the last for each note, as Storage's puts one after
 * another left it
 * @param {readonly IndexEntry[]} entries
 * @returns {IndexEntry[]}
 */
function lastPerNote(entries) {
  /** @type {Map<unknown, IndexEntry>} */
  const byNote = new Map();
  for (const entry of entries) byNote.set(entry && typeof entry === 'object' ? entry.noteId : undefined, entry);
  return [...byNote.values()];
}

/**
 * @param {Client} client - the new tab's kernel client
 * @param {{openDatabase: OpenDatabase}} options
 * @returns {Readonly<StorageFacade>}
 */
export function createStorageFacade(client, { openDatabase }) {
  /**
   * Runs a command, answering its outcome
   * @param {string} type
   * @param {Record<string, unknown>} fields
   * @returns {Promise<Outcome>}
   */
  const execute = async (type, fields) =>
    /** @type {Outcome} */ (
      await client.execute(/** @type {Command} */ ({ ...fields, type, commandId: client.ids.next() }))
    );

  /**
   * Runs a command, answering once it commits, which it may do changing nothing
   * @param {string} type
   * @param {Record<string, unknown>} fields
   * @returns {Promise<void>}
   */
  const write = async (type, fields) => {
    const outcome = await execute(type, fields);
    if (outcome.kind !== 'committed') throw new StorageFacadeError(type, outcome.kind, outcome.code, outcome);
  };

  /**
   * A query's data, or `none` when it found nothing, once the kernel is ready
   * @template {QueryType} T
   * @template N
   * @param {QueryOf<T>} query
   * @param {N} none
   * @returns {Promise<QueryData<T> | N>}
   */
  const read = async (query, none) => {
    await client.whenReady();
    const state = await client.query(query);
    if (state.kind === 'ready' || state.kind === 'stale') return state.data;
    if (state.kind === 'empty') return none;
    const [kind, code] = state.kind === 'failed' ? [state.cause, state.code] : ['loading', 'not-ready'];
    throw new StorageFacadeError(query.type, kind, code, state);
  };

  return Object.freeze({
    hasStore: (/** @type {string} */ name) =>
      Object.hasOwn(STORE_SCHEMAS, name) &&
      openDatabase.openState === 'open' &&
      !openDatabase.missingStores.includes(name),

    setSearchIndex: (/** @type {readonly IndexEntry[]} */ entries) =>
      write('updateSearchIndex', { entries: lastPerNote(entries), replaceAll: true }),

    setSearchIndexEntry: (/** @type {IndexEntry} */ entry) => write('updateSearchIndex', { entries: [entry] }),

    removeSearchIndexEntry: (/** @type {string} */ noteId) =>
      write('updateSearchIndex', { entries: [], removed: [noteId] }),

    getAllVectors: () => read({ type: 'listVectors' }, /** @type {VectorRecord[]} */ ([])),

    async saveVector(/** @type {string} */ noteId, /** @type {number[]} */ vector) {
      const outcome = await execute('saveVector', { noteId, vector });
      // A note deleted since the job read it keeps no embedding, which isn't the job's failure
      if (outcome.kind === 'rejected' && outcome.code === 'note-not-found') return false;
      if (outcome.kind !== 'committed') throw new StorageFacadeError('saveVector', outcome.kind, outcome.code, outcome);
      return outcome.changedIds.length > 0;
    },

    getAllNotes: (includeArchived = false) =>
      read({ type: 'listNotes', view: includeArchived ? 'withArchived' : 'active' }, /** @type {NoteRecord[]} */ ([])),

    listLinks: () => read({ type: 'listLinks' }, /** @type {Record<string, unknown>[]} */ ([])),

    async exportAll() {
      const data = await read({ type: 'getSyncData' }, null);
      if (!data) throw new StorageFacadeError('getSyncData', 'storage', 'no-export');
      return data;
    },
  });
}
