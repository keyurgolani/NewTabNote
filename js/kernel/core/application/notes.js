/**
 * Note use cases (#12, "Commands"): the note lifecycle, editor saves, derived titles and
 * insights, capture, bulk actions, and the note queries.
 *
 * Each command reads the note as committed and writes only the fields its intent touches,
 * so two commands on one note never undo each other: pinning an open note survives the
 * editor's next save, and a derived title or insights never put an old copy back.
 */

import { BULK_ACTIONS } from '../contracts/commands.js';
import { isId, isIdList, isIdOrNull, isRecord } from '../contracts/checks.js';
import { bulk, committed, conflict, empty, failed, ready, rejected } from '../contracts/outcomes.js';
import {
  NOTE_VIEWS,
  blocksFromTemplate,
  captureBlock,
  dailyDateStr,
  dailyNoteName,
  dailyNoteNameFor,
  expiredInTrash,
  findDailyNoteFor,
  inBlockOrder,
  insertLinkText,
  isDateStr,
  isEmpty,
  isUntitled,
  linkTargets,
  newDailyNoteRecord,
  newNoteRecord,
  newSearchEntry,
  noteSaveMetadata,
  notesInView,
  trashRetentionDays,
  wikiLinkNames,
} from '../domain/note.js';
import { contentChanged, unitsWork } from './work.js';

/** @typedef {import('../domain/note.js').NoteRecord} NoteRecord */
/** @typedef {import('../domain/note.js').BlockRecord} BlockRecord */
/** @typedef {import('../domain/note.js').NoteView} NoteView */
/** @typedef {import('../domain/note.js').SearchEntry} SearchEntry */
/** @typedef {import('../contracts/outcomes.js').Rejected} Rejected */
/** @typedef {import('../contracts/outcomes.js').BulkItem} BulkItem */
/** @typedef {import('../ports/repository.js').Unit} Unit */
/** @typedef {import('../ports/repository.js').Tx} Tx */
/** @typedef {import('../ports/repository.js').StoreName} StoreName */

/**
 * @template {import('../contracts/commands.js').CommandType} T
 * @typedef {import('./work.js').CommandHandler<T>} CommandHandler
 */

/**
 * @template {import('../contracts/queries.js').QueryType} T
 * @typedef {import('./work.js').QueryHandler<T>} QueryHandler
 */

/**
 * @typedef {'createNote' | 'renameNote' | 'setPinned' | 'archiveNote' | 'unarchiveNote' | 'trashNote'
 *   | 'restoreNote' | 'saveNoteContent' | 'deleteBlocks' | 'insertBlocks' | 'applyDerivedTitle' | 'attachInsights'
 *   | 'captureToDailyNote' | 'ensureDailyNote' | 'runBulkAction' | 'moveNoteToFolder' | 'convertNoteToTemplate'
 *   | 'convertTemplateToNote' | 'deleteNotePermanently' | 'emptyTrash' | 'runTrashCleanup'} NoteCommandType
 */

/**
 * @typedef {'listNotes' | 'getNote' | 'getNoteBlocks' | 'getBacklinks' | 'getNoteList' | 'getNotesByIds'
 *   | 'listSearchEntries' | 'findDailyNote'}
 *   NoteQueryType
 */

export const invalid = () => rejected('validation', 'invalid-command');
export const noteNotFound = () => rejected('not-found', 'note-not-found');

/**
 * Whether a command's expected version (or a derived command's source revision) is one it
 * may carry: absent, or a count from 0
 * @param {unknown} value
 * @returns {value is undefined | number}
 */
export const isOptionalVersion = value => value === undefined || (Number.isSafeInteger(value) && Number(value) >= 0);

/**
 * The conflict a note's committed versions give a command that expects others (#17,
 * "Versions"), asked after a `get` of the note in `tx` and before the unit writes anything: a
 * content command's `expectedRevision` is a `revision-conflict` with the current revision, and
 * a placement command's `expectedPlacementVersion` a `placement-conflict`, whose
 * `currentRevision` holds the current placement version. None on an adapter without revisions,
 * where the write over a newer one wins, or for a note the get didn't find.
 * @param {Tx} tx
 * @param {string} noteId
 * @param {{expectedRevision?: number, expectedPlacementVersion?: number}} expected
 * @returns {import('../contracts/outcomes.js').Conflict | undefined}
 */
export function versionConflict(tx, noteId, { expectedRevision, expectedPlacementVersion }) {
  if (expectedRevision === undefined && expectedPlacementVersion === undefined) return undefined;
  const versions = tx.versions('notes', noteId);
  if (!versions) return undefined;
  if (expectedRevision !== undefined && versions.revision !== expectedRevision) {
    return conflict('revision-conflict', versions.revision);
  }
  if (expectedPlacementVersion !== undefined && versions.placementVersion !== expectedPlacementVersion) {
    return conflict('placement-conflict', versions.placementVersion);
  }
  return undefined;
}

/**
 * What a bulk command is refused for before any of it runs: an action it doesn't know, or
 * notes that aren't a list of ids. The kernel asks before the adapter recalls the command,
 * which reserves a bulk command's key, so a refused one leaves no record and the corrected
 * one can run under the same commandId.
 * @param {{action: unknown, noteIds: unknown}} command
 * @returns {Rejected | undefined}
 */
