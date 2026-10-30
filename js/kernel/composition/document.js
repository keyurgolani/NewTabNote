/**
 * The document client (#12 slice 4): what a note editor reads and writes, as intents over its
 * page's kernel client. The new tab's root makes it, and App gives it to every editor it
 * makes, the PiP editor's included, in place of Storage. The editor's reads (its note and
 * blocks, the notes that link to it, the names a wiki link can take, the templates) are
 * queries, and its writes are commands. The note jobs (auto-title and insights, in
 * NotesManager, the editor, and AI chat) read and write through it too: each write names the
 * note it means, and none takes a note record.
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
/** @typedef {import('../core/domain/snapshot.js').SnapshotRecord} SnapshotRecord */
/** @typedef {import('../core/domain/snapshot.js').SnapshotSummary} SnapshotSummary */
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
 * @property {(noteId: string) => Promise<NoteRecord | null>} readNote - the note as stored, or null when it isn't
 * @property {(noteId: string) => Promise<NoteRecord[]>} backlinks - the notes that link to it
 * @property {() => Promise<string[]>} noteNames - the names a wiki link can take, as Storage.getNoteNames lists them
 * @property {() => Promise<NoteRecord[]>} templates
 * @property {(noteId: string) => Promise<BlockRecord[]>} blocksOf - a note's blocks in note order
 * @property {() => string} newId - an id for a note or block the editor makes
 * @property {(noteId: string, name: string, contentHash?: string) => Promise<Outcome>} deriveTitle
 *   A title a job derived (applyDerivedTitle): dropped, `title-kept`, when the note has a title
 *   set by hand
 * @property {(noteId: string, name: string, origin: 'typed' | 'generated') => Promise<Outcome>} renameNote
 *   A title the user asked for (renameNote), a generated one included
 * @property {(noteId: string, insights: unknown, contentHash?: string) => Promise<Outcome>} attachInsights
 *   Writes the note's insight fields and nothing else
 * @property {(noteId: string, pending: boolean) => Promise<Outcome>} setInsightsPending
 * @property {(noteId: string) => Promise<number | null>} insightsPending
 *   Since when the note's insights have been being extracted, or null
 * @property {(job: 'autoTitle' | 'insights') => Promise<Outcome>} recordJobRun
 * @property {() => Promise<{lastAutoTitleRun: number, lastInsightsRun: number}>} jobRuns
 *   When each job last started, 0 for never
 * @property {(keys: Array<keyof import('../core/contracts/settings.js').PreferenceValues>) =>
 *   Promise<import('../core/contracts/settings.js').PreferenceValues>} preferences
 *   The stored preferences of `keys`; one with nothing stored is left out, for its caller's default
 * @property {() => Promise<NoteRecord[]>} activeNotes - the active notes, newest first, as Storage.getAllNotes listed them
 * @property {(noteId: string, blocks: Array<Record<string, unknown> & {id: string}>, title: string) => Promise<Outcome>} saveSnapshot
 *   A snapshot of the note's blocks and title for its version history, under an id taken now
 * @property {(noteId: string) => Promise<SnapshotSummary[]>} snapshots - the note's snapshots, newest first
 * @property {(snapshotId: string) => Promise<SnapshotRecord | null>} snapshot - one snapshot, blocks included, or null
 * @property {(noteId: string, snapshotId: string, blocks: Array<Record<string, unknown> & {id: string}>, name?: string) =>
 *   Promise<Outcome>} restoreSnapshot
 *   Reverts the note to the snapshot: the note as stored becomes a snapshot first, under an id
 *   taken now, then `blocks` and `name` replace its own, in one unit
 * @property {(noteId: string, blocks: Array<Record<string, unknown> & {id: string}>, atOrder?: number) => Promise<Outcome>} insertBlocks
 *   New blocks, at `atOrder` or after the last, with the note's preview and links following
 * @property {() => boolean} connectionOpen
 *   Whether the page's connection to the database is open now, so a save started now opens
 *   its first transaction, which a closing connection lets finish
 * @property {(flush: () => void) => () => void} beforeConnectionCloses
 *   Runs `flush` when another context upgrades the database, before the page's connection
 *   closes, so an editor writes what it has pending: a save it opens then commits. Answers a
 *   function that stops it. A page with no such connection never runs it.
 */

/**
 * @param {Client} client - the page's kernel client
 * @param {{
 *   beforeConnectionCloses?: DocumentClient['beforeConnectionCloses'],
 *   connectionOpen?: DocumentClient['connectionOpen'],
 * }} [connection] What the page's connection runs before it closes for another context's
 *   upgrade, and whether it's open
 * @returns {DocumentClient}
 */
export function createDocumentClient(
  client,
  { beforeConnectionCloses = () => () => {}, connectionOpen = () => true } = {},
) {
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

    async readNote(noteId) {
      const found = await read({ type: 'getNote', noteId }, null);
      return found ? found.note : null;
    },

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

    deriveTitle: (noteId, name, contentHash) =>
      client.execute({
        type: 'applyDerivedTitle',
        commandId: client.ids.next(),
        noteId,
        name,
        ...(contentHash === undefined ? {} : { contentHash }),
      }),

    renameNote: (noteId, name, origin) =>
      client.execute({ type: 'renameNote', commandId: client.ids.next(), noteId, name, origin }),

    attachInsights: (noteId, insights, contentHash) =>
      client.execute({
        type: 'attachInsights',
        commandId: client.ids.next(),
        noteId,
        insights,
        ...(contentHash === undefined ? {} : { contentHash }),
      }),

    setInsightsPending: (noteId, pending) =>
      client.execute({ type: 'setInsightsPending', commandId: client.ids.next(), noteId, pending }),

    async insightsPending(noteId) {
      const found = await read({ type: 'getInsightsPending', noteId }, null);
      return found ? found.since : null;
    },

    recordJobRun: job => client.execute({ type: 'recordJobRun', commandId: client.ids.next(), job }),

    jobRuns: () => read({ type: 'getJobRuns' }, { lastAutoTitleRun: 0, lastInsightsRun: 0 }),

    preferences: keys => read({ type: 'getPreferences', keys }, {}),

    activeNotes: () => read({ type: 'listNotes', view: 'active' }, []),

    saveSnapshot: (noteId, blocks, title) =>
      client.execute({
        type: 'saveSnapshot',
        commandId: client.ids.next(),
        noteId,
        snapshotId: client.ids.next(),
        blocks,
        title,
      }),

    snapshots: noteId => read({ type: 'listSnapshots', noteId }, []),

    snapshot: snapshotId => read({ type: 'getSnapshot', snapshotId }, null),

    restoreSnapshot: (noteId, snapshotId, blocks, name) =>
      client.execute({
        type: 'restoreSnapshot',
        commandId: client.ids.next(),
        noteId,
        snapshotId,
        preSnapshotId: client.ids.next(),
        blocks,
        ...(name === undefined ? {} : { name }),
      }),

    insertBlocks: (noteId, blocks, atOrder) =>
      client.execute({
        type: 'insertBlocks',
        commandId: client.ids.next(),
        noteId,
        blocks,
        ...(atOrder === undefined ? {} : { atOrder }),
      }),

    beforeConnectionCloses,

    connectionOpen,
  });
}
