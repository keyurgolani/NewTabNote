/**
 * Side Panel's table (handlers.js): what js/sidepanel.js sends, the one read of the notes it
 * summarizes, and what its root sends as it starts when the page holds a closing tab's edit,
 * that edit's apply (#33), whose handler loads at its first use
 */

import { applyCloseDraftOnDemand } from './close-drafts-on-demand.js';
import { handlerTable } from './handlers.js';
import { noteQueries } from './notes.js';

export const SIDEPANEL_HANDLERS = handlerTable({
  commands: { applyCloseDraft: applyCloseDraftOnDemand },
  queries: { listNotes: noteQueries.listNotes },
});
