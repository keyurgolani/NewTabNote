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
  findDailyNote,
  inBlockOrder,
  isEmpty,
  isUntitled,
  newNoteRecord,
  newSearchEntry,
  notesInView,
} from '../domain/note.js';
import { contentChanged, unitsWork } from './work.js';

/** @typedef {import('../domain/note.js').NoteRecord} NoteRecord */
/** @typedef {import('../domain/note.js').BlockRecord} BlockRecord */
/** @typedef {import('../domain/note.js').NoteView} NoteView */
/** @typedef {import('../contracts/outcomes.js').Rejected} Rejected */
/** @typedef {import('../contracts/outcomes.js').BulkItem} BulkItem */
/** @typedef {import('../ports/repository.js').Unit} Unit */
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
 *   | 'restoreNote' | 'saveNoteContent' | 'applyDerivedTitle' | 'attachInsights' | 'captureToDailyNote'
 *   | 'runBulkAction'} NoteCommandType
 */

/** @typedef {'listNotes' | 'getNote' | 'getNoteBlocks'} NoteQueryType */

const invalid = () => rejected('validation', 'invalid-command');
const noteNotFound = () => rejected('not-found', 'note-not-found');

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
const noteRecord = noteId => () => ({ store: 'notes', key: noteId });

/**
 * A unit that reads the note and puts what `change` makes of it, in one transaction.
 * `change` returns null to put nothing.
 * @param {string} noteId
 * @param {(note: NoteRecord) => NoteRecord | null} change
 * @returns {Unit}
 */
function changeNote(noteId, change) {
  return {
    stores: ['notes'],
    async run(tx) {
      const note = await tx.get('notes', noteId);
      if (!note) return noteNotFound();
      const next = change(note);
      if (next) tx.put('notes', next);
    },
  };
}

/**
 * A unit that gives the note's search entry a new name, when it has an entry, as
 * Storage.updateNote does through updateNoteNameInSearchIndex.
 * @param {string} noteId
 * @param {string} name
 * @param {number} now
 * @returns {Unit}
 */
function renameSearchEntry(noteId, name, now) {
  return {
    stores: ['searchIndex'],
    async run(tx) {
      const entry = await tx.get('searchIndex', noteId);
      if (entry) tx.put('searchIndex', { ...entry, name, updatedAt: now });
    },
  };
}

/**
 * The blocks a command carries, as records of `noteId`. A block of another note, or two
 * blocks with one id, are refused.
 * @param {unknown} blocks
 * @param {string} noteId
 * @returns {BlockRecord[] | Rejected}
 */
