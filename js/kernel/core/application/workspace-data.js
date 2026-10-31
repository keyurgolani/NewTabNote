/**
 * What the new tab keeps beside its preferences (#12 slice 6): AI chat's conversations and
 * prompt templates, the first run's end, the backup bookkeeping, custom themes, and the
 * legacy backup tasks. Each settings write is one chrome.storage.local set under the keys
 * 1.4.x's Storage.setSetting wrote, so a pair saved together lands together, and every other
 * open tab hears of it, as before. Outcomes name the keys or ids they changed and never
 * carry what was saved.
 *
 * Slice 7's queries read them back: getWorkspaceData each key from the area its command
 * writes, listThemes the custom themes, and exportBackup the export file Export JSON and
 * Create Backup download.
 */

import { isId, isRecord } from '../contracts/checks.js';
import { committed, empty, failed, ready, rejected, unavailable } from '../contracts/outcomes.js';
import { isThemeProperties, savedTheme, themesInListOrder } from '../domain/theme.js';
import {
  BACKUP_KEYS,
  CHAT_KEYS,
  ONBOARDING_KEY,
  PROMPT_TEMPLATES_KEY,
  WORKSPACE_DATA_KEYS,
  workspaceDataArea,
} from '../domain/workspace-data.js';
import { unitsWork } from './work.js';

export { BACKUP_KEYS, CHAT_KEYS, ONBOARDING_KEY, PROMPT_TEMPLATES_KEY };

/**
 * @template {import('../contracts/commands.js').CommandType} T
 * @typedef {import('./work.js').CommandHandler<T>} CommandHandler
 */

/**
 * @template {import('../contracts/queries.js').QueryType} T
 * @typedef {import('./work.js').QueryHandler<T>} QueryHandler
 */

/** @typedef {import('../ports/repository.js').SettingsArea} SettingsArea */
/** @typedef {import('../contracts/commands.js').Command} Command */

const invalid = () => rejected('validation', 'invalid-command');

/** The code a backup task answers with on an adapter that can't run it */
export const BACKUPS_UNAVAILABLE = 'backups-need-legacy-storage';

/**
 * The work for a settings write of `values` in `area`
 * @param {Command} command
 * @param {SettingsArea} area
 * @param {Record<string, unknown>} values
 * @param {string} code
 * @returns {import('../ports/repository.js').Work}
 */
const settingsWork = (command, area, values, code) => ({
  commandId: command.commandId,
  command,
  effect: { kind: 'settings', area, values },
  done: () => committed(code, Object.keys(values)),
});

/**
 * @type {{
 *   saveChatHistory: CommandHandler<'saveChatHistory'>,
 *   savePromptTemplates: CommandHandler<'savePromptTemplates'>,
 *   saveTheme: CommandHandler<'saveTheme'>,
 *   completeOnboarding: CommandHandler<'completeOnboarding'>,
 *   recordBackup: CommandHandler<'recordBackup'>,
 *   recordExportNotice: CommandHandler<'recordExportNotice'>,
 *   createAutoBackup: CommandHandler<'createAutoBackup'>,
 *   importBackup: CommandHandler<'importBackup'>,
 * }}
 */
