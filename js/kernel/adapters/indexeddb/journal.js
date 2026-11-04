/**
 * NewTabNoteJournal (#35 slice 3, "The journal"; refined #17's capture journal): each
 * journaled command a context wrote before it sent it, until its answer removes it, or the
 * coordinator's drain replays it (core/application/journal-drain.js). It's its own database so a
 * `CanvasTabDB` that's upgrading, blocked, or failing can't stop an entry's write, and it's frozen
 * at version 1, as NewTabNoteTrust is (trust.js): the upgrade only creates what a new database
 * lacks, and a database at any other version is refused, `version-too-new`, and left as it was.
 * A build without slice 3, 1.5.0 or 1.4.x, never opens it.
 *
 * One store, `entries`, keyed by `opId`, with indexes on `noteId`, `ownerSessionId`, and
 * `createdAt` (domain/journal.js has the entry). It keeps #17's transaction rules (adapter.js):
 * each call is one transaction, readwrite with `durability: 'strict'` when it writes, which
 * answers only once it fires `complete`, so nothing is reported written that didn't commit. An
 * AbortError or UnknownError runs it once more in a new transaction, and answers
 * `retries-exhausted` if that fails too.
 *
 * `put` creates its transaction before anything is awaited once the database is open, so a page
 * that calls it, then sends its command, has issued the entry in the command's own task (3b).
 *
 * An entry holds what the user wrote. It's session state (#17's classification): never in a
 * backup, an export, sync, or diagnostics. InContextStores (adapters/in-context.js) is the one
 * place a context opens it.
 */

import { UnavailableError } from '../../core/contracts/outcomes.js';
import { inJournalOrder } from '../../core/domain/journal.js';
import { failureOf, isTransient, openFailureOf } from './failures.js';
import { endOf, result } from './requests.js';

/** @typedef {import('../../core/domain/journal.js').JournalRecord} JournalRecord */
/** @typedef {import('../../core/ports/journal.js').JournalStore} JournalStore */
/** @typedef {import('../../core/ports/journal.js').JournalReader} JournalReader */

export const JOURNAL_DB_NAME = 'NewTabNoteJournal';

/** Frozen at 1: a new store goes in a new database, never an upgrade of this one */
export const JOURNAL_DB_VERSION = 1;

export const JOURNAL_STORE = 'entries';

/** The layout of version 1 */
export const JOURNAL_DB_STORES = Object.freeze({
  [JOURNAL_STORE]: Object.freeze({
    keyPath: 'opId',
    autoIncrement: false,
    indexes: Object.freeze(['noteId', 'ownerSessionId', 'createdAt']),
  }),
});

/**
 * How long open() waits for an open that hasn't finished, as trust.js does. It then answers
 * `open-pending` and keeps connecting, and the next open() answers once the connection has.
 */
export const JOURNAL_OPEN_WITHIN_MS = 5000;

/** @type {IDBTransactionOptions} */
const STRICT = Object.freeze({ durability: 'strict' });

/**
 * Creates the store and each index version 1 has that `db` lacks. Runs only inside the upgrade.
 * @param {IDBDatabase} db
 * @param {IDBTransaction | null} upgrade
 */
function createStores(db, upgrade) {
  for (const [name, { keyPath, autoIncrement, indexes }] of Object.entries(JOURNAL_DB_STORES)) {
    const store = db.objectStoreNames.contains(name)
      ? /** @type {IDBTransaction} */ (upgrade).objectStore(name)
      : db.createObjectStore(name, { keyPath, autoIncrement });
    for (const index of indexes) if (!store.indexNames.contains(index)) store.createIndex(index, index);
  }
}

/**
 * Whether the journal database exists, so a drain with nothing to read opens nothing and makes
 * no database. True when the factory can't say, since opening an empty journal costs little.
 * @param {IDBFactory} indexedDB
 * @returns {Promise<boolean>}
 */
export async function journalExists(indexedDB) {
  try {
    if (typeof indexedDB.databases !== 'function') return true;
    return (await indexedDB.databases()).some(database => database.name === JOURNAL_DB_NAME);
  } catch {
    return true;
  }
}

/**
 * @typedef {JournalStore & JournalReader & {close: () => void, state: () => string}} JournalDatabase
 */

/**
 * @param {{indexedDB: IDBFactory, openWithinMs?: number}} options
 * @returns {JournalDatabase}
 */
