// A fault-injecting wrapper around an IndexedDB factory, its connections, and their
// transactions (#17, "Test plan"), over the pinned fake-indexeddb. It records every
// transaction opened, and makes the next write to a store throw, or go through and then have
// its transaction abort the way one the disk refuses at commit does, or the next read of a
// store fail. Everything else passes through to fake-indexeddb unchanged.

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
 * @property {(store: string, name: string) => void} abortAfterNextWrite
 *   The next put or delete on `store` succeeds, then its transaction aborts with a DOMException
 *   called `name`, as one the disk refuses at commit does (QuotaExceededError, UnknownError)
 * @property {(store: string, name: string) => void} failNextRead
 *   The next read of `store` fails with a DOMException called `name` and its transaction aborts,
 *   as a read of a damaged file does (NotReadableError, UnknownError)
 */

/**
 * Takes one planned fault for `store`, or undefined
 * @param {Array<{store: string, name: string}>} plans
 * @param {string} store
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
  /** @type {Array<{store: string, name: string}>} */
  const aborting = [];
  /** @type {Array<{store: string, name: string}>} */
  const unreadable = [];

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
      /** @param {'get' | 'getAll' | 'getAllKeys' | 'getKey' | 'count'} method */
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
      return { get: read('get'), getAll: read('getAll'), getAllKeys: read('getAllKeys') };
    };

    return wrap(tx, {
      get error() {
        return injected || tx.error;
      },
      objectStore: (/** @type {string} */ name) => {
        const store = tx.objectStore(name);
        /** @param {'put' | 'delete' | 'add' | 'clear'} method */
        const write =
          method =>
          (/** @type {unknown[]} */ ...args) => {
            const refused = take(throwing, name);
            if (refused) throw new DOMException(`A fault the test injected: ${refused.name}`, refused.name);
            const request = /** @type {any} */ (store)[method](...args);
            const late = take(aborting, name);
            if (late) request.addEventListener('success', () => abortWith(late.name));
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
      },
    });
  };

  /**
   * @param {IDBDatabase} db
   * @returns {IDBDatabase}
   */
  const wrapConnection = db =>
    wrap(db, {
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
    open: (/** @type {string} */ name, /** @type {number | undefined} */ version) => {
      const request = version === undefined ? real.open(name) : real.open(name, version);
      return wrap(request, {
        get result() {
          const db = request.result;
          if (!db) return db;
          if (!wrapped.has(db)) {
            connections.push(db);
            wrapped.set(db, wrapConnection(db));
          }
          return wrapped.get(db);
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
    abortAfterNextWrite: (store, name) => {
      aborting.push({ store, name });
    },
    failNextRead: (store, name) => {
      unreadable.push({ store, name });
    },
  };
}
