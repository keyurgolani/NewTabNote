/**
 * Every command name the service worker's queue runs (#35 slice 4b-1, the lead's ruling): the
 * shared catalog's (commands.js), the worker's own (worker-catalog.js), and recovery.html's
 * rebuild batch (recovery-port.js, #35 slice 8), names only. The
 * coordinator names the turn its queue runs by one, in system.coordinatorHealth's `running` and in
 * `coordinator.turn-stuck`'s evidence (js/trust/core/evidence.js, `commandType`), and that queue
 * runs the worker's own commands too: its capture, and the drain's conflict record.
 *
 * A literal list, so this module imports neither catalog, and nothing that reads it loads a schema
 * or Valibot for it: not the trust chunk a page loads late, nor the worker.
 * test/kernel/catalog.test.mjs pins it to the worker's catalog and recovery.html's commands as the
 * same set, so a command added to any of them fails there until it's here too.
 */

/** @type {readonly (import('./commands.js').CommandType | 'rebuildSearchIndex')[]} */
export const COMMAND_NAMES = Object.freeze([
  'createNote',
  'renameNote',
  'setPinned',
  'archiveNote',
  'unarchiveNote',
  'trashNote',
  'restoreNote',
  'saveNoteContent',
  'deleteBlocks',
  'applyDerivedTitle',
  'attachInsights',
  'ensureDailyNote',
  'runBulkAction',
  'moveNoteToFolder',
  'convertNoteToTemplate',
  'convertTemplateToNote',
  'deleteNotePermanently',
  'emptyTrash',
  'runTrashCleanup',
  'createFolder',
  'moveFolder',
  'renameFolder',
  'setFolderCollapsed',
  'deleteFolder',
  'setPreferences',
  'saveWorkspaceSession',
  'runStartupMaintenance',
  'setInsightsPending',
  'recordJobRun',
  'saveSnapshot',
  'restoreSnapshot',
  'insertBlocks',
  'applyCloseDraft',
  'saveChatHistory',
  'savePromptTemplates',
  'saveTheme',
  'completeOnboarding',
  'turnOffBackgroundJobs',
  'recordBackup',
  'recordExportNotice',
  'snoozeSpaceNotice',
  'createAutoBackup',
  'importBackup',
  'updateSearchIndex',
  'saveVector',
  'applyRemoteChanges',
  'applyRemoteContent',
  'applyRemotePlacement',
  // The worker's own (worker-catalog.js)
  'captureToDailyNote',
  'runIntegrityCheck',
  'catchUpNoteRecords',
  'keepJournalEntry',
  // recovery.html's (recovery-port.js)
  'rebuildSearchIndex',
]);
