/**
 * Popup's table (handlers.js): what js/popup.js reads, its list of recent notes and whether to show
 * the day's summary. Its writes, the quick note and the apply of a closing tab's edit, go to the
 * worker over #13's port (#35 slice 4b-2, composition/popup.js), so it holds no command.
 */

import { handlerTable } from './handlers.js';
import { noteQueries } from './notes.js';
import { preferenceQueries } from './preferences.js';

export const POPUP_HANDLERS = handlerTable({
  queries: {
    listNotes: noteQueries.listNotes,
    getPopupInsightsEnabled: preferenceQueries.getPopupInsightsEnabled,
  },
});
