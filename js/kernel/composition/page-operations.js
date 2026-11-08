/**
 * The commands a page sends the service worker over #13's port (#35 slice 4d's worker half, rule
 * 10): every one the shared catalog grants the new tab, but its session's write, which the page
 * commits itself, and startup maintenance, which the worker's own start runs. Popup's quick note and
 * the apply of a closing tab's edit, which Popup and Side Panel send too, are among them. Each is
 * the catalog's entry with the schemas its module exports, imported here since an MV3 worker can't
 * import() (messaging/operations.js). Only the worker imports this module, so no page's start holds
 * a payload schema (scripts/build/budgets.js, WORKER_ONLY_MODULES).
 */

import { COMMANDS } from '../core/contracts/commands.js';
import * as applyCloseDraftOperation from '../core/contracts/operations/apply-close-draft.js';
import * as applyDerivedTitleOperation from '../core/contracts/operations/apply-derived-title.js';
import * as applyRemoteChangesOperation from '../core/contracts/operations/apply-remote-changes.js';
import * as applyRemoteContentOperation from '../core/contracts/operations/apply-remote-content.js';
import * as applyRemotePlacementOperation from '../core/contracts/operations/apply-remote-placement.js';
import * as archiveNoteOperation from '../core/contracts/operations/archive-note.js';
import * as attachInsightsOperation from '../core/contracts/operations/attach-insights.js';
import * as completeOnboardingOperation from '../core/contracts/operations/complete-onboarding.js';
import * as convertNoteToTemplateOperation from '../core/contracts/operations/convert-note-to-template.js';
import * as convertTemplateToNoteOperation from '../core/contracts/operations/convert-template-to-note.js';
import * as createAutoBackupOperation from '../core/contracts/operations/create-auto-backup.js';
import * as createFolderOperation from '../core/contracts/operations/create-folder.js';
import * as createNoteOperation from '../core/contracts/operations/create-note.js';
import * as deleteBlocksOperation from '../core/contracts/operations/delete-blocks.js';
import * as deleteFolderOperation from '../core/contracts/operations/delete-folder.js';
import * as deleteNotePermanentlyOperation from '../core/contracts/operations/delete-note-permanently.js';
import * as emptyTrashOperation from '../core/contracts/operations/empty-trash.js';
import * as ensureDailyNoteOperation from '../core/contracts/operations/ensure-daily-note.js';
import * as importBackupOperation from '../core/contracts/operations/import-backup.js';
import * as insertBlocksOperation from '../core/contracts/operations/insert-blocks.js';
import * as moveFolderOperation from '../core/contracts/operations/move-folder.js';
import * as moveNoteToFolderOperation from '../core/contracts/operations/move-note-to-folder.js';
import * as recordBackupOperation from '../core/contracts/operations/record-backup.js';
import * as recordExportNoticeOperation from '../core/contracts/operations/record-export-notice.js';
import * as recordJobRunOperation from '../core/contracts/operations/record-job-run.js';
import * as renameFolderOperation from '../core/contracts/operations/rename-folder.js';
import * as renameNoteOperation from '../core/contracts/operations/rename-note.js';
import * as restoreNoteOperation from '../core/contracts/operations/restore-note.js';
import * as restoreSnapshotOperation from '../core/contracts/operations/restore-snapshot.js';
import * as runBulkActionOperation from '../core/contracts/operations/run-bulk-action.js';
import * as runTrashCleanupOperation from '../core/contracts/operations/run-trash-cleanup.js';
import * as saveChatHistoryOperation from '../core/contracts/operations/save-chat-history.js';
import * as saveNoteContentOperation from '../core/contracts/operations/save-note-content.js';
import * as savePromptTemplatesOperation from '../core/contracts/operations/save-prompt-templates.js';
import * as saveSnapshotOperation from '../core/contracts/operations/save-snapshot.js';
import * as saveThemeOperation from '../core/contracts/operations/save-theme.js';
import * as saveVectorOperation from '../core/contracts/operations/save-vector.js';
import * as setFolderCollapsedOperation from '../core/contracts/operations/set-folder-collapsed.js';
import * as setInsightsPendingOperation from '../core/contracts/operations/set-insights-pending.js';
import * as setPinnedOperation from '../core/contracts/operations/set-pinned.js';
import * as setPreferencesOperation from '../core/contracts/operations/set-preferences.js';
import * as snoozeSpaceNoticeOperation from '../core/contracts/operations/snooze-space-notice.js';
import * as trashNoteOperation from '../core/contracts/operations/trash-note.js';
import * as turnOffBackgroundJobsOperation from '../core/contracts/operations/turn-off-background-jobs.js';
import * as unarchiveNoteOperation from '../core/contracts/operations/unarchive-note.js';
import * as updateSearchIndexOperation from '../core/contracts/operations/update-search-index.js';
import { operationOf } from '../core/messaging/operations.js';

