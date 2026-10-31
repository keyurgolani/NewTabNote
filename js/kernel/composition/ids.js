/**
 * The ids each composition root hands out (#17 PR 2a): crypto.randomUUID() for every id a
 * kernel command carries (a new note's, block's, and folder's, and each command's own, #17's
 * opId), a context's caller id, and #13's sessions, requests, and coordinator instance. Ids
 * 1.4.x's Utils.generateId made stay as they are, and the legacy code keeps making them until
 * #12 slice 7. No code reads a time or an order from an id: the sorts that meet one only break
 * a tie with it, after the time, order, or timestamp they sort by. That includes the editor's
 * template insert, which goes by when each block was made (js/editor.js, selectTemplateItem).
 *
 * Loading this module touches no browser API: crypto is read when an id is made.
 */

/** @typedef {import('../core/ports/runtime.js').Ids} Ids */

/** @type {Ids} */
export const randomIds = Object.freeze({ next: () => crypto.randomUUID() });
