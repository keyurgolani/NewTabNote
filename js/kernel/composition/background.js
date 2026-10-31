/**
 * The service worker's composition root (#12, docs/adr/0001-kernel-stack.md).
 *
 * js/background.js imports this module statically, so it evaluates before the worker
 * registers any listener. A throw while it loads, or a top-level await anywhere in what it
 * imports, leaves the extension without its context menus and commands, so loading it
 * touches no browser API. js/background.js builds the worker's kernel with
 * createWorkerClient(), which starts #17's migration run, and installs #13's router with
 * installWorkerRouter().
 *
 * Since #17 PR 1b the worker is the one context that upgrades CanvasTabDB: at worker start it
 * runs the migration runner (migrate.js) under Web Lock `storage.migrate`, which makes the
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
 * What the worker's storage runs on, read from the worker's globals unless a test passes it
 * @typedef {object} WorkerHost
 * @property {IDBFactory} indexedDB
 * @property {typeof IDBKeyRange} keyRange
 * @property {SettingsStore} settings
 * @property {MigrateLocks} locks
 * @property {Estimate | null} estimate
 * @property {Digester} crypto
 * @property {string} [version] - the build's manifest version, which a record that stands must match
 */

/**
 * The run's outcome as the worker records it, under chrome.storage.local
 * `setting_storageUpgrade`: a status, a failure code, when, and the build that ran it, never
 * content
 * @typedef {{status: MigrationOutcome['status'], code: string | null, at: number, version: string | null}} UpgradeRecord
 */

/** chrome.storage.local key of the recorded outcome, which Storage.readSetting reads as `storageUpgrade` */
export const UPGRADE_RECORD_KEY = 'setting_storageUpgrade';

/** What a page sends to wake the worker and hear its run's status (#17, Q12), from host.js */
export { MIGRATE_MESSAGE };

/**
 * How long a run that stopped short of space, or failed, stands before a worker start of the
 * same build tries again. Each try reads every store to measure it, and a space-blocked
 * profile wakes the worker with every new tab, so it doesn't try on each one. An update tries
 * at once.
 */