export function bulkRefusal({ action, noteIds }) {
  if (typeof action !== 'string' || !Object.hasOwn(BULK_ACTIONS, action) || !isIdList(noteIds)) return invalid();
  return undefined;
}

/**
 * @param {string} noteId
 * @returns {() => {store: StoreName, key: string}}
 */
export const noteRecord = noteId => () => ({ store: 'notes', key: noteId });

/**
 * A unit that reads the note and puts what `change` makes of it, in one transaction.
 * `change` returns null to put nothing. A version the command expects is checked before
 * anything is put (versionConflict).
 * @param {string} noteId
 * @param {(note: NoteRecord) => NoteRecord | null} change
 * @param {{expectedRevision?: number, expectedPlacementVersion?: number}} [expected]
 * @returns {Unit}
 */
function changeNote(noteId, change, expected = {}) {
  return {
    stores: ['notes'],
    async run(tx) {
      const note = await tx.get('notes', noteId);
      if (!note) return noteNotFound();
      const stale = versionConflict(tx, noteId, expected);
      if (stale) return stale;
      const next = change(note);
      if (next) tx.put('notes', next);
    },
  };
}

/** The stores a note deleted for good is deleted from: what Storage.permanentlyDeleteNote deletes */
const DELETED_WITH_NOTE = /** @type {StoreName[]} */ (['notes', 'blocks', 'media', 'vectors', 'snapshots']);

/**
 * Delete a note for good in `tx`, with what Storage.permanentlyDeleteNote deletes: its blocks,
 * media, vectors, and snapshots, then the note. Its links and search entry stay, as they
 * always have, until #17's deletion takes them too. `tx` spans DELETED_WITH_NOTE.
 * @param {Tx} tx
 * @param {string} noteId
 * @param {BlockRecord[]} [blocks] - its blocks, when the caller has read them
 * @returns {Promise<void>}
 */
async function deleteNoteIn(tx, noteId, blocks) {
  for (const block of blocks || (await tx.getAllByIndex('blocks', 'canvasId', noteId))) tx.delete('blocks', block.id);
  for (const key of await tx.getKeysByIndex('media', 'canvasId', noteId)) tx.delete('media', key);
  tx.delete('vectors', noteId);
  for (const key of await tx.getKeysByIndex('snapshots', 'noteId', noteId)) tx.delete('snapshots', key);
  tx.delete('notes', noteId);
}

/**
 * Work that deletes, for good and in one transaction, the trashed notes `pick` chooses from
 * every stored note, and commits naming them
 * @param {import('../contracts/commands.js').Command} command
 * @param {string} code
 * @param {(notes: NoteRecord[]) => NoteRecord[]} pick
 */
function deleteTrashed(command, code, pick) {
  /** @type {string[]} */
  let deleted = [];
  /** @type {Unit} */
  const remove = {
    stores: DELETED_WITH_NOTE,
    async run(tx) {
      // Each run decides afresh, since an adapter may run the unit again (ports/repository.js, Unit)
      deleted = pick(await tx.getAll('notes')).map(note => note.id);
      for (const noteId of deleted) await deleteNoteIn(tx, noteId);
    },
  };
  return unitsWork(command, [remove], () => committed(code, deleted), { scope: 'placement' });
}

/**
 * A unit that gives the note's search entry a new name, when it has an entry, as
 * Storage.updateNote does through updateNoteNameInSearchIndex.
 * @param {string} noteId
 * @param {string} name
 * @param {number} now
 * @returns {Unit}
 */
export function renameSearchEntry(noteId, name, now) {
  return {
    stores: ['searchIndex'],
    async run(tx) {
      const entry = await tx.get('searchIndex', noteId);
      if (entry) tx.put('searchIndex', { ...entry, name, updatedAt: now });
    },
  };
}

/**
 * Units that replace the wiki links from `noteId` with links to the notes `names` name, as
 * Storage.updateNoteLinks has: the notes are read in one transaction, as it read them with
 * getAllNotes, and the links replaced in another, which only ever spans the links store. With
 * no names, the note's links are only deleted, as Storage.clearLinksFromNote deletes them.
 * @param {string} noteId
 * @param {readonly string[]} names
 * @param {{now: number, nextId: () => string}} stamp
 * @returns {Unit[]}
 */
export function replaceLinks(noteId, names, { now, nextId }) {
  /** @type {string[]} */
  let targets = [];
  return [
    {
      stores: ['notes'],
      mode: 'readonly',
      when: () => names.length > 0,
      // Each run decides afresh, since an adapter may run the units again (ports/repository.js, Unit)
      async run(tx) {
        targets = linkTargets(await tx.getAll('notes'), names, noteId);
      },
    },
    {
      stores: ['links'],
      async run(tx) {
        for (const key of await tx.getKeysByIndex('links', 'fromNoteId', noteId)) tx.delete('links', key);
        for (const toNoteId of targets) tx.put('links', { id: nextId(), fromNoteId: noteId, toNoteId, createdAt: now });
      },
    },
  ];
}

/**
 * The blocks a command carries, as records of `noteId`. A block of another note, or two
 * blocks with one id, are refused.
 * @param {unknown} blocks
 * @param {string} noteId
 * @returns {BlockRecord[] | Rejected}
 */
