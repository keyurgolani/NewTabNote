// AC1 of #17 ("every writer checks and bumps revisions"), command by command (#17 PR 4b): what
// each catalog command writes of a note or its blocks, the write scope it writes in
// (ports/repository.js, WriteScope), and the version that guards it, or why none does.
//
// No page caller sends a version yet (the lead, for 4b): the Merge item holds for every caller
// that sends one, and none does until #6's conflict view can show what a conflict kept. Until
// then two tabs' saves last-write-win, as in 1.4.x, while the scopes still keep a save from
// undoing a pin, a move, or a template. So each guarded command names the page methods that
// send it without its version, each for NO_CONFLICT_SURFACE.
//
// write-guards.test.mjs holds the table to the catalog, the schemas, the code, and the page's
// callers, and the kernel contract suite (contract.mjs) sends each guarded command twice from
// one version on every adapter with revisions.

/** Why a page caller sends a guarded command without its version (the lead, #17 PR 4b) */
export const NO_CONFLICT_SURFACE = 'no conflict surface until #6';

/** The fields a version travels in, whichever scope it guards */
export const VERSION_FIELDS = Object.freeze(['expectedRevision', 'expectedPlacementVersion', 'sourceRevision']);

/** The field that carries each scope's version (ports/repository.js, WriteScope) */
export const SCOPE_GUARDS = Object.freeze({
  content: 'expectedRevision',
  placement: 'expectedPlacementVersion',
  derived: 'sourceRevision',
});

/** @typedef {import('../../js/kernel/core/ports/repository.js').WriteScope} WriteScope */
/** @typedef {import('../../js/kernel/core/contracts/commands.js').CommandType} CommandType */

/**
 * - guarded: it writes a note or its blocks in `scope`, and a stale version at `guard`, the
 *   field's path in its payload, is a conflict, or for a derived write, dropped. `callers` are
 *   the page's methods that send it, `Class.method`, none with its version. `also` names any
 *   other version field it takes, each with when it checks it.
 * - unguarded: it writes a note or its blocks in one of `scopes` with no version to expect,
 *   for `why`.
 * - bulk: it writes nothing itself, and runs `items` for each note.
 * - none: it writes no note and no block, but `writes`.
 * @typedef {{kind: 'guarded', scope: WriteScope, guard: string, callers: readonly string[], also: Readonly<Record<string, string>>}
 *   | {kind: 'unguarded', scopes: readonly WriteScope[], why: string}
 *   | {kind: 'bulk', items: readonly CommandType[], why: string}
 *   | {kind: 'none', writes: string}} WriteGuard
 */

/**
 * @param {WriteScope} scope
 * @param {string} guard
 * @param {string[]} [callers]
 * @param {Record<string, string>} [also]
 * @returns {WriteGuard}
 */
const guarded = (scope, guard, callers = [], also = {}) =>
  Object.freeze({
    kind: 'guarded',
    scope,
    guard,
    callers: Object.freeze([...callers].sort()),
    also: Object.freeze({ ...also }),
  });

/**
 * @param {WriteScope | WriteScope[]} scope - one, or each its modes commit in
 * @param {string} why
 * @returns {WriteGuard}
 */
const unguarded = (scope, why) =>
  Object.freeze({ kind: 'unguarded', scopes: Object.freeze(Array.isArray(scope) ? scope : [scope]), why });

/**
 * @param {CommandType[]} items
 * @param {string} why
 * @returns {WriteGuard}
 */
const bulkOf = (items, why) => Object.freeze({ kind: 'bulk', items: Object.freeze(items), why });

/**
 * @param {string} writes
 * @returns {WriteGuard}
 */
const none = writes => Object.freeze({ kind: 'none', writes });