/** Each command a page sends the worker, by its type, in the catalog's order */
export const PAGE_OPERATIONS = Object.freeze({
  createNote: operationOf(COMMANDS.createNote, createNoteOperation),
  renameNote: operationOf(COMMANDS.renameNote, renameNoteOperation),
  setPinned: operationOf(COMMANDS.setPinned, setPinnedOperation),
  archiveNote: operationOf(COMMANDS.archiveNote, archiveNoteOperation),
  unarchiveNote: operationOf(COMMANDS.unarchiveNote, unarchiveNoteOperation),
  trashNote: operationOf(COMMANDS.trashNote, trashNoteOperation),
  restoreNote: operationOf(COMMANDS.restoreNote, restoreNoteOperation),
  saveNoteContent: operationOf(COMMANDS.saveNoteContent, saveNoteContentOperation),
  deleteBlocks: operationOf(COMMANDS.deleteBlocks, deleteBlocksOperation),
  applyDerivedTitle: operationOf(COMMANDS.applyDerivedTitle, applyDerivedTitleOperation),
  attachInsights: operationOf(COMMANDS.attachInsights, attachInsightsOperation),
  ensureDailyNote: operationOf(COMMANDS.ensureDailyNote, ensureDailyNoteOperation),
  runBulkAction: operationOf(COMMANDS.runBulkAction, runBulkActionOperation),
  moveNoteToFolder: operationOf(COMMANDS.moveNoteToFolder, moveNoteToFolderOperation),
  convertNoteToTemplate: operationOf(COMMANDS.convertNoteToTemplate, convertNoteToTemplateOperation),
  convertTemplateToNote: operationOf(COMMANDS.convertTemplateToNote, convertTemplateToNoteOperation),
  deleteNotePermanently: operationOf(COMMANDS.deleteNotePermanently, deleteNotePermanentlyOperation),
  emptyTrash: operationOf(COMMANDS.emptyTrash, emptyTrashOperation),
  runTrashCleanup: operationOf(COMMANDS.runTrashCleanup, runTrashCleanupOperation),
  createFolder: operationOf(COMMANDS.createFolder, createFolderOperation),
  moveFolder: operationOf(COMMANDS.moveFolder, moveFolderOperation),
  renameFolder: operationOf(COMMANDS.renameFolder, renameFolderOperation),
  setFolderCollapsed: operationOf(COMMANDS.setFolderCollapsed, setFolderCollapsedOperation),
  deleteFolder: operationOf(COMMANDS.deleteFolder, deleteFolderOperation),
  setPreferences: operationOf(COMMANDS.setPreferences, setPreferencesOperation),
  setInsightsPending: operationOf(COMMANDS.setInsightsPending, setInsightsPendingOperation),
  recordJobRun: operationOf(COMMANDS.recordJobRun, recordJobRunOperation),
  saveSnapshot: operationOf(COMMANDS.saveSnapshot, saveSnapshotOperation),
  restoreSnapshot: operationOf(COMMANDS.restoreSnapshot, restoreSnapshotOperation),
  insertBlocks: operationOf(COMMANDS.insertBlocks, insertBlocksOperation),
  applyCloseDraft: operationOf(COMMANDS.applyCloseDraft, applyCloseDraftOperation),
  saveChatHistory: operationOf(COMMANDS.saveChatHistory, saveChatHistoryOperation),
  savePromptTemplates: operationOf(COMMANDS.savePromptTemplates, savePromptTemplatesOperation),
  saveTheme: operationOf(COMMANDS.saveTheme, saveThemeOperation),
  completeOnboarding: operationOf(COMMANDS.completeOnboarding, completeOnboardingOperation),
  turnOffBackgroundJobs: operationOf(COMMANDS.turnOffBackgroundJobs, turnOffBackgroundJobsOperation),
  recordBackup: operationOf(COMMANDS.recordBackup, recordBackupOperation),
  recordExportNotice: operationOf(COMMANDS.recordExportNotice, recordExportNoticeOperation),
  snoozeSpaceNotice: operationOf(COMMANDS.snoozeSpaceNotice, snoozeSpaceNoticeOperation),
  createAutoBackup: operationOf(COMMANDS.createAutoBackup, createAutoBackupOperation),
  importBackup: operationOf(COMMANDS.importBackup, importBackupOperation),
  updateSearchIndex: operationOf(COMMANDS.updateSearchIndex, updateSearchIndexOperation),
  saveVector: operationOf(COMMANDS.saveVector, saveVectorOperation),
  applyRemoteChanges: operationOf(COMMANDS.applyRemoteChanges, applyRemoteChangesOperation),
  applyRemoteContent: operationOf(COMMANDS.applyRemoteContent, applyRemoteContentOperation),
  applyRemotePlacement: operationOf(COMMANDS.applyRemotePlacement, applyRemotePlacementOperation),
});
