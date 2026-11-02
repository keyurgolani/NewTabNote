/**
 * Where close-time drafts wait in a page's localStorage (#33), as 1.4.3 keys them, kept apart
 * from the rules that apply them, so a page's start can see whether it holds any without loading
 * those (composition/close-drafts.js):
 * - DRAFT_PREFIX + id: a draft, as JSON (close-draft.js)
 * - UNTOLD_KEY: the recovered notes no new tab has told about yet, `[{id, of}]`, their ids and
 *   their originals', never their text
 * - SAVED_UNTOLD_KEY: the notes in the Trash a start saved a closing edit into, which no new tab
 *   has told about yet, `[{id}]` (V3, QA2). 1.4.3 never reads it.
 * - CATCH_UP_KEY: what a 1.4.3 Popup or Side Panel start left for the next 1.4.3 new tab's
 *   catch-up, which the stack's first start reads and then removes (QA4)
 * - DRAFTS_LOCK: the Web Lock an apply holds, and every delete for good
 *
 * A draft's recovered note's id is here too (recoveredIdOf), so a page can tell which notes a
 * draft is for without loading the rules (close-draft.js re-exports it).
 */

export const DRAFT_PREFIX = 'ntn-close-draft:';
export const DRAFTS_LOCK = 'ntn-close-drafts';
export const UNTOLD_KEY = 'ntn-recovered-untold';
export const SAVED_UNTOLD_KEY = 'ntn-saved-untold';
export const CATCH_UP_KEY = 'ntn-start-catch-up:notes';

/**
 * The id of a draft's recovered note, the same at every start, so rule 0 finds the one an
 * earlier start made, a 1.4.3 start's included
 * @param {{id: string}} draft
 * @returns {string}
 */
export const recoveredIdOf = draft => `${draft.id}-recovered`;
