/**
 * What the new tab keeps beside its preferences (#12 slices 6 and 7), by the keys 1.4.x's
 * Storage.setSetting wrote: AI chat's conversations and prompt templates, the first run's end,
 * and the backup bookkeeping, since #17 PR 1b what the page reads of the storage upgrade, and
 * since NTN-21 whether the background jobs' one-time switch-off has run. Slice 6's commands write
 * them (application/workspace-data.js), and getWorkspaceData reads them back, each from the
 * settings area its command writes, or the worker, for the upgrade's record.
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
 * The keys of #17's storage upgrade the new tab reads (#17 PR 1b): the service worker's record
 * of its last migration run, which only the worker writes, and when the space notice was last
 * put off, which snoozeSpaceNotice writes
 */
export const UPGRADE_KEYS = Object.freeze({
  record: 'storageUpgrade',
  spaceNotice: 'spaceNoticeSnoozedAt',
});

/**
 * The key that says the background jobs' one-time switch-off has run (NTN-21), as 1.4.4 keeps it
 * (`setting_backgroundJobsOffOnce`). It's kept in the preferences area beside the two switches
 * it turned off, so turnOffBackgroundJobs writes all three in one write, and no preference
 * command writes it.
 */
export const JOBS_OFF_KEY = 'backgroundJobsOffOnce';

/** @typedef {'chat' | 'onboarding' | 'backup' | 'upgrade' | 'preferences'} WorkspaceDataArea */

/**
 * Each key getWorkspaceData reads, to the settings area it's kept in
 * @type {Readonly<Record<string, WorkspaceDataArea>>}
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
  [UPGRADE_KEYS.record]: 'upgrade',
  [UPGRADE_KEYS.spaceNotice]: 'upgrade',
  [JOBS_OFF_KEY]: 'preferences',
});

/** Every key getWorkspaceData reads */
export const WORKSPACE_DATA_KEYS = Object.freeze(/** @type {string[]} */ (Object.keys(AREAS)));

/**
 * The settings area `key` is kept in
 * @param {string} key - one of WORKSPACE_DATA_KEYS
 * @returns {WorkspaceDataArea}
 */
export function workspaceDataArea(key) {
  return AREAS[key];
}
