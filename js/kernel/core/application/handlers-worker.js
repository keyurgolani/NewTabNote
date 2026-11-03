/**
 * The service worker's table (handlers.js): its capture (js/background.js), the integrity
 * check its coordinator runs after an install or an update (composition/coordinator.js), the
 * startup maintenance its kernel runs as it opens, the one-time catch-up of 1.4.x's lagging
 * records after the update (composition/background.js, #33), and its journal drain
 * (application/journal-drain.js, #35 slice 3): the journaled commands it replays, a journaled
 * editor save as the close-time draft it applies by #33's rules, the tombstones it reads first,
 * and the conflict record it keeps of an entry it can't replay. An MV3 worker can't import() a
 * module, so the close-time drafts' apply comes in statically here.
 */

import { closeDraftCommands } from './close-drafts.js';
import { handlerTable } from './handlers.js';
import { journalCommands, journalQueries } from './journal.js';
import { maintenanceCommands } from './maintenance.js';
import { noteCommands } from './notes.js';
import { recordCatchUpCommands } from './record-catch-up.js';

export const WORKER_HANDLERS = handlerTable({
  commands: {
    captureToDailyNote: noteCommands.captureToDailyNote,
    runStartupMaintenance: maintenanceCommands.runStartupMaintenance,
    runIntegrityCheck: maintenanceCommands.runIntegrityCheck,
    catchUpNoteRecords: recordCatchUpCommands.catchUpNoteRecords,
    createNote: noteCommands.createNote,
    insertBlocks: noteCommands.insertBlocks,
    applyCloseDraft: closeDraftCommands.applyCloseDraft,
    keepJournalEntry: journalCommands.keepJournalEntry,
  },
  queries: {
    findTombstones: journalQueries.findTombstones,
  },
});
