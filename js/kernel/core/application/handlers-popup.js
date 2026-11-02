/**
 * Popup's table (handlers.js): what js/popup.js sends, its quick note, its list of recent
 * notes, and whether to show the day's summary, and what its root sends as it starts when the
 * page holds a closing tab's edit, that edit's apply (#33), whose handler loads at its first use
 */

import { applyCloseDraftOnDemand } from './close-drafts-on-demand.js';
import { handlerTable } from './handlers.js';
import { noteCommands, noteQueries } from './notes.js';
import { preferenceQueries } from './preferences.js';

export const POPUP_HANDLERS = handlerTable({
  commands: { createNote: noteCommands.createNote, applyCloseDraft: applyCloseDraftOnDemand },
  queries: {
    listNotes: noteQueries.listNotes,
    getPopupInsightsEnabled: preferenceQueries.getPopupInsightsEnabled,
  },
});
