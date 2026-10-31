/**
 * One context's connection to CanvasTabDB (#17, "Transactions" and "Hosting"), opened one of
 * two ways:
 * - `versioned` (the service worker only, since #17 PR 1b): at this build's version, 9. The
 *   worker opens it so only once the migration runner (migrate.js) has brought the database
 *   there after its verified recovery point, so this open finds nothing to upgrade. One that
 *   does (a database made or replaced since the run) runs the registry's pending structural
 *   steps in its `versionchange`, which only add, as the runner's would. A database without
 *   `canvases` or `elements` is refused, `missing-core-stores`. In a page the open first saves
 *   #33's recovery copy of a database missing stores (recovery.js), though no page opens it
 *   this way since #17 PR 1b.
 * - `existing` (Popup, Side Panel, and the worker when its run left the database as it was):
 *   at whatever version is on disk, up to this build's, with no upgrade or repair. On a
 *   profile with no database it makes none, `no-database`. With `requireCore` it refuses a
 *   database without `canvases` or `elements` too, as the worker's captures need. With
 *   `awaitUpgrade`, a page that finds no database, or one below this build's version, first
 *   waits on it (#17, Q12): it wakes the worker and waits up to 5 seconds for its run, and the
 *   open then goes ahead on what's there.
 * A database a newer build upgraded is refused either way, `newer-schema` `version-too-new`,
 * and left as it was.
 *
 * Opening never leaves its caller waiting: an open that hasn't finished within `openWithinMs`
 * (5 seconds, counted once any `awaitUpgrade` wait is over), because another connection blocks
 * its upgrade or for any other reason, lets open() resolve and keeps waiting. Until it
 * finishes, every call answers `blocked-upgrade`, or `open-pending` for an open nothing
 * reported blocked, both retryable, and once it opens, calls go through. An open that fails,
 * before open() answered or after, fails every call from then on with its cause and code, not
 * retryable, since nothing opens it again.
 *
 * On versionchange the connection closes, so it never blocks another context's upgrade, and a
 * connection Chrome closes itself (the database deleted, or its storage failing) is gone too.
 * After either, and after close(), every call answers `reload-required`, which no resend
 * fixes: pages reload to open the database again (#17: "Pages ask for a reload"). #17 slice
 * 2 adds the journal that keeps what a closing connection couldn't commit.
 */

import { UnavailableError } from '../../core/contracts/outcomes.js';
import { openFailureOf } from './failures.js';
import { writeMissingStoresCopy } from './recovery.js';
import { pendingStructural } from './registry.js';
import { CORE_STORES, DB_NAME, DB_VERSION, LEGACY_VERSION, STORE_SCHEMAS } from './schema.js';
import { openWithoutUpgrade } from './shapes.js';

/** @typedef {'versioned' | 'existing'} OpenMode */
/** @typedef {import('./adapter.js').SettingsStore} SettingsStore */
/** @typedef {import('./recovery.js').Locks} Locks */
/** @typedef {import('../../core/ports/runtime.js').Logger} Logger */

/**
 * Where a page's versioned open saves its missing-stores copy (recovery.js): null for the
 * service worker, and for Popup and Side Panel, which never write one
 * @typedef {{settings: SettingsStore, locks?: Locks, logger: Logger}} Recovery
 */

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
 *   with an UnavailableError when the open fails first, and with `reload-required`, opening
 *   nothing, after close(). Calling it again returns the first call's promise.
 * @property {() => IDBDatabase} database
 *   The open database, or a throw of the UnavailableError that says why there's none
 * @property {() => void} lost - for an IDBDatabase call that found the connection closed
 * @property {() => void} close
 * @property {() => ConnectionState} state
 */

/**
 * @typedef {object} ConnectionOptions
 * @property {IDBFactory} indexedDB
 * @property {OpenMode} mode
 * @property {number} [openWithinMs]
 * @property {Recovery | null} [recovery]
 * @property {boolean} [requireCore] - an `existing` open refuses a database without `canvases` or `elements`
 * @property {(() => Promise<unknown>) | null} [awaitUpgrade]
 *   What an `existing` open waits on first when it finds no database, or one below this
 *   build's version. It never rejects: a page passes its wait on the worker's run.
 */

/** How long open() waits before it answers for an open that hasn't finished (#17: "within 5 seconds") */
export const OPEN_WITHIN_MS = 5000;

/**
 * Runs the registry's pending structural steps in an upgrade's `versionchange`, synchronously,
 * from 8 for no database and every legacy shape, since step 9 adds whatever legacy store is
 * missing. Anything a step throws aborts the upgrade.
 * @param {IDBOpenDBRequest} request
 * @param {number} oldVersion
 */
