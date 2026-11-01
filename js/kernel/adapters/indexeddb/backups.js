/**
 * 1.4.x's backup tasks and export file on #17's adapter (#17 PR 4a, the lead's Q1): Export JSON
 * and Create Backup's file, the automatic backup, and Import's Merge and Replace all, moved from
 * js/storage.js with what each did there, so the new tab can leave DatabaseManager. #18's
 * backup engine later replaces them behind the same commands.
 *
 * - The export (Storage.exportAll and exportAllAsBlob): every note outside trash, newest first,
 *   archived notes included, then the templates, newest first; each one's blocks, note by note;
 *   the media of those notes, each Blob as a data URL; and every folder, as `{version: 1,
 *   exportedAt, canvases, elements, media, folders}`. `version` stays 1, so 1.4.0 still imports
 *   it. The file is written record by record, so no string ever holds the whole export, however
 *   many images its blocks carry. Each note goes without #17 PR 3's fields beside its flags
 *   (domain/placement.js's NEW_NOTE_FIELDS), as every export has since #17 PR 3b. It reads in
 *   one readonly transaction, where Storage read in several. Since #17 PR 4b Export JSON and
 *   Create Backup's file also hold, after the folders, the conflict records of the notes they
 *   export, so the text a conflict kept stays with the file (the lead's Q2, condition 2). A
 *   profile with none writes the file 1.4.x wrote, and 1.4.x's import reads only the four lists
 *   before them. The export as one object, which the automatic backup, Replace all's copy, and
 *   sync's upload hold, keeps 1.4.x's form.
 * - The automatic backup (Storage.createAutoBackup): the export, marked as one, under
 *   `auto_backup_<time>` in chrome.storage.local, the newest three kept, then
 *   `setting_lastBackupAt`.
 * - The import (Storage.validateImport and importData): a parsed file checked before anything
 *   is written; notes, blocks, and media under new ids, in 1.4.x's form; a folder whose id the
 *   profile has reused untouched, and a folder or parent id in neither the file nor the profile
 *   left null; a Daily Note for a date one of the profile's outside trash holds brought in as a
 *   plain note named "(imported)"; and every note without #17 PR 3's fields. Replace all first
 *   saves a recovery copy of the export, and stops when it can't, then moves every active note
 *   to trash. On this adapter the import's writes are one unit of its command, so they commit
 *   in the command's one transaction, with its ledger row, each note's versions, and a change
 *   for each note and folder it wrote.
 */

import { rejected, unavailable } from '../../core/contracts/outcomes.js';
import { withoutPlacement } from '../../core/domain/placement.js';
import { blobOf, dataUrlOf } from './data-urls.js';
import { settingsFailureOf } from './failures.js';
import { writeRecoveryCopy } from './recovery-copies.js';
import { CONFLICTS_STORE } from './registry.js';
import { result } from './requests.js';

/** @typedef {import('../../core/contracts/outcomes.js').Outcome} Outcome */
/** @typedef {import('../../core/ports/repository.js').Unit} Unit */
/** @typedef {import('../../core/ports/runtime.js').Clock} Clock */
/** @typedef {import('./recovery-copies.js').CopyStore} CopyStore */
/** @typedef {Record<string, any>} Row */

/** Each automatic backup's key starts with this, the rest its time, as Storage names them */
export const AUTO_BACKUP_PREFIX = 'auto_backup_';

/** How many automatic backups are kept, the newest */
export const AUTO_BACKUPS_KEPT = 3;

/** When the last backup was made, which Settings shows, as Storage.setSetting keys it */
export const LAST_BACKUP_KEY = 'setting_lastBackupAt';

/**
 * chrome.storage.local as the automatic backup uses it: every key read at once, and keys removed
 * @typedef {object} BackupStore
 * @property {(keys: string[] | null) => Promise<Record<string, unknown>>} get
 * @property {(items: Record<string, unknown>) => Promise<void>} set
 * @property {(keys: string[]) => Promise<void>} remove
 */

