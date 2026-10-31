/**
 * Startup maintenance: default settings where none are stored, and the read-only integrity
 * check that reports orphaned records (#33 made it report-only). The new-tab page and the
 * service worker run it as they start, as before, and the policy refuses it from Popup and
 * Side Panel, which open the database without repair or upgrade. The service worker's start
 * skips the check (#35 slice 1), and runs it as runIntegrityCheck after an install or an update.
 */

import { committed } from '../contracts/outcomes.js';

/**
 * @template {import('../contracts/commands.js').CommandType} T
 * @typedef {import('./work.js').CommandHandler<T>} CommandHandler
 */

/**
 * @type {{
 *   runStartupMaintenance: CommandHandler<'runStartupMaintenance'>,
 *   runIntegrityCheck: CommandHandler<'runIntegrityCheck'>,
 * }}
 */
export const maintenanceCommands = {
  runStartupMaintenance(command) {
    return {
      commandId: command.commandId,
      command,
      effect: { kind: 'maintenance' },
      done: () => committed('maintenance-ran', []),
    };
  },

  runIntegrityCheck(command) {
    return {
      commandId: command.commandId,
      command,
      effect: { kind: 'integrity-check' },
      done: () => committed('integrity-checked', []),
    };
  },
};
