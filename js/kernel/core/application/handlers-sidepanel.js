/**
 * Side Panel's table (handlers.js): what js/sidepanel.js sends, the one read of the notes it
 * summarizes. Its one write, the apply of a closing tab's edit (#33), goes to the worker over #13's
 * port, through Side Panel's send chunk (composition/sidepanel-send-chunk.js, #35 slice 4c), so
 * the table holds no command.
 */

import { handlerTable } from './handlers.js';
import { noteQueries } from './notes.js';

export const SIDEPANEL_HANDLERS = handlerTable({
  queries: { listNotes: noteQueries.listNotes },
});
