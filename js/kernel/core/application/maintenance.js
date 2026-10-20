/**
 * Startup maintenance: default settings where none are stored, and the read-only integrity
 * check that reports orphaned records (#33 made it report-only). The new-tab page and the
 * service worker run it as they start, as before, and the policy refuses it from Popup and
 * Side Panel, which open the database without repair or upgrade.
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
