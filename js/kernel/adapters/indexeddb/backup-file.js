/**
 * 1.4.x's backup file on #17's adapter, which writes nothing (#35 slice 4d's P-a, NTN-255):
 * the export's reads, the export as one object and as Export JSON's file, and an import's check of
 * a parsed backup. They moved out of backups.js, whose tasks write, so a page that only reads and
 * checks reaches no writer through them. backups.js's tasks and #17's adapter run them as before,
 * and backups.js's header says what the export and the import hold.
 */

import { withoutPlacement } from '../../core/domain/placement.js';
import { dataUrlOf } from './data-urls.js';
import { CONFLICTS_STORE } from './registry-names.js';
import { result } from './requests.js';

/** @typedef {Record<string, any>} Row */

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
