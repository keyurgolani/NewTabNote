/**
 * The repository port: what a kernel adapter offers the use cases. Stores go by domain
 * names here, and each adapter maps them to its own (the legacy adapter's `notes` is
 * IndexedDB's `canvases`).
 *
 * A command's writes come as units. A unit names its stores, reads committed state, checks
 * its invariants, and writes only the fields its intent touches, in one transaction with
 * nothing else awaited in between. An adapter with `atomicMultiStore` commits all of a
 * command's units together or none of them. One without commits each unit as it finishes,
 * so a later unit's failure leaves the earlier units' writes in place. A unit over several
 * stores is atomic on every adapter, which is why saveNoteContent's note fields and blocks
 * are one unit.
 */

/** @typedef {import('../domain/note.js').NoteRecord} NoteRecord */
/** @typedef {import('../domain/note.js').BlockRecord} BlockRecord */
/** @typedef {import('../domain/note.js').SearchEntry} SearchEntry */
/** @typedef {import('../domain/folder.js').FolderRecord} FolderRecord */
/** @typedef {import('../contracts/commands.js').Command} Command */
/** @typedef {import('../contracts/outcomes.js').Outcome} Outcome */
/** @typedef {import('../contracts/outcomes.js').Committed} Committed */
/** @typedef {import('../contracts/outcomes.js').Rejected} Rejected */
/** @typedef {import('../contracts/outcomes.js').Conflict} Conflict */

/** Each store and the field that keys its records */
export const STORES = Object.freeze({
  notes: Object.freeze({ keyPath: 'id' }),
  blocks: Object.freeze({ keyPath: 'id' }),
  folders: Object.freeze({ keyPath: 'id' }),
  searchIndex: Object.freeze({ keyPath: 'noteId' }),
  media: Object.freeze({ keyPath: 'id' }),
  vectors: Object.freeze({ keyPath: 'id' }),
  snapshots: Object.freeze({ keyPath: 'id' }),
  links: Object.freeze({ keyPath: 'id' }),
});

/** @typedef {keyof typeof STORES} StoreName */

/**
 * @typedef {object} StoreRecords
 * @property {NoteRecord} notes
 * @property {BlockRecord} blocks
 * @property {FolderRecord} folders
 * @property {SearchEntry} searchIndex
 * @property {{id: string, canvasId?: unknown} & Record<string, unknown>} media
 * @property {{id: string} & Record<string, unknown>} vectors
 * @property {{id: string, noteId?: unknown} & Record<string, unknown>} snapshots
 * @property {import('../domain/note.js').LinkRecord} links
 */

/**
 * Reads in a transaction. Records come back as copies, in key order.
 * @typedef {object} ReadTx
 * @property {<S extends StoreName>(store: S, key: string) => Promise<StoreRecords[S] | undefined>} get
 * @property {<S extends StoreName>(store: S) => Promise<StoreRecords[S][]>} getAll
 * @property {<S extends StoreName>(store: S, index: string, value: string) => Promise<StoreRecords[S][]>} getAllByIndex
 *   The records whose `index` field (each index is named after its field) holds `value`, an
 *   id. Every adapter refuses any other value, `adapter` `invalid-key`, since IndexedDB reads
 *   null and undefined as no range, which would return every record.
 * @property {(store: StoreName, index: string, value: string) => Promise<string[]>} getKeysByIndex
 *   The keys of those records, with the same refusal
 * @property {(store: StoreName, key: string) => number | undefined} revision
 *   The record's committed content revision, or undefined from an adapter without revisions.
 *   Ask only after a `get` of the same key in the same transaction: an adapter that keeps the
 *   revision in the record (#17) answers from the record that get read.
 */

/**
 * A unit's transaction. Writes take effect when the unit commits, and a write that fails
 * fails the command.
 * @typedef {object} WriteTx
 * @property {<S extends StoreName>(store: S, record: StoreRecords[S]) => void} put
 * @property {(store: StoreName, key: string) => void} delete
 */

/** @typedef {ReadTx & WriteTx} Tx */

/**
 * A unit can run more than once. An adapter whose transaction failed before anything in it
 * committed may run the command's units again, from the first, in a new transaction (#17's
 * IndexedDB adapter does once, for an abort or an UnknownError). So a run decides only from
 * what it reads in its own transaction, and sets every value it decides, `when` and the
 * work's `done`, `primary`, and `revised` included, for the run that commits.
 * @typedef {object} Unit
 * @property {StoreName[]} stores
 * @property {'readonly' | 'readwrite'} [mode] - readwrite unless the unit only reads
 * @property {() => boolean} [when] - checked when the unit's turn comes; false skips it
 * @property {(tx: Tx) => Promise<Rejected | Conflict | void>} run
 *   Returning an outcome stops the command: nothing this unit wrote commits, and on an
 *   adapter with atomicMultiStore nothing the earlier units wrote either
 */

