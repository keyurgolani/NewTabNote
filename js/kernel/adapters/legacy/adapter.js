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
 * - backups: true. The legacy import and auto-backup run here, through Storage's own code,
 *   which #18's backup engine replaces; the other adapters don't run them yet.
 *
 * The new tab and the service worker open it `versioned`: Storage.open, which upgrades an
 * older database to version 8 as Storage.init always has, and watches the connection. Their kernels set
 * `maintainOnOpen`, so Storage's startup maintenance runs before any command does, as
 * Storage.init ran it before the app did anything; its first run writes every default over
 * what's stored, so nothing may come before it. Popup and Side Panel open it `existing`:
 * whatever version is on disk, with no repair, upgrade, or maintenance. A database a newer
 * build upgraded is refused either way, as `unavailable` with cause `newer-schema`. Once
 * another context upgrades the database, or Chrome closes an `existing` connection itself,
 * that connection is gone, and every IndexedDB call answers `reload-required`, which no
 * resend fixes: the page reloads to open it again.
 */

import { STORAGE_EXCEPTIONS, UnavailableError, rejected, unavailable, unavailableFrom } from '../../core/contracts/outcomes.js';
import { IDB_SETTINGS_KEYS } from '../../core/ports/repository.js';
// The store names, setting keys, and request helpers #17's adapter uses, so the two agree
import { abort, indexValue, result } from '../indexeddb/requests.js';
import { DERIVED_STORES, IDB_STORES } from '../indexeddb/schema.js';
import { settingKey } from '../indexeddb/settings.js';

/** @typedef {import('../../core/ports/repository.js').CommitResult} CommitResult */
/** @typedef {import('../../core/ports/repository.js').KernelAdapter} KernelAdapter */
/** @typedef {import('../../core/ports/repository.js').StoreName} StoreName */
/** @typedef {import('../../core/ports/repository.js').SettingsArea} SettingsArea */
/** @typedef {import('../../core/ports/repository.js').ReadableSettingsArea} ReadableSettingsArea */
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
 * @property {(options?: {watchConnection?: boolean}) => Promise<void>} open
 * @property {() => Promise<void>} openExisting
 * @property {() => Promise<void>} runStartupMaintenance
 * @property {string} openState - `version-changed` or `closed-by-browser` once a connection openExisting opened is gone
 * @property {(flush: () => void) => () => void} beforeConnectionCloses - runs `flush` when another
 *   context upgrades the database, before a watched connection closes
 * @property {(data: unknown, mode: 'merge' | 'replace') => Promise<import('../../core/ports/repository.js').ImportReceipt>} importData
 *   1.4.x's import, recovery copy before Replace all included, in one transaction
 * @property {() => Promise<void>} createAutoBackup - 1.4.x's automatic backup, keeping the newest three
 */

/**
 * chrome.storage.local, or anything with its promise-returning get and set.
 * @typedef {object} SettingsStore
 * @property {(keys: string[]) => Promise<Record<string, unknown>>} get
 * @property {(items: Record<string, unknown>) => Promise<void>} set
 */

/** @typedef {'versioned' | 'existing'} OpenMode */

/** @typedef {KernelAdapter & {mode: OpenMode, open: () => Promise<void>}} LegacyAdapter */

/**
 * The UnavailableError for what DatabaseManager, IndexedDB, or chrome.storage threw, which it
 * keeps as its cause, for a log. Where a failure is one #17's adapter also answers, the cause
 * and code are the same (#17, "Transactions"): a newer database is `version-too-new`, and a
 * full disk is `quota`.
 * @param {unknown} error
 * @returns {UnavailableError}
 */
