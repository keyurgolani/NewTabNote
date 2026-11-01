/**
 * The service worker's table (handlers.js): its capture (js/background.js), the integrity
 * check its coordinator runs after an install or an update (composition/coordinator.js), and
 * the startup maintenance its kernel runs as it opens. It sends no query.
 */

import { handlerTable } from './handlers.js';
import { maintenanceCommands } from './maintenance.js';
import { noteCommands } from './notes.js';

export const WORKER_HANDLERS = handlerTable({
  commands: {
    captureToDailyNote: noteCommands.captureToDailyNote,
    runStartupMaintenance: maintenanceCommands.runStartupMaintenance,
    runIntegrityCheck: maintenanceCommands.runIntegrityCheck,
  },
});
