/**
 * The legacy kernel adapter (#12, "Layout"): the kernel's ports over the storage 1.4.x
 * ships, DatabaseManager (js/storage.js) for IndexedDB and chrome.storage.local for
 * settings. It writes the same records to the same stores, so nothing about the data
 * changes, and it guarantees less than the contract suite asks of #17's adapter:
 * - atomicMultiStore: false. Each unit commits in its own transaction, as DatabaseManager's
 *   methods always have, so a later unit's failure leaves the earlier units' writes in place.
 *   saveNoteContent is one unit, so its note fields and blocks still commit together.
 * - revisions: false. Records have none, so a save over a newer write wins, and two contexts
 *   saving one note's blocks race until #35's coordinator serializes them.
 * - idempotency: false. Nothing keeps a commandId's outcome, so a resent command runs again.
 * Each gap is a declared-gap row in docs/architecture/kernel-ledger.json, owned by #17.
 *
 * The new tab and the service worker open it `versioned`: Storage.open, which upgrades an
 * older database to version 8 as Storage.init always has. Popup and Side Panel open it
 * `existing`: whatever version is on disk, with no repair, upgrade, or maintenance. A
 * database a newer build upgraded is refused either way, as `unavailable` with cause
 * `newer-schema`.
 */

import { UnavailableError, unavailable, unavailableFrom } from '../../core/contracts/outcomes.js';

/** @typedef {import('../../core/ports/repository.js').CommitResult} CommitResult */
/** @typedef {import('../../core/ports/repository.js').KernelAdapter} KernelAdapter */
/** @typedef {import('../../core/ports/repository.js').StoreName} StoreName */
/** @typedef {import('../../core/ports/repository.js').SettingsArea} SettingsArea */
/** @typedef {import('../../core/ports/repository.js').Tx} Tx */
/** @typedef {import('../../core/ports/repository.js').Unit} Unit */
/** @typedef {import('../../core/ports/repository.js').Work} Work */
/** @typedef {import('../../core/contracts/outcomes.js').Outcome} Outcome */

/**
 * The parts of js/storage.js's DatabaseManager this adapter uses. TypeScript reads the
 * legacy `Storage` global as the DOM's Storage, so a composition root passes the instance in.
 * @typedef {object} LegacyStorage
 * @property {(name: string) => boolean} hasStore
 * @property {(storeNames: string | string[], mode?: IDBTransactionMode) => IDBTransaction} transaction
 * @property {() => Promise<void>} open
 * @property {() => Promise<void>} openExisting
 * @property {() => Promise<void>} runStartupMaintenance
 */

/**
 * chrome.storage.local, or anything with its promise-returning get and set.
 * @typedef {object} SettingsStore
 * @property {(keys: string[]) => Promise<Record<string, unknown>>} get
 * @property {(items: Record<string, unknown>) => Promise<void>} set
 */

/** @typedef {'versioned' | 'existing'} OpenMode */

/** @typedef {KernelAdapter & {mode: OpenMode, open: () => Promise<void>}} LegacyAdapter */

/** Each kernel store's IndexedDB store, under the names 1.4.x has always used */
export const IDB_STORES = Object.freeze({
  notes: 'canvases',
  blocks: 'elements',
  folders: 'folders',
  searchIndex: 'search_index',
  media: 'media',
  vectors: 'vectors',
  snapshots: 'snapshots',
});

/**
 * Derived from the notes, so a database without it skips its writes, as Storage.createNote
 * and Storage.updateNote do. A write to any other missing store fails the command.
 * @type {readonly StoreName[]}
 */
const DERIVED_STORES = Object.freeze(['searchIndex']);

/**
 * The chrome.storage.local key a setting lives under: `setting_<key>`, as Storage.setSetting
 * writes it, except the last-opened note, which TabController writes under its own name.
 * @param {SettingsArea | string} area
 * @param {string} key
 * @returns {string}
 */
const settingKey = (area, key) => (area === 'session' && key === 'lastOpenedNoteId' ? key : `setting_${key}`);

