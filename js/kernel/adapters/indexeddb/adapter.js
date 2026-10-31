/**
 * #17's IndexedDB adapter (#17 slice 1, "Repositories and commit semantics"): the kernel's
 * repository port over CanvasTabDB, with settings in chrome.storage.local. It writes the same
 * records to the same stores as #12's legacy adapter, with three version fields on each note
 * it writes (versions.js), and #17 PR 2a's bookkeeping beside them, in the stores step 10
 * makes (registry.js): the ledger (ledger.js), the change log (changes.js), and conflict
 * records (conflicts.js). Core's deletion puts a tombstone for each note and folder it deletes,
 * in the delete's own transaction, and this adapter fills in the note's last revision and the
 * commit's seq there (deletion.js, #17 PR 2b).
 *
 * Every command's units run in one transaction, opened in the task that commits it, readwrite
 * with `durability: 'strict'` whenever a unit writes or the database keeps a ledger, over the
 * units' stores and the bookkeeping stores the database has. A command answers only once that
 * transaction fires `complete`, and with a typed `unavailable` outcome when it fires `abort`,
 * even after every request in it succeeded, so nothing is ever reported saved that didn't
 * commit (failures.js has what each failure answers). The transaction asks for the command's
 * ledger row and the change log's head before the first unit runs, and once the units have
 * run, in this order:
 * - a ledger row for the commandId answers the command: with its outcome again, `replayed`,
 *   when it's the same command, and `idempotency-key-reuse` when it's another, and the
 *   transaction aborts, so nothing the units wrote again commits;
 * - a unit that stopped the command with a rejection, or threw, aborts it, and nothing of it
 *   is kept;
 * - a conflict commits only its conflict record and ledger row, since every unit checks the
 *   version it expects before it writes anything. One after a write aborts as
 *   `conflict-after-write`, which is a bug in the unit, so no lost update can commit;
 * - a committed command moves its notes' versions, puts a change-log row for each note and
 *   folder it wrote, completes each tombstone its units put, and puts its ledger row with the
 *   outcome, revision and commitSeq included, and commits.
 * A database below version 10 (a run that left it as it was) has none of those stores, so
 * commands commit there as they did before, with no ledger row, change, conflict record, or
 * tombstone, and a resend runs again.
 *
 * A transaction that aborts with an AbortError or an UnknownError runs once more, in a new
 * one, and answers `retries-exhausted` if that fails too (ports/repository.js, Unit). It runs
 * again only when this adapter has opened no write since on any store its units write, as a
 * later command there, such as a newer save of the same note, would land first and be written
 * over; it answers `transaction-failed`, retryable, instead. That holds within one context
 * only: another context's save that commits between the abort and the run again is written
 * over, unless the save carries the revision it expects, which is then a conflict.
 *
 * A transaction that ends before the command's units have finished, because a unit awaited
 * something other than it, isn't run again, and the command answers as it ends rather than
 * wait on the unit: `transaction-ended-early` when it committed, and why it aborted when it
 * aborted. The adapter can tell only by which comes first, so a unit that finishes before an
 * abort reaches it is answered as any other command, retry included.
 *
 * Flags:
 * - atomicMultiStore: true, since a command is one transaction.
 * - revisions: true. Each note has a content revision, a placement version, and a source
 *   revision (versions.js), and a command that expects another is a conflict.
 * - idempotency: true, on a database at version 10, for catalog commands made of units: their
 *   outcome is kept in the ledger in the commit's own transaction. Settings commands and
 *   startup maintenance write to chrome.storage.local, outside any IndexedDB transaction, so
 *   they keep none, and a resend writes the same values again. A bulk command's key is
 *   reserved in memory, in this adapter, from its first recall, since recall is synchronous:
 *   another context, or this one after the worker restarts, doesn't see the reservation,
 *   though each of the bulk command's items still answers from its own ledger row.
 *
 * Composition roots make it with `createIndexedDbAdapter({indexedDB, settings, mode})`: since
 * #17 PR 1b the service worker's (`versioned` once its migration run has brought the database
 * to this build's version, `existing` when the run left it as it was), Popup's and Side
 * Panel's (`existing`). The new tab stays on #12's legacy adapter until #17 PR 4 moves it
 * (connection.js).
 */

import { COMMANDS } from '../../core/contracts/commands.js';
import {
  STORAGE_EXCEPTIONS,
  UnavailableError,
  committed,
  rejected,
  unavailable,
  unavailableFrom,
} from '../../core/contracts/outcomes.js';
import { withoutPlacement } from '../../core/domain/placement.js';
import { digestOf } from '../../core/memory/fingerprint.js';
import { IDB_SETTINGS_KEYS, LATER_STORES } from '../../core/ports/repository.js';
import { systemClock } from '../../core/ports/runtime.js';
import { createAutoBackup, exportFile, prepareImport, readExport } from './backups.js';
import { createIndexedDbCommitLog, logHead, writeChanges } from './changes.js';
import { conflictRecord } from './conflicts.js';
import { createConnection } from './connection.js';
import { finishTombstones } from './deletion.js';
import { failureOf, isTransient, nameOf, settingsFailureOf } from './failures.js';
import { runIntegrityCheck } from './integrity.js';
import { createIndexedDbLedger, ledgerRow, replayFrom, sweepLedger } from './ledger.js';
import { copyMissingStores } from './recovery-copies.js';
import {
  CHANGES_KEY,
  CHANGES_STORE,
  CONFLICTS_STORE,
  META_STORE,
  OPERATIONS_STORE,
  TOMBSTONES_STORE,
} from './registry.js';
import { abort, indexValue, result } from './requests.js';
import { DERIVED_STORES, IDB_STORES } from './schema.js';
import { FIRST_RUN_SETTINGS, INITIALIZED_KEY, settingKey } from './settings.js';
import { createVersionTracker } from './versions.js';