/**
 * What an export holds, each note as 1.4.x stores one
 * @typedef {object} ExportRows
 * @property {Row[]} notes
 * @property {Row[]} elements
 * @property {Row[]} media
 * @property {Row[]} folders
 * @property {Row[]} [conflicts] - the conflict records of those notes, for the file, when asked for
 */

/**
 * What a committed import did, for its outcome: the new ids of the notes it added, in backup
 * order, the ids of the folders it added, and the ids of the notes Replace all moved to trash
 * @typedef {{importedIds: string[], addedFolderIds: string[], trashedIds: string[]}} ImportReceipt
 */

/**
 * An import worked out before it writes anything, its new ids taken
 * @typedef {object} ImportPlan
 * @property {'merge' | 'replace'} mode
 * @property {Row[]} notes - the file's notes, as it holds them
 * @property {Map<string, string>} noteIds - each file note's new id
 * @property {Row[]} elements - the file's blocks under their new ids and their notes' new ids
 * @property {Row[]} media - the media of the file's notes, under new ids, each data URL a Blob
 * @property {Row[]} folders
 * @property {number} skippedMedia - media rows whose note isn't in the file, which 1.4.0 exported
 */

/**
 * An id in the form 1.4.x's Utils.generateId gives one: the time, then up to nine random
 * base-36 characters. Imported records keep that form, so a note's blocks list in the order
 * they were imported where a reader goes by the time in an id (Utils.inCreationOrder).
 * @returns {string}
 */
export const legacyId = () => `${Date.now()}-${Math.random().toString(36).slice(2, 11)}`;

/**
 * What every export holds, read in one readonly transaction: the notes as Storage.getAllNotes
 * lists them with the archived ones, then the templates as Storage.getTemplates lists them,
 * each without #17 PR 3's fields; their blocks, note by note; the media of those notes, which
 * 1.4.0 exported whole; and every folder. A database without `media` or `folders` has none.
 * With `conflicts`, the conflict records of those notes too (#17 PR 4b), which a database below
 * version 10 has none of.
 * @param {IDBDatabase} db
 * @param {{conflicts?: boolean}} [options]
 * @returns {Promise<ExportRows>}
 */
export async function readExport(db, { conflicts = false } = {}) {
  const aux = ['media', 'folders', ...(conflicts ? [CONFLICTS_STORE] : [])].filter(name =>
    db.objectStoreNames.contains(name),
  );
  const tx = db.transaction(['canvases', 'elements', ...aux], 'readonly');
  const byUpdate = /** @type {Row[]} */ (await result(tx.objectStore('canvases').index('updatedAt').getAll()));
  const listed = [...byUpdate].reverse().filter(note => !note.trashed && !note.isTemplate);
  const templates = byUpdate
    .filter(note => note.isTemplate && !note.trashed)
    .sort((a, b) => Number(b.updatedAt) - Number(a.updatedAt));
  const notes = [...listed, ...templates].map(note => withoutPlacement(note));
  const blocks = tx.objectStore('elements').index('canvasId');
  /** @type {Row[]} */
  const elements = [];
  for (const note of notes) elements.push(...(await result(blocks.getAll(note.id))));
  const exported = new Set(notes.map(note => note.id));
  const media = aux.includes('media')
    ? /** @type {Row[]} */ (await result(tx.objectStore('media').getAll())).filter(row => exported.has(row.canvasId))
    : [];
  const folders = aux.includes('folders')
    ? /** @type {Row[]} */ (await result(tx.objectStore('folders').getAll()))
    : [];
  if (!conflicts) return { notes, elements, media, folders };
  const kept = aux.includes(CONFLICTS_STORE)
    ? /** @type {Row[]} */ (await result(tx.objectStore(CONFLICTS_STORE).getAll())).filter(row =>
        exported.has(row.noteId),
      )
    : [];
  return { notes, elements, media, folders, conflicts: kept };
}

