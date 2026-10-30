// A fault-injecting wrapper around an IndexedDB factory, its connections, and their
// transactions (#17, "Test plan"), over the pinned fake-indexeddb. It records every
// transaction opened, and makes the next write to a store throw, or go through and then have
// its transaction abort the way one the disk refuses at commit does, or the next read of a
// store fail. #17 PR 1a adds the open (the next open of a database fails, as a VersionError
// does), cursors among the reads, and the stores a `versionchange` creates or reaches, so a
// fault lands inside an upgrade too, on CanvasTabDB and NewTabNoteRecovery alike. Everything
// else passes through to fake-indexeddb unchanged.

/**
 * @typedef {object} OpenedTransaction
 * @property {string[]} names
 * @property {IDBTransactionMode} mode
 * @property {IDBTransactionDurability | undefined} durability
 * @property {IDBTransaction} tx - fake-indexeddb's, for a test to watch its events
 */

/**
 * @typedef {object} Faults
 * @property {IDBFactory} factory - hand this to the adapter
 * @property {OpenedTransaction[]} transactions - every transaction a wrapped connection opened, in order
 * @property {IDBDatabase[]} connections - the fake-indexeddb connections the wrapped factory opened
 * @property {(store: string, name: string) => void} throwOnNextWrite
 *   The next put or delete on `store` throws a DOMException called `name`, as a request the
 *   browser refuses at once does (DataCloneError, DataError)
 * @property {(store: string, name: string) => Promise<void>} abortAfterNextWrite
 *   The next put or delete on `store` succeeds, then its transaction aborts with a DOMException
 *   called `name`, as one the disk refuses at commit does (QuotaExceededError, UnknownError).
 *   Resolves once the abort has reached every listener the transaction had when it aborted,
 *   the adapter's included, so a unit that awaits it is still away when the adapter hears.
 * @property {(store: string, name: string) => void} failNextRead
 *   The next read of `store` fails with a DOMException called `name` and its transaction aborts,
 *   as a read of a damaged file does (NotReadableError, UnknownError)
 * @property {string[]} deletes - every database name the wrapped factory was asked to delete
 * @property {(database: string, name: string) => void} failNextOpen
 *   The next open of `database` fails with a DOMException called `name`, touching nothing, as
 *   an open below the version on disk does (VersionError)
 */

/**
 * Takes one planned fault for `store`, or undefined
 * @template {{store: string, name: string}} P
 * @param {P[]} plans
 * @param {string} store
 * @returns {P | undefined}
 */
function take(plans, store) {
  const index = plans.findIndex(plan => plan.store === store);
  return index === -1 ? undefined : plans.splice(index, 1)[0];
}

/**
 * `target` with its methods bound to it, and `overrides` in place of some of its properties
 * @template {object} T
 * @param {T} target
 * @param {Record<string | symbol, unknown>} overrides
 * @returns {T}
 */
function wrap(target, overrides) {
  return new Proxy(target, {
    get(object, property) {
      if (Object.hasOwn(overrides, property)) return overrides[property];
      const value = Reflect.get(object, property, object);
      return typeof value === 'function' ? value.bind(object) : value;
    },
    set(object, property, value) {
      return Reflect.set(object, property, value, object);
    },
  });
}

/**
 * @param {IDBFactory} real
 * @returns {Faults}
 */
