/**
 * The service worker's table (handlers.js), on the worker's catalog (contracts/worker-catalog.js):
 * its capture (js/background.js, capture.js), the integrity check its coordinator runs after an
 * install or an update (composition/coordinator.js), the startup maintenance its kernel runs as
 * it opens, the one-time catch-up of 1.4.x's lagging records after the update
 * (composition/background.js, #33), and its journal drain (application/journal-drain.js, #35
 * slice 3): the journaled commands it replays, the tombstones it reads first, and the conflict
 * record it keeps of an entry it can't replay. A journaled editor save is the pages' to replay,
 * as a close-time draft by #33's rules (slice 3b, the lead's call on #182), so the worker loads
 * none of the applier.
 */

import { WORKER_CATALOG } from '../contracts/worker-catalog.js';
import { captureCommands } from './capture.js';
import { handlerTable } from './handlers.js';
import { integrityCommands } from './integrity-check.js';
import { journalCommands, journalQueries } from './journal.js';
import { maintenanceCommands } from './maintenance.js';
import { noteCommands } from './notes.js';
import { recordCatchUpCommands } from './record-catch-up.js';

export const WORKER_HANDLERS = handlerTable(
  {
    commands: {
      captureToDailyNote: captureCommands.captureToDailyNote,
      runStartupMaintenance: maintenanceCommands.runStartupMaintenance,
      runIntegrityCheck: integrityCommands.runIntegrityCheck,
      catchUpNoteRecords: recordCatchUpCommands.catchUpNoteRecords,
      createNote: noteCommands.createNote,
      insertBlocks: noteCommands.insertBlocks,
      keepJournalEntry: journalCommands.keepJournalEntry,
    },
    queries: {
      findTombstones: journalQueries.findTombstones,
    },
  },
  WORKER_CATALOG,
);
