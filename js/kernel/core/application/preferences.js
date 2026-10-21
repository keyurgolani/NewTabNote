/**
 * The preferences use case and query, over the settings port. A preference write reaches
 * every open tab through chrome.storage.local, as before.
 */

import { isRecord, unknownKeys } from '../contracts/checks.js';
import { committed, empty, failed, ready, rejected } from '../contracts/outcomes.js';
import { PREFERENCE_KEYS } from '../domain/preferences.js';

/**
 * @template {import('../contracts/commands.js').CommandType} T
 * @typedef {import('./work.js').CommandHandler<T>} CommandHandler
 */

/**
 * @template {import('../contracts/queries.js').QueryType} T
 * @typedef {import('./work.js').QueryHandler<T>} QueryHandler
 */

/** @type {{setPreferences: CommandHandler<'setPreferences'>}} */
export const preferenceCommands = {
  setPreferences(command) {
    const { values } = command;
    if (!isRecord(values) || Object.keys(values).length === 0) return rejected('validation', 'invalid-command');
    if (unknownKeys(values, PREFERENCE_KEYS).length > 0) return rejected('validation', 'unknown-preference');
    const keys = Object.keys(values);
    return {
      commandId: command.commandId,
      command,
      effect: { kind: 'settings', area: 'preferences', values },
      done: () => committed('preferences-saved', keys),
    };
  },
};

/** @type {{getPreferences: QueryHandler<'getPreferences'>}} */
export const preferenceQueries = {
  async getPreferences({ keys = [...PREFERENCE_KEYS] }, { adapter, clock }) {
    if (!Array.isArray(keys) || keys.some(key => typeof key !== 'string')) return failed('validation', 'invalid-query');
    if (keys.some(key => !PREFERENCE_KEYS.includes(key))) return failed('validation', 'unknown-preference');
    const values = await adapter.readSettings('preferences', keys);
    return Object.keys(values).length > 0 ? ready(clock.now(), values) : empty(clock.now());
  },
};