/** @typedef {import('../../core/ports/repository.js').KernelAdapter} KernelAdapter */
/** @typedef {import('../../core/ports/repository.js').StoreName} StoreName */
/** @typedef {import('../../core/ports/repository.js').SettingsArea} SettingsArea */
/** @typedef {import('../../core/ports/repository.js').Tx} Tx */
/** @typedef {import('../../core/ports/repository.js').Unit} Unit */
/** @typedef {import('../../core/ports/repository.js').Work} Work */
/** @typedef {import('../../core/ports/repository.js').CommitResult} CommitResult */
/** @typedef {import('../../core/ports/idempotency-ledger.js').IdempotencyLedger} IdempotencyLedger */
/** @typedef {import('../../core/ports/commit-log.js').CommitLog} CommitLog */
/** @typedef {import('../../core/ports/runtime.js').Clock} Clock */
/** @typedef {import('../../core/contracts/outcomes.js').Outcome} Outcome */
/** @typedef {import('../../core/contracts/outcomes.js').Conflict} Conflict */
/** @typedef {import('./connection.js').OpenMode} OpenMode */
/** @typedef {import('./integrity.js').IntegrityLog} IntegrityLog */
/** @typedef {import('./connection.js').OpenState} OpenState */
/** @typedef {import('./versions.js').VersionTracker} VersionTracker */
/** @typedef {import('../../core/domain/tombstone.js').TombstoneRecord} TombstoneRecord */

/**
 * chrome.storage.local, or anything with its promise-returning get and set
 * @typedef {object} SettingsStore
 * @property {(keys: string[]) => Promise<Record<string, unknown>>} get
 * @property {(items: Record<string, unknown>) => Promise<void>} set
 */

/**
 * @typedef {object} IndexedDbOptions
 * @property {IDBFactory} indexedDB
 * @property {SettingsStore} settings
 * @property {OpenMode} [mode] - versioned unless given
 * @property {number} [openWithinMs] - how long open() waits for a blocked or slow open (connection.js)
 * @property {boolean} [requireCore] - an `existing` open refuses a database without notes or blocks (connection.js)
 * @property {(() => Promise<unknown>) | null} [awaitUpgrade]
 *   What an `existing` open waits on first when there's no database or an older one: a page's
 *   wait on the worker's migration run (connection.js)
 * @property {IntegrityLog} [integrityLog]
 *   Where the read-only integrity check reports (integrity.js): the context's console unless a
 *   test passes another
 * @property {boolean} [maintains]
 *   An `existing` open runs startup maintenance too: the new tab's (#17 PR 4a), which opens the
 *   database as it is and still writes a new profile's first-run settings. Popup and Side Panel
 *   leave it to the new tab and the worker.
 * @property {boolean} [copiesMissingStores]
 *   An `existing` open saves #33's recovery copy of a database at 8 that lacks some legacy
 *   store before it opens it, as js/storage.js's page open did: the new tab's (#17 PR 4a,
 *   recovery-copies.js)
 * @property {boolean} [backups]
 *   It runs 1.4.x's backup tasks and makes the export file (backups.js): the new tab's, which
 *   passes chrome.storage.local as `settings`, for the automatic backups and the recovery copy
 *   (#17 PR 4a, the lead's Q1). Popup, Side Panel, and the service worker run none, as the
 *   policy has it, so their adapters answer each as one without the `backups` flag does.
 * @property {import('./recovery-copies.js').CopyLocks | null} [locks]
 *   Web Locks, which that copy's check and write hold so tabs that open together write one
 * @property {Clock} [clock] - when a ledger row, a conflict record, and a tombstone are written
 * @property {typeof IDBKeyRange} [keyRange] - for the change log's reads, the global one unless given
 */

/**
 * @typedef {KernelAdapter & {
 *   mode: OpenMode,
 *   open: () => Promise<void>,
 *   close: () => void,
 *   beforeClose: (flush: () => void) => () => void,
 *   openState: () => OpenState,
 *   missingStores: () => string[],
 *   upgraded: () => boolean,
 *   ledger: IdempotencyLedger,
 *   commitLog: CommitLog,
 *   sweepLedger: () => Promise<{swept: boolean, deleted: number}>,
 * }} IndexedDbAdapter
 *   `ledger` and `commitLog` are #13's ports over this adapter's ledger and change log, and
 *   `sweepLedger` their retention (ledger.js), which only the worker runs. `beforeClose`,
 *   `openState`, `missingStores`, and `upgraded` are the connection's (connection.js), what
 *   the new tab read of js/storage.js's: a flush before another context's upgrade closes it,
 *   the state App and the export notice read, the legacy stores a degraded database lacks, and
 *   whether it's at this build's version.
 */