/**
 * A media row as exports hold it, its Blob as a data URL
 * @param {Row} row
 * @returns {Promise<Row>}
 */
async function exportedMedia(row) {
  return row.blob instanceof Blob ? { ...row, blob: await dataUrlOf(row.blob) } : row;
}

/**
 * The export as one object, as Storage.exportAll gives it: what the automatic backup and
 * Replace all's recovery copy save
 * @param {ExportRows} rows
 * @param {number} now
 * @returns {Promise<Row>}
 */
export async function exportObject({ notes, elements, media, folders }, now) {
  // Key name 'canvases' kept for backward compatibility with existing exports
  return {
    version: 1,
    exportedAt: now,
    canvases: notes,
    elements,
    media: await Promise.all(media.map(exportedMedia)),
    folders,
  };
}

/**
 * The export file Export JSON downloads, and with `extra` Create Backup's, as
 * Storage.exportAllAsBlob writes it: the same JSON as exportObject, without indentation, each
 * record through its own JSON.stringify, then the conflict records when there are any (#17 PR
 * 4b), and `extra`'s fields last
 * @param {ExportRows} rows
 * @param {number} now
 * @param {Record<string, unknown>} [extra]
 * @returns {Promise<Blob>}
 */
export async function exportFile({ notes, elements, media, folders, conflicts = [] }, now, extra = {}) {
  /** @type {string[]} */
  const parts = [`{"version":1,"exportedAt":${now}`];
  /**
   * @param {string} key
   * @param {Row[]} records
   */
  const list = (key, records) => {
    parts.push(`,${JSON.stringify(key)}:[`);
    records.forEach((record, i) => parts.push((i === 0 ? '' : ',') + JSON.stringify(record)));
    parts.push(']');
  };
  list('canvases', notes);
  list('elements', elements);
  parts.push(',"media":[');
  /** @type {Array<Row | null>} */
  const rows = [...media];
  for (let i = 0; i < rows.length; i++) {
    parts.push((i === 0 ? '' : ',') + JSON.stringify(await exportedMedia(/** @type {Row} */ (rows[i]))));
    // Its Blob can go once it's written out
    rows[i] = null;
  }
  parts.push(']');
  list('folders', folders);
  // What a conflict kept, the user's text included, which 1.4.x's import reads none of
  if (conflicts.length > 0) list('conflicts', conflicts);
  for (const [key, value] of Object.entries(extra)) parts.push(`,${JSON.stringify(key)}:${JSON.stringify(value)}`);
  parts.push('}');
  return new Blob(parts, { type: 'application/json' });
}

/**
 * Every automatic backup's key, oldest first, or none when chrome.storage can't say
 * @param {BackupStore} settings
 * @returns {Promise<string[]>}
 */
async function autoBackupKeys(settings) {
  try {
    const stored = (await settings.get(null)) || {};
    return Object.keys(stored)
      .filter(key => key.startsWith(AUTO_BACKUP_PREFIX))
      .sort();
  } catch {
    return [];
  }
}

/**
 * The automatic backup, as Storage.createAutoBackup makes it: the export, marked as one, under
 * `auto_backup_<time>`, then the oldest removed so three are kept, then the time of the last
 * backup. Rejects with what IndexedDB threw when the export can't be read, and with the
 * UnavailableError for what chrome.storage.local threw when the backup or its time can't be
 * saved, as every settings write on #17's adapter answers: `quota` for a full one.
 * @param {{db: IDBDatabase, settings: BackupStore, clock: Clock}} options
 * @returns {Promise<void>}
 */
