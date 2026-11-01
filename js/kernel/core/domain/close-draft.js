/**
 * A close-time draft (#33, the stack's close-time PR): the edit a closing tab hadn't seen
 * commit, which its page wrote to its localStorage as JSON, and the rules the next start applies
 * it by, one transaction per draft (application/close-drafts.js). The format is 1.4.3's (R0's
 * js/close-drafts.js), every field under its own name, type and meaning, so the 1.4.3 a rollback
 * brings back reads the stack's drafts too, plus the stack's own fields (the lead's Q1):
 *
 *   {v: 1, id, page?, noteId, at, base: {revision, updatedAt, issued, name?, blocks?, issuedSaves?},
 *    blocks, deletedBlockIds, name?, titleOrigin?, preview, todoProgress, linkedNames}
 *
 * - `blocks` holds the blocks changed since the base, as the editor has them, and
 *   `deletedBlockIds` the blocks deleted since. `name` is there only when the title changed,
 *   with `titleOrigin` 'typed' (the user) or 'generated' (the AI). `preview`, `todoProgress` and
 *   `linkedNames` are what the editor read from its whole note.
 * - `base.revision` is the content revision the page last saw commit, null from 1.4.x.
 *   `base.updatedAt` and `base.issued` are 1.4.3's: the record's `updatedAt` then, and the
 *   stamps the page's saves made since. The stack's writer leaves `issued` empty (QA1).
 * - A stack draft has `base.blocks`: each block of the note as the page last saw it commit, by
 *   its digest as stored (blockDigest). `base.name` is the name then, and `base.issuedSaves`
 *   what each save the page issued since wrote, its blocks by digest and its name, so a save
 *   that committed after the page last heard is still the page's own. `page` names the page
 *   load that wrote the draft.
 *
 * Each draft goes by these rules, in this order (decide):
 * 0. Its recovered note is stored already: an earlier start made it, and its page went before
 *    removing the draft. Nothing is written.
 * 1. Its note is gone, deleted for good since. Nothing is written.
 * 2. Content first: the residue (residueOf) is what of the draft the note doesn't hold yet. A
 *    draft block whose stored copy is equal already drops out, and so does a deleted block
 *    that's gone, and a name the note has, or a generated one its title set by hand keeps out.
 *    With nothing left the draft is dropped.
 * 3. Changed since the base: a 1.4.3 draft goes by 1.4.3's rule (savedElsewhere). A stack draft
 *    goes by its revision. Unmoved, nothing changed the note's title or blocks since, whatever
 *    moved its placement or derived fields. Moved, the residue is held against what the page saw
 *    and issued (conflicts).
 *    - A residue of deletes alone, maybe with a generated title, over a note changed since, is
 *      dropped, and the blocks stay (the lead's Q5).
 *    - Otherwise a 1.4.3 draft over a note saved elsewhere, a stack draft whose residue
 *      conflicts, and a draft holding a block another note holds, or a block no note holds (the
 *      lead's Q6), become one recovered note holding the residue (the lead's Q4).
 * 4. Otherwise the residue is saved: its blocks put, its deletes deleted, only the note's own,
 *    and its name written.
 *
 * Nothing here reads a store or a browser API: the handler reads the records and hands them in.
 */

import { isId, isRecord } from '../contracts/checks.js';
import { recoveredIdOf } from './close-draft-keys.js';

/** @typedef {import('./note.js').NoteRecord} NoteRecord */
/** @typedef {import('./note.js').BlockRecord} BlockRecord */
/** @typedef {import('../ports/repository.js').Versions} Versions */

/** The format both 1.4.3 and the stack write */
export const CLOSE_DRAFT_VERSION = 1;

/**
 * What the page last saw commit, and what it issued since
 * @typedef {object} DraftBase
 * @property {number | null} [revision]
 * @property {number | null} [updatedAt]
 * @property {number[]} [issued]
 * @property {string} [name]
 * @property {Record<string, string>} [blocks]
 * @property {Array<{name?: string, blocks: Record<string, string>}>} [issuedSaves]
 */

/**
 * @typedef {object} CloseDraft
 * @property {1} v
 * @property {string} id
 * @property {string} [page]
 * @property {string} noteId
 * @property {number} at
 * @property {DraftBase} base
 * @property {Array<{id: string} & Record<string, unknown>>} blocks
 * @property {string[]} deletedBlockIds
 * @property {string} [name]
 * @property {'typed' | 'generated'} [titleOrigin]
 * @property {string} [preview]
 * @property {unknown} [todoProgress]
 * @property {string[]} [linkedNames]
 */

/**
 * What of a draft the note doesn't hold yet: the blocks it changed that differ from the stored
 * ones, the blocks it deleted that are still the note's, and its name, when the save would
 * write one the note doesn't have
 * @typedef {{blocks: CloseDraft['blocks'], deletedBlockIds: string[], name: string | undefined}} Residue
 */

