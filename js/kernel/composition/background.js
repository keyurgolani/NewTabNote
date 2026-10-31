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
 * verified `pre-migration` recovery point and then opens the database at this build's version
 * (10 since #17 PR 2a). Its kernel is on #17's IndexedDB adapter, opened once the run has
 * finished: `versioned`, with startup maintenance, when the database is at that version, and
 * `existing` when the run left it as it was (short of space, refused, or failed), so captures
 * keep working on the shape that's there. Once it's open at version 10, the worker sweeps the
 * adapter's ledger, at most once a day (ledger.js), runs the data transforms its database
 * still needs (transforms.js, #17 PR 3a) at every start, and purges what was deleted for good
 * from the recovery points (purge.js, #17 PR 2b): at every start, after the transforms, and
 * again when a page that deleted something wakes it with `storage.purge`.
 * PURGE_RECOVERY_POINTS turns the purge off.
 * The run's outcome goes to chrome.storage.local (`setting_storageUpgrade`), which the new tab
 * reads for its space notice and Settings > Data & Backup.
 */

import { createIndexedDbAdapter } from '../adapters/indexeddb/adapter.js';
import { failureOf } from '../adapters/indexeddb/failures.js';
import { UPGRADE_BLOCKED_KEY } from '../adapters/indexeddb/health.js';
import { startMigrations } from '../adapters/indexeddb/migrate.js';
import { purgeRecoveryPoints } from '../adapters/indexeddb/purge.js';
import { LATEST_STRUCTURAL } from '../adapters/indexeddb/registry.js';
import { runTransforms } from '../adapters/indexeddb/transforms.js';
import { installRuntimePort } from '../adapters/messaging/runtime-port.js';
import { unavailable } from '../core/contracts/outcomes.js';
import { createRouter } from '../core/messaging/router.js';
import { createBaselinePolicy } from '../core/ports/policy.js';
import { systemClock } from '../core/ports/runtime.js';
import { MIGRATE_MESSAGE, PURGE_MESSAGE, chromeSettings, kernelClient } from './host.js';
import { hostTimers, randomIds } from './messaging.js';

/** @typedef {import('./host.js').Client} Client */
/** @typedef {import('../adapters/indexeddb/adapter.js').SettingsStore} SettingsStore */
/** @typedef {import('../adapters/indexeddb/migrate.js').MigrateLocks} MigrateLocks */
/** @typedef {import('../adapters/indexeddb/migrate.js').MigrationOutcome} MigrationOutcome */
/** @typedef {import('../adapters/indexeddb/migrate.js').MigrationRun} MigrationRun */
/** @typedef {import('../adapters/indexeddb/purge.js').PurgeOutcome} PurgeOutcome */
/** @typedef {import('../adapters/indexeddb/transforms.js').TransformOutcome} TransformOutcome */
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
 * @property {(report: MigrationReport) => void} [report]
 *   Told of each run the worker makes (#20, the diagnostic journal): when its upgrade turns out
 *   blocked, and when it ends, never for a record it keeps without running. Best effort: a
 *   report that throws changes nothing the run does.
 * @property {boolean} [purgeRecoveryPoints] - PURGE_RECOVERY_POINTS unless a test says otherwise
 * @property {PurgeEvents | null} [events] - the worker's failure events (#20), which a stopped
 *   purge and its end go to
 */

/**
 * Where the worker's purge journals a stop and its end: the worker's failure events
 * (composition/trust.js), best effort
 * @typedef {{event: (code: string, fields?: Record<string, unknown>, failure?: unknown) => void}} PurgeEvents
 */

/**
 * What the worker reports of a run
 * `standing` says a blocked marker stood when the attempt started, so a worker before this one
 * saw the same blocked upgrade; `previous` is the status and code of the record the run
 * replaced, null when there was none.
 * @typedef {{kind: 'blocked', standing?: boolean} | {kind: 'ended', outcome: MigrationOutcome, previous?: RecordedRun | null}} MigrationReport
 */

/**
 * A recorded run's status and code, which a report carries, codes only
 * @typedef {{status: string | null, code: string | null}} RecordedRun
 */

/**
 * @param {unknown} stored - a stored upgrade record
 * @returns {RecordedRun | null}
 */
function recordedOf(stored) {
  if (stored === null || typeof stored !== 'object') return null;
  const { status, code } = /** @type {Record<string, unknown>} */ (stored);
  return { status: typeof status === 'string' ? status : null, code: typeof code === 'string' ? code : null };
}

/**
 * The run's outcome as the worker records it, under chrome.storage.local
 * `setting_storageUpgrade`: a status, a failure code, when, the build that ran it, and whether
 * the run read the stores (`costly`), never content
 * @typedef {{status: MigrationOutcome['status'], code: string | null, at: number, version: string | null, costly: boolean}} UpgradeRecord
 */

/**
 * What two sweeps in a row did, as one answer: the later one's stop or failure when it had
 * one, and otherwise purged when either purged, with the tombstones and rows of both
 * @param {PurgeOutcome} first
 * @param {PurgeOutcome} then
 * @returns {PurgeOutcome}
 */
function combined(first, then) {
  const totals = {
    tombstones: first.tombstones + then.tombstones,
    rows: first.rows + then.rows,
    cleared: [...new Set([...first.cleared, ...then.cleared])],
  };
  if (then.status === 'stopped' || then.status === 'failed') return { ...then, ...totals };
  if (first.status === 'purged' || then.status === 'purged') {
    return { status: 'purged', failure: null, stops: [], backedOff: false, ...totals };
  }
  return { ...then, ...totals };
}

/**
 * Journals what one sweep stopped at and what it ended (#20): `storage.purge-stopped` for each
 * point it left, but one it backed off, and `storage.purge-completed` for each recorded stop it
 * purged or found gone. Codes and ids only.
 * @param {PurgeEvents | null | undefined} events
 * @param {PurgeOutcome} outcome
 */
export function journalPurge(events, outcome) {
  if (!events) return;
  try {
    for (const pointId of outcome.cleared) events.event('storage.purge-completed', { subjectId: pointId });
    for (const stop of outcome.stops) {
      // The code goes as the failure's, so the journal keeps it only when it's a registered one
      if (!stop.backedOff) events.event('storage.purge-stopped', { subjectId: stop.pointId }, { code: stop.code });
    }
  } catch {
    // Best effort: the purge never hears of the journal's
  }
}

/** chrome.storage.local key of the recorded outcome, which Storage.readSetting reads as `storageUpgrade` */
export const UPGRADE_RECORD_KEY = 'setting_storageUpgrade';

// The marker a run sets while its upgrade waits on another connection (adapters/indexeddb/health.js)
export { UPGRADE_BLOCKED_KEY };

/** What a page sends to wake the worker and hear its run's status (#17, Q12), from host.js */
export { MIGRATE_MESSAGE };

/** What a page sends once it has deleted something for good (#17 PR 2b), from host.js */
export { PURGE_MESSAGE };

/**
 * The owner's switch for the recovery-point purge (#17 PR 2b, Q16; purge.js). With it off, the
 * worker never purges, so a note deleted for good stays in every recovery point, and its
 * tombstone stays pending, so turning it on again purges it then.
 */
export const PURGE_RECOVERY_POINTS = true;

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
 * database older than this build's version, which only the runner upgrades
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
 * The runner's phase marks (migrate.js's hooks.between) that come only after it read the stores:
 * it measured them for the space check, then copied them. A point it reuses it read against the
 * stores too, with no mark, so a run with a point counts as well. A run that failed before
 * either read nothing but the database's shape (`inspected`), and backs nothing off (review R79).
 */
const READ_MARKS = Object.freeze(['measured', 'point-started', 'copy-read', 'copied', 'verified']);

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
 * @param {boolean} costly - whether the run read the stores
 * @returns {Promise<void>}
 */
async function record(settings, outcome, stored, now, version, costly) {
  const code = outcome.failure ? outcome.failure.code : null;
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
 * The worker's purge of the recovery points (purge.js), as its client exposes it
 * @typedef {object} WorkerPurge
 * @property {() => Promise<PurgeOutcome | null>} request
 *   What a page's storage.purge gets: a sweep once the latest migration attempt is in, which
 *   runs once more after the one in progress, so a delete made during it is purged too. Null
 *   while the database isn't at this build's version, or the switch is off.
 * @property {Promise<PurgeOutcome | null>} done - the latest sweep's outcome
 */

/**
 * The worker's data transforms (transforms.js), as its client exposes them
 * @typedef {object} WorkerTransforms
 * @property {Promise<TransformOutcome | null>} done - the latest run's outcome, null while the
 *   database isn't at this build's version
 */

/**
 * The worker's client, with the migration behind it, and the transforms and the purge after it
 * @typedef {Client & {migration: WorkerMigration, transforms: WorkerTransforms, purge: WorkerPurge}} WorkerClient
 */

/**
 * The worker's kernel and its client. It starts a migration attempt now: a run, unless one of
 * this build that read the stores and then stopped short of space or failed stands
 * (RETRY_AFTER_MS). It builds the kernel on #17's adapter once the attempt is done, as the top
 * of this file says, and builds it again after every later attempt. Its startup maintenance
 * writes first-run settings only, since the read-only integrity check runs after an install
 * or an update, as runIntegrityCheck (#35 slice 1). Its caller, `worker-internal`, may
 * capture, maintain and check, and nothing else. #35's coordinator builds it on its first
 * start, so the worker opens nothing until an event needs storage. Until an attempt is done,
 * every call waits for it, except while the upgrade is blocked (an open page of an older build
 * holds the database): then `whenReady` and every command answer `blocked-upgrade`, retryable,
 * at once, so a capture says "Not captured" rather than wait, and the coordinator says
 * `migrating` until the attempt ends. Its connection closes when another context upgrades or
 * deletes the database, so it never blocks one, and the next command starts another attempt,
 * which upgrades only after its own verified point, then opens the database again once. A run
 * keeps the worker alive (KEEPALIVE_MS) until it ends.
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
   * Tells the host's report of a run, never letting it in the run's way
   * @param {MigrationReport} report
   */
  const tell = report => {
    // A report that fails, now or later, has nowhere to go, and the run goes on
    Promise.resolve()
      .then(() => {
        if (typeof host.report === 'function') return host.report(report);
        return undefined;
      })
      .catch(() => {});
  };

  /**
   * Sets or clears the blocked marker. A write that fails leaves it as it was: the next attempt
   * clears it as it starts.
   * @param {{at: number} | null} value
   */
  const mark = value =>
    Promise.resolve()
      .then(() => host.settings.set({ [UPGRADE_BLOCKED_KEY]: value }))
      .catch(() => {});

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

  /** The outcomes an attempt kept from a standing record, without running */
  /** @type {WeakSet<MigrationOutcome>} */
  const kept = new WeakSet();

  /**
   * One attempt: read the record, then run unless a run that read the stores stands. It never
   * rejects: a run that couldn't start (a lock manager that throws, say) is a failed outcome.
   * @returns {Promise<MigrationOutcome>}
   */
  const attempt = () => {
    attempts += 1;
    let readStores = false;
    /** Whether a blocked marker stood when this attempt started, which it clears */
    let markerStood = false;
    /** @type {Promise<MigrationOutcome>} */
    const outcome = Promise.resolve()
      .then(() => host.settings.get([UPGRADE_RECORD_KEY, UPGRADE_BLOCKED_KEY]))
      .catch(() => ({}))
      .then(async stored => {
        const found = /** @type {Record<string, unknown>} */ (stored || {});
        // Every attempt clears the marker as it starts, and only a blocked upgrade sets it again,
        // so a worker that stopped while blocked leaves none behind past the next start
        markerStood = Boolean(found[UPGRADE_BLOCKED_KEY]);
        if (markerStood) await mark(null);
        return found;
      })
      .then(stored => {
        const previous = /** @type {Record<string, unknown>} */ (stored || {})[UPGRADE_RECORD_KEY];
        if (standing(previous, systemClock.now(), version)) {
          /** @type {MigrationOutcome} */
          const standingOutcome = {
            status: previous.status,
            shape: null,
            to: null,
            steps: [],
            recoveryPointId: null,
            failure: previous.code ? { code: previous.code } : null,
          };
          kept.add(standingOutcome);
          return standingOutcome;
        }
        /** Whether this run's upgrade turned out blocked, so it set the marker */
        let blockedNow = false;
        run = startMigrations({
          indexedDB: host.indexedDB,
          keyRange: host.keyRange,
          locks: host.locks,
          estimate: host.estimate,
          crypto: host.crypto,
          clock: systemClock,
          logger: storageLogger,
          hooks: {
            between: async label => {
              if (READ_MARKS.includes(label)) readStores = true;
            },
          },
          onBlocked: () => {
            // migrate.js marks the run blocked before it calls this
            for (const stop of [...onBlock]) stop();
            onBlock.clear();
            blockedNow = true;
            mark({ at: systemClock.now() });
            tell({ kind: 'blocked', standing: markerStood });
          },
        });
        return run.done.then(async ended => {
          await record(
            host.settings,
            ended,
            previous,
            systemClock.now(),
            version,
            (readStores || ended.recoveryPointId !== null) && ended.shape !== 'none',
          );
          if (blockedNow) await mark(null);
          tell({ kind: 'ended', outcome: ended, previous: recordedOf(previous) });
          return ended;
        });
      })
      .catch(async error => {
        const { code } = failureOf(error);
        storageLogger.warn('storage-migration-not-started', { code });
        /** @type {MigrationOutcome} */
        const failed = { status: 'failed', shape: null, to: null, steps: [], recoveryPointId: null, failure: { code } };
        // It read nothing, so the next request runs again at once
        const stored = await Promise.resolve()
          .then(() => host.settings.get([UPGRADE_RECORD_KEY]))
          .catch(() => ({}));
        const previous = recordedOf(/** @type {Record<string, unknown>} */ (stored || {})[UPGRADE_RECORD_KEY]);
        await record(host.settings, failed, null, systemClock.now(), version, false);
        tell({ kind: 'ended', outcome: failed, previous });
        return failed;
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

  /** @type {import('../adapters/indexeddb/adapter.js').IndexedDbAdapter | null} */
  let adapter = null;

  const purgeOn = host.purgeRecoveryPoints ?? PURGE_RECOVERY_POINTS;
  /** The sweep in progress, if any */
  /** @type {Promise<PurgeOutcome> | null} */
  let sweeping = null;
  /** Whether a wake came while a sweep ran, so another follows it */
  let sweepAgain = false;
  /** @type {Promise<PurgeOutcome | null>} */
  let purged = Promise.resolve(null);

  /**
   * Sweeps the recovery points of what the pending tombstones name, under the points lock, and
   * once more when asked again meanwhile. The keepalive spans it.
   * @returns {Promise<PurgeOutcome>}
   */
  const sweepPoints = () => {
    if (sweeping) {
      sweepAgain = true;
      return sweeping;
    }
    const running = (async () => {
      /** @type {PurgeOutcome | null} */
      let ended = null;
      do {
        sweepAgain = false;
        const next = await purgeRecoveryPoints({
          indexedDB: host.indexedDB,
          keyRange: host.keyRange,
          locks: host.locks,
          crypto: host.crypto,
          clock: systemClock,
          logger: storageLogger,
        });
        journalPurge(host.events, next);
        ended = ended ? combined(ended, next) : next;
      } while (sweepAgain);
      // The loop runs at least once
      return /** @type {PurgeOutcome} */ (ended);
    })().finally(() => {
      sweeping = null;
    });
    sweeping = running;
    keepAliveUntil(running);
    return running;
  };

  /** @type {Promise<TransformOutcome | null>} */
  let transformed = Promise.resolve(null);

  /**
   * The transforms the database still needs (transforms.js), once the latest attempt is in and
   * left it at this build's version. The kernel never waits for them: they run under the points
   * lock, in batches a page's commit goes between. The keepalive spans them.
   * @returns {Promise<TransformOutcome | null>}
   */
  const requestTransforms = () => {
    const next = done
      .then(ended =>
        ended.status === 'migrated' || ended.status === 'current'
          ? runTransforms({
              indexedDB: host.indexedDB,
              keyRange: host.keyRange,
              locks: host.locks,
              estimate: host.estimate,
              crypto: host.crypto,
              clock: systemClock,
              logger: storageLogger,
            })
          : null,
      )
      .catch(error => {
        storageLogger.warn('storage-transform-not-started', { code: failureOf(error).code });
        return null;
      });
    transformed = next;
    keepAliveUntil(next);
    return next;
  };

  /**
   * A sweep once the latest attempt and the transforms that followed it are in, when the attempt
   * left the database at this build's version and the switch is on
   * @returns {Promise<PurgeOutcome | null>}
   */
  const requestPurge = () => {
    const before = transformed;
    const next = Promise.all([done, before])
      .then(([ended]) =>
        purgeOn && (ended.status === 'migrated' || ended.status === 'current') ? sweepPoints() : null,
      )
      .catch(error => {
        storageLogger.warn('storage-purge-not-started', { code: failureOf(error).code });
        return null;
      });
    purged = next;
    return next;
  };

  /**
   * The ledger's retention on `opened`, once its kernel is ready, in the background: it never
   * holds up a command, sweeps at most once a day, and a sweep the worker's stop cuts off
   * finishes at the next start (ledger.js). Pages never sweep.
   * @param {import('../adapters/indexeddb/adapter.js').IndexedDbAdapter} opened
   * @param {Client} built
   */
  const sweepOnce = (opened, built) => {
    built
      .whenReady()
      .then(failure => (failure ? undefined : opened.sweepLedger()))
      .catch(error => storageLogger.warn('storage-ledger-sweep-failed', { code: failureOf(error).code }));
  };

  /**
   * The kernel on the database `outcome` left: versioned at this build's version, as it is
   * otherwise. An outcome
   * kept from a standing record changes nothing, so `keep`, the client before it, stays. Any
   * other closes the adapter it replaces, so the worker holds one connection (review R79).
   * @param {Promise<MigrationOutcome>} outcome
   * @param {Promise<Client> | null} [keep]
   * @returns {Promise<Client>}
   */
  const build = (outcome, keep = null) =>
    outcome.then(ended => {
      if (keep && kept.has(ended)) return keep;
      const upgraded = ended.status === 'migrated' || ended.status === 'current';
      const replaced = adapter;
      adapter = createIndexedDbAdapter({
        indexedDB: host.indexedDB,
        settings: host.settings,
        mode: upgraded ? 'versioned' : 'existing',
        requireCore: true,
      });
      if (replaced) replaced.close();
      const built = kernelClient({ adapter, surface: 'worker-internal', maintainOnOpen: upgraded });
      sweepOnce(adapter, built);
      // At every start, and after every later attempt: the transforms a run cut off or never
      // reached, then the deletes the worker didn't hear of, or a sweep its stop cut off
      if (upgraded) {
        requestTransforms();
        requestPurge();
      }
      return built;
    });

  let done = attempt();
  let client = build(done);

  /**
   * Starts another attempt, and builds the kernel on it. `keep` keeps the client when the
   * attempt only finds the record standing; a command whose connection went needs a new one.
   * @param {{keep?: boolean}} [options]
   */
  const again = ({ keep = false } = {}) => {
    const before = client;
    done = attempt();
    client = build(done, keep ? before : null);
    return done;
  };

  /** The retry that requests arriving together after a failed or space-blocked attempt share */
  /** @type {Promise<MigrationOutcome> | null} */
  let retry = null;

  /** @returns {Promise<MigrationOutcome>} */
  const request = () => {
    // One in progress, blocked or not, is the answer: another would only queue behind it
    if (settled < attempts) return done;
    if (!retry) {
      const shared = done
        .then(ended => (ended.status === 'space-blocked' || ended.status === 'failed' ? again({ keep: true }) : ended))
        .finally(() => {
          if (retry === shared) retry = null;
        });
      retry = shared;
    }
    return retry;
  };

  /** @returns {Unavailable} */
  const blockedUpgrade = () => unavailable('storage', 'blocked-upgrade', true);

  /** @returns {Unavailable} */
  const notOpened = () => unavailable('storage', 'open-failed', true);

  /**
   * Resolves `waiting`, or with null at once while the upgrade is blocked, or with undefined
   * when `waiting` rejects (a kernel that couldn't be built), so no call waits for ever
   * @template T
   * @param {Promise<T>} waiting
   * @returns {Promise<T | null | undefined>}
   */
  const unlessBlocked = waiting => {
    if (blocked()) return Promise.resolve(null);
    return new Promise(resolve => {
      const stop = () => resolve(null);
      onBlock.add(stop);
      waiting.then(
        value => {
          onBlock.delete(stop);
          resolve(value);
        },
        error => {
          onBlock.delete(stop);
          storageLogger.warn('storage-kernel-not-built', { code: failureOf(error).code });
          resolve(undefined);
        },
      );
    });
  };

  /** @type {WorkerClient['execute']} */
  const execute = /** @type {any} */ (
    async (/** @type {any} */ command) => {
      const ready = await unlessBlocked(client);
      if (ready === null) return blockedUpgrade();
      if (ready === undefined) return notOpened();
      const outcome = await ready.execute(command);
      if (outcome.kind !== 'unavailable' || !RETRIED_CODES.includes(outcome.code)) return outcome;
      // The connection went before this command's transaction began, or the open found an older
      // database than the run left, so nothing of it committed. The database may have been
      // replaced since, so another attempt first, which upgrades only after its own verified
      // point, then a new connection and the command once more.
      again();
      const next = await unlessBlocked(client);
      if (next === null) return blockedUpgrade();
      if (next === undefined) return notOpened();
      return next.execute(command);
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
      if (ready === null) return blockedUpgrade();
      if (ready === undefined) return notOpened();
      return ready.whenReady();
    },
    ids: randomIds,
    migration: Object.freeze({
      get done() {
        return done;
      },
      request,
      blocked,
      running: () => settled < attempts,
    }),
    transforms: Object.freeze({
      get done() {
        return transformed;
      },
    }),
    purge: Object.freeze({
      request: requestPurge,
      get done() {
        return purged;
      },
    }),
  });
}

/**
 * The refusals the worker's open journals itself, as storage.open-failed (#35's coordinator,
 * ./coordinator.js, on its kernel's first answer), so the run doesn't journal them again
 */
const OPEN_JOURNALS = Object.freeze(['missing-core-stores', 'version-too-new']);

/**
 * The worker's migration reports as diagnostic journal events (#20, slice 4 prerequisites):
 * a blocked upgrade or a run short of space is `storage.migration-blocked` with why, a run
 * that failed is `storage.migration-failed` with its code, and a run that upgraded a 1.4.x
 * database (not a fresh profile's, which only makes it) is `storage.migration-completed`.
 * A refused run is `storage.migration-failed` with its code, unless the open journals it.
 * Each holds the version the run upgrades to and codes only. The same event is journaled
 * once until a run completes, however often a page's request runs it again, and a later
 * worker start skips it while the record, or the blocked marker, says the same.
 * @param {(code: string, fields?: Record<string, unknown>, failure?: unknown) => void} event
 *   the context's failure events (composition/trust.js), which never throw
 * @returns {(report: MigrationReport) => void}
 */
export function migrationEvents(event) {
  /** @type {Set<string>} */
  const journaled = new Set();
  /**
   * @param {string} code
   * @param {Record<string, unknown>} fields
   * @param {unknown} [failure]
   */
  const once = (code, fields, failure) => {
    const key = `${code}/${String(fields.errorCode ?? (failure && /** @type {any} */ (failure).code) ?? '')}`;
    if (journaled.has(key)) return;
    journaled.add(key);
    event(code, { schemaVersion: LATEST_STRUCTURAL, ...fields }, failure);
  };
  return report => {
    if (report.kind === 'blocked') {
      // A marker that stood: a worker before this one journaled the same blocked upgrade
      if (report.standing) return;
      once('storage.migration-blocked', { errorCode: 'blocked-upgrade' });
      return;
    }
    const { outcome, previous = null } = report;
    // The record it replaced said the same, so a worker before this one journaled it: Chrome
    // stops an idle worker, and the next start runs again
    const repeated =
      previous !== null && previous.status === outcome.status && previous.code === (outcome.failure ? outcome.failure.code : null);
    if (outcome.status === 'migrated' && outcome.shape !== 'none' && outcome.shape !== null) {
      journaled.clear();
      event('storage.migration-completed', { schemaVersion: outcome.to ?? LATEST_STRUCTURAL });
    } else if (repeated) {
      return;
    } else if (outcome.status === 'space-blocked') {
      once('storage.migration-blocked', outcome.failure ? { errorCode: outcome.failure.code } : {});
    } else if (outcome.status === 'failed') {
      once('storage.migration-failed', {}, outcome.failure);
    } else if (outcome.status === 'refused' && outcome.failure && !OPEN_JOURNALS.includes(outcome.failure.code)) {
      once('storage.migration-failed', {}, outcome.failure);
    }
  };
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
