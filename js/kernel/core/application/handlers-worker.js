/**
 * The service worker's table (handlers.js): its capture (js/background.js), the integrity
 * check its coordinator runs after an install or an update (composition/coordinator.js), the
 * startup maintenance its kernel runs as it opens, and the one-time catch-up of 1.4.x's lagging
 * records after the update (composition/background.js, #33). It sends no query.
 */

import { handlerTable } from './handlers.js';
import { maintenanceCommands } from './maintenance.js';
import { noteCommands } from './notes.js';
import { recordCatchUpCommands } from './record-catch-up.js';

export const WORKER_HANDLERS = handlerTable({
  commands: {
    captureToDailyNote: noteCommands.captureToDailyNote,
    runStartupMaintenance: maintenanceCommands.runStartupMaintenance,
    runIntegrityCheck: maintenanceCommands.runIntegrityCheck,
    catchUpNoteRecords: recordCatchUpCommands.catchUpNoteRecords,
  },
});
