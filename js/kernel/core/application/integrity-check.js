/**
 * The read-only integrity check's command (#35 slice 1): what the service worker's coordinator
 * sends after an install or an update (composition/coordinator.js), whose effect the worker's
 * adapter runs (adapters/indexeddb/integrity.js). Only the worker sends it, so only its table
 * holds this handler (handlers-worker.js), and no page's start loads it (#35 slice 3c).
 */

import { committed } from '../contracts/outcomes.js';

/**
 * @template {import('../contracts/commands.js').CommandType} T
 * @typedef {import('./work.js').CommandHandler<T>} CommandHandler
 */

/** @type {{runIntegrityCheck: CommandHandler<'runIntegrityCheck'>}} */
export const integrityCommands = {
  runIntegrityCheck(command) {
    return {
      commandId: command.commandId,
      command,
      effect: { kind: 'integrity-check' },
      done: () => committed('integrity-checked', []),
    };
  },
};
