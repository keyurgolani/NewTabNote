/**
 * NewTabNoteTrust on #17's IndexedDB adapter (#20, "Records"): the Trust Center's receipts,
 * incidents, remediation runs, and diagnostic journal, in their own database so a broken
 * CanvasTabDB can't stop an incident write. It's frozen at version 1: the upgrade only
 * creates stores and indexes a new database lacks, and a database at any other version is
 * refused, `version-too-new`, and left as it was.
 *
 * It keeps #17's transaction rules (adapter.js): a unit runs in one transaction over the
 * stores it names, readwrite with `durability: 'strict'` when it writes, and a run answers
 * only once that transaction fires `complete`. One that fires `abort` rejects with the
 * UnavailableError failures.js gives it, even after every request in it succeeded, so nothing
 * is reported written that didn't commit. A unit that throws aborts its transaction, so
 * nothing it wrote commits. An AbortError or UnknownError abort runs the unit once more in a
 * new transaction, which is safe because every trust unit reads what it updates in the same
 * transaction, and answers `retries-exhausted` if that fails too.
 *
 * Everything it stores is `diagnostic` (#17's classification): never in a backup or in sync.
 * js/trust/core/ validates every record before it reaches this adapter. The adapter knows
 * nothing about bounds or keys beyond the layout below, which js/trust/core/memory-store.js
 * repeats and test/kernel/trust-store.test.mjs holds equal. The service worker's and the new
 * tab's failure events (js/kernel/composition/trust.js) open it on their first failure.
 */

import { UnavailableError } from '../../core/contracts/outcomes.js';
import { failureOf, isTransient, openFailureOf } from './failures.js';
import { abort, endOf, result } from './requests.js';

/** @typedef {import('../../../trust/core/ports.js').TrustStore} TrustStore */
/** @typedef {import('../../../trust/core/ports.js').TrustStoreName} TrustStoreName */
/** @typedef {import('../../../trust/core/ports.js').TrustTx} TrustTx */

export const TRUST_DB_NAME = 'NewTabNoteTrust';

/** Frozen at 1: a new store goes in a new database, never an upgrade of this one */
export const TRUST_DB_VERSION = 1;

/** The layout of version 1 */
export const TRUST_DB_STORES = Object.freeze({
  receipts: Object.freeze({
    keyPath: 'id',
    autoIncrement: false,
    indexes: Object.freeze(['providerId', 'verifiedAt']),
    unique: Object.freeze([]),
  }),
  incidents: Object.freeze({
    keyPath: 'id',
    autoIncrement: false,
    indexes: Object.freeze(['key', 'state']),
    unique: Object.freeze(['key']),
  }),
  runs: Object.freeze({
    keyPath: 'id',
    autoIncrement: false,
    indexes: Object.freeze(['startedAt']),
    unique: Object.freeze([]),
  }),
  journal: Object.freeze({
    keyPath: 'seq',
    autoIncrement: true,
    indexes: Object.freeze(['at']),
    unique: Object.freeze([]),
  }),
});

/**
 * How long open() waits for an open that hasn't finished, as connection.js waits. It then
 * answers `open-pending` and keeps connecting, and the next open() answers once the connection
 * has. An open that failed is tried again by the next open().
 */
export const TRUST_OPEN_WITHIN_MS = 5000;

/** @type {IDBTransactionOptions} */
const STRICT = Object.freeze({ durability: 'strict' });

/** How a transaction ends, Chrome's close of its connection included (requests.js) */
const ending = endOf;

/**
 * Creates each store and index version 1 has that `db` lacks. Runs only inside the upgrade.
 * @param {IDBDatabase} db
 * @param {IDBTransaction | null} upgrade
 */
function createStores(db, upgrade) {
  for (const [name, { keyPath, autoIncrement, indexes, unique }] of Object.entries(TRUST_DB_STORES)) {
    const store = db.objectStoreNames.contains(name)
      ? /** @type {IDBTransaction} */ (upgrade).objectStore(name)
      : db.createObjectStore(name, { keyPath, autoIncrement });
    for (const index of indexes) {
      if (!store.indexNames.contains(index))
        store.createIndex(index, index, { unique: /** @type {readonly string[]} */ (unique).includes(index) });
    }
  }
}

/**
 * @param {{
 *   indexedDB: IDBFactory,
 *   keyRange?: {upperBound(bound: unknown, open?: boolean): IDBKeyRange},
 *   openWithinMs?: number,
 * }} options - `keyRange` is IDBKeyRange unless given
 * @returns {TrustStore & {state: () => string}}
 */