/** @type {IDBTransactionOptions} */
const STRICT = Object.freeze({ durability: 'strict' });

/**
 * The context's console, read when the check reports, not when this module loads
 * @type {IntegrityLog}
 */
const contextConsole = Object.freeze({
  info: (message, detail) => globalThis.console.info(message, detail),
  warn: (message, error) => globalThis.console.warn(message, error),
});

/**
 * How a transaction ended: committed, or aborted with its error, which is null when this
 * adapter aborted it
 * @typedef {{committed: true} | {committed: false, error: DOMException | null}} Ending
 */

/**
 * @param {IDBTransaction} tx
 * @returns {Promise<Ending>}
 */
function ending(tx) {
  return new Promise(resolve => {
    tx.addEventListener('complete', () => resolve({ committed: true }));
    tx.addEventListener('abort', () => resolve({ committed: false, error: tx.error }));
  });
}

/**
 * The IndexedDB stores among `stores` the database has, once each
 * @param {IDBDatabase} db
 * @param {readonly StoreName[]} stores
 * @returns {string[]}
 */
function present(db, stores) {
  const names = new Set(stores.filter(store => Object.hasOwn(IDB_STORES, store)).map(store => IDB_STORES[store]));
  return [...names].filter(name => db.objectStoreNames.contains(name));
}

/**
 * The bookkeeping stores a database has: all of step 10's on a database at version 10, and
 * none below it, where commands commit as they did before step 10
 * @typedef {object} Books
 * @property {readonly string[]} names
 * @property {boolean} ledger - `operations`
 * @property {boolean} log - `changes`, with its head in `meta`
 * @property {boolean} conflicts
 * @property {boolean} tombstones
 */

/** @type {Books} */
const NO_BOOKS = Object.freeze({
  names: Object.freeze([]),
  ledger: false,
  log: false,
  conflicts: false,
  tombstones: false,
});

/**
 * @param {IDBDatabase} db
 * @returns {Books}
 */
function booksOf(db) {
  const has = (/** @type {string} */ name) => db.objectStoreNames.contains(name);
  if (!has(OPERATIONS_STORE)) return NO_BOOKS;
  const log = has(CHANGES_STORE) && has(META_STORE);
  const names = [OPERATIONS_STORE, ...(log ? [CHANGES_STORE, META_STORE] : [])];
  if (has(CONFLICTS_STORE)) names.push(CONFLICTS_STORE);
  if (has(TOMBSTONES_STORE)) names.push(TOMBSTONES_STORE);
  return { names, ledger: true, log, conflicts: has(CONFLICTS_STORE), tombstones: has(TOMBSTONES_STORE) };
}

/**
 * Whether `work` is a catalog command, which the ledger keys by its commandId. Work that isn't,
 * such as #20's storage probe, which writes and deletes a record of its own, keeps no ledger
 * row and never replays one, so each run of it runs, and it leaves CanvasTabDB as it found it.
 * @param {Work} work
 */
const isCatalogCommand = work => {
  const { type } = /** @type {{type?: unknown}} */ (work.command);
  return typeof type === 'string' && Object.hasOwn(COMMANDS, type);
};

/**
 * The ledger row `work`'s commandId has, read in a readonly transaction of its own, or
 * undefined: none for work that isn't a catalog command, or on a database below version 10
 * @param {IDBDatabase} db
 * @param {Work} work
 * @returns {Promise<import('./ledger.js').LedgerRow | undefined>}
 */
async function keptRow(db, work) {
  if (!isCatalogCommand(work) || !db.objectStoreNames.contains(OPERATIONS_STORE)) return undefined;
  const store = db.transaction(OPERATIONS_STORE, 'readonly').objectStore(OPERATIONS_STORE);
  return /** @type {import('./ledger.js').LedgerRow | undefined} */ (await result(store.get(work.commandId)));
}

/**
 * A unit's view of its command's transaction: only the stores it named, and no writes when
 * it only reads. A store the database lacks reads as empty, as DatabaseManager's reads of
 * auxiliary stores do. Notes come back as stored, versions included, and every note read or
 * written goes through the transaction's version tracker (versions.js).
 * @param {IDBDatabase} db
 * @param {IDBTransaction | null} tx - null when the database has none of the command's stores
 * @param {readonly StoreName[]} scope
 * @param {boolean} writable
 * @param {VersionTracker} tracker
 * @returns {Tx}
 */
