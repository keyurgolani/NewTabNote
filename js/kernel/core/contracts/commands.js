/**
 * The command catalog (#12, "Commands"). A command says what the user or a job meant,
 * never "put this whole record". Each carries a `commandId`, and every other id it needs (the
 * note to create, the block a capture adds) is chosen when the intent happens, so a retry
 * names the same things. Payloads are what contracts/clone.js copies.
 *
 * Each entry declares its command once (#13, "Desired behavior"): its catalog version, the
 * module under contracts/operations/ that holds its Valibot schemas, its aggregate, which
 * names it in the commit feed, the surfaces allowed to run it, which the baseline policy
 * reads, the most its request may encode to, its deadline, until when it can be cancelled,
 * its idempotency class, whether it's journaled, the entity types its ids may name, and the
 * destinations it may reach. An entry names its schema module rather than importing it, so
 * a page that reads the catalog loads no schema, and Moment (#2) imports only the schemas it
 * validates. Each command's type comes from its schema, through JSDoc.
 *
 * Slice 3 of #12 holds the commands the kernel core needs to prove itself, and later slices
 * add theirs as they route callers to the kernel.
 */

import { COMMAND_DEADLINE_MS, MAINTENANCE_DEADLINE_MS, MAX_MESSAGE_BYTES, SMALL_MESSAGE_BYTES } from './limits.js';

/** @typedef {import('./surfaces.js').Surface} Surface */
/** @typedef {import('./fields.js').EntityType} EntityType */

/** @typedef {import('./operations/create-note.js').CreateNote} CreateNote */
/** @typedef {import('./operations/rename-note.js').RenameNote} RenameNote */
/** @typedef {import('./operations/set-pinned.js').SetPinned} SetPinned */
/** @typedef {import('./operations/archive-note.js').ArchiveNote} ArchiveNote */
/** @typedef {import('./operations/unarchive-note.js').UnarchiveNote} UnarchiveNote */
/** @typedef {import('./operations/trash-note.js').TrashNote} TrashNote */
/** @typedef {import('./operations/restore-note.js').RestoreNote} RestoreNote */
/** @typedef {import('./operations/save-note-content.js').SaveNoteContent} SaveNoteContent */
/** @typedef {import('./operations/delete-blocks.js').DeleteBlocks} DeleteBlocks */
/** @typedef {import('./operations/apply-derived-title.js').ApplyDerivedTitle} ApplyDerivedTitle */
/** @typedef {import('./operations/attach-insights.js').AttachInsights} AttachInsights */
/** @typedef {import('./operations/capture-to-daily-note.js').CaptureToDailyNote} CaptureToDailyNote */
/** @typedef {import('./operations/ensure-daily-note.js').EnsureDailyNote} EnsureDailyNote */
/** @typedef {import('./operations/run-bulk-action.js').RunBulkAction} RunBulkAction */
/** @typedef {import('./operations/create-folder.js').CreateFolder} CreateFolder */
/** @typedef {import('./operations/move-folder.js').MoveFolder} MoveFolder */
/** @typedef {import('./operations/rename-folder.js').RenameFolder} RenameFolder */
/** @typedef {import('./operations/set-folder-collapsed.js').SetFolderCollapsed} SetFolderCollapsed */
/** @typedef {import('./operations/delete-folder.js').DeleteFolder} DeleteFolder */
/** @typedef {import('./operations/move-note-to-folder.js').MoveNoteToFolder} MoveNoteToFolder */
/** @typedef {import('./operations/convert-note-to-template.js').ConvertNoteToTemplate} ConvertNoteToTemplate */
/** @typedef {import('./operations/convert-template-to-note.js').ConvertTemplateToNote} ConvertTemplateToNote */
/** @typedef {import('./operations/delete-note-permanently.js').DeleteNotePermanently} DeleteNotePermanently */
/** @typedef {import('./operations/empty-trash.js').EmptyTrash} EmptyTrash */
/** @typedef {import('./operations/run-trash-cleanup.js').RunTrashCleanup} RunTrashCleanup */
/** @typedef {import('./operations/set-preferences.js').SetPreferences} SetPreferences */
/** @typedef {import('./operations/save-workspace-session.js').SaveWorkspaceSession} SaveWorkspaceSession */
/** @typedef {import('./operations/run-startup-maintenance.js').RunStartupMaintenance} RunStartupMaintenance */
/** @typedef {import('./operations/set-insights-pending.js').SetInsightsPending} SetInsightsPending */
/** @typedef {import('./operations/record-job-run.js').RecordJobRun} RecordJobRun */
/** @typedef {import('./operations/save-snapshot.js').SaveSnapshot} SaveSnapshot */
/** @typedef {import('./operations/restore-snapshot.js').RestoreSnapshot} RestoreSnapshot */
/** @typedef {import('./operations/insert-blocks.js').InsertBlocks} InsertBlocks */

/** @typedef {RunBulkAction['action']} BulkAction */