export const RETRY_AFTER_MS = 30 * 60 * 1000;

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
  return {
    indexedDB: globalThis.indexedDB,
    keyRange: globalThis.IDBKeyRange,
    settings: chromeSettings(),
    locks: /** @type {MigrateLocks} */ (/** @type {unknown} */ (nav && nav.locks)),
    estimate: nav && nav.storage && typeof nav.storage.estimate === 'function' ? () => nav.storage.estimate() : null,
    crypto: /** @type {Digester} */ (/** @type {unknown} */ (globalThis.crypto)),
    version: manifestVersion(),
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
 * Whether `record` is a run of this build that stopped short of space or failed less than
 * RETRY_AFTER_MS ago
 * @param {unknown} record
 * @param {number} now
 * @param {string | null} version
 * @returns {record is UpgradeRecord}
 */
function standing(record, now, version) {
  if (!record || typeof record !== 'object') return false;
  const { status, at, version: ranBy = null } = /** @type {UpgradeRecord} */ (record);
  if (ranBy !== version) return false;
  return (status === 'space-blocked' || status === 'failed') && typeof at === 'number' && now - at < RETRY_AFTER_MS;
}

/**
 * Records `outcome` where the new tab reads it, when it differs from what's there. Best
 * effort: the run's work is done either way.
 * @param {SettingsStore} settings
 * @param {MigrationOutcome} outcome
 * @param {unknown} stored
 * @param {number} now
 * @param {string | null} version
 * @returns {Promise<void>}
 */
async function record(settings, outcome, stored, now, version) {
  const code = outcome.failure ? outcome.failure.code : null;
  const previous = /** @type {Partial<UpgradeRecord>} */ (stored && typeof stored === 'object' ? stored : {});
  // A status that stands keeps its time, so a retry after RETRY_AFTER_MS still happens
  if (previous.status === outcome.status && previous.code === code && (previous.version ?? null) === version) return;
  try {
    await settings.set({ [UPGRADE_RECORD_KEY]: { status: outcome.status, code, at: now, version } });
  } catch (error) {
    storageLogger.warn('storage-upgrade-record-failed', { status: outcome.status, error });
  }
}

/**
 * The worker's client, with the migration run behind it
 * @typedef {Client & {migration: {done: Promise<MigrationOutcome>, blocked: () => boolean}}} WorkerClient
 */

/**
 * The worker's kernel and its client. It starts the migration run now (unless one that stopped
 * short of space or failed stands, RETRY_AFTER_MS), and builds the kernel on #17's adapter once
 * the run has finished, as the top of this file says. Its caller, `worker-internal`, may
 * capture and maintain, and nothing else. Until the run has finished, every call waits for it,
 * except while the upgrade is blocked (an open page of an older build holds the database):
 * then `whenReady` and every command answer `blocked-upgrade`, retryable, at once, so a capture
 * says "Not captured" rather than wait. Its connection closes when another context upgrades or
 * deletes the database, so it never blocks one, and the next command opens it again once.
 * @param {WorkerHost} [host]
 * @returns {WorkerClient}
 */
export function createWorkerClient(host = workerHost()) {
  /** @type {MigrationRun | null} */
  let run = null;
  /** Whether the run's upgrade waits on another connection now */
  const blocked = () => run !== null && run.state() === 'blocked-upgrade';
  /** What waits on the run, told when the upgrade turns out blocked */
  /** @type {Set<() => void>} */
  const onBlock = new Set();
  /** @type {Promise<MigrationOutcome>} */
  const done = Promise.resolve()
    .then(() => host.settings.get([UPGRADE_RECORD_KEY]))
    .catch(() => ({}))
    .then(stored => {
      const previous = /** @type {Record<string, unknown>} */ (stored || {})[UPGRADE_RECORD_KEY];
      const now = systemClock.now();
      if (standing(previous, now, host.version ?? null)) {
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
      return run.done.then(async outcome => {
        await record(host.settings, outcome, previous, systemClock.now(), host.version ?? null);
        return outcome;
      });
    });

  /** @returns {Promise<Client>} */
  const build = () =>
    done.then(outcome => {
      const upgraded = outcome.status === 'migrated' || outcome.status === 'current';
      const adapter = createIndexedDbAdapter({
        indexedDB: host.indexedDB,
        settings: host.settings,
        mode: upgraded ? 'versioned' : 'existing',
        requireCore: true,
      });
      return kernelClient({ adapter, surface: 'worker-internal', maintainOnOpen: upgraded });
    });

  let client = build();

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
      if (outcome.kind !== 'unavailable' || outcome.code !== 'reload-required') return outcome;
      // The connection went before this command's transaction began, so nothing of it
      // committed: a new connection, and the command once more
      client = build();
      return (await client).execute(command);
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
    migration: Object.freeze({ done, blocked }),
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
 * opens by PORT_NAME reaches it (adapters/messaging/runtime-port.js). It serves only the
 * handshake and system.messagingHealth until #35 adds its handlers, and no page opens a port
 * yet, since no client moves to it before #35. js/background.js calls this at its top level,
 * synchronously, so the listener is there before Chrome hands over the port that woke the
 * worker. It never throws, since a throw there would stop every listener the worker
 * registers: `report` hears why a router couldn't be installed, and what a port's listener
 * threw.
 * @param {{runtime?: unknown, report?: (error: unknown) => void}} [options] - `runtime` is
 *   chrome.runtime unless a test passes another
 * @returns {Router | null} the router, or null when it couldn't be installed
 */
export function installWorkerRouter({ runtime = globalThis.chrome?.runtime, report = warnOf } = {}) {
  try {
    const worker = /** @type {WorkerRuntime} */ (runtime);
    const router = createRouter({
      policy: createBaselinePolicy(),
      clock: systemClock,
      timers: hostTimers,
      coordinatorId: randomIds.next(),
      extensionVersion: worker.getManifest().version,
      logger: messagingLogger,
    });
    installRuntimePort({ runtime: worker, router, report });
    return router;
  } catch (error) {
    report(error);
    return null;
  }
}