function view(db, tx, scope, writable, tracker) {
  /**
   * @param {StoreName} store
   * @returns {IDBObjectStore | null}
   */
  const handle = store => {
    if (!Object.hasOwn(IDB_STORES, store)) throw new UnavailableError('adapter', 'unknown-store', false);
    if (!scope.includes(store)) throw new UnavailableError('adapter', 'store-outside-transaction', false);
    const name = IDB_STORES[store];
    return tx && db.objectStoreNames.contains(name) ? tx.objectStore(name) : null;
  };
  /**
   * @param {StoreName} store
   * @returns {IDBObjectStore | null}
   */
  const writing = store => {
    if (!writable) throw new UnavailableError('adapter', 'write-in-readonly-transaction', false);
    return handle(store);
  };
  /**
   * @param {StoreName} store
   * @param {Array<Record<string, unknown>>} records
   */
  const sawAll = (store, records) => {
    if (store === 'notes') for (const record of records) tracker.saw(/** @type {string} */ (record.id), record);
    return records;
  };
  return /** @type {Tx} */ ({
    get: async (store, key) => {
      const objectStore = handle(store);
      const record = objectStore ? await result(objectStore.get(key)) : undefined;
      if (store === 'notes') tracker.saw(key, record);
      return record;
    },
    getAll: async store => {
      const objectStore = handle(store);
      return sawAll(store, objectStore ? await result(objectStore.getAll()) : []);
    },
    getAllByIndex: async (store, index, value) => {
      const objectStore = handle(store);
      const key = indexValue(value);
      return sawAll(store, objectStore ? await result(objectStore.index(index).getAll(key)) : []);
    },
    getKeysByIndex: async (store, index, value) => {
      const objectStore = handle(store);
      const key = indexValue(value);
      return objectStore ? result(objectStore.index(index).getAllKeys(key)) : [];
    },
    revision: (store, key) => {
      handle(store);
      return store === 'notes' ? tracker.versions(key)?.revision : undefined;
    },
    versions: (store, key) => {
      handle(store);
      return store === 'notes' ? tracker.versions(key) : undefined;
    },
    has: store => handle(store) !== null,
    put: (store, record) => {
      const objectStore = writing(store);
      if (!objectStore) {
        // A derived store's writes are skipped where it's missing, and below version 10 a
        // deletion's tombstone, as commands committed before step 10 (#17 PR 2b's declared gap)
        if (!DERIVED_STORES.includes(store) && !LATER_STORES.includes(store)) {
          throw new UnavailableError('storage', 'store-unavailable', false);
        }
        return;
      }
      if (store === 'notes') {
        // Below version 10, which 1.4.1 still opens and where only its flags would follow it, a
        // note goes in without #17 PR 3's fields, as on the legacy adapter (review R88)
        tracker.putNote(
          objectStore,
          db.objectStoreNames.contains(TOMBSTONES_STORE) ? record : withoutPlacement(record),
        );
        return;
      }
      objectStore.put(record);
      if (store === 'folders') tracker.touched('folder', /** @type {string} */ (record.id));
      else if (store === 'tombstones') tracker.tombstone(/** @type {TombstoneRecord} */ (record));
      else tracker.wrote();
    },
    delete: (store, key) => {
      const objectStore = writing(store);
      if (!objectStore) return;
      if (store === 'notes') {
        tracker.deleteNote(objectStore, key);
        return;
      }
      objectStore.delete(key);
      if (store === 'folders') tracker.touched('folder', key);
      else tracker.wrote();
    },
  });
}

/**
 * Runs the units in order over `tx`, until one stops the command
 * @param {IDBDatabase} db
 * @param {IDBTransaction | null} tx
 * @param {Unit[]} units
 * @param {VersionTracker} tracker
 * @returns {Promise<Outcome | void>}
 */
async function runUnits(db, tx, units, tracker) {
  for (const unit of units) {
    if (unit.when && !unit.when()) continue;
    const stop = await unit.run(view(db, tx, unit.stores, (unit.mode || 'readwrite') === 'readwrite', tracker));
    if (stop) return stop;
  }
  return undefined;
}

/**
 * A request's result, or why it failed, never a rejection
 * @template T
 * @param {IDBRequest<T>} request
 * @returns {Promise<{value: T} | {error: unknown}>}
 */
const settled = request =>
  result(request).then(
    value => ({ value }),
    error => ({ error }),
  );

/**
 * A readwrite transaction this adapter opened: its place in the order it opened them, from 1,
 * and the IndexedDB stores its units span. `seq` 0, over no store, is a run that opened none.
 * @typedef {{seq: number, names: readonly string[]}} Write
 */

/** @type {Write} */
const NO_WRITE = Object.freeze({ seq: 0, names: Object.freeze([]) });

/**
 * How one run of a command's units ended: its answer, whether it replays a kept outcome,
 * whether another run could get past the failure, and the readwrite transaction it opened
 * @typedef {{outcome: Outcome, replayed: boolean, transient: boolean, write: Write}} Attempt
 */

/**
 * The answer for a transaction that failed, and whether it may run once more
 * @param {unknown} cause
 * @param {Write} write
 * @returns {Attempt}
 */
function failed(cause, write) {
  return { outcome: unavailableFrom(failureOf(cause)), replayed: false, transient: isTransient(cause), write };
}

/** @param {Outcome} outcome @returns {Attempt} */
const answered = outcome => ({ outcome, replayed: false, transient: false, write: NO_WRITE });

const endedEarly = () => answered(unavailable('adapter', 'transaction-ended-early', false));

const aborted = () => new DOMException('The transaction was aborted', 'AbortError');

/**
 * What a run's units and its bookkeeping came to, before the transaction ends: an answer that
 * aborts it, an outcome to answer once it commits, or a throw
 * @typedef {{abort: Attempt} | {commit: Outcome} | {error: unknown}} Decided
 */

/**
 * @param {IndexedDbOptions} options
 * @returns {IndexedDbAdapter}
 */