/**
 * What the next start does with a draft (decide):
 * - `recovered-before`: rule 0, its recovered note is stored already
 * - `gone`: rule 1
 * - `dropped`: nothing left to write, or deletes alone over a note changed since
 * - `recover`: one recovered note holding the residue
 * - `save`: the residue saved into the note
 * @typedef {{kind: 'recovered-before'} | {kind: 'gone'} | {kind: 'dropped', residue: Residue}
 *   | {kind: 'recover', residue: Residue} | {kind: 'save', residue: Residue}} Decision
 */

/** A block's times, which change on every edit, so content first leaves them out */
const TIMES = Object.freeze(['createdAt', 'updatedAt']);

/**
 * A block's fields but its times, as a stable string, as 1.4.3 compares them
 * @param {Record<string, unknown>} block
 * @returns {string}
 */
export function fingerprint(block) {
  const fields = Object.keys(block)
    .filter(key => !TIMES.includes(key))
    .sort();
  return JSON.stringify(fields.map(key => [key, block[key]]));
}

/**
 * A short digest of a block's fingerprint, 1.4.3's 53-bit cyrb53, so a draft names a block as
 * the page saw it without holding a second copy of the note's text or images
 * @param {Record<string, unknown>} block
 * @returns {string}
 */
export function digest(block) {
  const text = fingerprint(block);
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    h1 = Math.imul(h1 ^ code, 2654435761);
    h2 = Math.imul(h2 ^ code, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}

/**
 * The digest of `block` as note `noteId` stores it, which is what a stack draft's base and
 * issued saves hold, so the applier compares it with the stored copy's own
 * @param {Record<string, unknown>} block
 * @param {string} noteId
 * @returns {string}
 */
export const blockDigest = (block, noteId) => digest({ ...block, canvasId: noteId });

// The id of a draft's recovered note lives beside the keys (close-draft-keys.js), so a page can
// tell which notes a draft is for without loading these rules
export { recoveredIdOf };

/**
 * Whether `value` is a draft the applier can apply: 1.4.3's own check (isDraft), with ids that
 * aren't empty. A draft that fails it is removed unapplied, as 1.4.3 removes one, since nothing
 * could apply it.
 * @param {unknown} value
 * @returns {value is CloseDraft}
 */
export function isCloseDraft(value) {
  if (!isRecord(value) || value.v !== CLOSE_DRAFT_VERSION || !isId(value.id) || !isId(value.noteId)) return false;
  if (!isRecord(value.base) || typeof value.at !== 'number') return false;
  const { blocks, deletedBlockIds } = value;
  return (
    Array.isArray(blocks) &&
    blocks.every(block => isRecord(block) && isId(block.id)) &&
    Array.isArray(deletedBlockIds) &&
    deletedBlockIds.every(isId)
  );
}

/**
 * Whether a stack page wrote the draft: only the stack's base holds its blocks' digests
 * @param {CloseDraft} draft
 * @returns {boolean}
 */
export const isStackDraft = draft => isRecord(draft.base.blocks);

/**
 * A note's title as the sidebar names it
 * @param {NoteRecord | undefined} note
 * @returns {string}
 */
export const titleOf = note => (note && typeof note.name === 'string' && note.name) || 'Untitled';

/**
 * Whether `name` renames `note`: a title that isn't empty and isn't the one the list shows
 * @param {NoteRecord} note
 * @param {string | undefined} name
 * @returns {boolean}
 */
export const renames = (note, name) => typeof name === 'string' && name !== '' && name !== titleOf(note);

/**
 * Whether the draft's title is one a save writes: not a generated one over a title set by hand
 * @param {NoteRecord} note
 * @param {CloseDraft} draft
 * @returns {boolean}
 */
const writesName = (note, draft) =>
  typeof draft.name === 'string' && !(draft.titleOrigin === 'generated' && note.titleManuallySet);

/**
 * Whether a stored block is the note's own. One with no note id is no note's, so the draft
 * never takes it, by the kernel's rule (the lead's Q6), where 1.4.3 took it back.
 * @param {Record<string, unknown> | undefined} copy
 * @param {string} noteId
 * @returns {boolean}
 */
const ownCopy = (copy, noteId) => Boolean(copy) && /** @type {Record<string, unknown>} */ (copy).canvasId === noteId;

/**
 * Rule 2, content first: what of the draft the note doesn't hold yet
 * @param {NoteRecord} note
 * @param {ReadonlyMap<string, Record<string, unknown>>} stored - the stored blocks the draft names, by id
 * @param {CloseDraft} draft
 * @returns {Residue}
 */
export function residueOf(note, stored, draft) {
  const { noteId } = draft;
  const blocks = draft.blocks.filter(block => {
    const copy = stored.get(block.id);
    return !(ownCopy(copy, noteId) && fingerprint(/** @type {Record<string, unknown>} */ (copy)) === fingerprint({ ...block, canvasId: noteId }));
  });
  const deletedBlockIds = [...new Set(draft.deletedBlockIds)].filter(id => ownCopy(stored.get(id), noteId));
  const name = writesName(note, draft) && note.name !== draft.name ? draft.name : undefined;
  return { blocks, deletedBlockIds, name };
}

/**
 * @param {Residue} residue
 * @returns {boolean}
 */
const isEmpty = residue => residue.blocks.length === 0 && residue.deletedBlockIds.length === 0 && residue.name === undefined;

/**
 * Q5's case: deletes alone, maybe with a generated title, which hold no text to recover
 * @param {NoteRecord} note
 * @param {Residue} residue
 * @param {CloseDraft} draft
 * @returns {boolean}
 */
const onlyDeletes = (note, residue, draft) =>
  residue.blocks.length === 0 && !(renames(note, residue.name) && draft.titleOrigin !== 'generated');

/**
 * 1.4.3's rule 3 for a 1.4.3 draft: another writer saved the note after the draft's base. The
 * stored `updatedAt` at or below the base, or one the page's own saves stamped, is the page's.
 * @param {NoteRecord} note
 * @param {CloseDraft} draft
 * @returns {boolean}
 */
export function savedElsewhere(note, draft) {
  const stored = note.updatedAt;
  const base = draft.base.updatedAt;
  // A draft that can't say what it was based on never overwrites anything
  if (typeof base !== 'number') return true;
  if (typeof stored !== 'number' || stored <= base) return false;
  return !(Array.isArray(draft.base.issued) && draft.base.issued.includes(stored));
}

/**
 * The digests the page knows block `id` by: as it last saw it commit, and as each save it
 * issued since wrote it
 * @param {CloseDraft} draft
 * @param {string} id
 * @returns {string[]}
 */
function knownDigests(draft, id) {
  const { blocks = {}, issuedSaves = [] } = draft.base;
  return [blocks, ...issuedSaves.map(save => (isRecord(save) && isRecord(save.blocks) ? save.blocks : {}))]
    .filter(digests => Object.hasOwn(digests, id))
    .map(digests => digests[id]);
}

/**
 * Whether a stack draft's residue meets a change the page never made, once the note's revision
 * has moved past the draft's base: a block it changed that another writer changed or deleted
 * since, a block it deleted that another writer changed, or a name over one another writer
 * gave the note
 * @param {NoteRecord} note
 * @param {ReadonlyMap<string, Record<string, unknown>>} stored
 * @param {CloseDraft} draft
 * @param {Residue} residue
 * @returns {boolean}
 */
export function conflicts(note, stored, draft, residue) {
  const { noteId } = draft;
  /** @param {string} id */
  const changedElsewhere = id => {
    const copy = stored.get(id);
    if (!ownCopy(copy, noteId)) return Object.hasOwn(draft.base.blocks || {}, id);
    return !knownDigests(draft, id).includes(digest(/** @type {Record<string, unknown>} */ (copy)));
  };
  if (residue.blocks.some(block => changedElsewhere(block.id))) return true;
  if (residue.deletedBlockIds.some(changedElsewhere)) return true;
  if (residue.name === undefined) return false;
  const names = [draft.base.name, ...(draft.base.issuedSaves || []).map(save => save && save.name)];
  return !names.includes(note.name);
}

/**
 * What the next start does with `draft`, from the records its transaction read
 * @param {object} read
 * @param {CloseDraft} read.draft
 * @param {NoteRecord | undefined} read.note - the draft's note, if it's stored
 * @param {boolean} read.madeBefore - whether the draft's recovered note is stored
 * @param {ReadonlyMap<string, Record<string, unknown>>} read.stored - the stored blocks the draft names, by id
 * @param {Versions | undefined} read.versions - the note's committed versions, on an adapter with revisions
 * @returns {Decision}
 */
export function decide({ draft, note, madeBefore, stored, versions }) {
  if (madeBefore) return { kind: 'recovered-before' };
  if (!note) return { kind: 'gone' };
  const residue = residueOf(note, stored, draft);
  if (isEmpty(residue)) return { kind: 'dropped', residue };
  const stack = isStackDraft(draft);
  const changed = stack
    ? !versions || typeof draft.base.revision !== 'number' || versions.revision !== draft.base.revision
    : savedElsewhere(note, draft);
  if (changed && onlyDeletes(note, residue, draft)) return { kind: 'dropped', residue };
  // A block that can't be saved in place: another note holds it, or no note does
  const foreign = residue.blocks.some(block => stored.has(block.id) && !ownCopy(stored.get(block.id), draft.noteId));
  const conflicted = changed && (!stack || conflicts(note, stored, draft, residue));
  return conflicted || foreign ? { kind: 'recover', residue } : { kind: 'save', residue };
}