/** @type {Readonly<Record<CommandType, WriteGuard>>} */
export const WRITE_GUARDS = Object.freeze({
  // Content: a note's title and blocks
  renameNote: guarded('content', 'expectedRevision', [
    'NotesManager.generateTitleForNote',
    'AIChatController.applyGeneratedTitle',
  ]),
  saveNoteContent: guarded('content', 'expectedRevision', ['BlockEditor._writeSaveState']),
  deleteBlocks: guarded('content', 'expectedRevision', ['BlockEditor._deleteStoredBlocks']),
  insertBlocks: guarded('content', 'expectedRevision', [
    'AIChatController.insertBlocksInto',
    'AIChatController.appendAIResponseToNote',
    'SidebarController._appendBlockToNote',
  ]),
  applyDerivedTitle: guarded('content', 'expectedRevision', [
    'BlockEditor.checkFirstContentAutoTitle',
    'NotesManager.runAutoTitle',
    'AIChatController.generateTitleForNewNote',
  ]),
  // applyRemoteChanges sends it with the revision each change was made from, or null for none,
  // which counts as 0
  applyRemoteContent: guarded('content', 'expectedRevision'),

  // Placement: where a note sits and how it's kept
  setPinned: guarded('placement', 'expectedPlacementVersion', ['SidebarController.toggleNotePin']),
  archiveNote: guarded('placement', 'expectedPlacementVersion', ['NotesManager.archiveNote']),
  unarchiveNote: guarded('placement', 'expectedPlacementVersion', ['NotesManager.unarchiveNote']),
  trashNote: guarded('placement', 'expectedPlacementVersion', [
    'NotesManager.trashNoteById',
    'SettingsController.deleteCurrentNote',
  ]),
  restoreNote: guarded('placement', 'expectedPlacementVersion', ['NotesManager.restoreNoteById']),
  moveNoteToFolder: guarded('placement', 'expectedPlacementVersion', ['SidebarController.moveNoteToFolder']),
  convertNoteToTemplate: guarded('placement', 'expectedPlacementVersion', ['NotesManager.convertNoteToTemplate']),
  convertTemplateToNote: guarded('placement', 'expectedPlacementVersion', ['NotesManager.convertTemplateToNote']),
  deleteNotePermanently: guarded('placement', 'expectedPlacementVersion', ['NotesManager.permanentlyDeleteNoteById']),
  applyRemotePlacement: guarded('placement', 'expectedPlacementVersion', [], {
    expectedRevision: 'a trash, which needs the text the change was made from, since trash leads to deletion (R131)',
  }),

  // Derived: what jobs make from a note's content, dropped when made from an older revision
  attachInsights: guarded('derived', 'sourceRevision', [
    'BlockEditor.refreshInsights',
    'NotesManager.extractInsightsForNote',
    'NotesManager.runInsightsExtraction',
    'AIChatController.extractInsightsFromChat',
  ]),
  // #22's indexer and embeddings, through the facade's setSearchIndex, setSearchIndexEntry,
  // removeSearchIndexEntry, and saveVector (storage-facade.js), which know no revision until
  // #22's pipeline makes them from one
  updateSearchIndex: guarded('derived', 'entries.[].sourceRevision', ['NotesManager.initIndexer']),
  saveVector: guarded('derived', 'sourceRevision', ['NotesManager.updateMissingEmbeddings']),

  // Writes to notes no version guards, each with why
  createNote: unguarded(
    'content',
    "makes a note that isn't stored, and one sent with a stored note's id is note-exists",
  ),
  captureToDailyNote: unguarded(
    'content',
    "adds a block under its own new id to today's Daily Note, which it finds or makes in the same transaction",
  ),
  ensureDailyNote: unguarded(
    'content',
    'finds the Daily Note or makes it whole, and changes a note it finds only by giving it its date key',
  ),
  restoreSnapshot: unguarded(
    'content',
    "the user's revert, which first keeps the note as it is as a snapshot, so what it writes over stays in its history",
  ),
  emptyTrash: unguarded('placement', 'deletes what the trash holds as committed, so a note restored meanwhile stays'),
  runTrashCleanup: unguarded('placement', 'deletes what has been in the trash past its days as committed'),
  deleteFolder: unguarded(
    'placement',
    "files the folder's notes at the root, moving each one's placement version, and a note filed meanwhile goes too",
  ),
  importBackup: unguarded(
    ['content', 'placement'],
    'Merge adds notes under new ids, and Replace all, in placement, also trashes the active ones, as 1.4.x did',
  ),
  runBulkAction: bulkOf(
    ['archiveNote', 'unarchiveNote', 'trashNote', 'restoreNote', 'deleteNotePermanently'],
    'one placement command per note, each sent without a version, from SidebarController.performBulkAction',
  ),
  applyRemoteChanges: bulkOf(
    ['applyRemoteContent', 'applyRemotePlacement'],
    'both parts of each note, each with the version the change was made from, or 0, and a trash with the text revision too',
  ),

  // Writes no note and no block
  createFolder: none('a folder, which carries no versions (#17 PR 2a)'),
  renameFolder: none('a folder'),
  moveFolder: none('a folder'),
  setFolderCollapsed: none('a folder'),
  setPreferences: none('settings'),
  saveWorkspaceSession: none('settings'),
  runStartupMaintenance: none('settings'),
  runIntegrityCheck: none('nothing: it reads the stores and reports what it finds'),
  setInsightsPending: none("the insights job's bookkeeping"),
  recordJobRun: none("the jobs' bookkeeping"),
  saveSnapshot: none("a note's version history"),
  saveChatHistory: none("AI chat's history"),
  savePromptTemplates: none("AI chat's prompt templates"),
  saveTheme: none('a custom theme'),
  completeOnboarding: none('settings'),
  recordBackup: none("the backups' bookkeeping"),
  recordExportNotice: none("the export notice's outcome"),
  snoozeSpaceNotice: none("the space notice's snooze"),
  createAutoBackup: none('an automatic backup, beside the settings'),
});
