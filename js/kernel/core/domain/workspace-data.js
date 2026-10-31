/**
 * What the new tab keeps beside its preferences (#12 slices 6 and 7), by the keys 1.4.x's
 * Storage.setSetting wrote: AI chat's conversations and prompt templates, the first run's end,
 * and the backup bookkeeping. Slice 6's commands write them (application/workspace-data.js),
 * and getWorkspaceData reads them back, each from the settings area its command writes.
 */

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
 * Each key getWorkspaceData reads, to the settings area its command writes it in
 * @type {Readonly<Record<string, 'chat' | 'onboarding' | 'backup'>>}
 */
const AREAS = Object.freeze({
  [CHAT_KEYS.note[0]]: 'chat',
  [CHAT_KEYS.note[1]]: 'chat',
  [CHAT_KEYS.global[0]]: 'chat',
  [CHAT_KEYS.global[1]]: 'chat',
  [PROMPT_TEMPLATES_KEY]: 'chat',
  [ONBOARDING_KEY]: 'onboarding',
  [BACKUP_KEYS.fullExport]: 'backup',
  [BACKUP_KEYS.backup]: 'backup',
  [BACKUP_KEYS.exportNotice]: 'backup',
});

/** Every key getWorkspaceData reads */
export const WORKSPACE_DATA_KEYS = Object.freeze(/** @type {string[]} */ (Object.keys(AREAS)));

/**
 * The settings area `key` is kept in
 * @param {string} key - one of WORKSPACE_DATA_KEYS
 * @returns {'chat' | 'onboarding' | 'backup'}
 */
export function workspaceDataArea(key) {
  return AREAS[key];
}
