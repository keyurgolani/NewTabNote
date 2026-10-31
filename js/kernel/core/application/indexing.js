/**
 * #22's derived writes and the reads beside them (#17 PR 4b): the search entries the new tab's
 * indexer makes from notes, each note's embedding, and the links and embeddings the graph view
 * and semantic search read. Both writes are derived (scopes.js), so neither can touch a note,
 * and neither leaves a search entry or an embedding behind for a note that's gone.
 *
 * A record keeps the content revision it was made from when its job says one,
 * `sourceRevision`. One made from an older revision than the stored record's is dropped and
 * commits with no changed ids, as attachInsights drops older insights (#17, "Versions"), so a
 * slow job never puts an older record back. One that says none lands, as every write did before.
 * Both commit under the `index` aggregate, which the note list doesn't follow (commands.js).
 */

import { isId, isRecord } from '../contracts/checks.js';
import { committed, empty, ready, rejected } from '../contracts/outcomes.js';
import { invalid, isOptionalVersion, noteNotFound, noteRecord } from './notes.js';
import { unitsWork } from './work.js';

/** @typedef {import('../ports/repository.js').Unit} Unit */
/** @typedef {import('../domain/note.js').SearchEntry} SearchEntry */
/** @typedef {import('../domain/note.js').VectorRecord} VectorRecord */

/**
 * @template {import('../contracts/commands.js').CommandType} T
 * @typedef {import('./work.js').CommandHandler<T>} CommandHandler
 */

/**
 * @template {import('../contracts/queries.js').QueryType} T
 * @typedef {import('./work.js').QueryHandler<T>} QueryHandler
 */

/**
 * The revision a stored record says it was made from, or undefined for one that says none, as
 * no record written before #17 PR 4b does
 * @param {Record<string, unknown> | undefined} record
 * @returns {number | undefined}
 */
function sourceOf(record) {
  const value = record ? record.sourceRevision : undefined;
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

/**
 * Whether a record made from `sourceRevision` is older than `stored`, and so dropped. Only when
 * both say what they were made from: one that says nothing lands, and so does one over a
 * record that says nothing.
 * @param {number | undefined} sourceRevision
 * @param {Record<string, unknown> | undefined} stored
 */
function olderThan(sourceRevision, stored) {
  const kept = sourceOf(stored);
  return sourceRevision !== undefined && kept !== undefined && sourceRevision < kept;
}

/**
 * @param {unknown} value
 * @returns {value is number[]}
 */
const isVector = value =>
  Array.isArray(value) && value.length > 0 && value.every(item => typeof item === 'number' && Number.isFinite(item));

/** @type {{updateSearchIndex: CommandHandler<'updateSearchIndex'>, saveVector: CommandHandler<'saveVector'>}} */
export const indexCommands = {
  updateSearchIndex(command) {
    const { entries, removed = [], replaceAll = false } = command;
    if (!Array.isArray(entries) || !Array.isArray(removed) || typeof replaceAll !== 'boolean') return invalid();
    /** @type {Set<string>} */
    const named = new Set();
    for (const entry of entries) {
      if (!isRecord(entry) || !isId(entry.noteId) || !isOptionalVersion(entry.sourceRevision)) return invalid();
      // One entry a note, so which one is stored never depends on the order they came in
      if (named.has(entry.noteId)) return rejected('validation', 'duplicate-entry');
      named.add(entry.noteId);
    }
    if (!removed.every(isId) || removed.some(noteId => named.has(noteId))) return invalid();
    /** @type {string[]} */
    let changed = [];
    /** @type {Unit} */
    const index = {
      stores: ['notes', 'searchIndex'],
      async run(tx) {
        // Each run decides afresh, since an adapter may run the unit again (ports/repository.js, Unit)
        changed = [];
        // A database without the store has no index, as Storage.setSearchIndex skipped it
        if (!tx.has('searchIndex')) return;
        // The whole index is read at once when it's all replaced, and an entry at a time otherwise
        const notes = replaceAll ? new Set((await tx.getAll('notes')).map(note => note.id)) : null;
        const stored = replaceAll
          ? new Map((await tx.getAll('searchIndex')).map(entry => [entry.noteId, entry]))
          : null;
        /** @type {Set<string>} */
        const kept = new Set();
        for (const entry of entries) {
          // A note deleted since the indexer read it keeps no entry: its entry went with it
          const found = notes ? notes.has(entry.noteId) : Boolean(await tx.get('notes', entry.noteId));
          if (!found) continue;
          kept.add(entry.noteId);
          const before = stored ? stored.get(entry.noteId) : await tx.get('searchIndex', entry.noteId);
          if (olderThan(entry.sourceRevision, before)) continue;
          tx.put('searchIndex', /** @type {SearchEntry} */ (entry));
          changed.push(entry.noteId);
        }
        // Replacing the index drops the entry of every note the batch doesn't name or that's gone
        const gone = stored ? [...stored.keys()].filter(noteId => !kept.has(noteId)) : [];
        for (const noteId of new Set([...removed, ...gone])) {
          const before = stored ? stored.get(noteId) : await tx.get('searchIndex', noteId);
          if (!before) continue;
          tx.delete('searchIndex', noteId);
          changed.push(noteId);
        }
      },
    };
    return unitsWork(
      command,
      [index],
      () =>
        changed.length > 0
          ? committed('search-index-updated', changed)
          : committed('search-index-unchanged', [], { severity: 'info' }),
      { scope: 'derived' },
    );
  },

  saveVector(command, { clock }) {
    const { noteId, vector, sourceRevision } = command;
    if (!isId(noteId) || !isVector(vector) || !isOptionalVersion(sourceRevision)) return invalid();
    const now = clock.now();
    let saved = false;
    /** @type {Unit} */
    const save = {
      stores: ['notes', 'vectors'],
      async run(tx) {
        // Each run decides afresh, since an adapter may run the unit again (ports/repository.js, Unit)
        saved = false;
        if (!(await tx.get('notes', noteId))) return noteNotFound();
        // A database without the store keeps no embedding, as Storage.saveVector skipped it
        if (!tx.has('vectors')) return;
        if (olderThan(sourceRevision, await tx.get('vectors', noteId))) return;
        /** @type {VectorRecord} */
        const record = { id: noteId, noteId, vector, updatedAt: now };
        if (sourceRevision !== undefined) record.sourceRevision = sourceRevision;
        tx.put('vectors', record);
        saved = true;
      },
    };
    return unitsWork(
      command,
      [save],
      () => (saved ? committed('vector-saved', [noteId]) : committed('vector-unchanged', [], { severity: 'info' })),
      { primary: noteRecord(noteId), scope: 'derived' },
    );
  },
};

/** @type {{listLinks: QueryHandler<'listLinks'>, listVectors: QueryHandler<'listVectors'>}} */
export const indexQueries = {
  async listLinks(query, { adapter, clock }) {
    const links = await adapter.read(['links'], tx => tx.getAll('links'));
    return links.length > 0 ? ready(clock.now(), links) : empty(clock.now());
  },

  async listVectors(query, { adapter, clock }) {
    const vectors = await adapter.read(['vectors'], tx => tx.getAll('vectors'));
    return vectors.length > 0 ? ready(clock.now(), vectors) : empty(clock.now());
  },
};
