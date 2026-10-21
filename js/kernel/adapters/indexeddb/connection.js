/**
 * One context's connection to CanvasTabDB (#17, "Transactions" and "Hosting"), opened one of
 * two ways, as #12's legacy adapter opens it:
 * - `versioned` (the new tab and the service worker): at this build's version, upgrading an
 *   older database by creating the stores it lacks, as Storage.open does. A database without
 *   `canvases` or `elements` is refused, `missing-core-stores`.
 * - `existing` (Popup and Side Panel): at whatever version is on disk, with no upgrade or
 *   repair. On a profile with no database it makes none, `no-database`.
 * A database a newer build upgraded is refused either way, `newer-schema` `version-too-new`,
 * and left as it was.
 *
 * Opening never leaves its caller waiting: when another connection blocks the upgrade, or the
 * open hasn't finished within `openWithinMs` (5 seconds), open() resolves and the open keeps
 * waiting. Until it finishes, every call answers `blocked-upgrade`, or `open-pending` for an
 * open nothing reported blocked, both retryable, and once it opens, calls go through.
 *
 * On versionchange the connection closes, so it never blocks another context's upgrade, and a
 * connection Chrome closes itself (the database deleted, or its storage failing) is gone too.
 * After either, and after close(), every call answers `reload-required`, which no resend
 * fixes: pages reload to open the database again (#17: "Pages ask for a reload"). #17 slice
 * 2 has the service worker reopen after its own upgrade, and journal what it couldn't commit.
 */

import { UnavailableError } from '../../core/contracts/outcomes.js';
import { openFailureOf } from './failures.js';
import { CORE_STORES, DB_NAME, DB_VERSION, createMissingStores } from './schema.js';

/** @typedef {'versioned' | 'existing'} OpenMode */

/**
 * - `closed`: open() not called yet
 * - `opening`, `blocked`: open() called, and the database not open yet
 * - `open`
 * - `gone`: closed on versionchange, by Chrome, or by close()
 * - `failed`: the open failed
 * @typedef {'closed' | 'opening' | 'blocked' | 'open' | 'gone' | 'failed'} ConnectionState
 */

/**
 * @typedef {object} Connection
 * @property {() => Promise<void>} open
 *   Resolves once the database is open, or after `openWithinMs` while it isn't yet. Rejects
 *   with an UnavailableError when the open fails first. Calling it again returns the first
 *   call's promise.
 * @property {() => IDBDatabase} database
 *   The open database, or a throw of the UnavailableError that says why there's none
 * @property {() => void} lost - for an IDBDatabase call that found the connection closed
 * @property {() => void} close
 * @property {() => ConnectionState} state
 */

/** How long open() waits before it answers for an open that hasn't finished (#17: "within 5 seconds") */
export const OPEN_WITHIN_MS = 5000;

/**
 * @param {{indexedDB: IDBFactory, mode: OpenMode, openWithinMs?: number}} options
 * @returns {Connection}
 */
export function createConnection({ indexedDB, mode, openWithinMs = OPEN_WITHIN_MS }) {
  /** @type {ConnectionState} */
  let state = 'closed';
  /** @type {IDBDatabase | null} */
  let db = null;
  /** @type {UnavailableError | null} */
  let failure = null;
  /** @type {Promise<void> | null} */
  let opening = null;

  /**
   * Keeps `database` as this connection's, closing it on versionchange so it never blocks
   * another context's upgrade
   * @param {IDBDatabase} database
   */
  const adopt = database => {
    database.onversionchange = () => {
      database.close();
      if (db === database) state = 'gone';
    };
    database.onclose = () => {
      if (db === database) state = 'gone';
    };
    db = database;
    state = 'open';
  };

  /**
   * Opens the database. Resolves once it's open, and rejects with an UnavailableError.
   * @returns {Promise<void>}
   */
  const connect = () =>
    new Promise((resolve, reject) => {
      /** @param {UnavailableError} error */
      const fail = error => {
        state = 'failed';
        failure = error;
        reject(error);
      };
      /** @type {IDBOpenDBRequest} */
      let request;
      try {
        request = mode === 'versioned' ? indexedDB.open(DB_NAME, DB_VERSION) : indexedDB.open(DB_NAME);
      } catch (error) {
        fail(openFailureOf(error));
        return;
      }
      request.onupgradeneeded = () => {
        // An existing open makes no database, and changes none
        if (mode === 'existing') {
          if (request.transaction) request.transaction.abort();
          return;
        }
        createMissingStores(request.result);
      };
      request.onblocked = () => {
        if (state === 'opening') state = 'blocked';
      };
      request.onsuccess = () => {
        const database = request.result;
        // Closed while it opened: nothing may use it
        if (state === 'gone') {
          database.close();
          reject(new UnavailableError('storage', 'reload-required', false));
          return;
        }
        if (database.version > DB_VERSION) {
          database.close();
          fail(new UnavailableError('newer-schema', 'version-too-new', false));
          return;
        }
        if (mode === 'versioned' && CORE_STORES.some(name => !database.objectStoreNames.contains(name))) {
          database.close();
          fail(new UnavailableError('storage', 'missing-core-stores', false));
          return;
        }
        adopt(database);
        resolve();
      };
      request.onerror = () => {
        // The upgrade an existing open aborted: there was no database
        if (mode === 'existing' && request.error && request.error.name === 'AbortError') {
          fail(new UnavailableError('storage', 'no-database', true));
          return;
        }
        fail(openFailureOf(request.error));
      };
    });

  return Object.freeze({
    open() {
      if (opening) return opening;
      state = 'opening';
      const connected = connect();
      opening = new Promise((resolve, reject) => {
        const timer = setTimeout(resolve, openWithinMs);
        connected.then(
          () => {
            clearTimeout(timer);
            resolve();
          },
          error => {
            clearTimeout(timer);
            reject(error);
          },
        );
      });
      // Once open() has answered, a later failure is answered by database()
      opening.catch(() => {});
      return opening;
    },

    database() {
      switch (state) {
        case 'open':
          return /** @type {IDBDatabase} */ (db);
        case 'opening':
          throw new UnavailableError('storage', 'open-pending', true);
        case 'blocked':
          throw new UnavailableError('storage', 'blocked-upgrade', true);
        case 'failed':
          throw /** @type {UnavailableError} */ (failure);
        case 'gone':
          throw new UnavailableError('storage', 'reload-required', false);
        default:
          throw new UnavailableError('adapter', 'not-open', false);
      }
    },

    lost() {
      if (state === 'open') state = 'gone';
    },

    close() {
      if (db) db.close();
      state = 'gone';
    },

    state: () => state,
  });
}
