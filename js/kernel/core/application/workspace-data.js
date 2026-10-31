/**
 * What the new tab keeps beside its preferences (#12 slice 6): AI chat's conversations and
 * prompt templates, the first run's end, the backup bookkeeping, custom themes, and the
 * legacy backup tasks. Each settings write is one chrome.storage.local set under the keys
 * 1.4.x's Storage.setSetting wrote, so a pair saved together lands together, and every other
 * open tab hears of it, as before. Outcomes name the keys or ids they changed and never
 * carry what was saved.
 */

import { isId, isRecord } from '../contracts/checks.js';
import { committed, rejected, unavailable } from '../contracts/outcomes.js';
import { isThemeProperties, savedTheme } from '../domain/theme.js';
import { unitsWork } from './work.js';

/**
 * @template {import('../contracts/commands.js').CommandType} T
 * @typedef {import('./work.js').CommandHandler<T>} CommandHandler
 */

/** @typedef {import('../ports/repository.js').SettingsArea} SettingsArea */
/** @typedef {import('../contracts/commands.js').Command} Command */

const invalid = () => rejected('validation', 'invalid-command');

/** The code a backup task answers with on an adapter that can't run it */
export const BACKUPS_UNAVAILABLE = 'backups-need-legacy-storage';

/**
 * The keys each of AI chat's conversations is saved under: its history, then its messages
 * @type {Readonly<Record<'note' | 'global', readonly [string, string]>>}
 */
export const CHAT_KEYS = Object.freeze({
  note: Object.freeze(/** @type {const} */ (['aiChatHistory', 'noteChatMessages'])),
  global: Object.freeze(/** @type {const} */ (['globalChatHistory', 'globalChatMessages'])),
});

/** The key the prompt templates are saved under */
export const PROMPT_TEMPLATES_KEY = 'aiPromptTemplates';

/** The key that says the first run finished */
export const ONBOARDING_KEY = 'hasCompletedOnboarding';

/** The keys the backup bookkeeping is saved under */
export const BACKUP_KEYS = Object.freeze({
  fullExport: 'lastFullExportAt',
  backup: 'lastBackupAt',
  exportNotice: 'preMigrationNotice',
});

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

/** What a backup task answers on an adapter without the `backups` flag, before it writes anything */
function backupsUnavailable() {
  return unavailable('adapter', BACKUPS_UNAVAILABLE, false);
}
