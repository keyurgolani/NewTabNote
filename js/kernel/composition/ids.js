/**
 * The ids each composition root hands out (#17 PR 2a): crypto.randomUUID() for every id a
 * kernel command carries (a new note's, block's, and folder's, and each command's own, #17's
 * opId), a context's caller id, and #13's sessions, requests, and coordinator instance. Ids
 * 1.4.x's Utils.generateId made stay as they are, and the legacy code keeps making them until
 * #12 slice 7. One key reads a time from an id: Utils.inCreationOrder, which lists a note's
 * blocks in the order they were made, by the time in an id of generateId's form, else the
 * block's createdAt, then its order, then its id. The readers that need that order, which
 * 1.4.x's id order gave them, go by it: the editor's template insert (js/editor.js,
 * selectTemplateItem), and the search index's and the embeddings' text
 * (js/controllers/notes-manager.js: rebuildSearchIndex, updateNoteIndex, and
 * updateMissingEmbeddings). Every other sort that meets an id only breaks a tie with it, after
 * the time, order, or timestamp it sorts by.
 *
 * Loading this module touches no browser API: crypto is read when an id is made.
 */

/** @typedef {import('../core/ports/runtime.js').Ids} Ids */

/** @type {Ids} */
export const randomIds = Object.freeze({ next: () => crypto.randomUUID() });