export function createIndexedDbAdapter({
  indexedDB,
  settings,
  mode = 'versioned',
  openWithinMs,
  requireCore = false,
  awaitUpgrade = null,
  integrityLog = contextConsole,
  maintains = false,
  copiesMissingStores = false,
  backups = false,
  locks = null,
  clock = systemClock,
  keyRange,
}) {
  const connection = createConnection({
    indexedDB,
    mode,
    openWithinMs,
    requireCore,
    awaitUpgrade,
    beforeOpen: copiesMissingStores ? () => copyMissingStores({ indexedDB, settings, clock, locks }) : null,
  });
  const database = () => connection.database();

  /**
   * What a failure to start a transaction means: the connection closed under it (another
   * context's upgrade, or Chrome), or its own failure
   * @param {unknown} error
   * @returns {UnavailableError}
   */
  const startFailure = error => {
    if (nameOf(error) === 'InvalidStateError') {
      connection.lost();
      return new UnavailableError('storage', 'reload-required', false);
    }
    return failureOf(error);
  };

  /**
   * The values IndexedDB's `settings` store holds for `keys`, records of `{key, value}`, as
   * Popup has read them since 1.4.x (#12 slice 4a; #4 moves Popup to the setting the new tab
   * saves). The store also holds 1.4.x's provider keys, so only IDB_SETTINGS_KEYS are served,
   * as on the legacy adapter. A database without the store has none.
   * @param {readonly string[]} keys
   * @returns {Promise<Record<string, unknown>>}
   */
  const readIdbSettings = async keys => {
    if (keys.some(key => !IDB_SETTINGS_KEYS.includes(key))) {
      throw new UnavailableError('adapter', 'setting-not-served', false);
    }
    /** @type {IDBObjectStore | null} */
    let store = null;
    try {
      const db = connection.database();
      if (db.objectStoreNames.contains('settings')) {
        store = db.transaction('settings', 'readonly').objectStore('settings');
      }
    } catch (error) {
      throw startFailure(error);
    }
    /** @type {Record<string, unknown>} */
    const values = {};
    if (!store) return values;
    try {
      for (const key of keys) {
        const record = /** @type {{value?: unknown} | undefined} */ (await result(store.get(key)));
        if (record && record.value !== undefined) values[key] = record.value;
      }
    } catch (error) {
      throw failureOf(error);
    }
    return values;
  };

  /** How many readwrite transactions this adapter has opened */
  let writesOpened = 0;
  /**
   * The last readwrite transaction this adapter opened over each IndexedDB store its units
   * write, so a retry can tell whether a later write went first on any of them. The
   * bookkeeping stores every commit spans aren't counted: each command's rows there are its
   * own, and the change log's head is read in the transaction that moves it.
   * @type {Map<string, number>}
   */
  const lastWrite = new Map();

  /**
   * Keeps a conflict that wrote nothing: its record and its ledger row, in `tx`
   * @param {IDBTransaction} tx
   * @param {Books} books
   * @param {Work} work
   * @param {Conflict} conflict
   */
  const keepConflict = (tx, books, work, conflict) => {
    const at = clock.now();
    if (books.conflicts) tx.objectStore(CONFLICTS_STORE).put(conflictRecord(work, conflict, at));
    if (books.ledger && isCatalogCommand(work))
      tx.objectStore(OPERATIONS_STORE).put(ledgerRow(work.command, conflict, at));
  };

  /**
   * A committed command's bookkeeping, in `tx`: its notes' versions, its change-log rows and
   * tombstones, and its ledger row. Answers the outcome, with the primary note's revision and
   * the commit's seq.
   * @param {IDBTransaction} tx
   * @param {Books} books
   * @param {Work} work
   * @param {VersionTracker} tracker
   * @param {Promise<{value: unknown} | {error: unknown}>} headRead
   * @returns {Promise<Outcome>}
   */
  const keepCommit = async (tx, books, work, tracker, headRead) => {
    const scope = work.scope || 'content';
    const primary = work.primary && work.primary();
    const revised = scope === 'content' && Boolean(work.revised && work.revised());
    const writable = tx.mode === 'readwrite' && tx.objectStoreNames.contains(IDB_STORES.notes);
    const { revision, changes, deleted } = writable
      ? await tracker.settle({
          notes: tx.objectStore(IDB_STORES.notes),
          tombstones: books.tombstones ? tx.objectStore(TOMBSTONES_STORE) : null,
          primary: primary && { store: primary.store, key: primary.key },
          revised,
        })
      : { revision: undefined, changes: [], deleted: [] };
    /** @type {Outcome} */
    let outcome = work.done();
    if (revision !== undefined) outcome = { ...outcome, revision };
    /** @type {number | null} */
    let seq = null;
    if (books.log && changes.length > 0) {
      const head = await headRead;
      if ('error' in head) throw head.error;
      seq = writeChanges(tx, logHead(head.value), changes, work.commandId);
      outcome = { ...outcome, commitSeq: seq };
    }
    // Core's deletion put each tombstone in this transaction (#17 PR 2b); it gets the note's last
    // revision and this commit's seq here (deletion.js)
    if (books.tombstones) finishTombstones(tx.objectStore(TOMBSTONES_STORE), tracker.tombstones(), { deleted, seq });
    if (books.ledger && isCatalogCommand(work) && outcome.kind === 'committed') {
      tx.objectStore(OPERATIONS_STORE).put(ledgerRow(work.command, outcome, clock.now()));
    }
    return outcome;
  };

  /**
   * One run of a command's units, all in one transaction, which it opens before it returns
   * @param {Work} work
   * @param {Unit[]} units
   * @returns {Promise<Attempt>}
   */
  const attempt = (work, units) => {
    /** @type {IDBDatabase} */
    let db;
    /** @type {IDBTransaction | null} */
    let tx = null;
    let write = NO_WRITE;
    let books = NO_BOOKS;
    try {
      db = connection.database();
      const unitStores = units.flatMap(unit => unit.stores);
      // The primary note's revision may move, or be reported, though no unit touches the note
      /** @type {StoreName[]} */
      const primaryStores = work.primary ? ['notes'] : [];
      const names = present(db, [...unitStores, ...primaryStores]);
      // A deletion's own rows in step 10's stores aren't counted for a retry, as the
      // bookkeeping isn't: each command's tombstones and conflict records are its own
      const unitNames = present(
        db,
        unitStores.filter(store => !LATER_STORES.includes(store)),
      );
      books = booksOf(db);
      const writes = units.some(unit => (unit.mode || 'readwrite') === 'readwrite') || books.ledger;
      if (names.length > 0 && writes) {
        tx = db.transaction([...new Set([...names, ...books.names])], 'readwrite', STRICT);
        write = { seq: ++writesOpened, names: unitNames };
        for (const name of unitNames) lastWrite.set(name, write.seq);
      } else if (names.length > 0) {
        books = NO_BOOKS;
        tx = db.transaction(names, 'readonly');
      } else {
        books = NO_BOOKS;
      }
    } catch (error) {
      return Promise.resolve(answered(unavailableFrom(startFailure(error))));
    }
    const tracker = createVersionTracker({ scope: work.scope, sourceRevision: work.sourceRevision });
    // Asked for before any unit runs, so the units' requests still go out in the calling task
    /** @type {Promise<{value: unknown} | {error: unknown} | null>} */
    const kept =
      tx && books.ledger && isCatalogCommand(work)
        ? settled(tx.objectStore(OPERATIONS_STORE).get(work.commandId))
        : Promise.resolve(null);
    const headRead =
      tx && books.log ? settled(tx.objectStore(META_STORE).get(CHANGES_KEY)) : Promise.resolve({ value: undefined });
    /** @type {Promise<{stop: Outcome | void} | {error: unknown}>} */
    const running = runUnits(db, tx, units, tracker).then(
      stop => ({ stop }),
      error => ({ error }),
    );
    // With none of its stores in the database there's no transaction to end: the units read
    // empty stores, and a write fails or is skipped as Storage's would
    if (!tx) {
      return running.then(first => {
        if ('error' in first) return failed(first.error, NO_WRITE);
        return answered(first.stop || work.done());
      });
    }
    const open = tx;
    const ended = ending(open);
    /** @type {Promise<Decided>} */
    const deciding = running.then(async first => {
      try {
        // A ledger row answers first: a resend of a command that committed or conflicted gets
        // that outcome again, whatever its units found this time
        const row = await kept;
        if (row && 'value' in row && row.value) {
          const { outcome, replayed } = replayFrom(/** @type {any} */ (row.value), work.command);
          return { abort: { outcome, replayed, transient: false, write: NO_WRITE } };
        }
        if ('error' in first) return { error: first.error };
        const { stop } = first;
        if (stop && stop.kind === 'conflict') {
          // A unit checks the version it expects before it writes, so this is a bug in the unit
          if (tracker.written()) return { abort: answered(unavailable('adapter', 'conflict-after-write', false)) };
          keepConflict(open, books, work, stop);
          return { commit: stop };
        }
        if (stop) return { abort: answered(stop) };
        return { commit: await keepCommit(open, books, work, tracker, headRead) };
      } catch (error) {
        return { error };
      }
    });
    return Promise.race([deciding, ended.then(end => ({ end }))]).then(async first => {
      // The transaction ended while a unit still ran, because the unit awaited something else.
      // One that committed may hold what the unit wrote before that, so the command can't say it
      // saved; one that aborted holds nothing and says why. Neither runs again, as that unit may
      // still be running.
      if ('end' in first) {
        return first.end.committed
          ? endedEarly()
          : { ...failed(first.end.error || aborted(), write), transient: false };
      }
      if ('error' in first) {
        abort(open);
        const end = await ended;
        if (end.committed) return endedEarly();
        // Its own error says why the transaction aborted, when it aborted for one
        return failed(end.error || first.error, write);
      }
      if ('abort' in first) {
        abort(open);
        // Committed before the abort could land, so what came before the stop is stored
        if ((await ended).committed) return endedEarly();
        return first.abort;
      }
      const end = await ended;
      if (end.committed) return answered(first.commit);
      return failed(end.error || aborted(), write);
    });
  };

  /**
   * @param {Work} work
   * @param {Unit[]} units
   * @returns {Promise<CommitResult>}
   */
  const commitUnits = (work, units) =>
    attempt(work, units).then(first => {
      if (!first.transient) return { outcome: first.outcome, replayed: first.replayed };
      // Another run would queue behind every transaction opened since over its stores, so a
      // later command this context sent, such as a newer save of the same note, would land
      // first and then be written over. So it runs again only when no write opened after it on
      // any store it writes. One on other stores, such as filing into a folder, can't be.
      const overtaken = first.write.names.some(name => lastWrite.get(name) !== first.write.seq);
      if (overtaken) return { outcome: unavailable('storage', 'transaction-failed', true), replayed: false };
      return attempt(work, units).then(second =>
        second.transient
          ? { outcome: unavailable('storage', 'retries-exhausted', true), replayed: false }
          : { outcome: second.outcome, replayed: second.replayed },
      );
    });

  /**
   * @param {Work} work
   * @param {SettingsArea} area
   * @param {Record<string, unknown>} values
   * @returns {Promise<Outcome>}
   */
  const commitSettings = (work, area, values) => {
    const items = Object.fromEntries(Object.entries(values).map(([key, value]) => [settingKey(area, key), value]));
    return Promise.resolve()
      .then(() => settings.set(items))
      .then(
        () => work.done(),
        error => unavailableFrom(settingsFailureOf(error, 'write')),
      );
  };

  /**
   * The read-only integrity check (integrity.js), which only reports what it finds, so it
   * commits whatever that is. The worker runs it after an install or an update, as
   * runIntegrityCheck (#35 slice 1), never as it starts. With no connection to read, one
   * another context's upgrade or delete closed included, it warns and commits, as
   * Storage.runIntegrityCheck does on a closed database: a check is no reason to open the
   * database again, or to make one.
   * @param {Work} work
   * @returns {Promise<Outcome>}
   */
  const checkIntegrity = async work => {
    /** @type {IDBDatabase} */
    let db;
    try {
      db = connection.database();
    } catch (error) {
      integrityLog.warn('Integrity check encountered an error:', error);
      return work.done();
    }
    await runIntegrityCheck(db, integrityLog);
    return work.done();
  };

  /**
   * Startup maintenance: the settings Storage writes on a profile's first run, each one only
   * where nothing is stored, then nothing else. It reads no store, so it runs while the
   * database is blocked too. The read-only integrity check is an effect of its own
   * (checkIntegrity), which the worker runs after an install or an update. It runs on a
   * `versioned` open, the worker's, and on an `existing` one that `maintains`, the new tab's
   * (#17 PR 4a).
   *
   * It's best effort, as Storage.initializeDefaultSettings is, since a root that maintains as
   * it opens answers every call with maintenance's failure: when chrome.storage fails it, it
   * still commits, as `maintenance-deferred` at warning severity, so the page runs on, and with
   * nothing marking the profile initialized, the next start tries again. One that can't read
   * what's stored writes nothing, so no default lands over a setting.
   * @param {Work} work
   * @returns {Promise<Outcome>}
   */
  const maintain = async work => {
    // Popup and Side Panel never maintain the database
    if (mode !== 'versioned' && !maintains) return unavailable('adapter', 'maintenance-needs-versioned-open', false);
    try {
      const stored = (await settings.get([INITIALIZED_KEY, ...Object.keys(FIRST_RUN_SETTINGS)])) || {};
      if (!stored[INITIALIZED_KEY]) {
        const missing = Object.entries(FIRST_RUN_SETTINGS).filter(([key]) => stored[key] === undefined);
        await settings.set({ ...Object.fromEntries(missing), [INITIALIZED_KEY]: true });
      }
    } catch {
      return committed('maintenance-deferred', [], { severity: 'warning' });
    }
    return work.done();
  };

  /**
   * chrome.storage.local, as the backup tasks use it: a root that turns `backups` on passes it,
   * with its get of every key and its remove
   */
  const backupStore = /** @type {import('./backups.js').BackupStore} */ (/** @type {unknown} */ (settings));

  /**
   * A legacy backup task (backups.js), on an adapter that runs them. The automatic backup goes
   * to chrome.storage.local, as Storage's did. The import commits as one unit of its command, in
   * one transaction with its ledger row, its notes' versions, and its changes, after Replace
   * all's recovery copy; its outcome names what it added and trashed. A resend of one that
   * committed answers from its ledger row and imports nothing: Replace all reads the row before
   * its copy, so the lost-reply case saves no second copy of every note. Only a send that races
   * the first, both reading no row, saves one more, and its commit then answers from the row the
   * first wrote. A refused backup, or a recovery copy that couldn't be saved, writes nothing to
   * IndexedDB. A task that fails before any commit (the automatic backup, or an import's reads)
   * names the storage exception it failed with, as the legacy adapter's did, so #20's
   * `backup.auto-failed` keeps it; the import's commit answers as every command's does.
   * @param {Work} work
   * @param {import('../../core/ports/repository.js').BackupTask} task
   * @returns {Promise<CommitResult>}
   */
  const commitBackup = async (work, task) => {
    // Popup, Side Panel, and the service worker run none, until #18's backup engine (the `backups` flag)
    if (!backups) return { outcome: unavailable('adapter', 'backups-need-legacy-storage', false), replayed: false };
    /** @type {IDBDatabase} */
    let db;
    try {
      db = connection.database();
    } catch (error) {
      return { outcome: unavailableFrom(startFailure(error)), replayed: false };
    }
    try {
      if (task.action === 'auto') {
        await createAutoBackup({ db, settings: backupStore, clock });
        return { outcome: work.done(), replayed: false };
      }
      if (task.mode === 'replace') {
        const row = await keptRow(db, work);
        if (row) return replayFrom(row, work.command);
      }
      const prepared = await prepareImport({ db, settings: backupStore, clock, backup: task.backup, mode: task.mode });
      if ('refused' in prepared) return { outcome: prepared.refused, replayed: false };
      return commitUnits({ ...work, done: () => work.done(prepared.receipt()) }, [prepared.unit]);
    } catch (error) {
      const outcome = unavailableFrom(failureOf(error));
      const name = nameOf(error);
      if (name !== undefined && STORAGE_EXCEPTIONS.includes(name)) outcome.exception = name;
      return { outcome, replayed: false };
    }
  };

  /**
   * Each bulk command's digest, by commandId, from its first recall in this adapter
   * @type {Map<string, string>}
   */
  const bulkKeys = new Map();

  /** @type {CommitLog | null} */
  let commitLog = null;

  return Object.freeze({
    name: 'indexeddb',
    mode,
    flags: Object.freeze({ atomicMultiStore: true, revisions: true, idempotency: true, backups }),

    open: () => connection.open(),
    close: () => connection.close(),
    beforeClose: flush => connection.beforeClose(flush),
    openState: () => connection.openState(),
    missingStores: () => connection.missingStores(),
    upgraded: () => connection.upgraded(),

    // What commit keeps is in IndexedDB, which nothing reads synchronously, so a command's own
    // record answers from commit. Only a bulk command's reservation, which no transaction
    // keeps, answers here.
    recall(command) {
      const reserved = bulkKeys.get(command.commandId);
      if (reserved !== undefined) {
        return reserved === digestOf(command) ? undefined : rejected('validation', 'idempotency-key-reuse');
      }
      if (COMMANDS[command.type].bulk) bulkKeys.set(command.commandId, digestOf(command));
      return undefined;
    },

    commit(work) {
      const { effect } = work;
      /** @type {Promise<CommitResult>} */
      let pending;
      try {
        if (effect.kind === 'units') pending = commitUnits(work, effect.units);
        else if (effect.kind === 'settings') {
          pending = commitSettings(work, effect.area, effect.values).then(outcome => ({ outcome, replayed: false }));
        } else if (effect.kind === 'backup') pending = commitBackup(work, effect);
        else if (effect.kind === 'integrity-check') {
          // Read-only, it keeps no ledger row, as settings and maintenance keep none
          pending = checkIntegrity(work).then(outcome => ({ outcome, replayed: false }));
        } else pending = maintain(work).then(outcome => ({ outcome, replayed: false }));
      } catch (error) {
        pending = Promise.resolve({ outcome: unavailableFrom(failureOf(error)), replayed: false });
      }
      return pending.then(
        value => value,
        error => ({ outcome: unavailableFrom(failureOf(error)), replayed: false }),
      );
    },

    async read(stores, body) {
      for (const store of stores) {
        if (!Object.hasOwn(IDB_STORES, store)) throw new UnavailableError('adapter', 'unknown-store', false);
      }
      /** @type {IDBDatabase} */
      let db;
      /** @type {IDBTransaction | null} */
      let tx = null;
      try {
        db = connection.database();
        const names = present(db, stores);
        if (names.length > 0) tx = db.transaction(names, 'readonly');
      } catch (error) {
        throw startFailure(error);
      }
      try {
        return await body(view(db, tx, stores, false, createVersionTracker()));
      } catch (error) {
        throw failureOf(error);
      }
    },

    // Export JSON's file, and Create Backup's with its fields, on an adapter that runs the
    // backup tasks (backups.js), read in one readonly transaction
    async exportBackup(extra) {
      if (!backups) throw new UnavailableError('adapter', 'backups-need-legacy-storage', false);
      /** @type {IDBDatabase} */
      let db;
      try {
        db = connection.database();
      } catch (error) {
        throw startFailure(error);
      }
      try {
        return await exportFile(await readExport(db), clock.now(), extra);
      } catch (error) {
        throw failureOf(error);
      }
    },

    async readSettings(area, keys) {
      if (area === 'idbSettings') return readIdbSettings(keys);
      const storageKeys = keys.map(key => settingKey(area, key));
      /** @type {Record<string, unknown>} */
      let stored;
      try {
        stored = (await settings.get(storageKeys)) || {};
      } catch (error) {
        throw settingsFailureOf(error, 'read');
      }
      /** @type {Record<string, unknown>} */
      const values = {};
      keys.forEach((key, index) => {
        const value = stored[storageKeys[index]];
        if (value !== undefined) values[key] = value;
      });
      return values;
    },

    ledger: createIndexedDbLedger({ database }),
    get commitLog() {
      if (!commitLog) commitLog = createIndexedDbCommitLog({ database, keyRange: keyRange || globalThis.IDBKeyRange });
      return commitLog;
    },
    sweepLedger: () => sweepLedger({ database, now: clock.now() }),
  });
}
