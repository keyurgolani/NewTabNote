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
 */

/**
 * Reads in a transaction. Records come back as copies, in key order.
 * @typedef {object} ReadTx
 * @property {<S extends StoreName>(store: S, key: string) => Promise<StoreRecords[S] | undefined>} get
 * @property {<S extends StoreName>(store: S) => Promise<StoreRecords[S][]>} getAll
 * @property {<S extends StoreName>(store: S, index: string, value: string) => Promise<StoreRecords[S][]>} getAllByIndex
 *   The records whose `index` field (each index is named after its field) holds `value`
 * @property {(store: StoreName, index: string, value: string) => Promise<string[]>} getKeysByIndex
 * @property {(store: StoreName, key: string) => number | undefined} revision
 *   The record's committed revision, or undefined from an adapter without revisions
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
 * What a command changes: units over the stores, keys in a settings area, or startup
 * maintenance.
 * @typedef {{kind: 'units', units: Unit[]}
 *   | {kind: 'settings', area: SettingsArea, values: Record<string, unknown>}
 *   | {kind: 'maintenance'}} Effect
 */

/**
 * A command, ready for an adapter to commit.
 * @typedef {object} Work
 * @property {string} commandId
 * @property {Command} command - what an adapter with revisions keeps when the command conflicts
 * @property {Effect} effect
 * @property {() => {store: StoreName, key: string} | undefined} [primary]
 *   The record whose new revision the committed outcome reports, once the units have run
 * @property {() => Committed} done - the outcome once everything committed
 */

/**
 * What an adapter guarantees. The contract suite expects the documented difference for
 * each flag, and each one the legacy adapter lacks is a `declared-gap` row in the ledger.
 * @typedef {object} AdapterFlags
 * @property {boolean} atomicMultiStore - a command's units commit together or not at all
 * @property {boolean} revisions
 *   Records have revisions: committed outcomes report them, and a stale `expectedRevision`
 *   is a conflict
 * @property {boolean} idempotency
 *   A commandId that already has a committed, rejected, or conflict outcome gets that
 *   outcome again, and nothing runs
 */

/**
 * @typedef {object} KernelAdapter
 * @property {string} name
 * @property {Readonly<AdapterFlags>} flags
 * @property {(commandId: string) => Outcome | undefined} recall
 *   Synchronous, so a save can still open its transaction in the calling task
 * @property {(work: Work) => Promise<Outcome>} commit
 *   Opens the first transaction before it returns. It never rejects: a failure is an
 *   `unavailable` outcome.
 * @property {<T>(stores: StoreName[], body: (tx: ReadTx) => Promise<T>) => Promise<T>} read
 *   Rejects with an UnavailableError when storage fails
 * @property {(area: SettingsArea, keys: readonly string[]) => Promise<Record<string, unknown>>} readSettings
 *   The keys that have a stored value
 */