function storageError(error) {
  if (error instanceof UnavailableError) return error;
  const { code, name, message } = /** @type {{code?: unknown, name?: unknown, message?: unknown}} */ (error || {});
  const thrown = { cause: error };
  if (code === 'NEWER_SCHEMA') return new UnavailableError('newer-schema', 'version-too-new', false, thrown);
  if (code === 'MISSING_CORE_STORES') return new UnavailableError('storage', 'missing-core-stores', false, thrown);
  if (code === 'STORE_UNAVAILABLE') return new UnavailableError('storage', 'store-unavailable', false, thrown);
  if (code === 'OPEN_FAILED') return new UnavailableError('storage', 'open-failed', true, thrown);
  // Popup or Side Panel opened before any new tab made the database
  if (code === 'NO_DATABASE') return new UnavailableError('storage', 'no-database', true, thrown);
  if (name === 'QuotaExceededError' || /quota/i.test(String(message))) {
    return new UnavailableError('quota', 'quota', false, thrown);
  }
  if (name === 'InvalidStateError') return new UnavailableError('storage', 'database-closed', true, thrown);
  if (name === 'DataCloneError') return new UnavailableError('adapter', 'not-cloneable', false, thrown);
  return new UnavailableError('storage', 'transaction-failed', true, thrown);
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

/**
 * @param {LegacyStorage} storage
 * @param {readonly StoreName[]} stores
 * @returns {string[]} the IndexedDB stores among `stores` the database has
 */
function presentStores(storage, stores) {
  return stores.map(store => IDB_STORES[store]).filter(name => storage.hasStore(name));
}

/**
 * The object store `name` in `tx`. This is the one place the legacy adapter opens a store
 * (#17's objectStore rule): for its transaction view, and for the read of IndexedDB's
 * settings store Popup has always made.
 * @param {IDBTransaction} tx
 * @param {string} name
 * @returns {IDBObjectStore}
 */
function storeIn(tx, name) {
  return tx.objectStore(name);
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
    return tx && storage.hasStore(name) ? storeIn(tx, name) : null;
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
      const key = indexValue(value);
      return objectStore ? result(objectStore.index(index).getAll(key)) : [];
    },
    getKeysByIndex: async (store, index, value) => {
      const objectStore = handle(store);
      const key = indexValue(value);
      return objectStore ? result(objectStore.index(index).getAllKeys(key)) : [];
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
 * `reopen`, for a `versioned` open, watches the connection, and opens the database again when
 * it goes, before the next IndexedDB call: the service worker's root sets it, since a worker
 * has no page to reload. A reopen after a newer build's upgrade is refused as `newer-schema`,
 * and the next call tries again. A command that reopens awaits the open before its first
 * transaction, so only the worker, which runs no editor save, sets it.
 * @param {{storage: LegacyStorage, settings: SettingsStore, mode?: OpenMode, reopen?: boolean}} options
 * @returns {LegacyAdapter}
 */
export function createLegacyAdapter({ storage, settings, mode = 'versioned', reopen = false }) {
  /**
   * Whether the connection is gone: another context upgraded or deleted the database, or
   * Chrome closed the connection itself. A page's only comes back with a reload (#17: pages
   * ask for a reload), so every IndexedDB call answers `reload-required`, which no resend
   * fixes, and the worker's opens again (`reopen`). Each read, and each unit of a command,
   * checks first, since one that finds a store missing on the old connection would attempt no
   * transaction to fail.
   * @returns {boolean}
   */
  const reloadRequired = () => storage.openState === 'version-changed' || storage.openState === 'closed-by-browser';

  const reloadError = () => new UnavailableError('storage', 'reload-required', false);

  const reopens = reopen && mode === 'versioned';

  /**
   * The reopen running now, which every call that finds the connection gone waits for, so two
   * captures share one open
   * @type {Promise<void> | null}
   */
  let reopening = null;

  /**
   * Whether the next IndexedDB call has to reconnect first: the connection went, or, for an
   * adapter that reopens, a reopen is running or the last one was refused. It's synchronous,
   * so nothing is awaited while the connection is there.
   * @returns {boolean}
   */
  const mustReconnect = () => (reopens ? reopening !== null || storage.openState !== 'open' : reloadRequired());

  /**
   * Before the next IndexedDB call, once mustReconnect says so: open the database again if
   * this adapter reopens, or fail with `reload-required` if it doesn't
   * @returns {Promise<void>}
   */
  const reconnect = () => {
    if (!reopens) return Promise.reject(reloadError());
    if (!reopening) {
      reopening = storage.open({ watchConnection: true }).then(
        () => {
          reopening = null;
        },
        error => {
          reopening = null;
          throw storageError(error);
        },
      );
    }
    return reopening;
  };

  /**
   * What a failed IndexedDB call means here: `reload-required` when the connection went
   * while it ran
   * @param {unknown} error
   * @returns {UnavailableError}
   */
  const databaseError = error => (reloadRequired() ? reloadError() : storageError(error));

  /**
   * The values IndexedDB's `settings` store holds for `keys`, records of `{key, value}`, as
   * Popup has read them. A database without the store has none.
   * @param {readonly string[]} keys
   * @returns {Promise<Record<string, unknown>>}
   */
  const readIdbSettings = async keys => {
    if (keys.some(key => !IDB_SETTINGS_KEYS.includes(key))) {
      throw new UnavailableError('adapter', 'setting-not-served', false);
    }
    if (mustReconnect()) await reconnect();
    /** @type {Record<string, unknown>} */
    const values = {};
    try {
      if (!storage.hasStore('settings')) return values;
      const store = storeIn(storage.transaction('settings', 'readonly'), 'settings');
      for (const key of keys) {
        const record = /** @type {{value?: unknown} | undefined} */ (await result(store.get(key)));
        if (record && record.value !== undefined) values[key] = record.value;
      }
      return values;
    } catch (error) {
      throw databaseError(error);
    }
  };

  /**
   * @param {Work} work
   * @param {Unit[]} units
   * @returns {Promise<Outcome>}
   */
  const runUnits = async (work, units) => {
    try {
      for (const unit of units) {
        if (unit.when && !unit.when()) continue;
        // Each unit commits on its own, so the connection can go between one and the next. Nothing
        // is awaited while it's there, so a save still opens its transaction in the calling task
        if (mustReconnect()) await reconnect();
        const stop = await runUnit(storage, unit);
        if (stop) return stop;
      }
      return work.done();
    } catch (error) {
      return unavailableFrom(databaseError(error));
    }
  };

  /**
   * A legacy backup task, run by 1.4.x's own Storage code (#18 owns the engine that replaces
   * it). The import commits in one transaction, after Replace all's recovery copy, so its
   * outcome is committed only once all of it is, and names what it added and trashed. A
   * refused backup, a recovery copy that couldn't be saved, or an aborted commit leaves
   * IndexedDB as it was, and answers with a code, never the error's text.
   * @param {Work} work
   * @param {import('../../core/ports/repository.js').BackupTask} task
   * @returns {Promise<Outcome>}
   */
  const runBackup = async (work, task) => {
    if (mode !== 'versioned') return unavailable('adapter', 'backup-needs-versioned-open', false);
    try {
      if (mustReconnect()) await reconnect();
      if (task.action === 'auto') {
        await storage.createAutoBackup();
        return work.done();
      }
      const receipt = await storage.importData(task.backup, task.mode);
      return work.done({
        importedIds: [...receipt.importedIds],
        addedFolderIds: [...receipt.addedFolderIds],
        trashedIds: [...receipt.trashedIds],
      });
    } catch (error) {
      return backupFailure(error);
    }
  };

  /**
   * What a failed backup task answers: a backup 1.4.x's import refused is `validation`, one it
   * couldn't save a recovery copy for is `storage`, and anything else is how storage failed
   * @param {unknown} error
   * @returns {Outcome}
   */
  const backupFailure = error => {
    const { code, message } = /** @type {{code?: unknown, message?: unknown}} */ (error || {});
    if (code === 'IMPORT_INVALID') {
      const text = String(message);
      if (text.includes('folders store')) return rejected('validation', 'folders-store-missing');
      if (text.includes('media store')) return rejected('validation', 'media-store-missing');
      return rejected('validation', 'import-invalid');
    }
    if (code === 'RECOVERY_COPY_FAILED') return unavailable('storage', 'recovery-copy-failed', true);
    const outcome = unavailableFrom(databaseError(error));
    // The storage exception's name, and never its message, so a diagnostic tells them apart
    const name = typeof (/** @type {{name?: unknown}} */ (error || {}).name) === 'string' ? String(/** @type {any} */ (error).name) : '';
    if (STORAGE_EXCEPTIONS.includes(name)) outcome.exception = name;
    return outcome;
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
    flags: Object.freeze({ atomicMultiStore: false, revisions: false, idempotency: false, backups: true }),

    async open() {
      try {
        // Both versioned opens watch the connection, so another context's upgrade never waits
        // on this one: the worker opens again, and a page asks for a reload
        if (mode === 'versioned') await storage.open({ watchConnection: true });
        else await storage.openExisting();
      } catch (error) {
        const refused = storageError(error);
        // An error with no code of its own reads as a failed transaction, but this was the
        // open, as openExisting's OPEN_FAILED says
        throw refused.code === 'transaction-failed'
          ? new UnavailableError('storage', 'open-failed', true, { cause: error })
          : refused;
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
      if (effect.kind === 'backup') return fresh(runBackup(work, effect));
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
      if (mustReconnect()) await reconnect();
      try {
        const names = presentStores(storage, stores);
        const tx = names.length > 0 ? storage.transaction(names, 'readonly') : null;
        return await body(view(storage, tx, stores));
      } catch (error) {
        throw databaseError(error);
      }
    },

    async readSettings(area, keys) {
      if (area === 'idbSettings') return readIdbSettings(keys);
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
