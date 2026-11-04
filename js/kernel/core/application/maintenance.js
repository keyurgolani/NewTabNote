/**
 * Startup maintenance: default settings where none are stored. The new-tab page and the service
 * worker run it as they start, as before, and the policy refuses it from Popup and Side Panel,
 * which open the database without repair or upgrade. The read-only integrity check it ran is
 * runIntegrityCheck now, which the service worker runs after an install or an update (#35
 * slice 1), and js/storage.js's own went with #17 PR 4b. That command's handler is the worker's
 * alone (integrity-check.js, #35 slice 3c), so the new tab's start, which holds this module, holds
 * none of it.
 */

import { committed } from '../contracts/outcomes.js';

/**
 * @template {import('../contracts/commands.js').CommandType} T
 * @typedef {import('./work.js').CommandHandler<T>} CommandHandler
 */

/** @type {{runStartupMaintenance: CommandHandler<'runStartupMaintenance'>}} */
export const maintenanceCommands = {
  runStartupMaintenance(command) {
    return {
      commandId: command.commandId,
      command,
      effect: { kind: 'maintenance' },
      done: () => committed('maintenance-ran', []),
    };
  },
};
