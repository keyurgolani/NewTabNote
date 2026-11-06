/**
 * #17's read-only reader (#35 slice 4b-0b): what a page that only reads opens CanvasTabDB with,
 * once its writes go to the worker (4b-2 on). It opens the database as it is, as #17's adapter's
 * `existing` mode does, with no registry steps, so it never makes a database or upgrades one
 * (connection.js). It reads through the read view #17's adapter reads through (reads.js), with a
 * tracker for a read alone. It holds nothing that writes: no commit, no recall, no export, and no
 * module the architecture list (docs/architecture/committers.json) gives the role `writer`.
 *
 * Its failure mapping, read, readSettings and readIdbSettings are copies of #17's adapter's, so a
 * page's start keeps the adapter as it is (the lead's ruling, amending 4b-0b's 2d). Each copy
 * names its twin in adapter.js. test/kernel/storage-reader.test.mjs holds each copy to its twin
 * on every synthesized fixture and every failure the two can answer, and pins that every failure
 * either one names has a parity case of its own.
 */

import { UnavailableError } from '../../core/contracts/outcomes.js';
import { IDB_SETTINGS_KEYS } from '../../core/ports/repository.js';
import { createConnection } from './connection.js';
import { failureOf, nameOf, settingsFailureOf } from './failures.js';
import { createIndexedDbLedger } from './ledger.js';
import { createReadTracker, present, readView, withAnswer } from './reads.js';
import { result } from './requests.js';
import { IDB_STORES } from './schema.js';
import { settingKey } from './settings.js';

/** @typedef {import('../../core/ports/repository.js').AdapterFlags} AdapterFlags */
/** @typedef {import('../../core/ports/repository.js').ReadTx} ReadTx */
/** @typedef {import('../../core/ports/repository.js').ReadableSettingsArea} ReadableSettingsArea */
/** @typedef {import('../../core/ports/repository.js').StoreName} StoreName */
/** @typedef {import('../../core/ports/idempotency-ledger.js').IdempotencyLedger} IdempotencyLedger */
/** @typedef {import('./connection.js').OpenMode} OpenMode */
/** @typedef {import('./connection.js').OpenState} OpenState */

/**
 * @typedef {object} IndexedDbReaderOptions
 * @property {IDBFactory} indexedDB
 * @property {{get: (keys: string[]) => Promise<Record<string, unknown>>}} settings
 *   chrome.storage.local, or anything with its promise-returning get
 * @property {number} [openWithinMs] - how long open() waits for a slow open (connection.js)
 * @property {boolean} [requireCore] - the open refuses a database without notes or blocks (connection.js)
 * @property {(() => Promise<unknown>) | null} [awaitUpgrade]
 *   What the open waits on first when there's no database or an older one: a page's wait on the
 *   worker's migration run (connection.js)
 */

/**
 * The read half of #17's adapter (adapter.js, IndexedDbAdapter): its open, its reads and settings
 * reads, and #13's ledger for a command's status, with no commit, recall or export
 * @typedef {object} IndexedDbReader
 * @property {string} name
 * @property {OpenMode} mode - `existing`, always
 * @property {Readonly<AdapterFlags>} flags
 * @property {() => Promise<void>} open
 * @property {() => void} close
 * @property {(flush: () => void) => () => void} beforeClose
 * @property {() => OpenState} openState
 * @property {() => string[]} missingStores
 * @property {() => boolean} upgraded
 * @property {<T>(stores: StoreName[], body: (tx: ReadTx) => Promise<T>) => Promise<T>} read
 * @property {(area: ReadableSettingsArea, keys: readonly string[]) => Promise<Record<string, unknown>>} readSettings
 * @property {IdempotencyLedger} ledger - #13's ledger over the records #17's adapter keeps
 */

/**
 * #17's read-only reader over CanvasTabDB
 * @param {IndexedDbReaderOptions} options
 * @returns {IndexedDbReader}
 */
export function createIndexedDbReader({ indexedDB, settings, openWithinMs, requireCore, awaitUpgrade }) {
  /** @type {OpenMode} */
  const mode = 'existing';
  const connection = createConnection({ indexedDB, mode, openWithinMs, requireCore, awaitUpgrade });
  const database = () => connection.database();

  // A copy of adapter.js's startFailure, its twin: what a transaction that can't start answers.
  // storage-reader.test.mjs's "fails as #17's adapter in existing mode does" holds the two to
  // one answer, so change them together.
  /**
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

  // A copy of adapter.js's going, its twin: whether the connection is gone or closing, asked with
  // an empty transaction. storage-reader.test.mjs's "fails as #17's adapter in existing mode
  // does" holds the two to one answer, so change them together.
  /** @returns {boolean} */
  const going = () => {
    if (connection.state() === 'gone') return true;
    if (connection.state() !== 'open') return false;
    try {
      connection.database().transaction([], 'readonly');
    } catch (error) {
      if (nameOf(error) !== 'InvalidStateError') return false;
      connection.lost();
      return true;
    }
    return false;
  };

  // A copy of adapter.js's fromIndexedDb, its twin: whether IndexedDB threw it.
  // storage-reader.test.mjs's "fails as #17's adapter in existing mode does" holds the two to
  // one answer, so change them together.
  /** @param {unknown} error */
  const fromIndexedDb = error => typeof DOMException === 'function' && error instanceof DOMException;

  // A copy of adapter.js's failureIn, its twin: what a call that failed in flight answers.
  // storage-reader.test.mjs's "fails as #17's adapter in existing mode does" holds the two to
  // one answer, so change them together.
  /**
   * @param {unknown} error
   * @returns {UnavailableError}
   */
  const failureIn = error =>
    fromIndexedDb(error) && going() ? new UnavailableError('storage', 'reload-required', false) : failureOf(error);

  // A copy of adapter.js's readIdbSettings, its twin: IndexedDB's settings, IDB_SETTINGS_KEYS
  // alone. storage-reader.test.mjs's "on every synthesized fixture" and "fails as #17's adapter
  // in existing mode does" hold the two to one answer, so change them together.
  /**
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
      throw failureIn(error);
    }
    return values;
  };

  return Object.freeze({
    name: 'indexeddb-reader',
    mode,
    // Its reads report a note's revisions as #17's adapter's do. It commits nothing, so it keeps
    // no ledger row of its own and runs no backup task
    flags: Object.freeze({ atomicMultiStore: false, revisions: true, idempotency: false, backups: false }),

    open: () => connection.open(),
    close: () => connection.close(),
    beforeClose: flush => connection.beforeClose(flush),
    openState: () => connection.openState(),
    missingStores: () => connection.missingStores(),
    upgraded: () => connection.upgraded(),

    // A copy of adapter.js's read, its twin, but for the view: the read view alone, with a
    // tracker for a read alone. storage-reader.test.mjs's "on every synthesized fixture" and
    // "fails as #17's adapter in existing mode does" hold the two to one answer, so change them
    // together.
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
        const names = withAnswer(db, present(db, stores));
        if (names.length > 0) tx = db.transaction(names, 'readonly');
      } catch (error) {
        throw startFailure(error);
      }
      try {
        return await body(readView(db, tx, stores, createReadTracker()));
      } catch (error) {
        throw failureIn(error);
      }
    },

    // A copy of adapter.js's readSettings, its twin: IndexedDB's settings, or chrome.storage.local's.
    // storage-reader.test.mjs's "on every synthesized fixture" and "fails as #17's adapter in
    // existing mode does" hold the two to one answer, so change them together.
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

    ledger: createIndexedDbLedger({ database, failure: failureIn }),
  });
}
