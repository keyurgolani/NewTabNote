/**
 * Popup's table (handlers.js): what js/popup.js sends, its quick note, its list of recent
 * notes, and whether to show the day's summary
 */

import { handlerTable } from './handlers.js';
import { noteCommands, noteQueries } from './notes.js';
import { preferenceQueries } from './preferences.js';

export const POPUP_HANDLERS = handlerTable({
  commands: { createNote: noteCommands.createNote },
  queries: {
    listNotes: noteQueries.listNotes,
    getPopupInsightsEnabled: preferenceQueries.getPopupInsightsEnabled,
  },
});