function upgradeThroughRegistry(request, oldVersion) {
  const db = request.result;
  const tx = /** @type {IDBTransaction} */ (request.transaction);
  try {
    for (const step of pendingStructural(Math.max(LEGACY_VERSION, oldVersion), DB_VERSION)) {
      step.apply(db, tx, { logicalVersion: null });
    }
  } catch (error) {
    try {
      tx.abort();
    } catch {
      // Already aborted
    }
    throw error;
  }
}

/**
 * @param {ConnectionOptions} options
 * @returns {Connection}
 */
export function createConnection({
  indexedDB,
  mode,
  openWithinMs = OPEN_WITHIN_MS,
  recovery = null,
  requireCore = false,
  awaitUpgrade = null,
}) {
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
        // Closed while it opened, which stays the answer
        if (state !== 'gone') {
          state = 'failed';
          // Every call answers it from then on, and nothing opens the database again before the
          // page reloads, so no resend gets past it, whatever the open's error said. open()
          // rejects with that error as it came, and the kernel answers it the same way.
          failure = new UnavailableError(error.unavailableCause, error.code, false);
        }
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
      // An older database gets the stores it lacks from the upgrade, and so needs no copy
      let upgraded = false;
      request.onupgradeneeded = event => {
        // An existing open makes no database, and changes none
        if (mode === 'existing') {
          if (request.transaction) request.transaction.abort();
          return;
        }
        upgraded = true;
        upgradeThroughRegistry(request, event.oldVersion);
      };
      request.onblocked = () => {
        if (state === 'opening') state = 'blocked';
      };

      /**
       * The last checks on an open database, then it's this connection's
       * @param {IDBDatabase} database
       */
      const settle = database => {
        // Closed while it opened: nothing may use it
        if (state === 'gone') {
          database.close();
          reject(new UnavailableError('storage', 'reload-required', false));
          return;
        }
        if (
          (mode === 'versioned' || requireCore) &&
          CORE_STORES.some(name => !database.objectStoreNames.contains(name))
        ) {
          database.close();
          fail(new UnavailableError('storage', 'missing-core-stores', false));
          return;
        }
        adopt(database);
        resolve();
      };

      request.onsuccess = () => {
        const database = request.result;
        if (state === 'gone') {
          settle(database);
          return;
        }
        if (database.version > DB_VERSION) {
          database.close();
          fail(new UnavailableError('newer-schema', 'version-too-new', false));
          return;
        }
        // A database missing stores keeps them missing, and a page's versioned open saves a copy
        // of it first, even of one it then refuses (recovery.js)
        const missing =
          recovery && !upgraded
            ? Object.keys(STORE_SCHEMAS).filter(name => !database.objectStoreNames.contains(name))
            : [];
        if (missing.length === 0) {
          settle(database);
          return;
        }
        // It closes on versionchange while it copies too, so the copy never blocks an upgrade
        database.onversionchange = () => {
          database.close();
          state = 'gone';
        };
        database.onclose = () => {
          state = 'gone';
        };
        const { settings, locks, logger } = /** @type {Recovery} */ (recovery);
        writeMissingStoresCopy({ db: database, missing, settings, locks })
          .catch(error => logger.warn('recovery-copy-failed', { missingStores: missing, error }))
          .then(() => settle(database));
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

  /**
   * connect(), answering within openWithinMs
   * @returns {Promise<void>}
   */
  const connectWithin = () => {
    const connected = connect();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(resolve, openWithinMs);
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
  };

  /**
   * An `existing` open with `awaitUpgrade` waits on it first when there's no database or one
   * below this build's version. A failed look goes straight on to the open, which says why.
   * @param {() => Promise<unknown>} wait
   * @returns {Promise<void>}
   */
  const waitForUpgrade = async wait => {
    let version = 0;
    try {
      const found = await openWithoutUpgrade(indexedDB, DB_NAME);
      if (found) {
        version = found.version;
        found.close();
      }
    } catch {
      return;
    }
    if (version < DB_VERSION) await wait();
  };

  return Object.freeze({
    open() {
      if (opening) return opening;
      // close() came first, which stays the answer, so it opens nothing
      if (state === 'gone') {
        opening = Promise.reject(new UnavailableError('storage', 'reload-required', false));
        opening.catch(() => {});
        return opening;
      }
      state = 'opening';
      opening =
        mode === 'existing' && awaitUpgrade
          ? waitForUpgrade(awaitUpgrade).then(() => {
              // close() while it waited: it opens nothing
              if (/** @type {ConnectionState} */ (state) === 'gone') {
                throw new UnavailableError('storage', 'reload-required', false);
              }
              return connectWithin();
            })
          : connectWithin();
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
