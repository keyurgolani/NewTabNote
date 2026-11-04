/**
 * The `close-drafts-chunk` chunk (#33, the lead's option 1): what the new tab, Popup and Side
 * Panel load when their localStorage gives them work (composition/close-drafts.js), the apply's
 * handler, store and applier (close-drafts.js), and nothing else imports. No page's start holds
 * close-drafts.js, so this module is the one only an import() reaches, and its chunk is the one
 * Popup's and Side Panel's budget rows name as lazy (build/budgets.json). The new tab's row
 * doesn't name it: the budget check classifies only the import()s of a page's HTML root, and the
 * new tab's is in the workspace chunk.
 *
 * The journal's apply of the editor saves a closed page left is here too (journal-apply.js, #35
 * slice 3b), which the journal's chunk loads when it finds one: its command is the applier's, so
 * this chunk loads for it either way.
 */

export { applyCloseDrafts, closeDraftCommands, closeDraftStore, untoldToasts } from './close-drafts.js';
export { applyJournalSaves } from './journal-apply.js';
