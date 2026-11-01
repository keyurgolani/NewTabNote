/**
 * Side Panel's table (handlers.js): what js/sidepanel.js sends, the one read of the notes it
 * summarizes. It sends no command.
 */

import { handlerTable } from './handlers.js';
import { noteQueries } from './notes.js';

export const SIDEPANEL_HANDLERS = handlerTable({
  queries: { listNotes: noteQueries.listNotes },
});
