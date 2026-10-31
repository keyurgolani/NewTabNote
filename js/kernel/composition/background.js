/**
 * The service worker's composition root (#12, docs/adr/0001-kernel-stack.md).
 *
 * js/background.js imports this module statically, so it evaluates before the worker
 * registers any listener. A throw while it loads, or a top-level await anywhere in what it
 * imports, leaves the extension without its context menus and commands, so loading it
 * touches no browser API. js/background.js installs #13's router with installWorkerRouter(),
 * and hands createWorkerClient() to #35's coordinator (./coordinator.js), which builds the
 * worker's kernel on its first start, the first event that needs storage.
 *
 * Since #17 PR 1b the worker is the one context that upgrades CanvasTabDB: building its client
 * starts the migration runner (migrate.js) under Web Lock `storage.migrate`, which makes the
 * verified `pre-migration` recovery point and then opens the database at 9. Its kernel is on
 * #17's IndexedDB adapter, opened once the run has finished: `versioned`, with startup
 * maintenance, when the database is at 9, and `existing` when the run left it as it was
 * (short of space, refused, or failed), so captures keep working on the shape that's there.
 * The run's outcome goes to chrome.storage.local (`setting_storageUpgrade`), which the new tab
 * reads for its space notice and Settings > Data & Backup.
 */

import { createIndexedDbAdapter } from '../adapters/indexeddb/adapter.js';
import { startMigrations } from '../adapters/indexeddb/migrate.js';
import { installRuntimePort } from '../adapters/messaging/runtime-port.js';
import { unavailable } from '../core/contracts/outcomes.js';
import { createRouter } from '../core/messaging/router.js';
import { createBaselinePolicy } from '../core/ports/policy.js';
import { legacyIds, systemClock } from '../core/ports/runtime.js';
import { MIGRATE_MESSAGE, chromeSettings, kernelClient } from './host.js';
import { hostTimers, randomIds } from './messaging.js';

/** @typedef {import('./host.js').Client} Client */
/** @typedef {import('../adapters/indexeddb/adapter.js').SettingsStore} SettingsStore */
/** @typedef {import('../adapters/indexeddb/migrate.js').MigrateLocks} MigrateLocks */
/** @typedef {import('../adapters/indexeddb/migrate.js').MigrationOutcome} MigrationOutcome */
/** @typedef {import('../adapters/indexeddb/migrate.js').MigrationRun} MigrationRun */
/** @typedef {import('../adapters/indexeddb/space.js').Estimate} Estimate */
/** @typedef {import('../adapters/indexeddb/records.js').Digester} Digester */
/** @typedef {import('../core/messaging/router.js').Router} Router */
/** @typedef {import('../core/ports/runtime.js').Logger} Logger */
/** @typedef {import('../core/contracts/outcomes.js').Unavailable} Unavailable */

/**
 * What the router installs on: chrome.runtime's port listener, and the manifest's version
 * @typedef {import('../adapters/messaging/runtime-port.js').Runtime & Pick<typeof chrome.runtime, 'getManifest'>} WorkerRuntime
 */

/**
 * Timers the keepalive runs on: the worker's own unless a test passes a fake clock's
 * @typedef {{setInterval: (fn: () => void, ms: number) => unknown, clearInterval: (id: unknown) => void}} KeepaliveTimers
 */

/**
 * What the worker's storage runs on, read from the worker's globals unless a test passes it
 * @typedef {object} WorkerHost
 * @property {IDBFactory} indexedDB
 * @property {typeof IDBKeyRange} keyRange
 * @property {SettingsStore} settings
 * @property {MigrateLocks} locks
 * @property {Estimate | null} estimate
 * @property {Digester} crypto
 * @property {string | null} [version] - the build's manifest version, which a record that stands must match
 * @property {(() => unknown) | null} [keepAlive]
 *   A light extension API call, made every KEEPALIVE_MS while a run is in progress, since
 *   Chrome stops an extension worker that goes 30 seconds without an event or an extension
 *   API call, and IndexedDB work counts as neither
 * @property {KeepaliveTimers} [timers]
 */

/**
 * The run's outcome as the worker records it, under chrome.storage.local
 * `setting_storageUpgrade`: a status, a failure code, when, the build that ran it, and whether
 * the run read the stores (`costly`), never content
 * @typedef {{status: MigrationOutcome['status'], code: string | null, at: number, version: string | null, costly: boolean}} UpgradeRecord
 */

/** chrome.storage.local key of the recorded outcome, which Storage.readSetting reads as `storageUpgrade` */
export const UPGRADE_RECORD_KEY = 'setting_storageUpgrade';

/** What a page sends to wake the worker and hear its run's status (#17, Q12), from host.js */
export { MIGRATE_MESSAGE };