export function createTrustDatabase({ indexedDB, keyRange, openWithinMs = TRUST_OPEN_WITHIN_MS }) {
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
  // Read when a range is first needed, so a host without the global can still open
  const ranges = () =>
    keyRange || /** @type {{upperBound(bound: unknown, open?: boolean): IDBKeyRange}} */ (IDBKeyRange);

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
        request = indexedDB.open(TRUST_DB_NAME, TRUST_DB_VERSION);
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

  /**
   * @param {IDBDatabase} database
   * @param {IDBTransaction} tx
   * @param {readonly TrustStoreName[]} stores
   * @param {boolean} writable
   * @returns {TrustTx}
   */
  const view = (database, tx, stores, writable) => {
    /** @param {TrustStoreName} store */
    const handle = store => {
      if (!Object.prototype.hasOwnProperty.call(TRUST_DB_STORES, store))
        throw new UnavailableError('adapter', 'unknown-store', false);
      if (!stores.includes(store)) throw new UnavailableError('adapter', 'store-outside-transaction', false);
      if (!database.objectStoreNames.contains(store)) throw new UnavailableError('storage', 'store-unavailable', false);
      return tx.objectStore(store);
    };
    /** @param {TrustStoreName} store */
    const writing = store => {
      if (!writable) throw new UnavailableError('adapter', 'write-in-readonly-transaction', false);
      return handle(store);
    };
    return {
      get: (store, key) => result(handle(store).get(key)),
      getAll: store => result(handle(store).getAll()),
      getAllByIndex: (store, index, value) => result(handle(store).index(index).getAll(value)),
      count: store => result(handle(store).count()),
      keys: async (store, { index, below, limit } = {}) => {
        const objectStore = handle(store);
        const range = below === undefined ? null : ranges().upperBound(below, true);
        const source = index ? objectStore.index(index) : objectStore;
        return /** @type {Promise<(string | number)[]>} */ (result(source.getAllKeys(range, limit)));
      },
      put: (store, record) => {
        writing(store).put(record);
      },
      append: async (store, record) => /** @type {number} */ (await result(writing(store).add(record))),
      delete: (store, key) => {
        writing(store).delete(key);
      },
    };
  };

  /**
   * One run of `unit` in its own transaction
   * @template T
   * @param {readonly TrustStoreName[]} stores
   * @param {'readonly' | 'readwrite'} mode
   * @param {(tx: TrustTx) => Promise<T>} unit
   * @returns {Promise<{ok: true, value: T} | {ok: false, error: unknown}>}
   */
  const once = async (stores, mode, unit) => {
    const database = /** @type {IDBDatabase} */ (db);
    /** @type {IDBTransaction} */
    let tx;
    try {
      tx = database.transaction([...stores], mode, mode === 'readwrite' ? STRICT : undefined);
    } catch (error) {
      if (state === 'open' && /** @type {{name?: unknown}} */ (error)?.name === 'InvalidStateError') lose();
      return {
        ok: false,
        error: state === 'lost' ? new UnavailableError('storage', 'database-closed', true) : failureOf(error),
      };
    }
    const ended = ending(tx);
    /** @type {T} */
    let value;
    try {
      value = await unit(view(database, tx, stores, mode === 'readwrite'));
    } catch (error) {
      abort(tx);
      const end = await ended;
      // A request the transaction refused at commit is the transaction's failure, not the unit's
      if (!end.committed && end.error) return { ok: false, error: end.error };
      throw error;
    }
    const end = await ended;
    if (end.committed) return { ok: true, value };
    return { ok: false, error: end.error };
  };

  return {
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
      // Answers within openWithinMs; an open that answered open-pending keeps connecting, and
      // the next open() answers once it has
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

    async run(stores, mode, unit) {
      if (state !== 'open') {
        if (state === 'failed' && failure) throw failure;
        if (state === 'opening') throw new UnavailableError('storage', 'open-pending', true);
        if (state === 'lost') throw new UnavailableError('storage', 'database-closed', true);
        if (state === 'gone') throw new UnavailableError('storage', 'reload-required', false);
        throw new UnavailableError('adapter', 'not-open', false);
      }
      const first = await once(stores, mode, unit);
      if (first.ok) return first.value;
      if (!isTransient(first.error)) throw failureOf(first.error);
      const second = await once(stores, mode, unit);
      if (second.ok) return second.value;
      throw isTransient(second.error)
        ? new UnavailableError('storage', 'retries-exhausted', true)
        : failureOf(second.error);
    },

    close() {
      if (db) db.close();
      state = 'gone';
    },

    state: () => state,
  };
}