function blockRecords(blocks, noteId) {
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
 * @returns {value is import('../domain/note.js').Capture}
 */
function isCapture(value) {
  if (!isRecord(value)) return false;
  if (value.type === 'bookmark') return isOptionalString(value.url) && isOptionalString(value.title);
  if (value.type === 'text') return typeof value.content === 'string' && isOptionalString(value.source);
  return false;
}

/**
 * A command that sets placement fields on one note (pinned, archived, trashed), so the
 * note's content revision stays where it was.
 * @param {import('../contracts/commands.js').Command & {noteId: unknown}} command
 * @param {string} code
 * @param {(note: NoteRecord) => NoteRecord} change
 */
function setFields(command, code, change) {
  const { noteId } = command;
  if (!isId(noteId)) return invalid();
  return unitsWork(command, [changeNote(noteId, change)], () => committed(code, [noteId]), {
    primary: noteRecord(noteId),
  });
}

/** @type {{[T in NoteCommandType]: CommandHandler<T>}} */
export const noteCommands = {
  createNote(command, { clock }) {
    const { noteId, name = 'Untitled', folderId = null, blocks = [] } = command;
    if (!isId(noteId) || typeof name !== 'string' || !isIdOrNull(folderId)) return invalid();
    const records = blockRecords(blocks, noteId);
    if (!Array.isArray(records)) return records;
    const now = clock.now();
    const note = newNoteRecord({ id: noteId, name, now, folderId });
    /** @type {Unit[]} */
    const units = [];
    if (folderId !== null) {
      units.push({
        stores: ['folders'],
        mode: 'readonly',
        async run(tx) {
          if (!(await tx.get('folders', folderId))) return rejected('not-found', 'folder-not-found');
        },
      });
    }
    // One transaction for the note and its search entry, as Storage.createNote writes them
    units.push({
      stores: ['notes', 'searchIndex'],
      async run(tx) {
        if (await tx.get('notes', noteId)) return rejected('validation', 'note-exists');
        tx.put('notes', note);
        tx.put('searchIndex', newSearchEntry(note, now));
      },
    });
    if (records.length > 0) {
      units.push({
        stores: ['blocks'],
        async run(tx) {
          for (const block of records) tx.put('blocks', block);
        },
      });
    }
    return unitsWork(command, units, () => committed('note-created', [noteId]), {
      primary: noteRecord(noteId),
      revised: contentChanged,
    });
  },

  renameNote(command, { clock }) {
    const { noteId, name, origin = 'typed' } = command;
    if (!isId(noteId) || typeof name !== 'string' || (origin !== 'typed' && origin !== 'generated')) return invalid();
    const now = clock.now();
    // Only a title that changes moves the revision, so renaming to the same title never turns
    // the editor's next save into a conflict
    let renamed = false;
    const rename = changeNote(noteId, note => {
      renamed = note.name !== name;
      return origin === 'typed'
        ? { ...note, name, titleManuallySet: renamed ? true : note.titleManuallySet, updatedAt: now }
        : { ...note, name, lastAutoTitleAt: now, updatedAt: now };
    });
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
    const { noteId } = command;
    if (!isId(noteId)) return invalid();
    const now = clock.now();
    let deleting = false;
    // One transaction decides and does it, so a title or a save that commits in between can't
    // leave the decision stale on an adapter that commits each unit on its own
    /** @type {Unit} */
    const trash = {
      stores: ['notes', 'blocks', 'media', 'vectors', 'snapshots'],
      async run(tx) {
        const note = await tx.get('notes', noteId);
        if (!note) return noteNotFound();
        const blocks = isUntitled(note) ? await tx.getAllByIndex('blocks', 'canvasId', noteId) : null;
        // An untitled note with nothing in it is deleted, with what Storage.permanentlyDeleteNote deletes
        deleting = blocks !== null && isEmpty(blocks);
        if (deleting && blocks) {
          for (const block of blocks) tx.delete('blocks', block.id);
          for (const key of await tx.getKeysByIndex('media', 'canvasId', noteId)) tx.delete('media', key);
          tx.delete('vectors', noteId);
          for (const key of await tx.getKeysByIndex('snapshots', 'noteId', noteId)) tx.delete('snapshots', key);
          tx.delete('notes', noteId);
          return;
        }
        tx.put('notes', { ...note, trashed: true, trashedAt: now, archived: false, archivedAt: null, updatedAt: now });
      },
    };
    return unitsWork(command, [trash], () => committed(deleting ? 'note-deleted' : 'note-trashed', [noteId]), {
      primary: noteRecord(noteId),
    });
  },

  saveNoteContent(command, { clock }) {
    const { noteId, blocks, preview, todoProgress, expectedRevision } = command;
    if (!isId(noteId) || !isOptionalString(preview)) return invalid();
    if (expectedRevision !== undefined && !Number.isInteger(expectedRevision)) return invalid();
    const records = blockRecords(blocks, noteId);
    if (!Array.isArray(records)) return records;
    const now = clock.now();
    /** @type {Unit} */
    const save = {
      stores: ['notes', 'blocks'],
      async run(tx) {
        // The block puts go out before anything is awaited, as in Storage.saveNoteWithBlocks,
        // so a page-hide flush still stores them if the page goes before the read returns
        for (const block of records) tx.put('blocks', block);
        const note = await tx.get('notes', noteId);
        // A note deleted since the editor loaded it stays deleted, blocks included
        if (!note) return noteNotFound();
        const revision = tx.revision('notes', noteId);
        if (expectedRevision !== undefined && revision !== undefined && revision !== expectedRevision) {
          return conflict('revision-conflict', revision);
        }
        /** @type {NoteRecord} */
        const next = { ...note, updatedAt: now };
        if (preview !== undefined) next.preview = preview;
        if (todoProgress !== undefined) next.todoProgress = todoProgress;
        tx.put('notes', next);
      },
    };
    return unitsWork(command, [save], () => committed('content-saved', [noteId]), {
      primary: noteRecord(noteId),
      revised: contentChanged,
    });
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
    const { noteId, insights, contentHash } = command;
    if (!isId(noteId) || !isOptionalString(contentHash)) return invalid();
    const now = clock.now();
    return unitsWork(
      command,
      [
        changeNote(noteId, note => {
          /** @type {NoteRecord} */
          const next = { ...note, insights, lastInsightsExtractedAt: now };
          if (contentHash !== undefined) next.lastInsightsContentHash = contentHash;
          return next;
        }),
      ],
      () => committed('insights-attached', [noteId]),
      { primary: noteRecord(noteId) },
    );
  },

  async captureToDailyNote(command, { adapter, clock, ids }) {
    const { noteId, blockId, capture } = command;
    if (!isId(noteId) || !isId(blockId) || !isCapture(capture)) return invalid();
    // The template setting lives outside the note stores, so it's read before any unit runs
    const { dailyNoteTemplate: templateId } = await adapter.readSettings('preferences', ['dailyNoteTemplate']);
    const now = clock.now();
    let dailyId = noteId;
    let dailyName = '';
    let created = false;
    /** @type {Unit[]} */
    const units = [
      {
        stores: ['notes'],
        async run(tx) {
          // The later units follow what this one decides, and each run decides afresh, since
          // an adapter may run the units again (ports/repository.js, Unit)
          dailyId = noteId;
          dailyName = '';
          created = false;
          const daily = findDailyNote(await tx.getAll('notes'), now);
          if (daily) {
            dailyId = daily.id;
            return;
          }
          if (await tx.get('notes', noteId)) return rejected('validation', 'note-exists');
          dailyName = dailyNoteName(now);
          created = true;
          tx.put('notes', {
            ...newNoteRecord({ id: noteId, name: dailyName, now }),
            isDaily: true,
            dateStr: dailyDateStr(now),
          });
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
          if (created && isId(templateId)) {
            const template = await tx.getAllByIndex('blocks', 'canvasId', templateId);
            const copies = blocksFromTemplate(template, { noteId, title: dailyName, now, nextId: () => ids.next() });
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
    const { note, revision } = await adapter.read(['notes'], async tx => ({
      note: await tx.get('notes', noteId),
      revision: tx.revision('notes', noteId),
    }));
    if (!note) return empty(clock.now());
    return ready(clock.now(), revision === undefined ? { note } : { note, revision });
  },

  async getNoteBlocks({ noteId }, { adapter, clock }) {
    if (!isId(noteId)) return failed('validation', 'invalid-query');
    const blocks = await adapter.read(['blocks'], tx => tx.getAllByIndex('blocks', 'canvasId', noteId));
    return blocks.length > 0 ? ready(clock.now(), inBlockOrder(blocks)) : empty(clock.now());
  },
};
