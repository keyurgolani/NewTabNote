/**
 * What a root applies its page's close-time drafts with (composition/close-drafts.js, #33), which
 * the new tab, Popup and Side Panel import only when their localStorage gives them work, so no
 * page's start holds it: the `close-drafts-chunk` chunk's applier and store, and beside them the
 * forget that takes the journal entries a draft's close covered (#6). That one loads the journal's
 * chunk only for a draft that names its pane, once the draft's apply commits, and kernel core,
 * which reaches no browser API, never imports it.
 */

export { applyCloseDrafts, closeDraftStore, untoldToasts } from '../core/application/close-drafts-chunk.js';

/**
 * The journal entries `draft`'s close covered go (journal-chunk.js). A journal chunk that can't
 * load leaves them to #33's rules at the journal's apply, as before. Never rejects.
 * @param {import('../core/domain/close-draft.js').CloseDraft} draft
 * @returns {Promise<void>}
 */
export const forgetCovered = draft =>
  import('./journal-chunk.js').then(
    chunk => chunk.forgetCovered(draft),
    () => {},
  );
