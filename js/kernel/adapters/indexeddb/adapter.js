/**
 * #17's IndexedDB adapter (#17 slice 1, "Repositories and commit semantics"): the kernel's
 * repository port over CanvasTabDB, with settings in chrome.storage.local. It writes the same
 * records to the same stores as #12's legacy adapter, and changes nothing about the database
 * (schema.js).
 *
 * Every command's units run in one transaction, opened in the task that commits it, readwrite
 * with `durability: 'strict'` whenever a unit writes. A command answers only once that
 * transaction fires `complete`, and with a typed `unavailable` outcome when it fires `abort`,
 * even after every request in it succeeded, so nothing is ever reported saved that didn't
 * commit (failures.js has what each failure answers). A unit that stops the command (a
 * rejection or a conflict), or throws, aborts it, so nothing any of its units wrote commits.
 *
 * A transaction that aborts with an AbortError or an UnknownError runs once more, in a new
 * one, and answers `retries-exhausted` if that fails too (ports/repository.js, Unit). It runs
 * again only when this adapter has opened no write since on any store it writes, as a later
 * command there, such as a newer save of the same note, would land first and be written
 * over; it answers `transaction-failed`, retryable, instead. That holds within one context
 * only: another context's save that commits between the abort and the run again is written
 * over, so the older content wins. It's the two-contexts gap the kernel ledger declares, and
 * once saves carry an expected revision (#17 slice 2) the run again is a conflict instead.
 *
 * A transaction that ends before the command's units have finished, because a unit awaited
 * something other than it, isn't run again, and the command answers as it ends rather than
 * wait on the unit: `transaction-ended-early` when it committed, and why it aborted when it
 * aborted. The adapter can tell only by which comes first, so a unit that finishes before an
 * abort reaches it is answered as any other command, retry included.
 *
 * Flags:
 * - atomicMultiStore: true, since a command is one transaction.
 * - revisions: false. A content revision needs something stored with each note, and #17
 *   slice 1 adds nothing on disk, so a save over a newer write wins, as on the legacy adapter.
 * - idempotency: false. Persisted outcomes live in #17's `operations` store, which the first
 *   schema change (#17 slice 2) creates, so a resent command runs again.
 *
 * Composition roots make it with `createIndexedDbAdapter({indexedDB, settings, mode})`: since
 * #17 PR 1b the service worker's (`versioned` once its migration run has brought the database
 * to 9, `existing` when the run left it as it was), Popup's and Side Panel's (`existing`). The
 * new tab stays on #12's legacy adapter until #12 moves its writers (connection.js).
 */

import { UnavailableError, committed, unavailable, unavailableFrom } from '../../core/contracts/outcomes.js';
import { IDB_SETTINGS_KEYS } from '../../core/ports/repository.js';
import { createConnection } from './connection.js';
import { failureOf, isTransient, nameOf, settingsFailureOf } from './failures.js';
import { abort, indexValue, result } from './requests.js';
import { DERIVED_STORES, IDB_STORES } from './schema.js';
import { FIRST_RUN_SETTINGS, INITIALIZED_KEY, settingKey } from './settings.js';

/** @typedef {import('../../core/ports/repository.js').KernelAdapter} KernelAdapter */
/** @typedef {import('../../core/ports/repository.js').StoreName} StoreName */
/** @typedef {import('../../core/ports/repository.js').SettingsArea} SettingsArea */
/** @typedef {import('../../core/ports/repository.js').Tx} Tx */
/** @typedef {import('../../core/ports/repository.js').Unit} Unit */
/** @typedef {import('../../core/ports/repository.js').Work} Work */
/** @typedef {import('../../core/contracts/outcomes.js').Outcome} Outcome */
/** @typedef {import('./connection.js').OpenMode} OpenMode */

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
 */

/** @typedef {KernelAdapter & {mode: OpenMode, open: () => Promise<void>, close: () => void}} IndexedDbAdapter */

/** @type {IDBTransactionOptions} */
const STRICT = Object.freeze({ durability: 'strict' });

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
 * A unit's view of its command's transaction: only the stores it named, and no writes when
 * it only reads. A store the database lacks reads as empty, as DatabaseManager's reads of
 * auxiliary stores do.
 * @param {IDBDatabase} db
 * @param {IDBTransaction | null} tx - null when the database has none of the command's stores
 * @param {readonly StoreName[]} scope
 * @param {boolean} writable
 * @returns {Tx}
 */
function view(db, tx, scope, writable) {
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
      const objectStore = writing(store);
      if (objectStore) objectStore.put(record);
      else if (!DERIVED_STORES.includes(store)) throw new UnavailableError('storage', 'store-unavailable', false);
    },
    delete: (store, key) => {
      const objectStore = writing(store);
      if (objectStore) objectStore.delete(key);
    },
  });
}

/**
 * Runs the units in order over `tx`, until one stops the command
 * @param {IDBDatabase} db
 * @param {IDBTransaction | null} tx
 * @param {Unit[]} units
 * @returns {Promise<Outcome | void>}
 */
async function runUnits(db, tx, units) {
  for (const unit of units) {
    if (unit.when && !unit.when()) continue;
    const stop = await unit.run(view(db, tx, unit.stores, (unit.mode || 'readwrite') === 'readwrite'));
    if (stop) return stop;
  }
  return undefined;
}

/**
 * A readwrite transaction this adapter opened: its place in the order it opened them, from 1,
 * and the IndexedDB stores it spans. `seq` 0, over no store, is a run that opened none.
 * @typedef {{seq: number, names: readonly string[]}} Write
 */