export async function createAutoBackup({ db, settings, clock }) {
  const data = {
    ...(await exportObject(await readExport(db), clock.now())),
    autoBackup: true,
    backupCreatedAt: clock.now(),
  };
  /** @param {Record<string, unknown>} items */
  const save = async items => {
    try {
      await settings.set(items);
    } catch (error) {
      throw settingsFailureOf(error, 'write');
    }
  };
  const key = `${AUTO_BACKUP_PREFIX}${clock.now()}`;
  const existing = await autoBackupKeys(settings);
  await save({ [key]: data });
  const all = [...existing, key].sort();
  if (all.length > AUTO_BACKUPS_KEPT) {
    try {
      await settings.remove(all.slice(0, all.length - AUTO_BACKUPS_KEPT));
    } catch {
      // Left for the next backup to remove, as Storage left it
    }
  }
  await save({ [LAST_BACKUP_KEY]: clock.now() });
}

/**
 * A parsed backup's check before anything is written, as Storage.validateImport has it: a
 * version-1 file with lists of notes and blocks, and of media and folders when it has them,
 * each record with an id of its own, and each block's note in the file. Media for a note
 * outside the file, which 1.4.0's exports carry, is counted as skipped, not refused.
 * @param {unknown} data
 * @returns {{ok: true, counts: {notes: number, blocks: number, folders: number, media: number, skippedMedia: number}}
 *   | {ok: false, reason: string}}
 */
export function validateBackup(data) {
  /** @param {string} reason */
  const refuse = reason => ({ ok: /** @type {const} */ (false), reason });
  if (!data || typeof data !== 'object' || Array.isArray(data) || !('canvases' in data)) {
    return refuse("the file isn't a NewTabNote backup");
  }
  const file = /** @type {Row} */ (data);
  if (file.version !== 1) {
    return refuse(
      file.version === undefined
        ? 'the file has no backup version'
        : `backup version ${String(file.version)} isn't supported`,
    );
  }
  if (!Array.isArray(file.canvases)) return refuse("its notes aren't a list");
  if (!Array.isArray(file.elements)) return refuse('it has no list of blocks');
  /** @param {unknown} value */
  const optionalList = value => value === undefined || value === null || Array.isArray(value);
  if (!optionalList(file.media)) return refuse("its media isn't a list");
  if (!optionalList(file.folders)) return refuse("its folders aren't a list");
  const media = Array.isArray(file.media) ? file.media : [];
  const folders = Array.isArray(file.folders) ? file.folders : [];

  /**
   * @param {unknown[]} list
   * @param {string} one
   * @param {string} many
   * @returns {string | null}
   */
  const checkRecords = (list, one, many) => {
    const seen = new Set();
    for (let i = 0; i < list.length; i++) {
      const record = /** @type {Row} */ (list[i]);
      if (!record || typeof record !== 'object' || Array.isArray(record)) return `${one} ${i + 1} isn't a record`;
      if (typeof record.id !== 'string' || record.id === '') return `${one} ${i + 1} has no text ID`;
      if (seen.has(record.id)) return `two ${many} share the ID "${record.id}"`;
      seen.add(record.id);
    }
    return null;
  };
  const problem =
    checkRecords(file.canvases, 'note', 'notes') ||
    checkRecords(file.elements, 'block', 'blocks') ||
    checkRecords(media, 'media item', 'media items') ||
    checkRecords(folders, 'folder', 'folders');
  if (problem) return refuse(problem);

  const noteIds = new Set(file.canvases.map((/** @type {Row} */ note) => note.id));
  const orphan = file.elements.find((/** @type {Row} */ block) => !noteIds.has(block.canvasId));
  if (orphan) return refuse(`block "${orphan.id}" belongs to a note that isn't in the file`);

  const skippedMedia = media.filter((/** @type {Row} */ row) => !noteIds.has(row.canvasId)).length;
  return {
    ok: true,
    counts: {
      notes: file.canvases.length,
      blocks: file.elements.length,
      folders: folders.length,
      media: media.length - skippedMedia,
      skippedMedia,
    },
  };
}