export function faultyFactory(real) {
  /** @type {OpenedTransaction[]} */
  const transactions = [];
  /** @type {IDBDatabase[]} */
  const connections = [];
  /** @type {Array<{store: string, name: string}>} */
  const throwing = [];
  /** @type {Array<{store: string, name: string, delivered: () => void}>} */
  const aborting = [];
  /** @type {Array<{store: string, name: string}>} */
  const unreadable = [];
  /** @type {Array<{store: string, name: string}>} */
  const unopenable = [];
  /** @type {string[]} */
  const deletes = [];

  /**
   * @param {IDBTransaction} tx
   * @returns {IDBTransaction}
   */
  const wrapTransaction = tx => {
    /** @type {DOMException | null} */
    let injected = null;
    /**
     * Aborts the transaction with `name` as its error
     * @param {string} name
     */
    const abortWith = name => {
      injected = new DOMException(`A fault the test injected: ${name}`, name);
      try {
        tx.abort();
      } catch {
        // Already finished
      }
    };

    /**
     * @param {string} storeName
     * @param {IDBObjectStore | IDBIndex} source
     * @returns {Record<string, unknown>}
     */
    const reads = (storeName, source) => {
      /** @param {'get' | 'getAll' | 'getAllKeys' | 'getKey' | 'count' | 'openCursor'} method */
      const read =
        method =>
        (/** @type {unknown[]} */ ...args) => {
          const fault = take(unreadable, storeName);
          if (!fault) return /** @type {any} */ (source)[method](...args);
          // A request that fails, as fake-indexeddb has no way to fail a real one
          const request = /** @type {any} */ ({ result: undefined, error: null, readyState: 'pending' });
          setImmediate(() => {
            request.readyState = 'done';
            request.error = new DOMException(`A fault the test injected: ${fault.name}`, fault.name);
            if (typeof request.onerror === 'function') request.onerror({ type: 'error', target: request });
            abortWith(fault.name);
          });
          return request;
        };
      return {
        get: read('get'),
        getAll: read('getAll'),
        getAllKeys: read('getAllKeys'),
        openCursor: read('openCursor'),
      };
    };

    /**
     * `store` with its writes and reads open to faults
     * @param {string} name
     * @param {IDBObjectStore} store
     * @returns {IDBObjectStore}
     */
    const wrapStore = (name, store) => {
      /** @param {'put' | 'delete' | 'add' | 'clear'} method */
      const write =
        method =>
        (/** @type {unknown[]} */ ...args) => {
          const refused = take(throwing, name);
          if (refused) throw new DOMException(`A fault the test injected: ${refused.name}`, refused.name);
          const request = /** @type {any} */ (store)[method](...args);
          const late = take(aborting, name);
          if (late) {
            request.addEventListener('success', () => {
              abortWith(late.name);
              // Added after every listener the transaction already had, so it hears last
              tx.addEventListener('abort', late.delivered, { once: true });
            });
          }
          return request;
        };
      return wrap(store, {
        put: write('put'),
        delete: write('delete'),
        add: write('add'),
        clear: write('clear'),
        ...reads(name, store),
        index: (/** @type {string} */ indexName) => {
          const index = store.index(indexName);
          return wrap(index, reads(name, index));
        },
      });
    };

    const wrapped = wrap(tx, {
      get error() {
        return injected || tx.error;
      },
      objectStore: (/** @type {string} */ name) => wrapStore(name, tx.objectStore(name)),
    });
    storeWrappers.set(wrapped, wrapStore);
    return wrapped;
  };

  /** Each wrapped transaction's store wrapper, for the stores an upgrade creates */
  /** @type {WeakMap<IDBTransaction, (name: string, store: IDBObjectStore) => IDBObjectStore>} */
  const storeWrappers = new WeakMap();
  /** Each connection's running upgrade, wrapped */
  /** @type {WeakMap<IDBDatabase, IDBTransaction>} */
  const upgrades = new WeakMap();

  /**
   * @param {IDBDatabase} db
   * @returns {IDBDatabase}
   */
  const wrapConnection = db =>
    wrap(db, {
      createObjectStore: (/** @type {string} */ name, /** @type {IDBObjectStoreParameters | undefined} */ options) => {
        const store = db.createObjectStore(name, options);
        const upgrade = upgrades.get(db);
        const wrapStore = upgrade && storeWrappers.get(upgrade);
        return wrapStore ? wrapStore(name, store) : store;
      },
      transaction: (
        /** @type {string | string[]} */ names,
        /** @type {IDBTransactionMode | undefined} */ mode,
        /** @type {IDBTransactionOptions | undefined} */ options,
      ) => {
        const tx = db.transaction(names, mode, options);
        transactions.push({
          names: [names].flat(),
          mode: mode || 'readonly',
          durability: options && options.durability,
          tx,
        });
        return wrapTransaction(tx);
      },
    });

  /** @type {WeakMap<IDBDatabase, IDBDatabase>} */
  const wrapped = new WeakMap();

  const factory = wrap(real, {
    deleteDatabase: (/** @type {string} */ name) => {
      deletes.push(name);
      return real.deleteDatabase(name);
    },
    open: (/** @type {string} */ name, /** @type {number | undefined} */ version) => {
      const refused = take(unopenable, name);
      if (refused) {
        // A request that fails, touching nothing
        const failing = /** @type {any} */ ({
          result: undefined,
          error: null,
          readyState: 'pending',
          transaction: null,
        });
        setImmediate(() => {
          failing.readyState = 'done';
          failing.error = new DOMException(`A fault the test injected: ${refused.name}`, refused.name);
          if (typeof failing.onerror === 'function') failing.onerror({ type: 'error', target: failing });
        });
        return failing;
      }
      const request = version === undefined ? real.open(name) : real.open(name, version);
      /** @type {IDBTransaction | null} */
      let upgrade = null;
      const connection = () => {
        const db = request.result;
        if (!db) return db;
        if (!wrapped.has(db)) {
          connections.push(db);
          wrapped.set(db, wrapConnection(db));
        }
        return /** @type {IDBDatabase} */ (wrapped.get(db));
      };
      return wrap(request, {
        get result() {
          return connection();
        },
        get transaction() {
          const tx = request.transaction;
          if (!tx) return tx;
          if (!upgrade) {
            upgrade = wrapTransaction(tx);
            upgrades.set(request.result, upgrade);
          }
          return upgrade;
        },
      });
    },
  });

  return {
    factory,
    transactions,
    connections,
    throwOnNextWrite: (store, name) => {
      throwing.push({ store, name });
    },
    abortAfterNextWrite: (store, name) =>
      new Promise(resolve => {
        aborting.push({ store, name, delivered: () => resolve(undefined) });
      }),
    failNextRead: (store, name) => {
      unreadable.push({ store, name });
    },
    deletes,
    failNextOpen: (database, name) => {
      unopenable.push({ store: database, name });
    },
  };
}