export function blockRecords(blocks, noteId) {
  if (!Array.isArray(blocks)) return invalid();
  const seen = new Set();
  /** @type {BlockRecord[]} */
  const records = [];
  for (const block of blocks) {
    if (!isRecord(block) || !isId(block.id)) return invalid();
    if (block.canvasId !== undefined && block.canvasId !== noteId)
      return rejected('validation', 'block-of-another-note');
    if (seen.has(block.id)) return rejected('validation', 'duplicate-block');
    seen.add(block.id);
    records.push({ ...block, id: block.id, canvasId: noteId });
  }
  return records;
}

/**
 * @param {unknown} value
 * @returns {value is undefined | string}
 */
const isOptionalString = value => value === undefined || typeof value === 'string';

/**
 * @param {unknown} value
 * @returns {value is string[]}
 */
const isStringList = value => Array.isArray(value) && value.every(item => typeof item === 'string');

/**
 * @param {unknown} value
 * @returns {value is import('../domain/note.js').Capture}
 */
function isCapture(value) {
  if (!isRecord(value)) return false;
  if (value.type === 'bookmark') return isOptionalString(value.url) && isOptionalString(value.title);
  if (value.type === 'text') return typeof value.content === 'string' && isOptionalString(value.source);
  return false;
}

/**
 * The Daily Note for `dateStr`, found or made in `tx`, which spans the notes store: the one
 * Storage.ensureDailyNote and ensureDailyNoteForDate would find, or else a new one with id
 * `noteId`, `isDaily`, and `dateStr` in one put. Two of these at once can't both make one,
 * since each transaction that writes the notes store waits for the one before it to finish,
 * and the later one finds the note the earlier one made. Capture and ensureDailyNote both
 * find their Daily Note here.
 * @param {Tx} tx
 * @param {{noteId: string, dateStr: string, name: string, now: number}} daily
 * @returns {Promise<{dailyId: string, created: boolean} | Rejected>}
 */
async function findOrMakeDailyNote(tx, { noteId, dateStr, name, now }) {
  const found = findDailyNoteFor(await tx.getAll('notes'), dateStr);
  if (found) return { dailyId: found.id, created: false };
  if (await tx.get('notes', noteId)) return rejected('validation', 'note-exists');
  tx.put('notes', newDailyNoteRecord({ id: noteId, name, dateStr, now }));
  return { dailyId: noteId, created: true };
}

/**
 * A new Daily Note's first blocks: copies of the Daily Note template's, as
 * Storage.applyTemplateToNote made them, read in `tx`, which spans the blocks store. None
 * when no template is set.
 * @param {Tx} tx
 * @param {unknown} templateId - the `dailyNoteTemplate` preference
 * @param {{noteId: string, title: string, now: number, nextId: () => string}} target
 * @returns {Promise<BlockRecord[]>}
 */
async function dailyTemplateBlocks(tx, templateId, target) {
  if (!isId(templateId)) return [];
  return blocksFromTemplate(await tx.getAllByIndex('blocks', 'canvasId', templateId), target);
}

/**
 * A command that sets placement fields on one note (pinned, archived, trashed), so the
 * note's content revision stays where it was and its placement version moves. One that
 * carries `expectedPlacementVersion` is a `placement-conflict` when the note has another.
 * @param {import('../contracts/commands.js').Command & {noteId: unknown, expectedPlacementVersion?: unknown}} command
 * @param {string} code
 * @param {(note: NoteRecord) => NoteRecord} change
 */
function setFields(command, code, change) {
  const { noteId, expectedPlacementVersion } = command;
  if (!isId(noteId) || !isOptionalVersion(expectedPlacementVersion)) return invalid();
  return unitsWork(
    command,
    [changeNote(noteId, change, { expectedPlacementVersion })],
    () => committed(code, [noteId]),
    { primary: noteRecord(noteId), scope: 'placement' },
  );
}