/**
 * @typedef {CreateNote | RenameNote | SetPinned | ArchiveNote | UnarchiveNote | TrashNote | RestoreNote
 *   | SaveNoteContent | DeleteBlocks | ApplyDerivedTitle | AttachInsights | CaptureToDailyNote | EnsureDailyNote
 *   | RunBulkAction | CreateFolder | MoveFolder | RenameFolder | SetFolderCollapsed | DeleteFolder | MoveNoteToFolder
 *   | ConvertNoteToTemplate | ConvertTemplateToNote | DeleteNotePermanently | EmptyTrash | RunTrashCleanup
 *   | SetPreferences | SaveWorkspaceSession | RunStartupMaintenance | SetInsightsPending | RecordJobRun
 *   | SaveSnapshot | RestoreSnapshot | InsertBlocks} Command
 */

/** @typedef {Command['type']} CommandType */

/**
 * @template {CommandType} T
 * @typedef {Extract<Command, {type: T}>} CommandOf
 */

/**
 * What the commit feed names a commit by. `job` is the jobs' own bookkeeping, and `snapshot` a
 * note's version history, neither of which changes a note, so a note list ignores both.
 * @typedef {'note' | 'folder' | 'preferences' | 'session' | 'job' | 'snapshot' | 'system'} Aggregate
 */

/**
 * A command's catalog entry. `maxBytes` caps its encoded request, envelope included, and a
 * journaled command declares exactly MAX_MESSAGE_BYTES. `deadlineMs` runs from when the
 * request is sent. A command can be cancelled only until the coordinator opens its
 * transaction, and its `commandId` is its idempotency key. `destinations` stays empty until
 * #21 (security boundaries) adds destination ids. A bulk command returns an outcome per item.
 * @typedef {Readonly<{
 *   kind: 'command',
 *   version: number,
 *   schema: string,
 *   aggregate: Aggregate,
 *   surfaces: readonly Surface[],
 *   maxBytes: number,
 *   deadlineMs: number,
 *   cancellable: 'before-transaction',
 *   idempotency: 'keyed',
 *   journaled: boolean,
 *   entityTypes: readonly EntityType[],
 *   destinations: readonly string[],
 *   bulk?: true,
 * }>} CommandEntry
 */

/**
 * A version 1 entry. #35 (background coordinator) sets `journaled` on its content saves, note
 * creation, appends, and captures. A command moved to a new version keeps a step from the
 * last one in contracts/upcast.js, so a journal entry written before the move still replays.
 * @param {string} module - the schema module's name under contracts/operations/
 * @param {Aggregate} aggregate
 * @param {Surface[]} surfaces
 * @param {{entityTypes: EntityType[], maxBytes?: number, deadlineMs?: number, bulk?: true}} options
 * @returns {CommandEntry}
 */
const entry = (module, aggregate, surfaces, { entityTypes, maxBytes = SMALL_MESSAGE_BYTES, ...options }) =>
  Object.freeze({
    kind: /** @type {const} */ ('command'),
    version: 1,
    schema: `./operations/${module}.js`,
    aggregate,
    surfaces: Object.freeze(surfaces),
    maxBytes,
    deadlineMs: COMMAND_DEADLINE_MS,
    cancellable: /** @type {const} */ ('before-transaction'),
    idempotency: /** @type {const} */ ('keyed'),
    journaled: false,
    entityTypes: Object.freeze(entityTypes),
    destinations: Object.freeze([]),
    ...options,
  });

/** What a request that carries content, or a list as long as the user makes it, may encode to */
const LARGE = MAX_MESSAGE_BYTES;

/**
 * What each surface could do before the kernel: everything from the new-tab page, a quick
 * note from Popup, nothing from Side Panel, and capture plus startup maintenance from the
 * service worker.
 * @type {Readonly<Record<CommandType, CommandEntry>>}
 */
