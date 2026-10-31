/**
 * The trust store in memory (ports.js, TrustStore), with NewTabNoteTrust's stores, keys, and
 * indexes, for tests and for a host with no IndexedDB. It keeps the same transaction rules as
 * #17's adapter: readwrite units run one at a time, a unit sees its own writes, and a unit
 * that throws leaves every store as it was. Records are copied in and out, so nothing a caller
 * holds changes what's stored.
 */

import { UnavailableError } from '../../kernel/core/contracts/outcomes.js';

/** @typedef {import('./ports.js').TrustStore} TrustStore */
/** @typedef {import('./ports.js').TrustStoreName} TrustStoreName */
/** @typedef {import('./ports.js').TrustTx} TrustTx */
/** @typedef {import('./ports.js').TrustKey} TrustKey */

/**
 * NewTabNoteTrust's layout, which js/kernel/adapters/indexeddb/trust.js creates at version 1.
 * test/kernel/trust-store.test.mjs holds the two equal.
 */
export const TRUST_STORES = Object.freeze({
  receipts: Object.freeze({ keyPath: 'id', autoIncrement: false, indexes: Object.freeze(['providerId', 'verifiedAt']), unique: Object.freeze([]) }),
  incidents: Object.freeze({ keyPath: 'id', autoIncrement: false, indexes: Object.freeze(['key', 'state']), unique: Object.freeze(['key']) }),
  runs: Object.freeze({ keyPath: 'id', autoIncrement: false, indexes: Object.freeze(['startedAt']), unique: Object.freeze([]) }),
  journal: Object.freeze({ keyPath: 'seq', autoIncrement: true, indexes: Object.freeze(['at']), unique: Object.freeze([]) }),
});

/** @param {unknown} value */
const copy = value => (value === undefined ? undefined : JSON.parse(JSON.stringify(value)));

/**
 * @param {TrustKey} a
 * @param {TrustKey} b
 */
const compare = (a, b) => {
  if (typeof a === typeof b) return a < b ? -1 : a > b ? 1 : 0;
  // IndexedDB orders numbers before strings
  return typeof a === 'number' ? -1 : 1;
};

/**
 * @param {{openError?: UnavailableError | null}} [options] - what open() rejects with, to stand
 *   in for an IndexedDB that won't open
 * @returns {TrustStore & {state: () => string}}
 */
export function createMemoryTrustStore({ openError = null } = {}) {
  /** @type {Record<TrustStoreName, Map<TrustKey, Record<string, any>>>} */
  const data = { receipts: new Map(), incidents: new Map(), runs: new Map(), journal: new Map() };
  let nextSeq = 1;
  let state = 'closed';
  /** @type {Promise<unknown>} */
  let writing = Promise.resolve();

  /**
   * @param {readonly TrustStoreName[]} stores
   * @param {boolean} writable
   * @returns {TrustTx}
   */
  const view = (stores, writable) => {
    /** @param {TrustStoreName} store */
    const inScope = store => {
      if (!Object.prototype.hasOwnProperty.call(TRUST_STORES, store)) throw new UnavailableError('adapter', 'unknown-store', false);
      if (!stores.includes(store)) throw new UnavailableError('adapter', 'store-outside-transaction', false);
      return data[store];
    };
    /** @param {TrustStoreName} store */
    const forWrite = store => {
      if (!writable) throw new UnavailableError('adapter', 'write-in-readonly-transaction', false);
      return inScope(store);
    };
    /**
     * @param {TrustStoreName} store
     * @param {Record<string, any>} record
     */
    const checkUnique = (store, record) => {
      const { keyPath, unique } = TRUST_STORES[store];
      for (const index of unique) {
        for (const other of data[store].values()) {
          if (other[keyPath] !== record[keyPath] && other[index] === record[index]) {
            throw new UnavailableError('storage', 'constraint', false);
          }
        }
      }
    };
    return {
      get: async (store, key) => copy(inScope(store).get(key)),
      getAll: async store => [...inScope(store).entries()].sort(([a], [b]) => compare(a, b)).map(([, record]) => copy(record)),
      getAllByIndex: async (store, index, value) =>
        [...inScope(store).entries()]
          .filter(([, record]) => record[index] === value)
          .sort(([a], [b]) => compare(a, b))
          .map(([, record]) => copy(record)),
      count: async store => inScope(store).size,
      keys: async (store, { index, below, limit } = {}) => {
        const { keyPath } = TRUST_STORES[store];
        const field = index || keyPath;
        let rows = [...inScope(store).values()]
          .filter(record => record[field] !== undefined)
          .sort((a, b) => compare(a[field], b[field]) || compare(a[keyPath], b[keyPath]));
        if (below !== undefined) rows = rows.filter(record => record[field] < below);
        if (limit !== undefined) rows = rows.slice(0, limit);
        return rows.map(record => record[keyPath]);
      },
      put: (store, record) => {
        const target = forWrite(store);
        const { keyPath } = TRUST_STORES[store];
        const stored = copy(record);
        if (stored[keyPath] === undefined) throw new UnavailableError('adapter', 'invalid-key', false);
        checkUnique(store, stored);
        target.set(stored[keyPath], stored);
      },
      append: async (store, record) => {
        const target = forWrite(store);
        const seq = nextSeq++;
        target.set(seq, { ...copy(record), seq });
        return seq;
      },
      delete: (store, key) => {
        forWrite(store).delete(key);
      },
    };
  };

  return {
    async open() {
      if (openError) {
        state = 'failed';
        throw openError;
      }
      state = 'open';
    },

    async run(stores, mode, unit) {
      if (state !== 'open') throw new UnavailableError('storage', state === 'failed' ? 'open-failed' : 'not-open', false);
      const writable = mode === 'readwrite';
      const go = async () => {
        /** @type {Partial<Record<TrustStoreName, Map<TrustKey, Record<string, any>>>>} */
        const before = {};
        for (const store of stores) before[store] = new Map(data[store]);
        const seqBefore = nextSeq;
        try {
          return await unit(view(stores, writable));
        } catch (error) {
          for (const store of stores) data[store] = /** @type {Map<TrustKey, Record<string, any>>} */ (before[store]);
          nextSeq = seqBefore;
          throw error;
        }
      };
      if (!writable) return go();
      // Readwrite units over any store run one at a time, as IndexedDB runs overlapping ones
      const turn = writing.then(go);
      writing = turn.catch(() => {});
      return turn;
    },

    close() {
      state = 'closed';
    },

    state: () => state,
  };
}
