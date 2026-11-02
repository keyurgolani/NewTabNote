/**
 * catchUpNoteRecords (#33, the lead's Q9 and QA3): one batch of the service worker's one-time
 * catch-up after the update. 1.4.x could leave a note's record behind its blocks: a closing
 * tab's blocks-only write, or a delete that committed before the save after it, so a record's
 * preview or to-do progress lags what its blocks give. Each note the batch names gets the
 * preview and to-do progress its blocks give, as insertBlocks makes them (domain/note.js,
 * noteSaveMetadata), where they differ, and nothing else: it's a derived command
 * (application/scopes.js), so it never writes a name, `updatedAt` or a block, and moves no
 * version. Links wait for each note's next save, which reads them from the editor's text, as the
 * lead ruled (Q9).
 *
 * A batch reads at most CATCH_UP_NOTES notes and, past the first, no more than CATCH_UP_BYTES of
 * them and their blocks, as the transforms' batches do (adapters/indexeddb/transforms.js). One it
 * stopped short answers `records-caught-up-part`, and the worker sends the start of it again in
 * a smaller batch (composition/background.js), so what a batch holds in memory stays bounded. Its
 * changedIds are the notes it caught up.
 */

import { isIdList } from '../contracts/checks.js';
import { committed } from '../contracts/outcomes.js';
import { inBlockOrder, noteSaveMetadata } from '../domain/note.js';
import { invalid } from './notes.js';
import { unitsWork } from './work.js';

/** @typedef {import('../ports/repository.js').Unit} Unit */

/**
 * @template {import('../contracts/commands.js').CommandType} T
 * @typedef {import('./work.js').CommandHandler<T>} CommandHandler
 */

/** The most notes one batch reads, as a transform's batch holds at most 100 records */
export const CATCH_UP_NOTES = 100;

/** What a batch reads before it stops, after its first note: 2 MB, as a transform's batch holds */
export const CATCH_UP_BYTES = 2 * 1024 * 1024;

/**
 * About how many bytes `value` holds: its strings' characters, and a little for the rest
 * @param {unknown} value
 * @returns {number}
 */
function sizeOf(value) {
  if (typeof value === 'string') return value.length;
  if (Array.isArray(value)) return value.reduce((total, item) => total + sizeOf(item), 0);
  if (value && typeof value === 'object') {
    return Object.entries(value).reduce((total, [key, item]) => total + key.length + sizeOf(item), 0);
  }
  return 8;
}

/**
 * @param {unknown} a
 * @param {unknown} b
 * @returns {boolean} whether two to-do progresses are the same, null and a missing one alike
 */
const sameProgress = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

/** @type {{catchUpNoteRecords: CommandHandler<'catchUpNoteRecords'>}} */
export const recordCatchUpCommands = {
  catchUpNoteRecords(command) {
    const { noteIds } = command;
    if (!isIdList(noteIds) || noteIds.length > CATCH_UP_NOTES) return invalid();
    /** @type {string[]} */
    let caughtUp = [];
    let read = 0;
    /** @type {Unit} */
    const catchUp = {
      stores: ['notes', 'blocks'],
      async run(tx) {
        // Each run decides afresh, since an adapter may run the unit again (ports/repository.js, Unit)
        caughtUp = [];
        read = 0;
        let bytes = 0;
        for (const noteId of noteIds) {
          if (read > 0 && bytes > CATCH_UP_BYTES) return;
          read += 1;
          const note = await tx.get('notes', noteId);
          if (!note) continue;
          const blocks = await tx.getAllByIndex('blocks', 'canvasId', noteId);
          bytes += sizeOf(note) + sizeOf(blocks);
          const { preview, todoProgress } = noteSaveMetadata(inBlockOrder(blocks));
          if (preview === note.preview && sameProgress(todoProgress, note.todoProgress)) continue;
          tx.put('notes', { ...note, preview, todoProgress });
          caughtUp.push(noteId);
        }
      },
    };
    return unitsWork(
      command,
      [catchUp],
      () => committed(read === noteIds.length ? 'records-caught-up' : 'records-caught-up-part', caughtUp),
      { scope: 'derived' },
    );
  },
};
