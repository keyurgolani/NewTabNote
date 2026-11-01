// A 1.4.x profile's notes, blocks, folders and themes, written and read with raw IndexedDB in the
// shapes 1.4.x's Storage gave them, so the e2e specs and the characterization driver can seed a
// profile and read what the app stored with no app code (#17 PR 4a, Q8). Since 4a the service
// worker has no Storage global, and 4b takes the new tab's.
//
// Each write makes the record 1.4.1's DatabaseManager made for the same call, with every field
// test/fixtures/storage/recorded/v8.v1.4.0.json holds for it, and each read answers what 1.4.1's
// answered: test/kernel/profile-store.test.mjs holds it to both. What differs, on purpose:
// - a write answers once its transaction commits, where 1.4.x's createNote and saveElement
//   answered before (KD-003, KD-004);
// - a note and its search entry, or a note and its name in the entry, go in one transaction;
// - trashNote refuses an untitled note with nothing in it, which 1.4.x deleted for good;
// - seedNotes gives each block every field 1.4.x's editor saved a block of its type with, and
//   refuses a field that type's record has none of, or a type no recording holds.
//
// Each call opens CanvasTabDB as it is, at whatever version, makes no database and upgrades
// none, and closes it before it answers, so it never blocks another context's upgrade. A store
// the profile lacks reads as empty where 1.4.x read it as empty (folders, themes), and a write
// to it throws. It runs on Node, and in an extension page or the service worker through
// e2e/harness/profile-store.js, which evaluates this file's body there: it imports nothing.

/** The database 1.4.x's Storage kept notes in */
export const PROFILE_DATABASE = 'CanvasTabDB';

/**
 * A 1.4.x note record, as DatabaseManager.createNote made one
 * @typedef {Record<string, any> & {id: string, name: string, updatedAt: number}} NoteRecord
 */

/**
 * A block record, as the editor saved one
 * @typedef {Record<string, any> & {id: string, canvasId: string}} BlockRecord
 */

/**
 * A folder record, as DatabaseManager.createFolder made one
 * @typedef {{id: string, name: string, parentId: string | null, createdAt: number, updatedAt: number, color: null, collapsed: boolean}} FolderRecord
 */

/**
 * A note for seedNotes: its name, its blocks' fields in order, and whether it's archived or a
 * template
 * @typedef {{name: string, blocks?: Array<Record<string, unknown>>, archived?: boolean, isTemplate?: boolean}} SeedNote
 */

/**
 * What 1.4.x's editor saved for a block of each type the e2e specs seed, beside the fields every
 * block has: Block.serialize's own (SERIALIZED_FIELDS), then the note's id and the block's
 * order. Each value is the one Block gave a block made without it. test/kernel/profile-store.test.mjs
 * holds each type to its editor save in recorded/v8.v1.4.0.json or recorded/v8.v1.4.0.blocks.json.
 * @type {Readonly<Record<string, Readonly<Record<string, unknown>>>>}
 */
export const BLOCK_TYPE_FIELDS = Object.freeze({
  text: Object.freeze({}),
  h1: Object.freeze({}),
  todo: Object.freeze({}),
  code: Object.freeze({}),
  image: Object.freeze({}),
  bookmark: Object.freeze({ url: '', title: '', description: '', favicon: '' }),
  table: Object.freeze({ rows: 2, cols: 2, tableData: null, hasHeaderRow: true }),
});

/**
 * The fields Block.serialize wrote for every type, with the value Block gave a block made
 * without each; `id`, `type`, and the times aside
 */
export const SERIALIZED_FIELDS = Object.freeze({
  content: '',
  indentLevel: 0,
  checked: false,
  imageUrl: null,
  calloutIcon: '\u{1F4A1}',
});

/**
 * A block of `fields` in note `canvasId` at `order`, as 1.4.x's editor saved one: Block.serialize's
 * fields for its type, each given one over Block's value for it, with the note's id and the
 * order. A type no recording holds, or a field its type's record has none of, throws, so a seed
 * in a shape no release wrote fails where it's made.
 * @param {Record<string, unknown>} fields
 * @param {string} canvasId
 * @param {number} order
 * @returns {BlockRecord}
 */