/**
 * How long a run that read the stores and then stopped short of space, or failed, stands
 * before another start of the same build tries again. Each such try reads every store to
 * measure it, and a space-blocked profile wakes the worker with every new tab, so it doesn't
 * try on each one. An update, and a run that read nothing (no database, or a failure before
 * the copy), try at once.
 */
export const RETRY_AFTER_MS = 30 * 60 * 1000;

/** How often the keepalive calls an extension API while a run is in progress, under Chrome's 30 s */
export const KEEPALIVE_MS = 20 * 1000;

/**
 * The answers after which a command starts another attempt and runs once more: its connection
 * went (another context upgraded or deleted the database), or its versioned open found the
 * database older than 9, which only the runner upgrades
 */
const RETRIED_CODES = Object.freeze(['reload-required', 'migration-required']);

/**
 * Where the runner and the worker's storage warn, with ids, codes, and statuses only
 * @type {Logger}
 */
const storageLogger = Object.freeze({
  warn: (event, detail) => console.warn(`NewTabNote storage: ${event}`, detail),
});

/**
 * The worker's own storage host
 * @returns {WorkerHost}
 */
export function workerHost() {
  const nav = /** @type {Navigator & {storage?: {estimate?: () => Promise<{quota?: number, usage?: number}>}}} */ (
    globalThis.navigator
  );
  const runtime = globalThis.chrome && globalThis.chrome.runtime;
  return {
    indexedDB: globalThis.indexedDB,
    keyRange: globalThis.IDBKeyRange,
    settings: chromeSettings(),
    locks: /** @type {MigrateLocks} */ (/** @type {unknown} */ (nav && nav.locks)),
    estimate: nav && nav.storage && typeof nav.storage.estimate === 'function' ? () => nav.storage.estimate() : null,
    crypto: /** @type {Digester} */ (/** @type {unknown} */ (globalThis.crypto)),
    version: manifestVersion(),
    keepAlive: runtime && typeof runtime.getPlatformInfo === 'function' ? () => runtime.getPlatformInfo() : null,
  };
}

/**
 * This build's manifest version, or null where there's no chrome.runtime
 * @returns {string | null}
 */
function manifestVersion() {
  try {
    return globalThis.chrome.runtime.getManifest().version;
  } catch {
    return null;
  }
}

/**
 * Whether a run's outcome came after reading the stores: it found a database with stores, so it
 * measured them for the space check, and copied and verified them if there was room
 * @param {MigrationOutcome} outcome
 */
const readTheStores = outcome => outcome.shape !== null && outcome.shape !== 'none';

/**
 * Whether `record` is a run of this build that read the stores and then stopped short of space
 * or failed, less than RETRY_AFTER_MS ago
 * @param {unknown} record
 * @param {number} now
 * @param {string | null} version
 * @returns {record is UpgradeRecord}
 */
function standing(record, now, version) {
  if (!record || typeof record !== 'object') return false;
  const { status, at, version: ranBy = null, costly = true } = /** @type {UpgradeRecord} */ (record);
  if (ranBy !== version || costly === false) return false;
  return (status === 'space-blocked' || status === 'failed') && typeof at === 'number' && now - at < RETRY_AFTER_MS;
}

/**
 * Records a run's `outcome` where the new tab reads it. A run that stopped short of space or
 * failed is written every time it runs, so its time starts the next RETRY_AFTER_MS; any other
 * outcome only when it changes, so the pages' settings listeners don't hear every worker start.
 * Best effort: the run's work is done either way.
 * @param {SettingsStore} settings
 * @param {MigrationOutcome} outcome
 * @param {unknown} stored
 * @param {number} now
 * @param {string | null} version
 * @returns {Promise<void>}
 */
async function record(settings, outcome, stored, now, version) {
  const code = outcome.failure ? outcome.failure.code : null;
  const costly = readTheStores(outcome);
  const previous = /** @type {Partial<UpgradeRecord>} */ (stored && typeof stored === 'object' ? stored : {});
  const backsOff = outcome.status === 'space-blocked' || outcome.status === 'failed';
  const same =
    previous.status === outcome.status &&
    previous.code === code &&
    (previous.version ?? null) === version &&
    (previous.costly ?? true) === costly;
  if (same && !backsOff) return;
  try {
    await settings.set({ [UPGRADE_RECORD_KEY]: { status: outcome.status, code, at: now, version, costly } });
  } catch (error) {
    storageLogger.warn('storage-upgrade-record-failed', { status: outcome.status, error });
  }
}

/**
 * The worker's migration, as its client exposes it
 * @typedef {object} WorkerMigration
 * @property {Promise<MigrationOutcome>} done - the latest attempt's outcome
 * @property {() => Promise<MigrationOutcome>} request
 *   What a page's storage.migrate gets (#17, Q12): the attempt running now, or, after one that
 *   stopped short of space or failed, a new one, which the backoff holds back only for a run
 *   that read the stores
 * @property {() => boolean} blocked - whether the run's upgrade waits on another connection now
 * @property {() => boolean} running - whether an attempt is in progress, which the keepalive spans
 */

