/**
 * The command catalog (#12, "Commands"). A command says what the user or a job meant,
 * never "put this whole record". Each carries a `commandId`, and every other id it needs (the
 * note to create, the block a capture adds) is chosen when the intent happens, so a retry
 * names the same things. Payloads are structured-clone safe.
 *
 * Slice 3 holds the commands the kernel core needs to prove itself, and later slices add
 * theirs as they route callers to the kernel. #13 (message contracts) adds versions and
 * validators to this file.
 */

/** @typedef {import('../domain/note.js').BlockInput} BlockInput */
/** @typedef {import('../domain/note.js').Capture} Capture */
/** @typedef {import('../domain/session.js').WorkspaceSession} WorkspaceSession */

/**
 * A note with the fields Storage.createNote has always written, plus its search entry.
 * `folderId` files it, and `blocks` are its first blocks.
 * @typedef {{type: 'createNote', commandId: string, noteId: string, name?: string, folderId?: string | null, blocks?: BlockInput[]}} CreateNote
 */

/**
 * A new title, which the search entry gets too. `typed` (the default) is a title the user
 * typed, which marks it as set by hand when it differs; `generated` is one the user asked the
 * AI for, which records `lastAutoTitleAt` instead.
 * @typedef {{type: 'renameNote', commandId: string, noteId: string, name: string, origin?: 'typed' | 'generated'}} RenameNote
 */

/** @typedef {{type: 'setPinned', commandId: string, noteId: string, pinned: boolean}} SetPinned */
/** @typedef {{type: 'archiveNote', commandId: string, noteId: string}} ArchiveNote */
/** @typedef {{type: 'unarchiveNote', commandId: string, noteId: string}} UnarchiveNote */

/**
 * Moves the note to trash, out of the archive. An untitled note with no content is deleted
 * instead, blocks, media, vectors, and snapshots included, as Storage.trashNote does.
 * @typedef {{type: 'trashNote', commandId: string, noteId: string}} TrashNote
 */

/** @typedef {{type: 'restoreNote', commandId: string, noteId: string}} RestoreNote */

/**
 * An editor save: the blocks as they were when the save started, and what the editor
 * derived from them. It writes those, `updatedAt`, and no other note field, and it puts the
 * blocks without deleting any (deleting blocks is its own command). Note fields and blocks
 * commit together on every adapter. `expectedRevision`, from an adapter with revisions, makes
 * a save over a newer write a conflict.
 * @typedef {{type: 'saveNoteContent', commandId: string, noteId: string, blocks: BlockInput[], preview?: string, todoProgress?: unknown, expectedRevision?: number}} SaveNoteContent
 */

/**
 * A title a background job derived. Dropped when the note's title was set by hand.
 * @typedef {{type: 'applyDerivedTitle', commandId: string, noteId: string, name: string, contentHash?: string}} ApplyDerivedTitle
 */

/**
 * Insights a job extracted. Writes `insights`, `lastInsightsExtractedAt`, and the content
 * hash, and nothing else, `updatedAt` included.
 * @typedef {{type: 'attachInsights', commandId: string, noteId: string, insights: unknown, contentHash?: string}} AttachInsights
 */

/**
 * A capture into today's Daily Note. `noteId` is the id the Daily Note gets if this
 * capture creates it, and `blockId` the captured block's.
 * @typedef {{type: 'captureToDailyNote', commandId: string, noteId: string, blockId: string, capture: Capture}} CaptureToDailyNote
 */

/** @typedef {'archive' | 'unarchive' | 'trash' | 'restore'} BulkAction */

/**
 * One note command per id, in order. It returns an outcome per note.
 * @typedef {{type: 'runBulkAction', commandId: string, action: BulkAction, noteIds: string[]}} RunBulkAction
 */

/** @typedef {{type: 'createFolder', commandId: string, folderId: string, name: string, parentId: string | null}} CreateFolder */

/**
 * A new parent, null for the root. Moving a folder into itself or a folder inside it is
 * rejected, against the folders as committed.
 * @typedef {{type: 'moveFolder', commandId: string, folderId: string, parentId: string | null}} MoveFolder
 */

/** @typedef {{type: 'setPreferences', commandId: string, values: Record<string, unknown>}} SetPreferences */
/** @typedef {{type: 'saveWorkspaceSession', commandId: string, session: Partial<WorkspaceSession>}} SaveWorkspaceSession */

/**
 * Default settings and the read-only integrity check, which the new-tab page and the
 * service worker run as they start.
 * @typedef {{type: 'runStartupMaintenance', commandId: string}} RunStartupMaintenance
 */

/**
 * @typedef {CreateNote | RenameNote | SetPinned | ArchiveNote | UnarchiveNote | TrashNote | RestoreNote
 *   | SaveNoteContent | ApplyDerivedTitle | AttachInsights | CaptureToDailyNote | RunBulkAction
 *   | CreateFolder | MoveFolder | SetPreferences | SaveWorkspaceSession | RunStartupMaintenance} Command
 */

/** @typedef {Command['type']} CommandType */

/**
 * @template {CommandType} T
 * @typedef {Extract<Command, {type: T}>} CommandOf
 */

/** @typedef {'note' | 'folder' | 'preferences' | 'session' | 'system'} Aggregate */

/**
 * Each command's aggregate, which names it in the commit feed. A bulk command returns an
 * outcome per item.
 * @type {Readonly<Record<CommandType, Readonly<{aggregate: Aggregate, bulk?: true}>>>}
 */
export const COMMANDS = Object.freeze({
  createNote: Object.freeze({ aggregate: 'note' }),
  renameNote: Object.freeze({ aggregate: 'note' }),
  setPinned: Object.freeze({ aggregate: 'note' }),
  archiveNote: Object.freeze({ aggregate: 'note' }),
  unarchiveNote: Object.freeze({ aggregate: 'note' }),
  trashNote: Object.freeze({ aggregate: 'note' }),
  restoreNote: Object.freeze({ aggregate: 'note' }),
  saveNoteContent: Object.freeze({ aggregate: 'note' }),
  applyDerivedTitle: Object.freeze({ aggregate: 'note' }),
  attachInsights: Object.freeze({ aggregate: 'note' }),
  captureToDailyNote: Object.freeze({ aggregate: 'note' }),
  runBulkAction: Object.freeze({ aggregate: 'note', bulk: true }),
  createFolder: Object.freeze({ aggregate: 'folder' }),
  moveFolder: Object.freeze({ aggregate: 'folder' }),
  setPreferences: Object.freeze({ aggregate: 'preferences' }),
  saveWorkspaceSession: Object.freeze({ aggregate: 'session' }),
  runStartupMaintenance: Object.freeze({ aggregate: 'system' }),
});

/** @type {readonly CommandType[]} */
export const COMMAND_TYPES = Object.freeze(/** @type {CommandType[]} */ (Object.keys(COMMANDS)));

/** @type {Readonly<Record<BulkAction, 'archiveNote' | 'unarchiveNote' | 'trashNote' | 'restoreNote'>>} */
export const BULK_ACTIONS = Object.freeze({
  archive: 'archiveNote',
  unarchive: 'unarchiveNote',
  trash: 'trashNote',
  restore: 'restoreNote',
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