export function editorBlock(fields, canvasId, order) {
  const type = fields.type === undefined ? 'text' : String(fields.type);
  if (!Object.hasOwn(BLOCK_TYPE_FIELDS, type)) {
    throw new Error(`profile store: no recording holds the ${type} block 1.4.x's editor saved`);
  }
  const now = Date.now();
  /** @type {BlockRecord} */
  const block = {
    id: generateId(),
    type,
    ...SERIALIZED_FIELDS,
    createdAt: now,
    updatedAt: now,
    ...BLOCK_TYPE_FIELDS[type],
    canvasId,
    order,
    ...fields,
  };
  const known = new Set([
    'id',
    'type',
    ...Object.keys(SERIALIZED_FIELDS),
    'createdAt',
    'updatedAt',
    ...Object.keys(BLOCK_TYPE_FIELDS[type]),
    'canvasId',
    'order',
  ]);
  const unknown = Object.keys(block).filter(field => !known.has(field));
  if (unknown.length > 0) {
    throw new Error(`profile store: 1.4.x's editor saved a ${type} block with no ${unknown.join(', ')}`);
  }
  return block;
}

/**
 * An id as 1.4.x's Utils.generateId made one: the time, a dash, and up to nine base-36 characters
 * @returns {string}
 */
export function generateId() {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 11)}`;
}

/**
 * Whether 1.4.x read a note as untitled (DatabaseManager.isNoteUntitled)
 * @param {{name?: unknown}} note
 * @returns {boolean}
 */
export function isUntitled(note) {
  if (!note || typeof note.name !== 'string' || note.name === '') return true;
  const name = note.name.toLowerCase().trim();
  return name === '' || name === 'untitled' || /^untitled\s*\d*$/.test(name);
}

/**
 * Whether 1.4.x read a block as holding nothing (DatabaseManager.isEmptyTextBlock)
 * @param {Record<string, unknown>} block
 * @returns {boolean}
 */
export function isEmptyBlock(block) {
  if ((block.type || 'text') !== 'text') return false;
  return (
    String(block.content || '')
      .replace(/<br\s*\/?>|&nbsp;/gi, '')
      .trim() === ''
  );
}

/**
 * @template T
 * @param {IDBRequest<T>} request
 * @returns {Promise<T>}
 */
function requested(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

/**
 * Resolves when `tx` commits, and rejects when it aborts, or when Chrome closes its connection
 * first: a transaction that close catches fires neither complete nor abort
 * (e2e/connection-closing.spec.js). A close this store makes, on another context's upgrade, fires
 * no close event and lets the transaction finish. Whichever comes first, the other listeners go.
 * @param {IDBTransaction} tx
 * @returns {Promise<void>}
 */
function committed(tx) {
  return new Promise((resolve, reject) => {
    const { db } = tx;
    /** @param {() => void} then */
    const settle = then => {
      tx.removeEventListener('complete', completed);
      tx.removeEventListener('abort', aborted);
      db.removeEventListener('close', closed);
      then();
    };
    const completed = () => settle(() => resolve());
    const aborted = () => settle(() => reject(tx.error || new Error('profile store: the transaction aborted')));
    const closed = () => settle(() => reject(new Error('profile store: Chrome closed the connection')));
    tx.addEventListener('complete', completed);
    tx.addEventListener('abort', aborted);
    db.addEventListener('close', closed);
  });
}

/**
 * CanvasTabDB as it is, at its version, closing on another context's upgrade. A profile without
 * one is refused, and none is made.
 * @param {IDBFactory} factory
 * @returns {Promise<IDBDatabase>}
 */
function openAsItIs(factory) {
  return new Promise((resolve, reject) => {
    const request = factory.open(PROFILE_DATABASE);
    let none = false;
    request.onupgradeneeded = () => {
      none = true;
      if (request.transaction) request.transaction.abort();
    };
    request.onsuccess = () => {
      const db = request.result;
      db.onversionchange = () => db.close();
      resolve(db);
    };
    request.onerror = () => reject(none ? new Error(`profile store: the profile has no ${PROFILE_DATABASE}`) : request.error);
  });
}

/**
 * The profile store over `factory`'s CanvasTabDB: DatabaseManager's calls the e2e specs and the
 * driver made, by the same names and with the same arguments and answers
 * @param {IDBFactory} factory
 */
export function createProfileStore(factory) {
  /**
   * Runs `work` on the database, opened for it alone, and closes it after
   * @template T
   * @param {(db: IDBDatabase) => Promise<T>} work
   * @returns {Promise<T>}
   */
  const withDatabase = async work => {
    const db = await openAsItIs(factory);
    try {
      return await work(db);
    } finally {
      db.close();
    }
  };

  /**
   * @param {IDBDatabase} db
   * @param {string} name
   */
  const has = (db, name) => db.objectStoreNames.contains(name);

  /**
   * Every note, as the `updatedAt` index lists them, oldest first
   * @param {IDBDatabase} db
   * @returns {Promise<NoteRecord[]>}
   */
  const notesIn = db => requested(db.transaction('canvases', 'readonly').objectStore('canvases').index('updatedAt').getAll());

  /**
   * @param {IDBDatabase} db
   * @param {string} id
   * @returns {Promise<NoteRecord | undefined>}
   */
  const noteIn = (db, id) => requested(db.transaction('canvases', 'readonly').objectStore('canvases').get(id));

  /**
   * @param {IDBDatabase} db
   * @param {string} noteId
   * @returns {Promise<BlockRecord[]>}
   */
  const blocksIn = (db, noteId) =>
    requested(db.transaction('elements', 'readonly').objectStore('elements').index('canvasId').getAll(noteId));

  /**
   * DatabaseManager.updateNote: the note with `updatedAt` now, and its search entry's name, when
   * it has one, in one transaction
   * @param {IDBDatabase} db
   * @param {NoteRecord} note
   * @returns {Promise<NoteRecord>}
   */
  const putNote = async (db, note) => {
    note.updatedAt = Date.now();
    const indexed = note.name !== undefined && has(db, 'search_index');
    const tx = db.transaction(indexed ? ['canvases', 'search_index'] : ['canvases'], 'readwrite');
    const done = committed(tx);
    tx.objectStore('canvases').put(note);
    if (indexed) {
      const search = tx.objectStore('search_index');
      const read = search.get(note.id);
      read.onsuccess = () => {
        const entry = read.result;
        if (!entry) return;
        entry.name = note.name;
        entry.updatedAt = Date.now();
        search.put(entry);
      };
    }
    await done;
    return note;
  };

  /**
   * @param {IDBDatabase} db
   * @param {string} id
   * @param {(note: NoteRecord) => void} change
   * @returns {Promise<NoteRecord | null>}
   */
  const changeNote = async (db, id, change) => {
    const note = await noteIn(db, id);
    if (!note) return null;
    change(note);
    return putNote(db, note);
  };

  /**
   * @param {IDBDatabase} db
   * @param {string} name
   * @returns {Promise<NoteRecord>}
   */
  const createNoteIn = async (db, name) => {
    const now = Date.now();
    /** @type {NoteRecord} */
    const note = {
      id: generateId(),
      name,
      createdAt: now,
      updatedAt: now,
      archived: false,
      archivedAt: null,
      titleManuallySet: false,
      lastAutoTitleAt: null,
      insights: null,
      lastInsightsExtractedAt: null,
      preview: '',
      pinned: false,
      todoProgress: null,
      isDaily: false,
      dateStr: null,
      isTemplate: false,
      folderId: null,
      viewport: { scale: 1, offsetX: 0, offsetY: 0 },
      settings: { gridType: 'dots', backgroundColor: '#fafafa' },
    };
    // Without a search_index store the note is still made, as 1.4.x's was, with no entry
    const indexed = has(db, 'search_index');
    const tx = db.transaction(indexed ? ['canvases', 'search_index'] : ['canvases'], 'readwrite');
    const done = committed(tx);
    tx.objectStore('canvases').add(note);
    if (indexed) {
      tx.objectStore('search_index').add({ noteId: note.id, name: note.name, content: '', updatedAt: note.updatedAt });
    }
    await done;
    return note;
  };

  /**
   * @param {IDBDatabase} db
   * @param {BlockRecord} element
   * @returns {Promise<BlockRecord>}
   */
  const saveElementIn = async (db, element) => {
    const tx = db.transaction('elements', 'readwrite');
    const done = committed(tx);
    tx.objectStore('elements').put(element);
    await done;
    return element;
  };

  return Object.freeze({
    /**
     * @param {string} [name]
     * @returns {Promise<NoteRecord>}
     */
    createNote: (name = 'Untitled') => withDatabase(db => createNoteIn(db, name)),

    /**
     * @param {BlockRecord} element
     * @returns {Promise<BlockRecord>}
     */
    saveElement: element => withDatabase(db => saveElementIn(db, element)),

    /**
     * @param {NoteRecord} note
     * @returns {Promise<NoteRecord>}
     */
    updateNote: note => withDatabase(db => putNote(db, note)),

    /**
     * @param {string} id
     * @returns {Promise<NoteRecord | null>}
     */
    archiveNote: id =>
      withDatabase(db =>
        changeNote(db, id, note => {
          note.archived = true;
          note.archivedAt = Date.now();
        }),
      ),

    /**
     * @param {string} id
     * @returns {Promise<NoteRecord | null>}
     */
    unarchiveNote: id =>
      withDatabase(db =>
        changeNote(db, id, note => {
          note.archived = false;
          note.archivedAt = null;
        }),
      ),

    /**
     * DatabaseManager.trashNote, but for an untitled note with nothing in it, which 1.4.x deleted
     * for good: that throws, and nothing is written
     * @param {string} id
     * @returns {Promise<NoteRecord | null>}
     */
    trashNote: id =>
      withDatabase(async db => {
        const note = await noteIn(db, id);
        if (!note) return null;
        if (isUntitled(note) && (await blocksIn(db, id)).every(isEmptyBlock)) {
          throw new Error(`profile store: 1.4.x deletes the untitled empty note ${id} for good, which this store doesn't`);
        }
        note.trashed = true;
        note.trashedAt = Date.now();
        note.archived = false;
        note.archivedAt = null;
        return putNote(db, note);
      }),

    /**
     * @param {string} name
     * @param {string | null} [parentId]
     * @returns {Promise<FolderRecord>}
     */
    createFolder: (name, parentId = null) =>
      withDatabase(async db => {
        if (!has(db, 'folders')) throw new Error('profile store: the profile has no folders store');
        const now = Date.now();
        /** @type {FolderRecord} */
        const folder = { id: generateId(), name, parentId, createdAt: now, updatedAt: now, color: null, collapsed: false };
        const tx = db.transaction('folders', 'readwrite');
        const done = committed(tx);
        tx.objectStore('folders').add(folder);
        await done;
        return folder;
      }),

    /**
     * DatabaseManager.deleteFolder: the folder and every folder under it go, and the notes filed
     * in any of them, archived ones included, move to the top level
     * @param {string} folderId
     * @returns {Promise<true>}
     */
    deleteFolder: folderId =>
      withDatabase(async db => {
        if (!has(db, 'folders')) throw new Error('profile store: the profile has no folders store');
        /** @type {FolderRecord[]} */
        const folders = await requested(db.transaction('folders', 'readonly').objectStore('folders').getAll());
        const notes = (await notesIn(db)).filter(note => !note.trashed && !note.isTemplate);
        const gone = [folderId];
        /** @type {NoteRecord[]} */
        const moved = [];
        for (let i = 0; i < gone.length; i += 1) {
          for (const child of folders) if (child.parentId === gone[i] && !gone.includes(child.id)) gone.push(child.id);
          for (const note of notes) if (note.folderId === gone[i]) moved.push(note);
        }
        const tx = db.transaction(['folders', 'canvases'], 'readwrite');
        const done = committed(tx);
        for (const id of gone) tx.objectStore('folders').delete(id);
        for (const note of moved) {
          note.folderId = null;
          note.updatedAt = Date.now();
          tx.objectStore('canvases').put(note);
        }
        await done;
        return /** @type {true} */ (true);
      }),

    /**
     * Notes newest first, without trashed notes or templates, and without archived ones unless
     * `includeArchived`
     * @param {boolean} [includeArchived]
     * @returns {Promise<NoteRecord[]>}
     */
    getAllNotes: (includeArchived = false) =>
      withDatabase(async db =>
        (await notesIn(db))
          .reverse()
          .filter(note => !note.trashed && !note.isTemplate && (includeArchived || !note.archived)),
      ),

    /**
     * @param {string} id
     * @returns {Promise<NoteRecord | undefined>}
     */
    getNote: id => withDatabase(db => noteIn(db, id)),

    /**
     * @param {string} noteId
     * @returns {Promise<BlockRecord[]>}
     */
    getElementsByNote: noteId => withDatabase(db => blocksIn(db, noteId)),

    /** @returns {Promise<FolderRecord[]>} */
    getAllFolders: () =>
      withDatabase(async db =>
        has(db, 'folders') ? requested(db.transaction('folders', 'readonly').objectStore('folders').getAll()) : [],
      ),

    /**
     * Trashed notes, the one trashed last first
     * @returns {Promise<NoteRecord[]>}
     */
    getTrashedNotes: () =>
      withDatabase(async db =>
        (await notesIn(db)).filter(note => note.trashed).sort((a, b) => (b.trashedAt || 0) - (a.trashedAt || 0)),
      ),

    /**
     * Templates not in the trash, the one changed last first
     * @returns {Promise<NoteRecord[]>}
     */
    getTemplates: () =>
      withDatabase(async db =>
        (await notesIn(db)).filter(note => note.isTemplate && !note.trashed).sort((a, b) => b.updatedAt - a.updatedAt),
      ),

    /**
     * Custom themes, the one changed last first
     * @returns {Promise<Array<Record<string, any>>>}
     */
    getCustomThemes: () =>
      withDatabase(async db =>
        has(db, 'themes')
          ? (await requested(db.transaction('themes', 'readonly').objectStore('themes').index('updatedAt').getAll())).reverse()
          : [],
      ),

    /**
     * Writes `notes` as a user writes them one after another, each in a later millisecond than
     * the one before was last written, so the last is the newest: each note, its blocks in order
     * as 1.4.x's editor saved them (editorBlock), then archived or made a template. Every block
     * is checked before anything is written. Answers each note's id and name.
     * @param {SeedNote[]} notes
     * @returns {Promise<Array<{id: string, name: string}>>}
     */
    seedNotes: notes =>
      withDatabase(async db => {
        // A shape no release wrote fails here, with nothing written
        for (const { blocks = [] } of notes) blocks.forEach((block, order) => editorBlock(block, 'checked', order));
        let lastWrite = 0;
        /** @type {Array<{id: string, name: string}>} */
        const seeded = [];
        for (const { name, blocks = [], archived = false, isTemplate = false } of notes) {
          while (Date.now() <= lastWrite) await new Promise(resolve => setTimeout(resolve, 1));
          const note = await createNoteIn(db, name);
          for (const [order, block] of blocks.entries()) await saveElementIn(db, editorBlock(block, note.id, order));
          if (archived) {
            note.archived = true;
            note.archivedAt = Date.now();
            await putNote(db, note);
          }
          if (isTemplate) {
            note.isTemplate = true;
            await putNote(db, note);
          }
          lastWrite = note.updatedAt;
          seeded.push({ id: note.id, name: note.name });
        }
        return seeded;
      }),
  });
}