export const workspaceDataCommands = {
  saveChatHistory(command) {
    const { chat, history, messages } = command;
    if ((chat !== 'note' && chat !== 'global') || !Array.isArray(history) || !Array.isArray(messages)) {
      return invalid();
    }
    const [historyKey, messagesKey] = CHAT_KEYS[chat];
    return settingsWork(command, 'chat', { [historyKey]: history, [messagesKey]: messages }, 'chat-saved');
  },

  savePromptTemplates(command) {
    if (!Array.isArray(command.templates)) return invalid();
    return settingsWork(command, 'chat', { [PROMPT_TEMPLATES_KEY]: command.templates }, 'prompt-templates-saved');
  },

  saveTheme(command, { clock }) {
    const { themeId, name, properties } = command;
    if (!isId(themeId) || typeof name !== 'string' || !isThemeProperties(properties)) return invalid();
    const now = clock.now();
    return unitsWork(
      command,
      [
        {
          stores: ['themes'],
          async run(tx) {
            tx.put('themes', savedTheme(await tx.get('themes', themeId), { id: themeId, name, properties, now }));
          },
        },
      ],
      () => committed('theme-saved', [themeId]),
    );
  },

  completeOnboarding(command) {
    return settingsWork(command, 'onboarding', { [ONBOARDING_KEY]: true }, 'onboarding-completed');
  },

  recordBackup(command, { clock }) {
    const { fullExport, backup } = command;
    if (typeof fullExport !== 'boolean' || typeof backup !== 'boolean' || !(fullExport || backup)) return invalid();
    const now = clock.now();
    /** @type {Record<string, unknown>} */
    const values = {};
    if (fullExport) values[BACKUP_KEYS.fullExport] = now;
    if (backup) values[BACKUP_KEYS.backup] = now;
    return settingsWork(command, 'backup', values, 'backup-recorded');
  },

  recordExportNotice(command, { clock }) {
    const { version, outcome } = command;
    if (!Number.isSafeInteger(version) || version < 0) return invalid();
    if (outcome !== 'exported' && outcome !== 'dismissed' && outcome !== 'not-needed') return invalid();
    const record = { version, outcome, at: clock.now() };
    return settingsWork(command, 'backup', { [BACKUP_KEYS.exportNotice]: record }, 'export-notice-recorded');
  },

  createAutoBackup(command, { adapter }) {
    if (!adapter.flags.backups) return backupsUnavailable();
    return {
      commandId: command.commandId,
      command,
      effect: { kind: 'backup', action: 'auto' },
      done: () => committed('auto-backup-created', [BACKUP_KEYS.backup]),
    };
  },

  importBackup(command, { adapter }) {
    const { mode, backup } = command;
    if ((mode !== 'merge' && mode !== 'replace') || !isRecord(backup)) return invalid();
    if (!adapter.flags.backups) return backupsUnavailable();
    return {
      commandId: command.commandId,
      command,
      effect: { kind: 'backup', action: 'import', mode, backup },
      // Only once the import's one transaction committed: the notes it added, in backup order,
      // then the folders it added, then the notes Replace all trashed
      done: receipt =>
        committed('backup-imported', receipt ? [...receipt.importedIds, ...receipt.addedFolderIds, ...receipt.trashedIds] : []),
    };
  },
};

/**
 * @type {{
 *   getWorkspaceData: QueryHandler<'getWorkspaceData'>,
 *   listThemes: QueryHandler<'listThemes'>,
 *   exportBackup: QueryHandler<'exportBackup'>,
 * }}
 */
export const workspaceDataQueries = {
  // Each key from the area its command writes it in, as Storage.getSetting read them
  async getWorkspaceData({ keys = [...WORKSPACE_DATA_KEYS] }, { adapter, clock }) {
    if (!Array.isArray(keys) || keys.some(key => typeof key !== 'string')) return failed('validation', 'invalid-query');
    if (keys.some(key => !WORKSPACE_DATA_KEYS.includes(key))) return failed('validation', 'unknown-workspace-data');
    /** @type {Map<'chat' | 'onboarding' | 'backup', string[]>} */
    const byArea = new Map();
    for (const key of keys) {
      const area = workspaceDataArea(key);
      byArea.set(area, [...(byArea.get(area) || []), key]);
    }
    /** @type {Record<string, unknown>} */
    const values = {};
    for (const [area, inArea] of byArea) Object.assign(values, await adapter.readSettings(area, inArea));
    return Object.keys(values).length > 0 ? ready(clock.now(), values) : empty(clock.now());
  },

  async listThemes(query, { adapter, clock }) {
    const themes = themesInListOrder(await adapter.read(['themes'], tx => tx.getAll('themes')));
    return themes.length > 0 ? ready(clock.now(), themes) : empty(clock.now());
  },

  // Create Backup adds the fields 1.4.x's createBackup gave the file, stamped by the kernel clock
  async exportBackup({ backup }, { adapter, clock }) {
    if (typeof backup !== 'boolean') return failed('validation', 'invalid-query');
    if (!adapter.flags.backups) return failed('adapter', BACKUPS_UNAVAILABLE);
    const extra = backup
      ? { backupType: 'full-backup', backupCreatedAt: new Date(clock.now()).toISOString(), backupVersion: 1 }
      : {};
    return ready(clock.now(), await adapter.exportBackup(extra));
  },
};

/** What a backup task answers on an adapter without the `backups` flag, before it writes anything */
function backupsUnavailable() {
  return unavailable('adapter', BACKUPS_UNAVAILABLE, false);
}