/** @type {Write} */
const NO_WRITE = Object.freeze({ seq: 0, names: Object.freeze([]) });

/**
 * How one run of a command's units ended: its answer, whether another run could get past the
 * failure, and the readwrite transaction it opened
 * @typedef {{outcome: Outcome, transient: boolean, write: Write}} Attempt
 */

/**
 * The answer for a transaction that failed, and whether it may run once more
 * @param {unknown} cause
 * @param {Write} write
 * @returns {Attempt}
 */
function failed(cause, write) {
  return { outcome: unavailableFrom(failureOf(cause)), transient: isTransient(cause), write };
}

/** @param {Outcome} outcome @returns {Attempt} */
const answered = outcome => ({ outcome, transient: false, write: NO_WRITE });

const endedEarly = () => answered(unavailable('adapter', 'transaction-ended-early', false));

const aborted = () => new DOMException('The transaction was aborted', 'AbortError');

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
}) {
  const connection = createConnection({ indexedDB, mode, openWithinMs, requireCore, awaitUpgrade });

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
   * The last readwrite transaction this adapter opened over each IndexedDB store, so a retry
   * can tell whether a later write went first on any store it writes
   * @type {Map<string, number>}
   */
  const lastWrite = new Map();

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
    try {
      db = connection.database();
      const stores = units.flatMap(unit => unit.stores);
      const names = present(db, stores);
      const writes = units.some(unit => (unit.mode || 'readwrite') === 'readwrite');
      if (names.length > 0 && writes) {
        tx = db.transaction(names, 'readwrite', STRICT);
        write = { seq: ++writesOpened, names };
        for (const name of names) lastWrite.set(name, write.seq);
      } else if (names.length > 0) {
        tx = db.transaction(names, 'readonly');
      }
    } catch (error) {
      return Promise.resolve(answered(unavailableFrom(startFailure(error))));
    }
    /** @type {Promise<{stop: Outcome | void} | {error: unknown}>} */
    const running = runUnits(db, tx, units).then(
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
    const ended = ending(tx);
    return Promise.race([running, ended.then(end => ({ end }))]).then(async first => {
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
        abort(tx);
        const end = await ended;
        if (end.committed) return endedEarly();
        // Its own error says why the transaction aborted, when it aborted for one
        return failed(end.error || first.error, write);
      }
      if (first.stop) {
        abort(tx);
        // Committed before the abort could land, so what came before the stop is stored
        if ((await ended).committed) return endedEarly();
        return answered(first.stop);
      }
      const end = await ended;
      if (end.committed) return answered(work.done());
      return failed(end.error || aborted(), write);
    });
  };

  /**
   * @param {Work} work
   * @param {Unit[]} units
   * @returns {Promise<Outcome>}
   */
  const commitUnits = (work, units) =>
    attempt(work, units).then(first => {
      if (!first.transient) return first.outcome;
      // Another run would queue behind every transaction opened since over its stores, so a
      // later command this context sent, such as a newer save of the same note, would land
      // first and then be written over. So it runs again only when no write opened after it on
      // any store it writes. One on other stores, such as filing into a folder, can't be.
      const overtaken = first.write.names.some(name => lastWrite.get(name) !== first.write.seq);
      if (overtaken) return unavailable('storage', 'transaction-failed', true);
      return attempt(work, units).then(second =>
        second.transient ? unavailable('storage', 'retries-exhausted', true) : second.outcome,
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
   * Startup maintenance: the settings Storage writes on a profile's first run, each one only
   * where nothing is stored, then nothing else. It reads no store, so it runs while the
   * database is blocked too. #17's read-only integrity scan moves to the worker root, at most
   * daily, and then to #35's job host.
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
    if (mode !== 'versioned') return unavailable('adapter', 'maintenance-needs-versioned-open', false);
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

  return Object.freeze({
    name: 'indexeddb',
    mode,
    flags: Object.freeze({ atomicMultiStore: true, revisions: false, idempotency: false, backups: false }),

    open: () => connection.open(),
    close: () => connection.close(),

    // Nothing is kept per commandId (idempotency: false)
    recall: () => undefined,

    commit(work) {
      const { effect } = work;
      /** @type {Promise<Outcome>} */
      let outcome;
      try {
        if (effect.kind === 'units') outcome = commitUnits(work, effect.units);
        else if (effect.kind === 'settings') outcome = commitSettings(work, effect.area, effect.values);
        // The legacy backup tasks run only on 1.4.x's Storage until #18's engine (the `backups` flag)
        else if (effect.kind === 'backup') outcome = Promise.resolve(unavailable('adapter', 'backups-need-legacy-storage', false));
        // No integrity check here until #17's scan exists (#35 slice 1): it commits and checks nothing
        else if (effect.kind === 'integrity-check') outcome = Promise.resolve(work.done());
        else outcome = maintain(work);
      } catch (error) {
        outcome = Promise.resolve(unavailableFrom(failureOf(error)));
      }
      return outcome.then(
        value => ({ outcome: value, replayed: false }),
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
        return await body(view(db, tx, stores, false));
      } catch (error) {
        throw failureOf(error);
      }
    },

    // The export file runs only on 1.4.x's Storage until #18's engine (the `backups` flag)
    exportBackup: () => Promise.reject(new UnavailableError('adapter', 'backups-need-legacy-storage', false)),

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
  });
}