export function createJournalDatabase({ indexedDB, openWithinMs = JOURNAL_OPEN_WITHIN_MS }) {
  // `lost`: Chrome closed the connection (onclose, or onversionchange for a deleted database),
  // which the next open() connects again; `gone`: close() was called, which nothing reopens
  /** @type {'closed' | 'opening' | 'open' | 'lost' | 'gone' | 'failed'} */
  let state = 'closed';
  /** @type {IDBDatabase | null} */
  let db = null;
  /** @type {UnavailableError | null} */
  let failure = null;
  /** @type {Promise<unknown> | null} */
  let connecting = null;
  /** The connection is closed under us: the next open() connects again */
  const lose = () => {
    state = 'lost';
    db = null;
    connecting = null;
  };

  const connect = () =>
    new Promise((resolve, reject) => {
      /** @param {UnavailableError} error */
      const fail = error => {
        state = 'failed';
        failure = new UnavailableError(error.unavailableCause, error.code, false);
        reject(error);
      };
      /** @type {IDBOpenDBRequest} */
      let request;
      try {
        request = indexedDB.open(JOURNAL_DB_NAME, JOURNAL_DB_VERSION);
      } catch (error) {
        fail(openFailureOf(error));
        return;
      }
      request.onupgradeneeded = () => createStores(request.result, request.transaction);
      request.onsuccess = () => {
        const database = request.result;
        if (state === 'gone') {
          database.close();
          return;
        }
        database.onversionchange = () => {
          database.close();
          if (db === database) lose();
        };
        database.onclose = () => {
          if (db === database) lose();
        };
        db = database;
        state = 'open';
        resolve(undefined);
      };
      request.onerror = () => fail(openFailureOf(request.error));
    });

  /** Why a call can't run now, as an UnavailableError */
  const notOpen = () => {
    if (state === 'failed' && failure) return failure;
    if (state === 'opening') return new UnavailableError('storage', 'open-pending', true);
    if (state === 'lost') return new UnavailableError('storage', 'database-closed', true);
    if (state === 'gone') return new UnavailableError('storage', 'reload-required', false);
    return new UnavailableError('adapter', 'not-open', false);
  };

  /**
   * One transaction over the store, created before anything is awaited, so a caller's command
   * sent right after it goes in the same task
   * @template T
   * @param {'readonly' | 'readwrite'} mode
   * @param {(store: IDBObjectStore) => Promise<T> | T} unit
   * @returns {Promise<{ok: true, value: T} | {ok: false, error: unknown}>}
   */
  const once = (mode, unit) => {
    const database = /** @type {IDBDatabase} */ (db);
    /** @type {IDBTransaction} */
    let tx;
    try {
      tx = database.transaction([JOURNAL_STORE], mode, mode === 'readwrite' ? STRICT : undefined);
    } catch (error) {
      if (state === 'open' && /** @type {{name?: unknown}} */ (error)?.name === 'InvalidStateError') lose();
      return Promise.resolve({
        ok: false,
        error: state === 'lost' ? new UnavailableError('storage', 'database-closed', true) : failureOf(error),
      });
    }
    const ended = endOf(tx);
    /** @type {Promise<T>} */
    let value;
    try {
      value = Promise.resolve(unit(tx.objectStore(JOURNAL_STORE)));
    } catch (error) {
      value = Promise.reject(error);
    }
    return value.then(
      async done => {
        const end = await ended;
        return end.committed ? { ok: true, value: done } : { ok: false, error: end.error };
      },
      async error => {
        try {
          tx.abort();
        } catch {
          // Already finished
        }
        const end = await ended;
        return { ok: false, error: !end.committed && end.error ? end.error : error };
      },
    );
  };

  /**
   * `unit` in a transaction, once more after a transient failure
   * @template T
   * @param {'readonly' | 'readwrite'} mode
   * @param {(store: IDBObjectStore) => Promise<T> | T} unit
   * @returns {Promise<T>}
   */
  const run = (mode, unit) => {
    if (state !== 'open') return Promise.reject(notOpen());
    return once(mode, unit).then(async first => {
      if (first.ok) return first.value;
      if (!isTransient(first.error)) throw failureOf(first.error);
      if (state !== 'open') throw notOpen();
      const second = await once(mode, unit);
      if (second.ok) return second.value;
      throw isTransient(second.error)
        ? new UnavailableError('storage', 'retries-exhausted', true)
        : failureOf(second.error);
    });
  };

  /** @returns {Promise<JournalRecord[]>} */
  const list = () =>
    run('readonly', store => /** @type {Promise<JournalRecord[]>} */ (result(store.getAll()))).then(inJournalOrder);

  return Object.freeze({
    open() {
      if (state === 'open') return Promise.resolve();
      if (state === 'gone') return Promise.reject(new UnavailableError('storage', 'reload-required', false));
      // One connection attempt at a time; a failed one leaves the next open() to try again
      if (!connecting) {
        state = 'opening';
        connecting = connect();
        connecting.catch(() => {
          connecting = null;
        });
      }
      const connected = connecting;
      const answer = new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new UnavailableError('storage', 'open-pending', true)), openWithinMs);
        connected.then(
          () => {
            clearTimeout(timer);
            resolve(undefined);
          },
          error => {
            clearTimeout(timer);
            reject(error);
          },
        );
      });
      answer.catch(() => {});
      return /** @type {Promise<void>} */ (answer);
    },
    put: entry =>
      run('readwrite', store => {
        store.put(entry);
      }),
    remove: opIds =>
      opIds.length === 0
        ? Promise.resolve()
        : run('readwrite', store => {
            for (const opId of opIds) store.delete(opId);
          }),
    mark: (opId, unreplayable) =>
      run('readwrite', async store => {
        const entry = await result(store.get(opId));
        if (entry && typeof entry === 'object') store.put({ ...entry, unreplayable });
      }),
    list,
    inFlight: () => list().then(entries => entries.map(({ v, command }) => ({ v, command }))),
    close() {
      if (db) db.close();
      db = null;
      state = 'gone';
    },
    state: () => state,
  });
}
