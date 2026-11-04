/**
 * The new tab's close-time draft writer (#33, the stack's close-time PR): the port the document
 * client hands its editors (the lead's Q2), so kernel core touches no browser API and the editor
 * no Web Storage. At the page's own `pagehide`, each editor that holds an edit it hasn't seen
 * commit gives it the edit, and it writes the draft to the page's localStorage as JSON, at once,
 * which a closing page manages whatever IndexedDB is doing. The next start applies it
 * (core/application/close-drafts.js).
 *
 * The draft is 1.4.3's v1, every field under its own name, type and meaning, so the 1.4.3 a
 * rollback brings back reads it too, plus the stack's own fields (core/domain/close-draft.js):
 *
 *   {v: 1, id, page, pane?, noteId, at, base: {revision, updatedAt, issued: [], name?, blocks, orders?, issuedSaves},
 *    blocks, orders?, deletedBlockIds, name?, titleOrigin?, preview, todoProgress, linkedNames}
 *
 * `orders` is there only when the pane moved a block it changed nothing else of (#6): each such
 * block's move, and in the base its order as the page last saw it commit and as each save the
 * page issued since gave it.
 *
 * Its key is `ntn-close-draft:<id>`, where `id` is the commandId of the closing save the editor
 * issues right after, so the draft and the save it shadows share one id. `base.issued` stays
 * empty (QA1): the kernel stamps `updatedAt` inside its command, and no outcome reports it.
 * `page` is this page load's id, the same on each of its drafts, and `pane` the editor pane whose
 * base the draft was made on, when the editor gives one (#6). A draft with no pane is byte for
 * byte what the writer wrote before it had one.
 *
 * A draft that doesn't fit, typically QuotaExceededError, is skipped: the closing save stands,
 * and nothing throws out of `pagehide`. It's logged by the error's name alone, never the edit.
 * NewTabNote has no locked or encrypted notes, so no draft skips one; a feature that adds them
 * has to make the editor skip them.
 */

import { CLOSE_DRAFT_VERSION, blockDigest } from '../core/domain/close-draft-format.js';
import { DRAFT_PREFIX } from '../core/domain/close-draft-keys.js';

/** @typedef {import('../core/application/close-drafts.js').DraftStorage} DraftStorage */

/**
 * What the page last saw commit of the note, and what it issued since, as the draft's base
 * holds them: each block the draft names by its digest as stored
 * @typedef {object} DraftBaseFields
 * @property {number | null} revision - the content revision, null when the page doesn't know it
 * @property {number | null} updatedAt - the stored `updatedAt` as the page last read it
 * @property {string} [name] - the name as the page last saw it commit
 * @property {Record<string, string>} blocks
 * @property {Record<string, number>} [orders] - each block the draft moves, at its order then
 * @property {Array<{name?: string, blocks: Record<string, string>, orders?: Record<string, number>}>} issuedSaves
 */

/**
 * What an editor gives the writer of an edit it hasn't seen commit
 * @typedef {object} DraftFields
 * @property {string} id - the commandId of the closing save the editor issues next, or a fresh id
 * @property {string} noteId
 * @property {DraftBaseFields} base
 * @property {Array<Record<string, unknown> & {id: string}>} blocks - changed since the base, as the editor serializes them
 * @property {Array<{id: string, order: number}>} [orders] - the blocks only moved since the base, each at its new order
 * @property {string[]} deletedBlockIds - in the base, and no longer the editor's
 * @property {string} [name] - a title set since the base
 * @property {'typed' | 'generated'} [titleOrigin]
 * @property {string} preview
 * @property {unknown} todoProgress
 * @property {string[]} linkedNames
 * @property {string} [pane] - the pane whose base the draft was made on, as its saves name it
 */

/**
 * @typedef {object} CloseDraftWriter
 * @property {string} page - this page load's id, which each of its drafts carries
 * @property {(block: Record<string, unknown>, noteId: string) => string} digest
 *   A block's digest as note `noteId` stores it, which the draft's base names it by
 * @property {(fields: DraftFields) => boolean} write - whether the draft was written
 * @property {(fields: DraftFields) => import('../core/domain/close-draft.js').CloseDraft} draftOf
 *   The draft `write` would write, written nowhere: an editor save's, for the page's journal (#35
 *   slice 3b), which the next page applies by the same rules if this one closes before the save
 *   is answered
 */

/** Tells of a draft that didn't fit, by the error's name alone */
const consoleLogger = Object.freeze({
  warn: (/** @type {string} */ event, /** @type {Record<string, unknown>} */ detail) =>
    console.warn(`NewTabNote close-time drafts: ${event}`, detail),
});

/**
 * The writer on `storage`, the page's localStorage. A page without one writes no draft.
 * @param {{storage: DraftStorage | undefined, newId: () => string, now?: () => number,
 *   logger?: {warn: (event: string, detail: Record<string, unknown>) => void}}} options
 * @returns {CloseDraftWriter}
 */
export function closeDraftWriter({ storage, newId, now = () => Date.now(), logger = consoleLogger }) {
  const page = newId();
  /** @param {DraftFields} fields */
  const draftOf = fields => {
    const { base } = fields;
    /** @type {Record<string, unknown>} */
    const draft = {
      v: CLOSE_DRAFT_VERSION,
      id: fields.id,
      page,
      pane: fields.pane,
      noteId: fields.noteId,
      at: now(),
      base: {
        revision: base.revision,
        updatedAt: base.updatedAt,
        issued: [],
        ...(base.name === undefined ? {} : { name: base.name }),
        blocks: base.blocks,
        orders: base.orders,
        issuedSaves: base.issuedSaves,
      },
      blocks: fields.blocks,
      orders: fields.orders,
      deletedBlockIds: fields.deletedBlockIds,
      preview: fields.preview,
      todoProgress: fields.todoProgress,
      linkedNames: fields.linkedNames,
    };
    if (fields.name !== undefined)
      Object.assign(draft, { name: fields.name, titleOrigin: fields.titleOrigin || 'typed' });
    return /** @type {import('../core/domain/close-draft.js').CloseDraft} */ (/** @type {unknown} */ (draft));
  };
  return Object.freeze({
    page,
    digest: blockDigest,
    draftOf,
    write(fields) {
      if (!storage) return false;
      const draft = draftOf(fields);
      try {
        storage.setItem(DRAFT_PREFIX + fields.id, JSON.stringify(draft));
        return true;
      } catch (error) {
        logger.warn('close-draft-skipped', { name: /** @type {any} */ (error)?.name ?? 'Error' });
        return false;
      }
    },
  });
}