/**
 * The UnavailableError for what DatabaseManager, IndexedDB, or chrome.storage threw.
 * @param {unknown} error
 * @returns {UnavailableError}
 */
function storageError(error) {
  if (error instanceof UnavailableError) return error;
  const { code, name, message } = /** @type {{code?: unknown, name?: unknown, message?: unknown}} */ (error || {});
  if (code === 'NEWER_SCHEMA') return new UnavailableError('newer-schema', 'newer-schema', false);
  if (code === 'MISSING_CORE_STORES') return new UnavailableError('storage', 'missing-core-stores', false);
  if (code === 'STORE_UNAVAILABLE') return new UnavailableError('storage', 'store-unavailable', false);
  if (code === 'OPEN_FAILED') return new UnavailableError('storage', 'open-failed', true);
  // Popup or Side Panel opened before any new tab made the database
  if (code === 'NO_DATABASE') return new UnavailableError('storage', 'no-database', true);
  if (name === 'QuotaExceededError' || /quota/i.test(String(message))) {
    return new UnavailableError('quota', 'quota-exceeded', false);
  }
  if (name === 'InvalidStateError') return new UnavailableError('storage', 'database-closed', true);
  if (name === 'DataCloneError') return new UnavailableError('adapter', 'not-cloneable', false);
  return new UnavailableError('storage', 'transaction-failed', true);
}

/**
 * @template T
 * @param {IDBRequest<T>} request
 * @returns {Promise<T>}
 */
function result(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

/**
 * Resolves when the transaction commits, and rejects when it aborts.
 * @param {IDBTransaction} tx
 * @returns {Promise<void>}
 */
function completion(tx) {
  const done = new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve(undefined);
    tx.onabort = () => reject(tx.error || new DOMException('The transaction was aborted', 'AbortError'));
  });
  // Handled where it matters; an abort the adapter asked for isn't a failure to report
  done.catch(() => {});
  return /** @type {Promise<void>} */ (done);
}

/** @param {IDBTransaction | null} tx */
function abort(tx) {
  try {
    if (tx) tx.abort();
  } catch {
    // Already finished
  }
}

/**
 * @param {LegacyStorage} storage
 * @param {readonly StoreName[]} stores
 * @returns {string[]} the IndexedDB stores among `stores` the database has
 */
function presentStores(storage, stores) {
  return stores.map(store => IDB_STORES[store]).filter(name => storage.hasStore(name));
}

/**
 * The kernel's view of one transaction over `scope`. A store the database lacks reads as
 * empty, as DatabaseManager's reads of auxiliary stores do.
 * @param {LegacyStorage} storage
 * @param {IDBTransaction | null} tx - null when the database has none of the scope's stores
 * @param {readonly StoreName[]} scope
 * @returns {Tx}
 */
function view(storage, tx, scope) {
  /**
   * @param {StoreName} store
   * @returns {IDBObjectStore | null}
   */
  const handle = store => {
    if (!scope.includes(store)) throw new UnavailableError('adapter', 'store-outside-transaction', false);
    const name = IDB_STORES[store];
    return tx && storage.hasStore(name) ? tx.objectStore(name) : null;
  };
  return /** @type {Tx} */ ({
    get: async (store, key) => {
      const objectStore = handle(store);
      return objectStore ? result(objectStore.get(key)) : undefined;
    },
    getAll: async store => {
      const objectStore = handle(store);
      return objectStore ? result(objectStore.getAll()) : [];
    },
    getAllByIndex: async (store, index, value) => {
      const objectStore = handle(store);
      return objectStore ? result(objectStore.index(index).getAll(value)) : [];
    },
    getKeysByIndex: async (store, index, value) => {
      const objectStore = handle(store);
      return objectStore ? result(objectStore.index(index).getAllKeys(value)) : [];
    },
    revision: store => {
      handle(store);
      return undefined;
    },
    put: (store, record) => {
      const objectStore = handle(store);
      if (objectStore) objectStore.put(record);
      else if (!DERIVED_STORES.includes(store)) throw new UnavailableError('storage', 'store-unavailable', false);
    },
    delete: (store, key) => {
      const objectStore = handle(store);
      if (objectStore) objectStore.delete(key);
    },
  });
}