/** @typedef {'preferences' | 'session'} SettingsArea */

/**
 * A settings area a query may read: one a command writes, or `idbSettings`, the settings 1.4.x
 * kept in IndexedDB's `settings` store. Storage.setSetting never writes there, and only Popup's
 * summary reads it, until #4 rebuilds Popup. The store also holds 1.4.x's provider keys, so an
 * adapter serves only IDB_SETTINGS_KEYS from it.
 * @typedef {SettingsArea | 'idbSettings'} ReadableSettingsArea
 */

/** The keys an adapter serves from `idbSettings` */
export const IDB_SETTINGS_KEYS = Object.freeze(['insightsEnabled']);

/**
 * What a command changes: units over the stores, keys in a settings area, or startup
 * maintenance.
 * @typedef {{kind: 'units', units: Unit[]}
 *   | {kind: 'settings', area: SettingsArea, values: Record<string, unknown>}
 *   | {kind: 'maintenance'}} Effect
 */

/**
 * What a command writes, in the three scopes #17 keeps apart so filing never conflicts with
 * typing:
 * - `content`: a note's title and blocks, and what's made with them (the default)
 * - `placement`: where a record sits and how it's kept: pinned, filed, a template or a Daily
 *   Note, archived, trashed
 * - `derived`: what jobs and the editor derive from content: preview, todoProgress, insights
 * Only content moves a record's content revision, on an adapter with revisions. A derived
 * command's units are held to the derived fields of notes they read (application/scopes.js),
 * so it can't change a note's name, placement, or lifecycle.
 * @typedef {'content' | 'placement' | 'derived'} WriteScope
 */

/**
 * A command, ready for an adapter to commit.
 * @typedef {object} Work
 * @property {string} commandId
 * @property {Command} command
 *   What an adapter with idempotency compares a resent commandId against, and what one with
 *   revisions keeps when the command conflicts
 * @property {WriteScope} [scope] - content when left out
 * @property {Effect} effect
 * @property {() => {store: StoreName, key: string} | undefined} [primary]
 *   The record whose revision the committed outcome reports (#13's `committedRevision`),
 *   once the units have run
 * @property {() => boolean} [revised]
 *   Whether the command changed the primary record's content (a note's title or blocks),
 *   asked once the units have run. An adapter with revisions then moves the record's revision
 *   on by one, for a content command only. Placement and derived writes (pin, archive, trash,
 *   restore, a folder move, insights) leave it where it was, so they never turn a save into a
 *   conflict.
 * @property {() => Committed} done - the outcome once everything committed
 */

/**
 * What commit answers. `replayed` is true when the commandId already had this outcome, from a
 * send of the same command that committed first, so the kernel doesn't publish it again.
 * @typedef {{outcome: Outcome, replayed: boolean}} CommitResult
 */

/**
 * What an adapter guarantees. The contract suite expects the documented difference for
 * each flag, and each one the legacy adapter lacks is a `declared-gap` row in the ledger.
 * @typedef {object} AdapterFlags
 * @property {boolean} atomicMultiStore - a command's units commit together or not at all
 * @property {boolean} revisions
 *   Notes have content revisions: committed outcomes report them, only title and block
 *   changes move them, and a stale `expectedRevision` is a conflict
 * @property {boolean} idempotency
 *   A commandId sent again with the same command gets its committed or conflict outcome
 *   again, and nothing runs. Sent with another command it's rejected as
 *   `idempotency-key-reuse`. A rejection or an `unavailable` outcome leaves no record, so the
 *   same command sent again runs again. A bulk command keeps only its fingerprint, from its
 *   first recall: the same commandId with another selection is key reuse, even when both are
 *   sent at once, and a resend runs again, so each item that committed or conflicted answers
 *   from its own record and each other item runs again.
 */

/**
 * @typedef {object} KernelAdapter
 * @property {string} name
 * @property {Readonly<AdapterFlags>} flags
 * @property {(command: Command) => Outcome | undefined} recall
 *   What the command's commandId already answered, when it has a record (see `idempotency`),
 *   or undefined. A bulk command with no record gets one here, its fingerprint, before any of
 *   its items runs. The kernel refuses a bulk command for its action or its notes before it
 *   asks, so a refused one gets none. Synchronous, so a save can still open its transaction
 *   in the calling task.
 * @property {(work: Work) => Promise<CommitResult>} commit
 *   Opens the first transaction before it returns. It never rejects: a failure is an
 *   `unavailable` outcome.
 * @property {<T>(stores: StoreName[], body: (tx: ReadTx) => Promise<T>) => Promise<T>} read
 *   Rejects with an UnavailableError when storage fails
 * @property {(area: ReadableSettingsArea, keys: readonly string[]) => Promise<Record<string, unknown>>} readSettings
 *   The keys that have a stored value. A key outside IDB_SETTINGS_KEYS from `idbSettings` rejects
 *   with an UnavailableError, code `setting-not-served`.
 */