/**
 * The import worked out before it writes anything, as Storage.importData works it out: on a
 * copy of the file, so the parsed input never changes, with each note's, block's, and media
 * row's new id taken in the order Storage takes them (notes, then blocks, then media), and each
 * media row's data URL as a Blob, since a transaction can't wait on anything else. A file the
 * check refuses, or a profile without the folders or media store a file needs, answers
 * `rejected` `validation`.
 * @param {unknown} backup
 * @param {'merge' | 'replace'} mode
 * @param {{newId: () => string, has: (store: string) => boolean}} options
 * @returns {{plan: ImportPlan} | {refused: Outcome}}
 */
export function planImport(backup, mode, { newId, has }) {
  if (mode !== 'merge' && mode !== 'replace') return { refused: rejected('validation', 'import-invalid') };
  if (!validateBackup(backup).ok) return { refused: rejected('validation', 'import-invalid') };
  const file = /** @type {Row} */ (structuredClone(backup));
  /** @type {Row[]} */
  const folders = Array.isArray(file.folders) ? file.folders : [];
  /** @type {Row[]} */
  const rows = Array.isArray(file.media) ? file.media : [];
  if (folders.length > 0 && !has('folders')) return { refused: rejected('validation', 'folders-store-missing') };

  /** @type {Row[]} */
  const notes = file.canvases;
  const noteIds = new Map(notes.map(note => [note.id, newId()]));
  // Field name 'canvasId' kept for backward compatibility
  const elements = file.elements.map((/** @type {Row} */ block) => ({
    ...block,
    id: newId(),
    canvasId: noteIds.get(block.canvasId),
  }));
  /** @type {Row[]} */
  const media = [];
  let skippedMedia = 0;
  for (const row of rows) {
    if (!noteIds.has(row.canvasId)) {
      skippedMedia += 1;
      continue;
    }
    /** @type {unknown} */
    let blob = row.blob;
    if (typeof blob === 'string' && blob.startsWith('data:')) {
      try {
        blob = blobOf(blob);
      } catch {
        return { refused: rejected('validation', 'import-invalid') };
      }
    }
    media.push({ ...row, id: newId(), canvasId: noteIds.get(row.canvasId), blob });
  }
  if (media.length > 0 && !has('media')) return { refused: rejected('validation', 'media-store-missing') };
  return { plan: { mode, notes, noteIds, elements, media, folders, skippedMedia } };
}

/**
 * The import's writes, as one unit of its command, which reads the profile's notes and folders
 * in the command's own transaction, so what it decides (what moves to trash, which folders are
 * reused, which Daily Notes come in as plain notes) matches what it writes. It decides only
 * from what it reads, so it can run again in a new transaction. `receipt` answers what the run
 * that commits did.
 * @param {ImportPlan} plan
 * @param {Clock} clock
 * @returns {{unit: Unit, receipt: () => ImportReceipt}}
 */