/**
 * Run one unit in its own transaction, opened before this returns. Resolves with the
 * unit's rejection or conflict, if it returned one, once the transaction is aborted, and
 * with undefined once it commits.
 * @param {LegacyStorage} storage
 * @param {Unit} unit
 * @returns {Promise<Outcome | undefined>}
 */
function runUnit(storage, unit) {
  const names = presentStores(storage, unit.stores);
  const tx = names.length > 0 ? storage.transaction(names, unit.mode || 'readwrite') : null;
  const committed = tx ? completion(tx) : Promise.resolve();
  return unit.run(view(storage, tx, unit.stores)).then(
    async stop => {
      if (stop) {
        abort(tx);
        await committed.catch(() => {});
        return stop;
      }
      await committed;
      return undefined;
    },
    async error => {
      abort(tx);
      await committed.catch(() => {});
      throw error;
    },
  );
}

/**
 * @param {{storage: LegacyStorage, settings: SettingsStore, mode?: OpenMode}} options
 * @returns {LegacyAdapter}
 */
export function createLegacyAdapter({ storage, settings, mode = 'versioned' }) {
  /**
   * @param {Work} work
   * @param {Unit[]} units
   * @returns {Promise<Outcome>}
   */
  const runUnits = async (work, units) => {
    try {
      for (const unit of units) {
        if (unit.when && !unit.when()) continue;
        const stop = await runUnit(storage, unit);
        if (stop) return stop;
      }
      return work.done();
    } catch (error) {
      return unavailableFrom(storageError(error));
    }
  };

  /**
   * Nothing is kept per commandId, so no outcome is ever a replay.
   * @param {Promise<Outcome>} outcome
   * @returns {Promise<CommitResult>}
   */
  const fresh = outcome => outcome.then(value => ({ outcome: value, replayed: false }));

  return Object.freeze({
    name: 'legacy',
    mode,
    flags: Object.freeze({ atomicMultiStore: false, revisions: false, idempotency: false }),

    async open() {
      try {
        if (mode === 'versioned') await storage.open();
        else await storage.openExisting();
      } catch (error) {
        throw storageError(error);
      }
    },

    recall: () => undefined,

    commit(work) {
      const { effect } = work;
      if (effect.kind === 'units') return fresh(runUnits(work, effect.units));
      if (effect.kind === 'settings') {
        const items = Object.fromEntries(
          Object.entries(effect.values).map(([key, value]) => [settingKey(effect.area, key), value]),
        );
        return fresh(
          settings.set(items).then(
            () => work.done(),
            error => unavailableFrom(storageError(error)),
          ),
        );
      }
      // Popup and Side Panel never repair or maintain the database
      if (mode !== 'versioned') {
        return fresh(Promise.resolve(unavailable('adapter', 'maintenance-needs-versioned-open', false)));
      }
      return fresh(
        storage.runStartupMaintenance().then(
          () => work.done(),
          error => unavailableFrom(storageError(error)),
        ),
      );
    },

    async read(stores, body) {
      for (const store of stores) {
        if (!Object.hasOwn(IDB_STORES, store)) throw new UnavailableError('adapter', 'unknown-store', false);
      }
      try {
        const names = presentStores(storage, stores);
        const tx = names.length > 0 ? storage.transaction(names, 'readonly') : null;
        return await body(view(storage, tx, stores));
      } catch (error) {
        throw storageError(error);
      }
    },

    async readSettings(area, keys) {
      const storageKeys = keys.map(key => settingKey(area, key));
      /** @type {Record<string, unknown>} */
      let stored;
      try {
        stored = await settings.get(storageKeys);
      } catch {
        throw new UnavailableError('storage', 'settings-read-failed', true);
      }
      /** @type {Record<string, unknown>} */
      const values = {};
      keys.forEach((key, index) => {
        const value = stored[storageKeys[index]];
        if (value !== undefined) values[key] = value;
      });
      return values;
    },
  });
}
