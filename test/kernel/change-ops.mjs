// #17 PR 4c, command by command: the ops each catalog command's change rows may hold (the lead's
// Q4: content-free ops; contracts/entities.js, changeOp), and none at all for a command that
// changes no note or folder. change-ops.test.mjs holds every catalog sample's rows to it, on the
// in-memory adapter and #17's.

/** @typedef {import('../../js/kernel/core/contracts/commands.js').CommandType} CommandType */
/** @typedef {import('../../js/kernel/core/contracts/entities.js').ChangeOp['op']} OpName */

/** The block ops a command that writes a note's blocks as it has them may take */
const BLOCK_DIFF = /** @type {const} */ (['insertBlock', 'updateBlock', 'moveBlock', 'deleteBlock']);

/** @type {Readonly<Record<CommandType, readonly OpName[]>>} */
export const CHANGE_OPS = Object.freeze({
  // A note's content
  createNote: ['createNote', 'insertBlock'],
  renameNote: ['updateNote'],
  saveNoteContent: ['updateNote', 'insertBlock', 'updateBlock', 'moveBlock'],
  deleteBlocks: ['deleteBlock'],
  insertBlocks: ['updateNote', 'insertBlock', 'moveBlock'],
  applyDerivedTitle: ['updateNote'],
  captureToDailyNote: ['createNote', 'insertBlock'],
  ensureDailyNote: ['createNote', 'updateNote', 'insertBlock'],
  restoreSnapshot: ['updateNote', ...BLOCK_DIFF],
  applyRemoteContent: ['createNote', 'updateNote', ...BLOCK_DIFF],
  // What the jobs make from it
  attachInsights: ['updateNote'],
  // Where it sits and how it's kept, and an empty untitled note trash deletes for good
  setPinned: ['updateNote'],
  archiveNote: ['updateNote'],
  unarchiveNote: ['updateNote'],
  trashNote: ['updateNote', 'deleteNote'],
  restoreNote: ['updateNote'],
  moveNoteToFolder: ['updateNote'],
  convertNoteToTemplate: ['updateNote'],
  convertTemplateToNote: ['updateNote'],
  applyRemotePlacement: ['updateNote'],
  deleteNotePermanently: ['deleteNote'],
  emptyTrash: ['deleteNote'],
  runTrashCleanup: ['deleteNote'],
  // Merge's notes and folders, and the active notes Replace all trashes
  importBackup: ['createNote', 'insertBlock', 'updateNote', 'createFolder'],
  // Folders, and the notes deleteFolder files at the root
  createFolder: ['createFolder'],
  renameFolder: ['updateFolder'],
  moveFolder: ['updateFolder'],
  setFolderCollapsed: ['updateFolder'],
  deleteFolder: ['deleteFolder', 'updateNote'],
  // Each runs its items as commands of their own, whose rows are theirs
  runBulkAction: [],
  applyRemoteChanges: [],
  // No note and no folder: #22's index and embeddings, settings, the jobs' bookkeeping, a note's
  // version history, AI chat, themes, and the backup tasks' records, and the integrity check,
  // which writes nothing
  updateSearchIndex: [],
  saveVector: [],
  setPreferences: [],
  saveWorkspaceSession: [],
  runStartupMaintenance: [],
  runIntegrityCheck: [],
  setInsightsPending: [],
  recordJobRun: [],
  saveSnapshot: [],
  saveChatHistory: [],
  savePromptTemplates: [],
  saveTheme: [],
  completeOnboarding: [],
  recordBackup: [],
  recordExportNotice: [],
  snoozeSpaceNotice: [],
  createAutoBackup: [],
});