/** @type {{[T in NoteCommandType]: CommandHandler<T>}} */
export const noteCommands = {
  createNote(command, { clock }) {
    const {
      noteId,
      name = 'Untitled',
      folderId = null,
      blocks = [],
      pinned = false,
      titleManuallySet = false,
    } = command;
    if (!isId(noteId) || typeof name !== 'string' || !isIdOrNull(folderId)) return invalid();
    if (typeof pinned !== 'boolean' || typeof titleManuallySet !== 'boolean') return invalid();
    const records = blockRecords(blocks, noteId);
    if (!Array.isArray(records)) return records;
    const now = clock.now();
    const note = newNoteRecord({ id: noteId, name, now, folderId, pinned, titleManuallySet });
    /** @type {StoreName[]} */
    const stores = ['notes', 'searchIndex'];
    if (folderId !== null) stores.push('folders');
    if (records.length > 0) stores.push('blocks');
    // One transaction checks the folder and writes the note, its search entry, and its first
    // blocks, so on every adapter a new note lands whole or not at all: an import, a note made
    // from a dragged block, or the welcome note never stays behind without its blocks, and a
    // folder deleted meanwhile can't leave it filed nowhere. Storage.createNote wrote the note
    // and its entry together, and its callers saved the blocks one by one after it.
    /** @type {Unit} */
    const create = {
      stores,
      async run(tx) {
        if (folderId !== null && !(await tx.get('folders', folderId))) {
          return rejected('not-found', 'folder-not-found');
        }
        if (await tx.get('notes', noteId)) return rejected('validation', 'note-exists');
        tx.put('notes', note);
        tx.put('searchIndex', newSearchEntry(note, now));
        for (const block of records) tx.put('blocks', block);
      },
    };
    return unitsWork(command, [create], () => committed('note-created', [noteId]), {
      primary: noteRecord(noteId),
      revised: contentChanged,
    });
  },

  renameNote(command, { clock }) {
    const { noteId, name, origin = 'typed', expectedRevision } = command;
    if (!isId(noteId) || typeof name !== 'string' || (origin !== 'typed' && origin !== 'generated')) return invalid();
    if (!isOptionalVersion(expectedRevision)) return invalid();
    const now = clock.now();
    // Only a title that changes moves the revision, so renaming to the same title never turns
    // the editor's next save into a conflict
    let renamed = false;
    const rename = changeNote(
      noteId,
      note => {
        renamed = note.name !== name;
        return origin === 'typed'
          ? { ...note, name, titleManuallySet: renamed ? true : note.titleManuallySet, updatedAt: now }
          : { ...note, name, lastAutoTitleAt: now, updatedAt: now };
      },
      { expectedRevision },
    );
    return unitsWork(
      command,
      [rename, renameSearchEntry(noteId, name, now)],
      () => committed('note-renamed', [noteId]),
      { primary: noteRecord(noteId), revised: () => renamed },
    );
  },

  setPinned(command, { clock }) {
    const { pinned } = command;
    if (typeof pinned !== 'boolean') return invalid();
    const now = clock.now();
    return setFields(command, pinned ? 'note-pinned' : 'note-unpinned', note => ({ ...note, pinned, updatedAt: now }));
  },

  archiveNote(command, { clock }) {
    const now = clock.now();
    return setFields(command, 'note-archived', note => ({ ...note, archived: true, archivedAt: now, updatedAt: now }));
  },

  unarchiveNote(command, { clock }) {
    const now = clock.now();
    return setFields(command, 'note-unarchived', note => ({
      ...note,
      archived: false,
      archivedAt: null,
      updatedAt: now,
    }));
  },

  restoreNote(command, { clock }) {
    const now = clock.now();
    return setFields(command, 'note-restored', note => ({ ...note, trashed: false, trashedAt: null, updatedAt: now }));
  },

  trashNote(command, { clock }) {
    const { noteId, expectedPlacementVersion } = command;
    if (!isId(noteId) || !isOptionalVersion(expectedPlacementVersion)) return invalid();
    const now = clock.now();
    let deleting = false;
    // One transaction decides and does it, so a title or a save that commits in between can't
    // leave the decision stale on an adapter that commits each unit on its own
    /** @type {Unit} */
    const trash = {
      stores: DELETED_WITH_NOTE,
      async run(tx) {
        const note = await tx.get('notes', noteId);
        if (!note) return noteNotFound();
        const stale = versionConflict(tx, noteId, { expectedPlacementVersion });
        if (stale) return stale;
        const blocks = isUntitled(note) ? await tx.getAllByIndex('blocks', 'canvasId', noteId) : null;
        // An untitled note with nothing in it is deleted, with what Storage.permanentlyDeleteNote deletes
        deleting = blocks !== null && isEmpty(blocks);
        if (deleting && blocks) {
          await deleteNoteIn(tx, noteId, blocks);
          return;
        }
        tx.put('notes', { ...note, trashed: true, trashedAt: now, archived: false, archivedAt: null, updatedAt: now });
      },
    };
    return unitsWork(command, [trash], () => committed(deleting ? 'note-deleted' : 'note-trashed', [noteId]), {
      primary: noteRecord(noteId),
      scope: 'placement',
    });
  },

  moveNoteToFolder(command, { clock }) {
    const { noteId, folderId, expectedPlacementVersion } = command;
    if (!isId(noteId) || !isIdOrNull(folderId) || !isOptionalVersion(expectedPlacementVersion)) return invalid();
    const now = clock.now();
    let moved = false;
    /** @type {Unit} */
    const move = {
      stores: ['notes', 'folders'],
      async run(tx) {
        // Each run decides afresh, since an adapter may run the unit again (ports/repository.js, Unit)
        moved = false;
        const note = await tx.get('notes', noteId);
        if (!note) return noteNotFound();
        const stale = versionConflict(tx, noteId, { expectedPlacementVersion });
        if (stale) return stale;
        // A folder deleted since the view showed it is refused, so no note is filed out of sight
        if (folderId !== null && !(await tx.get('folders', folderId))) return rejected('not-found', 'folder-not-found');
        // Already there: nothing to write
        if ((note.folderId ?? null) === folderId) return;
        moved = true;
        tx.put('notes', { ...note, folderId, updatedAt: now });
      },
    };
    return unitsWork(command, [move], () => committed('note-moved', moved ? [noteId] : []), {
      primary: noteRecord(noteId),
      scope: 'placement',
    });
  },

  convertNoteToTemplate(command, { clock }) {
    const now = clock.now();
    // Templates don't live in folders, as NotesManager.convertNoteToTemplate set it
    return setFields(command, 'note-made-template', note => ({
      ...note,
      isTemplate: true,
      folderId: null,
      updatedAt: now,
    }));
  },

  convertTemplateToNote(command, { clock }) {
    const now = clock.now();
    return setFields(command, 'template-made-note', note => ({ ...note, isTemplate: false, updatedAt: now }));
  },

  deleteNotePermanently(command) {
    const { noteId, expectedPlacementVersion } = command;
    if (!isId(noteId) || !isOptionalVersion(expectedPlacementVersion)) return invalid();
    /** @type {Unit} */
    const remove = {
      stores: DELETED_WITH_NOTE,
      async run(tx) {
        const note = await tx.get('notes', noteId);
        if (!note) return noteNotFound();
        const stale = versionConflict(tx, noteId, { expectedPlacementVersion });
        if (stale) return stale;
        // Only a note in the trash, as committed: one restored since the trash view showed it stays
        if (!note.trashed) return rejected('validation', 'note-not-trashed');
        await deleteNoteIn(tx, noteId);
      },
    };
    return unitsWork(command, [remove], () => committed('note-deleted', [noteId]), {
      primary: noteRecord(noteId),
      scope: 'placement',
    });
  },

  emptyTrash(command) {
    return deleteTrashed(command, 'trash-emptied', notes => notesInView(notes, 'trashed'));
  },

  async runTrashCleanup(command, { adapter, clock }) {
    // The retention setting lives outside the note stores, so it's read before any unit runs
    const { trashRetention } = await adapter.readSettings('preferences', ['trashRetention']);
    const days = trashRetentionDays(trashRetention);
    if (days === null) return committed('trash-kept', []);
    const now = clock.now();
    return deleteTrashed(command, 'trash-cleaned', notes => expiredInTrash(notes, now, days));
  },

  saveNoteContent(command, { clock, ids }) {
    const {
      noteId,
      blocks,
      preview,
      todoProgress,
      name,
      titleOrigin = 'typed',
      linkedNames,
      expectedRevision,
    } = command;
    if (!isId(noteId) || !isOptionalString(preview) || !isOptionalString(name)) return invalid();
    if (titleOrigin !== 'typed' && titleOrigin !== 'generated') return invalid();
    if (linkedNames !== undefined && !isStringList(linkedNames)) return invalid();
    if (!isOptionalVersion(expectedRevision)) return invalid();
    const records = blockRecords(blocks, noteId);
    if (!Array.isArray(records)) return records;
    const now = clock.now();
    // A generated title the save drops, since the note has a title set by hand
    let titleKept = false;
    /** @type {Unit} */
    const save = {
      stores: ['notes', 'blocks'],
      async run(tx) {
        // Each run decides afresh, since an adapter may run the unit again (ports/repository.js, Unit)
        titleKept = false;
        // Without an expected revision, the block puts go out before anything is awaited, as in
        // Storage.saveNoteWithBlocks, so a page-hide flush still stores them if the page goes
        // before the read returns. With one, the revision is checked first, so a conflict
        // writes nothing of the save (ports/repository.js, WriteScope).
        const checked = expectedRevision !== undefined;
        if (!checked) for (const block of records) tx.put('blocks', block);
        const note = await tx.get('notes', noteId);
        // A note deleted since the editor loaded it stays deleted, blocks included
        if (!note) return noteNotFound();
        const stale = versionConflict(tx, noteId, { expectedRevision });
        if (stale) return stale;
        if (checked) for (const block of records) tx.put('blocks', block);
        /** @type {NoteRecord} */
        const next = { ...note, updatedAt: now };
        if (preview !== undefined) next.preview = preview;
        if (todoProgress !== undefined) next.todoProgress = todoProgress;
        // A title goes in with the blocks, as 1.4.x's editor save wrote it: a typed one marked as
        // set by hand, as the editor marked it when the user typed it, and one the AI made with
        // the time it was made, as BlockEditor.setTitleProgrammatically stamped it. A generated
        // one is dropped when the note as committed has a title set by hand, as
        // applyDerivedTitle drops it, and the blocks still land.
        if (name !== undefined) {
          titleKept = titleOrigin === 'generated' && Boolean(note.titleManuallySet);
          if (!titleKept) {
            next.name = name;
            if (titleOrigin === 'typed') next.titleManuallySet = true;
            else next.lastAutoTitleAt = now;
          }
        }
        tx.put('notes', next);
      },
    };
    /** @type {Unit[]} */
    const units = [save];
    // The search entry's name and the wiki links follow in their own units, as 1.4.x's save
    // updated them after the note and its blocks were stored
    if (name !== undefined) units.push({ ...renameSearchEntry(noteId, name, now), when: () => !titleKept });
    if (linkedNames !== undefined) units.push(...replaceLinks(noteId, linkedNames, { now, nextId: () => ids.next() }));
    return unitsWork(
      command,
      units,
      () =>
        titleKept
          ? committed('content-saved-title-kept', [noteId], { severity: 'info' })
          : committed('content-saved', [noteId]),
      { primary: noteRecord(noteId), revised: contentChanged },
    );
  },

  deleteBlocks(command) {
    const { noteId, blockIds, expectedRevision } = command;
    if (!isId(noteId) || !isIdList(blockIds) || !isOptionalVersion(expectedRevision)) return invalid();
    let deleted = false;
    // The note is read only to check the revision the command expects, so one without it
    // reads and writes only blocks, as it always has
    const checked = expectedRevision !== undefined;
    /** @type {Unit} */
    const remove = {
      stores: checked ? ['notes', 'blocks'] : ['blocks'],
      async run(tx) {
        // Each run decides afresh, since an adapter may run the unit again (ports/repository.js, Unit)
        deleted = false;
        if (checked) {
          await tx.get('notes', noteId);
          const stale = versionConflict(tx, noteId, { expectedRevision });
          if (stale) return stale;
        }
        for (const blockId of new Set(blockIds)) {
          const block = await tx.get('blocks', blockId);
          // Never saved, or deleted already
          if (!block) continue;
          if (block.canvasId !== noteId) return rejected('validation', 'block-of-another-note');
          tx.delete('blocks', blockId);
          deleted = true;
        }
      },
    };
    return unitsWork(command, [remove], () => committed('blocks-deleted', deleted ? [noteId] : []), {
      primary: noteRecord(noteId),
      revised: () => deleted,
    });
  },

  insertBlocks(command, { clock, ids }) {
    const { noteId, blocks, atOrder } = command;
    if (!isId(noteId) || (atOrder !== undefined && !(Number.isSafeInteger(atOrder) && atOrder >= 0))) return invalid();
    const records = blockRecords(blocks, noteId);
    if (!Array.isArray(records)) return records;
    if (records.length === 0) return invalid();
    const now = clock.now();
    /** The names the note's wiki links hold once the blocks are in, which the link units replace its links with */
    const linkedNames = /** @type {string[]} */ ([]);
    /** @type {Unit} */
    const insert = {
      stores: ['notes', 'blocks'],
      async run(tx) {
        // Each run decides afresh, since an adapter may run the unit again (ports/repository.js, Unit)
        linkedNames.length = 0;
        const note = await tx.get('notes', noteId);
        if (!note) return noteNotFound();
        for (const block of records) {
          const stored = await tx.get('blocks', block.id);
          if (stored && stored.canvasId !== noteId) return rejected('validation', 'block-of-another-note');
          if (stored) return rejected('validation', 'duplicate-block');
        }
        const existing = await tx.getAllByIndex('blocks', 'canvasId', noteId);
        // After the last block, as the note's next order, when no place is given
        const start = atOrder ?? existing.reduce((next, block) => Math.max(next, (Number(block.order) || 0) + 1), 0);
        // The blocks at or past the place move down by as many as come in, as AI chat moved them
        const placed = existing.map(block =>
          (Number(block.order) || 0) >= start
            ? { ...block, order: (Number(block.order) || 0) + records.length }
            : block,
        );
        placed.forEach((block, index) => {
          if (block !== existing[index]) tx.put('blocks', block);
        });
        const added = records.map((block, index) => ({
          ...block,
          order: start + index,
          createdAt: now,
          updatedAt: now,
        }));
        for (const block of added) tx.put('blocks', block);
        // What the note shows and links to comes from its blocks as stored, in note order
        const stored = inBlockOrder([...placed, ...added]);
        const { preview, todoProgress } = noteSaveMetadata(stored);
        tx.put('notes', { ...note, preview, todoProgress, updatedAt: now });
        linkedNames.push(...wikiLinkNames(insertLinkText(stored)));
      },
    };
    return unitsWork(
      command,
      [insert, ...replaceLinks(noteId, linkedNames, { now, nextId: () => ids.next() })],
      () => committed('blocks-inserted', [noteId]),
      { primary: noteRecord(noteId), revised: contentChanged },
    );
  },

  applyDerivedTitle(command, { clock }) {
    const { noteId, name, contentHash } = command;
    if (!isId(noteId) || typeof name !== 'string' || !isOptionalString(contentHash)) return invalid();
    const now = clock.now();
    let kept = false;
    let renamed = false;
    const derive = changeNote(noteId, note => {
      // A title set by hand stays, so the derived one is dropped. Each run decides both afresh,
      // since an adapter may run the unit again (ports/repository.js, Unit)
      kept = Boolean(note.titleManuallySet);
      renamed = !kept && note.name !== name;
      if (kept) return null;
      /** @type {NoteRecord} */
      const next = { ...note, name, lastAutoTitleAt: now, updatedAt: now };
      if (contentHash !== undefined) next.lastTitleContentHash = contentHash;
      return next;
    });
    return unitsWork(
      command,
      [derive, { ...renameSearchEntry(noteId, name, now), when: () => !kept }],
      () => (kept ? committed('title-kept', [], { severity: 'info' }) : committed('title-derived', [noteId])),
      { primary: noteRecord(noteId), revised: () => renamed },
    );
  },

  attachInsights(command, { clock }) {
    const { noteId, insights, contentHash, sourceRevision } = command;
    if (!isId(noteId) || !isOptionalString(contentHash) || !isOptionalVersion(sourceRevision)) return invalid();
    const now = clock.now();
    // Insights made from an older revision than the ones the note has are dropped, so a slow
    // job never puts older insights over newer ones (#17, "Versions"). Ones made from any
    // revision at or past it land, so a note being typed in still gets new insights.
    let stale = false;
    /** @type {Unit} */
    const attach = {
      stores: ['notes'],
      async run(tx) {
        // Each run decides afresh, since an adapter may run the unit again (ports/repository.js, Unit)
        stale = false;
        const note = await tx.get('notes', noteId);
        if (!note) return noteNotFound();
        const versions = sourceRevision === undefined ? undefined : tx.versions('notes', noteId);
        stale = versions !== undefined && /** @type {number} */ (sourceRevision) < versions.sourceRevision;
        if (stale) return;
        /** @type {NoteRecord} */
        const next = { ...note, insights, lastInsightsExtractedAt: now };
        if (contentHash !== undefined) next.lastInsightsContentHash = contentHash;
        tx.put('notes', next);
      },
    };
    return unitsWork(
      command,
      [attach],
      () => (stale ? committed('insights-stale', [], { severity: 'info' }) : committed('insights-attached', [noteId])),
      // Held to the insight fields, so it can't change the note's name, placement, or lifecycle
      { primary: noteRecord(noteId), scope: 'derived', sourceRevision },
    );
  },

  async captureToDailyNote(command, { adapter, clock, ids }) {
    const { noteId, blockId, capture } = command;
    if (!isId(noteId) || !isId(blockId) || !isCapture(capture)) return invalid();
    // The template setting lives outside the note stores, so it's read before any unit runs
    const { dailyNoteTemplate: templateId } = await adapter.readSettings('preferences', ['dailyNoteTemplate']);
    const now = clock.now();
    // Today's, keyed by the UTC date and named with the local one, as background.js always had it
    const dailyName = dailyNoteName(now);
    let dailyId = noteId;
    let created = false;
    /** @type {Unit[]} */
    const units = [
      {
        stores: ['notes'],
        async run(tx) {
          // The later units follow what this one decides, and each run decides afresh, since
          // an adapter may run the units again (ports/repository.js, Unit)
          dailyId = noteId;
          created = false;
          const daily = await findOrMakeDailyNote(tx, { noteId, dateStr: dailyDateStr(now), name: dailyName, now });
          if ('kind' in daily) return daily;
          ({ dailyId, created } = daily);
        },
      },
      {
        stores: ['searchIndex'],
        when: () => created,
        async run(tx) {
          tx.put('searchIndex', newSearchEntry({ id: noteId, name: dailyName }, now));
        },
      },
      {
        stores: ['blocks'],
        async run(tx) {
          // A new Daily Note starts with the Daily Note template's blocks, as in Storage.ensureDailyNote
          if (created) {
            const copies = await dailyTemplateBlocks(tx, templateId, {
              noteId,
              title: dailyName,
              now,
              nextId: () => ids.next(),
            });
            for (const block of copies) tx.put('blocks', block);
          }
          tx.put('blocks', captureBlock({ id: blockId, noteId: dailyId, capture, now }));
        },
      },
    ];
    return unitsWork(command, units, () => committed('capture-saved', [dailyId]), {
      primary: () => ({ store: 'notes', key: dailyId }),
      revised: contentChanged,
    });
  },

  async ensureDailyNote(command, { adapter, clock, ids }) {
    const { noteId, dateStr, at } = command;
    if (!isId(noteId) || (dateStr !== undefined && !isDateStr(dateStr))) return invalid();
    // An instant decides today; a calendar day needs none
    if (at !== undefined && (dateStr !== undefined || !Number.isSafeInteger(at) || at < 0)) return invalid();
    // The template setting lives outside the note stores, so it's read before the unit runs
    const { dailyNoteTemplate: templateId } = await adapter.readSettings('preferences', ['dailyNoteTemplate']);
    const now = clock.now();
    // With no day, today's: keyed by the UTC date and named with the local one, as
    // Storage.ensureDailyNote has it. A calendar day's is keyed and named by that day, as
    // Storage.ensureDailyNoteForDate has it.
    const today = at === undefined ? now : at;
    const day = dateStr === undefined ? dailyDateStr(today) : dateStr;
    const name = dateStr === undefined ? dailyNoteName(today) : dailyNoteNameFor(dateStr);
    let dailyId = noteId;
    let created = false;
    // One transaction finds the Daily Note or makes it whole: the record with its isDaily and
    // dateStr, its search entry, and the template's blocks, which 1.4.x wrote in four steps, so
    // a note never stays half made and two calls at once make one Daily Note
    /** @type {Unit} */
    const ensure = {
      stores: ['notes', 'searchIndex', 'blocks'],
      async run(tx) {
        // Each run decides afresh, since an adapter may run the unit again (ports/repository.js, Unit)
        dailyId = noteId;
        created = false;
        const daily = await findOrMakeDailyNote(tx, { noteId, dateStr: day, name, now });
        if ('kind' in daily) return daily;
        ({ dailyId, created } = daily);
        if (!created) return;
        tx.put('searchIndex', newSearchEntry({ id: noteId, name }, now));
        const copies = await dailyTemplateBlocks(tx, templateId, {
          noteId,
          title: name,
          now,
          nextId: () => ids.next(),
        });
        for (const block of copies) tx.put('blocks', block);
      },
    };
    // Only a Daily Note it made changed anything. One it found changes nothing, so it names no
    // id, writes no change entry, and moves no revision: the caller reads the Daily Note with
    // findDailyNote either way
    return unitsWork(
      command,
      [ensure],
      () =>
        created ? committed('daily-note-created', [dailyId]) : committed('daily-note-exists', [], { severity: 'info' }),
      { primary: () => ({ store: 'notes', key: dailyId }), revised: () => created },
    );
  },

  async runBulkAction(command, { run }) {
    const refused = bulkRefusal(command);
    if (refused) return refused;
    const { action, noteIds } = command;
    const type = BULK_ACTIONS[action];
    /** @type {BulkItem[]} */
    const items = [];
    // One command per note, in order, so one note failing leaves the others committed
    for (const noteId of new Set(noteIds)) {
      items.push({ id: noteId, outcome: await run({ type, commandId: `${command.commandId}:${noteId}`, noteId }) });
    }
    return bulk(action, items);
  },
};

