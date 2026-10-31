/**
 * One context's connection to CanvasTabDB (#17, "Transactions" and "Hosting"), opened one of
 * two ways:
 * - `versioned` (the service worker only, since #17 PR 1b): at this build's version, 10. The
 *   worker opens it so only once the migration runner (migrate.js) has brought the database
 *   there after its verified recovery point, so this open finds nothing to upgrade. With no
 *   database it makes one through the registry's structural steps, which have nothing to keep.
 *   An older database is never upgraded here, since every structural step needs a verified
 *   point first: the open is refused, `migration-required`, retryable, and the worker runs the
 *   runner again (review R79). A database without `canvases` or `elements` is refused,
 *   `missing-core-stores`. Before #17 PR 1b the new tab
 *   opened it this way too, and saved #33's missing-stores copy first; that copy stays the new
 *   tab's own (js/storage.js), since no page opens this adapter versioned now.
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
 *
 * What the new tab took from js/storage.js's connection comes with it (#17 PR 4a), so the page
 * can open this adapter: before a versionchange closes the connection, each function passed to
 * beforeClose runs, synchronously, so an editor writes what it has pending and the write it
 * opens then still commits; openState answers in the words Storage's openState used; and
 * missingStores names the legacy stores the open database lacks.
 */

import { UnavailableError } from '../../core/contracts/outcomes.js';
import { openFailureOf } from './failures.js';
import { pendingStructural } from './registry.js';
import { CORE_STORES, DB_NAME, DB_VERSION, LEGACY_VERSION, STORE_SCHEMAS } from './schema.js';
import { openWithoutUpgrade } from './shapes.js';

/** @typedef {'versioned' | 'existing'} OpenMode */

/**
 * The connection in the words js/storage.js's openState has used since 1.4.x, which the new
 * tab's App and its export notice read: `closed` until it opens, `open`, `newer-version` and
 * `missing-core-stores` for those two refusals, `failed` for any other failed open,
 * `version-changed` once another context's upgrade closed it, and `closed-by-browser` once
 * Chrome closed it itself or a call found it closed. After close() it's `closed`.
 * @typedef {'closed' | 'open' | 'newer-version' | 'missing-core-stores' | 'failed' | 'version-changed'
 *   | 'closed-by-browser'} OpenState
 */

/** The legacy stores, in the order Storage's requiredStores lists them */
const LEGACY_STORES = Object.freeze(Object.keys(STORE_SCHEMAS));

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
 * @property {(flush: () => void) => () => void} beforeClose
 *   Runs `flush` when another context's upgrade closes the connection, right before it closes,
 *   so a transaction `flush` opens then still commits. What it throws is reported, and the
 *   others and the close still run. A connection Chrome closes itself is gone already, so
 *   nothing runs then. Answers a function that stops it.
 * @property {() => OpenState} openState
 * @property {() => string[]} missingStores
 *   The legacy stores the database lacks, once an open found it, the one it refused for its
 *   notes or blocks too, as Storage's missingStores names them. None before then.
 */

/**
 * @typedef {object} ConnectionOptions
 * @property {IDBFactory} indexedDB
 * @property {OpenMode} mode
 * @property {number} [openWithinMs]
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
   * Why the connection is gone, as openState says it: the first reason it went, kept
   * @type {OpenState | null}
   */
  let goneAs = null;
  /** @type {string[]} */
  let missing = [];
  /** @type {Set<() => void>} */
  const flushers = new Set();

  /** @param {OpenState} why */
  const gone = why => {
    state = 'gone';
    if (!goneAs) goneAs = why;
  };

  // Each runs, whatever another one threw, and the close goes ahead after them
  const flushAll = () => {
    for (const flush of [...flushers]) {
      try {
        flush();
      } catch (error) {
        const report = /** @type {{reportError?: (error: unknown) => void}} */ (globalThis).reportError;
        if (typeof report === 'function') report(error);
      }
    }
  };

  /**
   * Keeps `database` as this connection's, closing it on versionchange so it never blocks
   * another context's upgrade, once what the page has pending opened its writes
   * @param {IDBDatabase} database
   */
  const adopt = database => {
    database.onversionchange = () => {
      // Each write a flush opens now is let finish by the close
      if (db === database && state === 'open') flushAll();
      database.close();
      if (db === database) gone('version-changed');
    };
    database.onclose = () => {
      if (db === database) gone('closed-by-browser');
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
      // A database without its notes or blocks gets no step (Q13), and is refused
      let coreMissing = false;
      // A database below this build's version, which only the migration runner upgrades
      let needsRunner = false;
      request.onupgradeneeded = event => {
        // An existing open makes no database, and changes none
        if (mode === 'existing') {
          if (request.transaction) request.transaction.abort();
          return;
        }
        const names = request.result.objectStoreNames;
        if (event.oldVersion > 0 && CORE_STORES.some(name => !names.contains(name))) {
          coreMissing = true;
          if (request.transaction) request.transaction.abort();
          return;
        }
        // A database with anything in it upgrades only through the runner, after its verified
        // point (review R79): this open makes only a new one
        if (event.oldVersion > 0) {
          needsRunner = true;
          if (request.transaction) request.transaction.abort();
          return;
        }
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
        // Named even when the open is refused for them, as Storage names them
        missing = LEGACY_STORES.filter(name => !database.objectStoreNames.contains(name));
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
        settle(database);
      };
      request.onerror = () => {
        if (coreMissing) {
          fail(new UnavailableError('storage', 'missing-core-stores', false));
          return;
        }
        if (needsRunner) {
          fail(new UnavailableError('storage', 'migration-required', true));
          return;
        }
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
      if (state === 'open') gone('closed-by-browser');
    },

    close() {
      if (db) db.close();
      gone('closed');
    },

    state: () => state,

    beforeClose(flush) {
      flushers.add(flush);
      return () => {
        flushers.delete(flush);
      };
    },

    openState() {
      switch (state) {
        case 'open':
          return 'open';
        case 'gone':
          return goneAs || 'closed';
        case 'failed': {
          const code = failure ? failure.code : '';
          if (code === 'version-too-new') return 'newer-version';
          if (code === 'missing-core-stores') return 'missing-core-stores';
          return 'failed';
        }
        default:
          return 'closed';
      }
    },

    missingStores: () => [...missing],
  });
}
