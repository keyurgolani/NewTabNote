/**
 * The ops of #17's change log (#17 PR 4c; contracts/entities.js, changeOp): what a commit did
 * to each note and folder it changed, worked out from each record as it was before the commit
 * and as the commit leaves it. Both adapters hand their records here, so they write the same
 * ops. An op holds its name, and a block's id or the names of the fields that changed, never a
 * value (the lead's Q4: content-free ops, until #19's merge adds content).
 *
 * - A note made: createNote, then insertBlock for each block it's made with.
 * - A note changed: updateNote naming the fields NOTE_OP_FIELDS lists whose value changed, if
 *   any, then an op for each block of it that changed: insertBlock for one it didn't have,
 *   deleteBlock for one it lost, moveBlock for one whose order alone changed, and updateBlock
 *   for any other change. A block put as it was takes none, so a save of every block names
 *   only the ones that changed.
 * - A note deleted for good: deleteNote, which stands for its blocks.
 * - A folder made, changed, or deleted: createFolder, updateFolder naming the fields
 *   FOLDER_OP_FIELDS lists that changed, or deleteFolder.
 * A note whose revision moved with no field or block changed takes none.
 */

import { FOLDER_OP_FIELDS, NOTE_OP_FIELDS } from '../contracts/entities.js';

/** @typedef {import('../contracts/entities.js').ChangeOp} ChangeOp */
/** @typedef {Record<string, unknown>} Row */

/**
 * A record around a commit: as it was, null when there was none, and as the commit leaves it,
 * null when the commit deleted it, or undefined when the commit didn't write it
 * @typedef {{before: Row | null, after: Row | null | undefined}} Around
 */

/**
 * Whether two stored values are the same: equal primitives, or arrays or plain objects whose
 * items or fields are, a missing field the same as an undefined one
 * @param {unknown} a
 * @param {unknown} b
 * @returns {boolean}
 */
export function sameValue(a, b) {
  if (Object.is(a, b)) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const x = /** @type {Record<string, unknown>} */ (a);
  const y = /** @type {Record<string, unknown>} */ (b);
  for (const key of new Set([...Object.keys(x), ...Object.keys(y)])) {
    if (!sameValue(x[key], y[key])) return false;
  }
  return true;
}

/**
 * The fields of `fields` whose value differs between the two records, in `fields`' order
 * @param {readonly string[]} fields
 * @param {Row} before
 * @param {Row} after
 * @returns {string[]}
 */
const changedFields = (fields, before, after) => fields.filter(field => !sameValue(before[field], after[field]));

/**
 * The op one block takes, or null for none
 * @param {string} blockId
 * @param {Around} block
 * @returns {ChangeOp | null}
 */
function blockOp(blockId, { before, after }) {
  if (after === undefined) return null;
  if (after === null) return before ? { op: 'deleteBlock', blockId } : null;
  if (!before) return { op: 'insertBlock', blockId };
  for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
    if (key !== 'order' && !sameValue(before[key], after[key])) return { op: 'updateBlock', blockId };
  }
  return sameValue(before.order, after.order) ? null : { op: 'moveBlock', blockId };
}

/**
 * The note a block belongs to, as a record has it
 * @param {Row | null | undefined} block
 * @returns {string | null}
 */
const noteOf = block => (block && typeof block.canvasId === 'string' ? block.canvasId : null);

/**
 * The blocks a commit wrote, by the note each belongs to, each note's in the order the commit
 * first wrote them. A block that moved to another note is deleted from the one it left and
 * inserted into the one it joined.
 * @param {Iterable<[string, Around]>} blocks - each block the commit wrote, by id
 * @returns {Map<string, Array<[string, Around]>>}
 */
export function blocksByNote(blocks) {
  /** @type {Map<string, Array<[string, Around]>>} */
  const byNote = new Map();
  /**
   * @param {string | null} noteId
   * @param {string} blockId
   * @param {Around} around
   */
  const add = (noteId, blockId, around) => {
    if (noteId === null) return;
    const list = byNote.get(noteId) || [];
    list.push([blockId, around]);
    byNote.set(noteId, list);
  };
  for (const [blockId, { before, after }] of blocks) {
    const left = noteOf(before);
    const joined = after === undefined ? left : noteOf(after);
    if (left !== null && joined !== null && left !== joined) {
      add(left, blockId, { before, after: null });
      add(joined, blockId, { before: null, after });
    } else {
      add(joined ?? left, blockId, { before, after });
    }
  }
  return byNote;
}

/**
 * A note's ops for a commit
 * @param {Around} note
 * @param {ReadonlyArray<[string, Around]>} [blocks] - the blocks of it the commit wrote (blocksByNote)
 * @returns {ChangeOp[]}
 */
export function noteOps({ before, after }, blocks = []) {
  if (after === null) return before ? [{ op: 'deleteNote' }] : [];
  /** @type {ChangeOp[]} */
  const ops = [];
  if (after && !before) ops.push({ op: 'createNote' });
  if (after && before) {
    const fields = changedFields(NOTE_OP_FIELDS, before, after);
    if (fields.length > 0) ops.push({ op: 'updateNote', fields });
  }
  for (const [blockId, around] of blocks) {
    const op = blockOp(blockId, around);
    if (op) ops.push(op);
  }
  return ops;
}

/**
 * A folder's ops for a commit
 * @param {Around} folder
 * @returns {ChangeOp[]}
 */
export function folderOps({ before, after }) {
  if (after === undefined) return [];
  if (after === null) return before ? [{ op: 'deleteFolder' }] : [];
  if (!before) return [{ op: 'createFolder' }];
  const fields = changedFields(FOLDER_OP_FIELDS, before, after);
  return fields.length > 0 ? [{ op: 'updateFolder', fields }] : [];
}