/** @type {{[T in NoteQueryType]: QueryHandler<T>}} */
export const noteQueries = {
  async listNotes({ view }, { adapter, clock }) {
    if (!NOTE_VIEWS.includes(view)) return failed('validation', 'invalid-query');
    const notes = notesInView(await adapter.read(['notes'], tx => tx.getAll('notes')), view);
    return notes.length > 0 ? ready(clock.now(), notes) : empty(clock.now());
  },

  async getNote({ noteId }, { adapter, clock }) {
    if (!isId(noteId)) return failed('validation', 'invalid-query');
    const { note, versions } = await adapter.read(['notes'], async tx => ({
      note: await tx.get('notes', noteId),
      versions: tx.versions('notes', noteId),
    }));
    if (!note) return empty(clock.now());
    // The versions a later command sends back as what it expects: `revision` for the editor's
    // save, `placementVersion` for filing, pinning, and the trash (#17, "Versions")
    return ready(
      clock.now(),
      versions === undefined
        ? { note }
        : { note, revision: versions.revision, placementVersion: versions.placementVersion },
    );
  },

  async getNoteBlocks({ noteId }, { adapter, clock }) {
    if (!isId(noteId)) return failed('validation', 'invalid-query');
    const blocks = await adapter.read(['blocks'], tx => tx.getAllByIndex('blocks', 'canvasId', noteId));
    return blocks.length > 0 ? ready(clock.now(), inBlockOrder(blocks)) : empty(clock.now());
  },

  async getBacklinks({ noteId }, { adapter, clock }) {
    if (!isId(noteId)) return failed('validation', 'invalid-query');
    // Each link's note, in the order the links are stored, as Storage.getBacklinks lists them. A
    // link whose note is gone is left out, as is one that names none.
    const notes = await adapter.read(['links', 'notes'], async tx => {
      /** @type {NoteRecord[]} */
      const found = [];
      for (const link of await tx.getAllByIndex('links', 'toNoteId', noteId)) {
        const note = isId(link.fromNoteId) ? await tx.get('notes', link.fromNoteId) : undefined;
        if (note) found.push(note);
      }
      return found;
    });
    return notes.length > 0 ? ready(clock.now(), notes) : empty(clock.now());
  },

  async getNoteList(query, { adapter, clock }) {
    // Every note in key order, as each view sorts them itself (domain/note.js notesInView),
    // with the folders and search entries, in one transaction, so no list is newer than another
    const list = await adapter.read(['notes', 'folders', 'searchIndex'], async tx => ({
      notes: await tx.getAll('notes'),
      folders: await tx.getAll('folders'),
      searchEntries: await tx.getAll('searchIndex'),
    }));
    const found = list.notes.length > 0 || list.folders.length > 0 || list.searchEntries.length > 0;
    return found ? ready(clock.now(), list) : empty(clock.now());
  },

  async getNotesByIds({ noteIds }, { adapter, clock }) {
    if (!isIdList(noteIds)) return failed('validation', 'invalid-query');
    const wanted = [...new Set(noteIds)];
    // Each read is asked for before any answers, so a long list costs one round of requests
    const found = await adapter.read(['notes', 'searchIndex'], tx =>
      Promise.all(
        wanted.map(async noteId => ({
          note: await tx.get('notes', noteId),
          entry: await tx.get('searchIndex', noteId),
        })),
      ),
    );
    /** @type {NoteRecord[]} */
    const notes = [];
    /** @type {SearchEntry[]} */
    const searchEntries = [];
    for (const { note, entry } of found) {
      if (!note) continue;
      notes.push(note);
      if (entry) searchEntries.push(entry);
    }
    return notes.length > 0 ? ready(clock.now(), { notes, searchEntries }) : empty(clock.now());
  },

  async findDailyNote({ dateStr }, { adapter, clock }) {
    if (!isDateStr(dateStr)) return failed('validation', 'invalid-query');
    // The first in the withArchived list with that day, as ensureDailyNote finds it
    const note = findDailyNoteFor(await adapter.read(['notes'], tx => tx.getAll('notes')), dateStr);
    return note ? ready(clock.now(), { note }) : empty(clock.now());
  },

  async listSearchEntries(query, { adapter, clock }) {
    const entries = await adapter.read(['searchIndex'], tx => tx.getAll('searchIndex'));
    return entries.length > 0 ? ready(clock.now(), entries) : empty(clock.now());
  },
};
