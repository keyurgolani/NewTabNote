/**
 * The `close-drafts-chunk` chunk (#33, the lead's option 1): what Popup and Side Panel load when
 * their localStorage holds a closing tab's edit, the apply's handler, store and applier
 * (close-drafts.js), and nothing else imports. The new tab has close-drafts.js in its start, so
 * this module is the one only an import() reaches, and its chunk is the one their budget rows
 * name as lazy (build/budgets.json).
 */

export { applyCloseDrafts, closeDraftCommands, closeDraftStore } from './close-drafts.js';
