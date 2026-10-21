/**
 * The document client (#12 slice 4): what a note editor reads and writes, as intents over its
 * page's kernel client. The new tab's root makes it, and App gives it to every editor it
 * makes, the PiP editor's included, in place of Storage. The editor's reads (its note and
 * blocks, the notes that link to it, the names a wiki link can take, the templates) are
 * queries, and its writes are commands.
 *
 * A read rejects when its query fails, as the Storage call it replaces rejected, so the
 * editor fails where it always has. A write answers the command's outcome and never rejects,
 * and a save opens its transaction before saveContent returns, as the kernel commits it in
 * the calling task.
 */

/** @typedef {import('./host.js').Client} Client */
/** @typedef {import('../core/domain/note.js').NoteRecord} NoteRecord */
/** @typedef {import('../core/domain/note.js').BlockRecord} BlockRecord */
/** @typedef {import('../core/contracts/outcomes.js').Outcome} Outcome */
/** @typedef {import('../core/contracts/queries.js').Query} Query */
/** @typedef {import('../core/contracts/queries.js').QueryType} QueryType */
/** @typedef {import('../core/contracts/queries.js').QueryData} QueryData */

/**
 * @template {import('../core/contracts/commands.js').CommandType} T
 * @typedef {Omit<import('../core/contracts/commands.js').CommandOf<T>, 'type' | 'commandId'>} Fields
 */

/**
 * @template {QueryType} T
 * @typedef {import('../core/contracts/queries.js').QueryOf<T>} QueryOf
 */

/**
 * @typedef {object} DocumentClient
 * @property {(noteId: string) => Promise<{note: NoteRecord, blocks: BlockRecord[]} | null>} openNote
 *   The note and its blocks in note order, or null when the note isn't stored
 * @property {(save: Fields<'saveNoteContent'>) => Promise<Outcome>} saveContent
 * @property {(noteId: string, blockIds: string[]) => Promise<Outcome>} deleteBlocks
 * @property {(note: Fields<'createNote'>) => Promise<Outcome>} createNote
 * @property {(noteId: string, name: string) => Promise<Outcome>} deriveTitle
 * @property {(noteId: string) => Promise<NoteRecord[]>} backlinks - the notes that link to it
 * @property {() => Promise<string[]>} noteNames - the names a wiki link can take, as Storage.getNoteNames lists them
 * @property {() => Promise<NoteRecord[]>} templates
 * @property {(noteId: string) => Promise<BlockRecord[]>} blocksOf - a note's blocks in note order
 * @property {() => string} newId - an id for a note or block the editor makes
 */

/**
 * @param {Client} client - the page's kernel client
 * @returns {DocumentClient}
 */
export function createDocumentClient(client) {
  /**
   * A query's data, or `none` when it found nothing. Its kernel is ready once the page has
   * started, which the read waits for.
   * @template {QueryType} T
   * @template N
   * @param {QueryOf<T>} query
   * @param {N} none
   * @returns {Promise<QueryData[T] | N>}
   */
  const read = async (query, none) => {
    await client.whenReady();
    const state = await client.query(query);
    if (state.kind === 'ready' || state.kind === 'stale') return state.data;
    if (state.kind === 'empty') return none;
    const why = state.kind === 'failed' ? `${state.cause}: ${state.code}` : 'not ready';
    throw new Error(`NewTabNote couldn't read ${query.type} (${why})`, { cause: state });
  };

  return Object.freeze({
    async openNote(noteId) {
      const found = await read({ type: 'getNote', noteId }, null);
      if (!found) return null;
      return { note: found.note, blocks: await read({ type: 'getNoteBlocks', noteId }, []) };
    },

    saveContent: save => client.execute({ ...save, type: 'saveNoteContent', commandId: client.ids.next() }),

    deleteBlocks: (noteId, blockIds) =>
      client.execute({ type: 'deleteBlocks', commandId: client.ids.next(), noteId, blockIds }),

    createNote: note => client.execute({ ...note, type: 'createNote', commandId: client.ids.next() }),

    deriveTitle: (noteId, name) =>
      client.execute({ type: 'applyDerivedTitle', commandId: client.ids.next(), noteId, name }),

    backlinks: noteId => read({ type: 'getBacklinks', noteId }, []),

    async noteNames() {
      const notes = await read({ type: 'listNotes', view: 'withArchived' }, []);
      /** @type {string[]} */
      const names = [];
      for (const { name } of notes) {
        if (typeof name === 'string' && name.trim() !== '' && name.toLowerCase() !== 'untitled') names.push(name);
      }
      return names;
    },

    templates: () => read({ type: 'listNotes', view: 'templates' }, []),

    blocksOf: noteId => read({ type: 'getNoteBlocks', noteId }, []),

    newId: () => client.ids.next(),
  });
}