export const COMMANDS = Object.freeze({
  createNote: entry('create-note', 'note', ['newtab', 'popup'], {
    entityTypes: ['note', 'block', 'folder'],
    maxBytes: LARGE,
  }),
  renameNote: entry('rename-note', 'note', ['newtab'], { entityTypes: ['note'], maxBytes: LARGE }),
  setPinned: entry('set-pinned', 'note', ['newtab'], { entityTypes: ['note'] }),
  archiveNote: entry('archive-note', 'note', ['newtab'], { entityTypes: ['note'] }),
  unarchiveNote: entry('unarchive-note', 'note', ['newtab'], { entityTypes: ['note'] }),
  trashNote: entry('trash-note', 'note', ['newtab'], { entityTypes: ['note'] }),
  restoreNote: entry('restore-note', 'note', ['newtab'], { entityTypes: ['note'] }),
  saveNoteContent: entry('save-note-content', 'note', ['newtab'], { entityTypes: ['note', 'block'], maxBytes: LARGE }),
  deleteBlocks: entry('delete-blocks', 'note', ['newtab'], { entityTypes: ['note', 'block'], maxBytes: LARGE }),
  applyDerivedTitle: entry('apply-derived-title', 'note', ['newtab'], { entityTypes: ['note'], maxBytes: LARGE }),
  attachInsights: entry('attach-insights', 'note', ['newtab'], { entityTypes: ['note'], maxBytes: LARGE }),
  captureToDailyNote: entry('capture-to-daily-note', 'note', ['newtab', 'worker-internal'], {
    entityTypes: ['note', 'block'],
    maxBytes: LARGE,
  }),
  // The sidebar's Daily Note button and calendar, the palette, and AI chat's Alt+D, all in the new tab
  ensureDailyNote: entry('ensure-daily-note', 'note', ['newtab'], { entityTypes: ['note'] }),
  runBulkAction: entry('run-bulk-action', 'note', ['newtab'], { entityTypes: ['note'], maxBytes: LARGE, bulk: true }),
  moveNoteToFolder: entry('move-note-to-folder', 'note', ['newtab'], { entityTypes: ['note', 'folder'] }),
  convertNoteToTemplate: entry('convert-note-to-template', 'note', ['newtab'], { entityTypes: ['note'] }),
  convertTemplateToNote: entry('convert-template-to-note', 'note', ['newtab'], { entityTypes: ['note'] }),
  deleteNotePermanently: entry('delete-note-permanently', 'note', ['newtab'], { entityTypes: ['note'] }),
  emptyTrash: entry('empty-trash', 'note', ['newtab'], { entityTypes: [] }),
  runTrashCleanup: entry('run-trash-cleanup', 'note', ['newtab'], { entityTypes: [] }),
  createFolder: entry('create-folder', 'folder', ['newtab'], { entityTypes: ['folder'], maxBytes: LARGE }),
  moveFolder: entry('move-folder', 'folder', ['newtab'], { entityTypes: ['folder'] }),
  renameFolder: entry('rename-folder', 'folder', ['newtab'], { entityTypes: ['folder'], maxBytes: LARGE }),
  setFolderCollapsed: entry('set-folder-collapsed', 'folder', ['newtab'], { entityTypes: ['folder'] }),
  // A folder commit names the folders it deleted and the notes it filed at the root
  deleteFolder: entry('delete-folder', 'folder', ['newtab'], { entityTypes: ['folder'] }),
  setPreferences: entry('set-preferences', 'preferences', ['newtab'], { entityTypes: ['note'] }),
  saveWorkspaceSession: entry('save-workspace-session', 'session', ['newtab'], {
    entityTypes: ['note'],
    maxBytes: LARGE,
  }),
  runStartupMaintenance: entry('run-startup-maintenance', 'system', ['newtab', 'worker-internal'], {
    entityTypes: [],
    deadlineMs: MAINTENANCE_DEADLINE_MS,
  }),
  // The auto-title and insights jobs run in the new tab until #35 moves them
  setInsightsPending: entry('set-insights-pending', 'job', ['newtab'], { entityTypes: ['note'] }),
  recordJobRun: entry('record-job-run', 'job', ['newtab'], { entityTypes: [] }),
  // Version history and AI chat's inserts, which only the new tab's editor and chat have run
  saveSnapshot: entry('save-snapshot', 'snapshot', ['newtab'], {
    entityTypes: ['note', 'snapshot', 'block'],
    maxBytes: LARGE,
  }),
  restoreSnapshot: entry('restore-snapshot', 'note', ['newtab'], {
    entityTypes: ['note', 'snapshot', 'block'],
    maxBytes: LARGE,
  }),
  insertBlocks: entry('insert-blocks', 'note', ['newtab'], { entityTypes: ['note', 'block'], maxBytes: LARGE }),
});

/** @type {readonly CommandType[]} */
export const COMMAND_TYPES = Object.freeze(/** @type {CommandType[]} */ (Object.keys(COMMANDS)));

/**
 * @type {Readonly<Record<BulkAction,
 *   'archiveNote' | 'unarchiveNote' | 'trashNote' | 'restoreNote' | 'deleteNotePermanently'>>}
 */
export const BULK_ACTIONS = Object.freeze({
  archive: 'archiveNote',
  unarchive: 'unarchiveNote',
  trash: 'trashNote',
  restore: 'restoreNote',
  delete: 'deleteNotePermanently',
});

/**
 * @param {unknown} type
 * @returns {type is CommandType}
 */
export function isCommandType(type) {
  return typeof type === 'string' && Object.hasOwn(COMMANDS, type);
}

/**
 * A command of `type` with a new commandId. Make it when the intent happens, with the
 * other ids it needs already in `fields`.
 * @template {CommandType} T
 * @param {{next(): string}} ids
 * @param {T} type
 * @param {Omit<CommandOf<T>, 'type' | 'commandId'>} fields
 * @returns {CommandOf<T>}
 */
export function newCommand(ids, type, fields) {
  return /** @type {CommandOf<T>} */ ({ ...fields, type, commandId: ids.next() });
}