export function importUnit(plan, clock) {
  /** @type {ImportReceipt} */
  let receipt = { importedIds: [], addedFolderIds: [], trashedIds: [] };
  /** @type {Unit} */
  const unit = {
    stores: ['notes', 'blocks', 'media', 'folders'],
    run: async tx => {
      /** @type {ImportReceipt} */
      const made = {
        importedIds: plan.notes.map(note => /** @type {string} */ (plan.noteIds.get(note.id))),
        addedFolderIds: [],
        trashedIds: [],
      };
      receipt = made;
      if (plan.folders.length > 0 && !tx.has('folders')) return rejected('validation', 'folders-store-missing');
      if (plan.media.length > 0 && !tx.has('media')) return rejected('validation', 'media-store-missing');
      const trashedAt = clock.now();
      const localNotes = /** @type {Row[]} */ (await tx.getAll('notes'));
      const localFolders = /** @type {Row[]} */ (await tx.getAll('folders'));
      const localFolderIds = new Set(localFolders.map(folder => folder.id));
      const fileFolderIds = new Set(plan.folders.map(folder => folder.id));
      /** @param {unknown} id */
      const folderOf = id =>
        id && (fileFolderIds.has(/** @type {string} */ (id)) || localFolderIds.has(/** @type {string} */ (id)))
          ? id
          : null;

      if (plan.mode === 'replace') {
        for (const local of localNotes) {
          if (local.trashed || local.archived || local.isTemplate) continue;
          // As trashNote does, without its hard delete of empty untitled notes
          local.trashed = true;
          local.trashedAt = trashedAt;
          local.archived = false;
          local.archivedAt = null;
          local.updatedAt = trashedAt;
          // A lifecycle the kernel wrote beside the flags follows them (#17 PR 3a)
          if (local.lifecycle !== undefined) local.lifecycle = 'trashed';
          tx.put('notes', /** @type {any} */ (local));
          made.trashedIds.push(local.id);
        }
      }

      // The dates that keep a local Daily Note outside trash once this commits
      const dailyDates = new Set(
        localNotes.filter(note => !note.trashed && note.isDaily && note.dateStr).map(note => note.dateStr),
      );

      for (const folder of plan.folders) {
        if (localFolderIds.has(folder.id)) continue;
        tx.put('folders', /** @type {any} */ ({ ...folder, parentId: folderOf(folder.parentId) }));
        made.addedFolderIds.push(folder.id);
      }

      // The fields #17 PR 3 writes beside the flags, which a backup from a build before the
      // exports dropped them, or a later one, carries: an import drops them, so the flags it
      // sets are all a note says, and the kernel derives the rest from those
      for (const fileNote of plan.notes) {
        const imported = /** @type {Row} */ (
          withoutPlacement({
            ...fileNote,
            id: plan.noteIds.get(fileNote.id),
            folderId: folderOf(fileNote.folderId),
          })
        );
        // Imported notes start outside trash, so an import never queues anything for deletion
        delete imported.trashed;
        delete imported.trashedAt;
        if (imported.isDaily && imported.dateStr && dailyDates.has(imported.dateStr)) {
          imported.isDaily = false;
          imported.dateStr = null;
          imported.name = `${imported.name || 'Untitled'} (imported)`;
        }
        tx.put('notes', /** @type {any} */ (imported));
      }
      for (const element of plan.elements) tx.put('blocks', /** @type {any} */ (element));
      for (const row of plan.media) tx.put('media', /** @type {any} */ (row));
      return undefined;
    },
  };
  return { unit, receipt: () => receipt };
}

/**
 * The import up to its commit: its plan, then for Replace all the recovery copy of the export,
 * saved before anything moves to trash, and the unit that writes it all. Answers the outcome
 * that refuses it, with nothing written, when the file is refused, the profile lacks a store
 * it needs, or the copy can't be saved (`unavailable` `storage` `recovery-copy-failed`,
 * retryable). Rejects when the export the copy holds can't be read.
 * @param {{db: IDBDatabase, settings: CopyStore, clock: Clock, backup: unknown, mode: 'merge' | 'replace',
 *   newId?: () => string}} options
 * @returns {Promise<{refused: Outcome} | {unit: Unit, receipt: () => ImportReceipt}>}
 */
export async function prepareImport({ db, settings, clock, backup, mode, newId = legacyId }) {
  const planned = planImport(backup, mode, { newId, has: store => db.objectStoreNames.contains(store) });
  if ('refused' in planned) return planned;
  if (planned.plan.mode === 'replace') {
    // A superset of the export and the older recovery format, for the legacy decoders in #18
    const copy = {
      ...(await exportObject(await readExport(db), clock.now())),
      recoveryBackup: true,
      reason: 'pre-import-replace',
      timestamp: clock.now(),
    };
    try {
      await writeRecoveryCopy(settings, copy, clock);
    } catch {
      return { refused: unavailable('storage', 'recovery-copy-failed', true) };
    }
  }
  return importUnit(planned.plan, clock);
}