/**
 * The worker's client, with the migration behind it
 * @typedef {Client & {migration: WorkerMigration}} WorkerClient
 */

/**
 * The worker's kernel and its client. It starts a migration attempt now: a run, unless one of
 * this build that read the stores and then stopped short of space or failed stands
 * (RETRY_AFTER_MS). It builds the kernel on #17's adapter once the attempt is done, as the top
 * of this file says, and builds it again after every later attempt. Its caller,
 * `worker-internal`, may capture and maintain, and nothing else. Until an attempt is done,
 * every call waits for it, except while the upgrade is blocked (an open page of an older build
 * holds the database): then `whenReady` and every command answer `blocked-upgrade`, retryable,
 * at once, so a capture says "Not captured" rather than wait. Its connection closes when
 * another context upgrades or deletes the database, so it never blocks one, and the next
 * command starts another attempt, which upgrades only after its own verified point, then opens
 * the database again once. A run keeps the worker alive (KEEPALIVE_MS) until it ends.
 * @param {WorkerHost} [host]
 * @returns {WorkerClient}
 */
export function createWorkerClient(host = workerHost()) {
  const version = host.version ?? null;
  /** @type {KeepaliveTimers} */
  const timers = host.timers || {
    setInterval: (fn, ms) => globalThis.setInterval(fn, ms),
    clearInterval: id => globalThis.clearInterval(/** @type {ReturnType<typeof setInterval>} */ (id)),
  };
  /** @type {MigrationRun | null} */
  let run = null;
  let attempts = 0;
  let settled = 0;
  /** Whether the run's upgrade waits on another connection now */
  const blocked = () => run !== null && run.state() === 'blocked-upgrade';
  /** What waits on the run, told when the upgrade turns out blocked */
  /** @type {Set<() => void>} */
  const onBlock = new Set();

  /**
   * Calls an extension API every KEEPALIVE_MS until `ending` settles
   * @param {Promise<unknown>} ending
   */
  const keepAliveUntil = ending => {
    if (typeof host.keepAlive !== 'function') return;
    const keepAlive = host.keepAlive;
    const id = timers.setInterval(() => {
      try {
        Promise.resolve(keepAlive()).catch(() => {});
      } catch {
        // A keepalive that throws keeps nothing alive, and stops nothing either
      }
    }, KEEPALIVE_MS);
    ending.finally(() => timers.clearInterval(id)).catch(() => {});
  };

  /**
   * One attempt: read the record, then run unless a run that read the stores stands
   * @returns {Promise<MigrationOutcome>}
   */
  const attempt = () => {
    attempts += 1;
    /** @type {Promise<MigrationOutcome>} */
    const outcome = Promise.resolve()
      .then(() => host.settings.get([UPGRADE_RECORD_KEY]))
      .catch(() => ({}))
      .then(stored => {
        const previous = /** @type {Record<string, unknown>} */ (stored || {})[UPGRADE_RECORD_KEY];
        if (standing(previous, systemClock.now(), version)) {
          /** @type {MigrationOutcome} */
          const kept = {
            status: previous.status,
            shape: null,
            to: null,
            steps: [],
            recoveryPointId: null,
            failure: previous.code ? { code: previous.code } : null,
          };
          return kept;
        }
        run = startMigrations({
          indexedDB: host.indexedDB,
          keyRange: host.keyRange,
          locks: host.locks,
          estimate: host.estimate,
          crypto: host.crypto,
          clock: systemClock,
          logger: storageLogger,
          onBlocked: () => {
            // migrate.js marks the run blocked before it calls this
            for (const stop of [...onBlock]) stop();
            onBlock.clear();
          },
        });
        return run.done.then(async ended => {
          await record(host.settings, ended, previous, systemClock.now(), version);
          return ended;
        });
      });
    keepAliveUntil(outcome);
    outcome.then(
      () => {
        settled += 1;
      },
      () => {
        settled += 1;
      },
    );
    return outcome;
  };

  /**
   * The kernel on the database `outcome` left: versioned at 9, as it is otherwise
   * @param {Promise<MigrationOutcome>} outcome
   * @returns {Promise<Client>}
   */
  const build = outcome =>
    outcome.then(ended => {
      const upgraded = ended.status === 'migrated' || ended.status === 'current';
      const adapter = createIndexedDbAdapter({
        indexedDB: host.indexedDB,
        settings: host.settings,
        mode: upgraded ? 'versioned' : 'existing',
        requireCore: true,
      });
      return kernelClient({ adapter, surface: 'worker-internal', maintainOnOpen: upgraded });
    });

  let done = attempt();
  let client = build(done);

  /** Starts another attempt, and builds the kernel on it */
  const again = () => {
    done = attempt();
    client = build(done);
    return done;
  };

  /** @returns {Promise<MigrationOutcome>} */
  const request = () => {
    // One in progress, blocked or not, is the answer: another would only queue behind it
    if (settled < attempts) return done;
    return done.then(ended => (ended.status === 'space-blocked' || ended.status === 'failed' ? again() : ended));
  };

  /** @returns {Unavailable} */
  const blockedUpgrade = () => unavailable('storage', 'blocked-upgrade', true);

  /**
   * Resolves `waiting`, or with null at once while the upgrade is blocked
   * @template T
   * @param {Promise<T>} waiting
   * @returns {Promise<T | null>}
   */
  const unlessBlocked = waiting => {
    if (blocked()) return Promise.resolve(null);
    return new Promise(resolve => {
      const stop = () => resolve(null);
      onBlock.add(stop);
      waiting.then(value => {
        onBlock.delete(stop);
        resolve(value);
      });
    });
  };

  /** @type {WorkerClient['execute']} */
  const execute = /** @type {any} */ (
    async (/** @type {any} */ command) => {
      const ready = await unlessBlocked(client);
      if (!ready) return blockedUpgrade();
      const outcome = await ready.execute(command);
      if (outcome.kind !== 'unavailable' || !RETRIED_CODES.includes(outcome.code)) return outcome;
      // The connection went before this command's transaction began, or the open found an older
      // database than the run left, so nothing of it committed. The database may have been
      // replaced since, so another attempt first, which upgrades only after its own verified
      // point, then a new connection and the command once more.
      again();
      const next = await unlessBlocked(client);
      return next ? next.execute(command) : blockedUpgrade();
    }
  );

  return Object.freeze({
    execute,
    query: /** @type {WorkerClient['query']} */ (
      /** @type {any} */ (async (/** @type {any} */ query) => (await client).query(query))
    ),
    subscribe: listener => {
      let unsubscribe = () => {};
      let stopped = false;
      client.then(ready => {
        if (!stopped) unsubscribe = ready.subscribe(listener);
      });
      return () => {
        stopped = true;
        unsubscribe();
      };
    },
    whenReady: async () => {
      const ready = await unlessBlocked(client);
      return ready ? ready.whenReady() : blockedUpgrade();
    },
    ids: legacyIds,
    migration: Object.freeze({
      get done() {
        return done;
      },
      request,
      blocked,
      running: () => settled < attempts,
    }),
  });
}

