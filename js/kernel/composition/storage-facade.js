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
 * - setSearchIndex drops the entry of every note that's gone, and of a note it's given twice
 *   keeps the last entry, as Storage's puts one after another did;
 * - setSearchIndex sends the whole index in bounded batches, each once the one before it
 *   answers, and then removes the entries stored as it began that it names none of (#262), so
 *   once the new tab's writes go to the worker (#35 slice 4d) another page's save gets its turn
 *   between two batches, and an entry another command writes meanwhile stays;
 * - a write that doesn't commit rejects with a StorageFacadeError, which names the command
 *   and its outcome's kind and code, never what it carried, as Storage rejected when
 *   IndexedDB failed.
 *
 * The holders send no sourceRevision yet (the lead's AC1 call on #17 PR 4b), so each write
 * lands as it did. #22's pipeline sends one when it moves the indexer.
 */

import { STORE_SCHEMAS } from '../adapters/indexeddb/schema.js';
import { encodedBytes } from '../core/contracts/codec.js';

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
 * The note an entry is for, or undefined for one that isn't an entry
 * @param {unknown} entry
 * @returns {unknown}
 */
const noteOf = entry => (entry && typeof entry === 'object' ? /** @type {IndexEntry} */ (entry).noteId : undefined);

/**
 * The entries in `entries`, one a note: the last for each note, as Storage's puts one after
 * another left it
 * @param {readonly IndexEntry[]} entries
 * @returns {IndexEntry[]}
 */
function lastPerNote(entries) {
  /** @type {Map<unknown, IndexEntry>} */
  const byNote = new Map();
  for (const entry of entries) byNote.set(noteOf(entry), entry);
  return [...byNote.values()];
}

/**
 * The most one batch of the whole index holds (#262): 100 entries, and 256 KiB of their JSON as
 * UTF-8. Chrome's second JSON encoding at most doubles a frame, so a batch stays under the
 * command's ceiling (#259), and under the 1 MiB cap it had before, unless it's a lone entry that's
 * larger on its own.
 */
const INDEX_BATCH_ENTRIES = 100;
const INDEX_BATCH_BYTES = 256 * 1024;

/**
 * The whole index's commands, in order (#262): the entries, then the note ids to remove, in
 * batches of at most INDEX_BATCH_ENTRIES items and INDEX_BATCH_BYTES of their JSON, each item
 * counted as the codec encodes it. An item larger than that on its own goes alone. There's always
 * one batch, so a write of nothing still runs a command, as the one command of the whole index did.
 * @param {readonly IndexEntry[]} entries
 * @param {readonly string[]} removed
 * @returns {Array<{entries: IndexEntry[], removed: string[]}>}
 */
function batchesOf(entries, removed) {
  /** @type {Array<{entries: IndexEntry[], removed: string[]}>} */
  const batches = [];
  /** @type {{entries: IndexEntry[], removed: string[]}} */
  let batch = { entries: [], removed: [] };
  let count = 0;
  let bytes = 0;
  /** @param {unknown} item - the next one, which a full batch leaves to the next */
  const makeRoom = item => {
    const size = encodedBytes(JSON.stringify(item) ?? '');
    if (count > 0 && (count >= INDEX_BATCH_ENTRIES || bytes + size > INDEX_BATCH_BYTES)) {
      batches.push(batch);
      batch = { entries: [], removed: [] };
      count = 0;
      bytes = 0;
    }
    count += 1;
    bytes += size;
  };
  for (const entry of entries) {
    makeRoom(entry);
    batch.entries.push(entry);
  }
  for (const noteId of removed) {
    makeRoom(noteId);
    batch.removed.push(noteId);
  }
  batches.push(batch);
  return batches;
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

  /**
   * The note ids of the stored search entries, keys alone, in one read, never paged, so none of
   * them is an entry another command writes once the whole index's write has begun (#262). Null when
   * the read fails, an answer over the 1 MiB answer cap among them: that write then removes nothing,
   * and the next rebuild tries again.
   * @returns {Promise<string[] | null>}
   */
  const storedEntryIds = async () => {
    try {
      return await read({ type: 'listSearchEntryIds' }, /** @type {string[]} */ ([]));
    } catch {
      return null;
    }
  };

  return Object.freeze({
    hasStore: (/** @type {string} */ name) =>
      Object.hasOwn(STORE_SCHEMAS, name) &&
      openDatabase.openState === 'open' &&
      !openDatabase.missingStores.includes(name),

    // The whole index (#262), as bounded batches, none replacing the index: what was stored is read
    // first, and the batches after the entries remove what it names none of. Each batch goes once
    // the one before it answers, so on the worker's queue another page's save takes its turn between
    // two (#35 slice 4d). A batch that doesn't commit ends the write, as the one command did.
    async setSearchIndex(/** @type {readonly IndexEntry[]} */ entries) {
      const whole = lastPerNote(entries);
      const stored = await storedEntryIds();
      const named = new Set(whole.map(noteOf));
      const removed = stored === null ? [] : stored.filter(noteId => !named.has(noteId));
      for (const batch of batchesOf(whole, removed)) {
        await write(
          'updateSearchIndex',
          batch.removed.length > 0 ? { entries: batch.entries, removed: batch.removed } : { entries: batch.entries },
        );
      }
    },

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