/**
 * What the router warns of, with an operation's name and an error at most, never a payload
 * @type {Logger}
 */
const messagingLogger = Object.freeze({
  warn: (event, detail) => console.warn(`NewTabNote messaging: ${event}`, detail),
});

/** @param {unknown} error */
const warnOf = error => messagingLogger.warn('worker-router-failed', { error });

/**
 * #13's router, on `runtime`'s port listener, so each port one of this extension's pages
 * opens by PORT_NAME reaches it (adapters/messaging/runtime-port.js). It serves the handshake,
 * system.messagingHealth and system.coordinatorHealth, and no page opens a port yet, since no
 * client moves to it before #35's later slices. js/background.js calls this at its top level, synchronously, so the
 * listener is there before Chrome hands over the port that woke the worker. It never throws,
 * since a throw there would stop every listener the worker registers: `report` hears why a
 * router couldn't be installed, and what a port's listener threw.
 *
 * #35's coordinator gives it this instance's id, which each welcome sends, `status`, which
 * each welcome says, the session hooks, whose `opened` starts the coordinator, and the
 * handler for system.coordinatorHealth.
 * @param {{
 *   runtime?: unknown,
 *   report?: (error: unknown) => void,
 *   coordinatorId?: string,
 *   status?: () => import('../core/messaging/router.js').CoordinatorStatus,
 *   sessions?: import('../core/messaging/router.js').SessionHooks,
 *   handlers?: Readonly<Record<string, import('../core/messaging/router.js').Handler>>,
 * }} [options] - `runtime` is chrome.runtime unless a test passes another
 * @returns {Router | null} the router, or null when it couldn't be installed
 */
export function installWorkerRouter({
  runtime = globalThis.chrome?.runtime,
  report = warnOf,
  coordinatorId,
  status,
  sessions,
  handlers,
} = {}) {
  try {
    const worker = /** @type {WorkerRuntime} */ (runtime);
    const router = createRouter({
      policy: createBaselinePolicy(),
      clock: systemClock,
      timers: hostTimers,
      coordinatorId: coordinatorId ?? randomIds.next(),
      extensionVersion: worker.getManifest().version,
      status,
      sessions,
      handlers,
      logger: messagingLogger,
    });
    installRuntimePort({ runtime: worker, router, report });
    return router;
  } catch (error) {
    report(error);
    return null;
  }
}
