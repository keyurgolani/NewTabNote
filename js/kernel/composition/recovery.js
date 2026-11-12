/**
 * recovery.html's composition root (#20 slice 4b): what its Trust Center and Recovery Center
 * run on, all in the page. Checks run in the page that asks (#20's scope), and the worker
 * serves none of the trust operations.
 *
 * - A kernel client on CanvasTabDB through #17's IndexedDB adapter, opened as the database is
 *   on disk (`existing`, as Popup's and Side Panel's roots open it: no repair, upgrade, or
 *   maintenance). Unlike theirs, it doesn't wait on the worker's migration run, so the page
 *   never asks the worker to migrate, and makes no database on a profile without one. It
 *   reads only the theme, with one query (core/application/handlers-recovery.js), and sends
 *   no note command, so it applies no closing tab's edit and journals nothing. Its adapter is
 *   also what capture and storage probe, and what rebuild-index reads the search index through.
 * - rebuild-index's writes go to the worker's queue over #13's port, a batch at a time, and only
 *   while the coordinator can't run them to the page's fallback, under Web Lock storage.restore
 *   (./recovery-fallback.js, which it loads at its first use, #35 slice 8).
 * - NewTabNoteTrust's records and journal, a #15 registry root on the `recovery` host with
 *   slice 2's providers and slice 3's remediations, the use cases over the providers' ports,
 *   and the remediation pipeline. Storage's check reads CanvasTabDB's version against the
 *   latest, and what the worker recorded of its last run, through the migration port, and a
 *   recovery point is verified under the points lock, held shared, so the worker's purge never
 *   changes a point under it.
 * - #14's block registry on the same host, the `block` family with the built-ins, whose
 *   resolution and block-health query the Block types check reads. The page reads no block.
 * - #13's router over them, in the page, reached through the in-process transport as surface
 *   `recovery`, under recovery.html's rows (js/trust/core/router-rows.js), and the client the
 *   views send through, so every call passes the router's schema, deadline, and policy checks.
 *
 * Building the root starts the adapter's open of CanvasTabDB as it is, as every root's open
 * starts when it's made: the open writes nothing, and never creates, upgrades, or blocks the
 * database, since another context's upgrade closes this connection
 * (js/kernel/adapters/indexeddb/connection.js). The trust records open, and the registry's
 * probes run, on the first request the router serves.
 */

import { createIndexedDbAdapter } from '../adapters/indexeddb/adapter.js';
import { createMigrationReader, createRecoveryReader, createVectorsReader } from '../adapters/indexeddb/health.js';
import { createLegacySecretReader } from '../adapters/indexeddb/legacy-secrets.js';
import { DB_VERSION } from '../adapters/indexeddb/schema.js';
import { TRUST_DB_VERSION, createTrustDatabase } from '../adapters/indexeddb/trust.js';
import { RECOVERY_HANDLERS } from '../core/application/handlers-recovery.js';
import { rejected } from '../core/contracts/outcomes.js';
import { RECOVERY_PORT_OPERATIONS } from '../core/contracts/recovery-port.js';
import { createClient } from '../core/messaging/client.js';
import { createInProcessTransport } from '../core/messaging/in-process.js';
import { createLookup } from '../core/messaging/operations.js';
import { createRouter } from '../core/messaging/router.js';
import { SYSTEM_OPERATIONS } from '../core/messaging/system-operations.js';
import { createBaselinePolicy } from '../core/ports/policy.js';
import { systemClock } from '../core/ports/runtime.js';
import { createRegistryRoot } from '../registry/root.js';
import { createRuntime } from '../registry/runtime.js';
import { health, remediation } from '../../trust/core/families.js';
import { createDiagnosticJournal } from '../../trust/core/journal.js';
import { PROVIDERS } from '../../trust/core/providers/catalog.js';
import { REMEDIATIONS } from '../../trust/core/remediation/catalog.js';
import { createRemediationPipeline } from '../../trust/core/remediation/pipeline.js';
import { RECOVERY_PAGE_ROWS } from '../../trust/core/router-rows.js';
import { TRUST_OPERATIONS } from '../../trust/core/trust-operations.js';
import { createTrustRecords } from '../../trust/core/trust-records.js';
import { createTrustUseCases } from '../../trust/core/use-cases.js';
import { createBlockRegistry } from './blocks.js';
import { kernelClient } from './host.js';
import { hostTimers, pageTransport, randomIds } from './messaging.js';

/** @typedef {import('./host.js').Client} KernelPageClient */
/** @typedef {import('../core/messaging/client.js').Client} MessagingClient */
/** @typedef {import('../core/messaging/router.js').Handler} Handler */
/** @typedef {import('../core/messaging/router.js').Dispatch} Dispatch */
/** @typedef {import('../core/ports/runtime.js').Clock} Clock */
/** @typedef {import('../core/ports/runtime.js').Ids} Ids */
/** @typedef {import('../core/ports/runtime.js').Timers} Timers */
/** @typedef {import('../core/ports/repository.js').KernelAdapter} KernelAdapter */
/** @typedef {import('../../trust/core/ports.js').SettingsPort} SettingsPort */
/** @typedef {import('../../trust/core/providers/context.js').PermissionsReader} PermissionsReader */
/** @typedef {import('../../trust/core/providers/context.js').ManifestPermissions} ManifestPermissions */
/** @typedef {import('../../trust/core/providers/context.js').ProviderContext} ProviderContext */
/** @typedef {import('../../trust/core/providers/context.js').Pipeline} Pipeline */
/** @typedef {import('../core/ports/commit-log.js').CommitLog} CommitLog */
/** @typedef {import('../core/contracts/outcomes.js').Outcome} Outcome */
/** @typedef {import('../core/contracts/outcomes.js').BulkOutcome} BulkOutcome */
/** @typedef {import('../../trust/core/remediation/ports.js').RebuildBatch} RebuildBatch */

/**
 * What recovery.html's root runs on: the browser's (browserRecoveryHost), or a test's
 * @typedef {object} RecoveryHost
 * @property {KernelAdapter & {open(): Promise<void>}} [adapter]
 *   The notes database's adapter: #17's over `indexedDB`, opened as the database is on disk,
 *   unless a test passes its own, which stays the test's to close
 * @property {IDBFactory} indexedDB
 * @property {typeof IDBKeyRange} keyRange
 * @property {SettingsPort & {getKeys?: () => Promise<string[]>}} settings - chrome.storage.local, with
 *   its keys where Chrome lists them without reading every value (recoverySettings)
 * @property {{get(keys: string[] | string): Promise<Record<string, unknown>>}} secretSettings
 *   chrome.storage.local itself, which the legacy secret reader reads present or absent
 * @property {{request: (...args: any[]) => Promise<any>} | null} locks - navigator.locks
 * @property {{subtle: SubtleCrypto}} crypto
 * @property {PermissionsReader} permissions
 * @property {ManifestPermissions & {version: string}} manifest
 * @property {unknown} [runtime] - chrome.runtime, which the messaging check reaches the worker through
 * @property {readonly Pipeline[]} [pipelines]
 *   The pipelines over #17's commit feed, which index lag reads with `commitLog`. The browser's
 *   host has none until #22 registers its projections, so index lag reads `not-configured`
 *   there; a test passes its own, with the commit log they follow.
 * @property {CommitLog} [commitLog]
 * @property {Clock} [clock]
 * @property {Ids} [ids]
 * @property {Timers} [timers]
 */

/**
 * What the root hands recovery.html
 * @typedef {object} RecoveryRoot
 * @property {KernelPageClient} kernel - the notes database's client, for `whenReady`
 * @property {() => Promise<string>} theme
 *   The theme setting as stored, read once through the kernel, which the views map to a scheme:
 *   `system` when nothing is stored, when the notes database didn't open, and when the read fails
 * @property {MessagingClient} trust - #13's client to the page's router, for the rows only
 * @property {Ids} ids - for a command's id, made when the user asks
 * @property {() => void} close - closes both clients, and the adapter the root made
 */

/**
 * chrome.storage.local as the providers read it: values by key, and its keys only where Chrome
 * lists them without reading every value (getKeys, Chrome 130). From 116 to 129 it has no
 * getKeys, so the count of legacy copies reads as unavailable, never through get(null), which
 * reads every value (countLegacyCopies in js/trust/core/providers/recovery-readiness.js).
 * @param {chrome.storage.LocalStorageArea & {getKeys?: () => Promise<string[]>}} local
 * @returns {RecoveryHost['settings']}
 */
function recoverySettings(local) {
  /** @type {RecoveryHost['settings']} */
  const settings = {
    get: keys => local.get(keys),
    set: items => local.set(items),
  };
  if (typeof local.getKeys === 'function') settings.getKeys = () => /** @type {() => Promise<string[]>} */ (local.getKeys)();
  return settings;
}

/**
 * This page's host: the browser's APIs, each read when the root is made
 * @returns {RecoveryHost}
 */
export function browserRecoveryHost() {
  const scope = /** @type {{navigator?: {locks?: RecoveryHost['locks']}}} */ (globalThis);
  return {
    indexedDB: globalThis.indexedDB,
    keyRange: globalThis.IDBKeyRange,
    settings: recoverySettings(chrome.storage.local),
    secretSettings: chrome.storage.local,
    locks: (scope.navigator && scope.navigator.locks) || null,
    crypto: globalThis.crypto,
    permissions: chrome.permissions,
    manifest: /** @type {ManifestPermissions & {version: string}} */ (chrome.runtime.getManifest()),
    runtime: chrome.runtime,
  };
}

/**
 * Where recovery.html's links lead outside it: the new tab, which its way back opens, and
 * Chrome's extensions page, where NewTabNote's Details hold its site access. Its own details
 * page needs the extension's id in the URL, a path built at run time, which the closure check
 * refuses (scripts/build/closure.js), so Review site access opens the page before it.
 * @returns {{newTabUrl: string, openSiteAccess: () => void}}
 */
export function browserRecoveryLinks() {
  return {
    newTabUrl: chrome.runtime.getURL('newtab.html'),
    openSiteAccess: () => {
      chrome.tabs.create({ url: 'chrome://extensions/' });
    },
  };
}

/**
 * A command's handler: it runs `serve` once the trust code has started and the router says it
 * may begin, and otherwise answers cancelled, so a command the router stopped waiting for
 * changes nothing
 * @param {() => Promise<unknown>} start
 * @param {(payload: unknown) => unknown} serve
 * @returns {Handler}
 */
const commandHandler = (start, serve) => async (payload, context) => {
  await start();
  return context.begin() ? serve(payload) : rejected('validation', 'cancelled');
};

/**
 * A query's handler: it answers `serve` once the trust code has started
 * @param {() => Promise<unknown>} start
 * @param {(payload: Record<string, unknown>) => unknown} serve
 * @returns {Handler}
 */
const queryHandler = (start, serve) => async payload => {
  await start();
  return serve(/** @type {Record<string, unknown>} */ (payload));
};

/**
 * What a coordinator that can't run a batch says, in its welcome or its answer, which sends the
 * batch to the fallback (#35 slice 8). Anything else it says, `restoring`, `migrating` and
 * `starting` among them, is its answer, and the run fails with its code.
 */
const FALLBACK_REASONS = Object.freeze(['coordinator-unavailable', 'storage-unavailable']);

/**
 * Whether the coordinator couldn't run a batch that answered `outcome`: the client stopped trying
 * to wake the worker, or the coordinator's last welcome or the answer named a FALLBACK_REASONS one
 * @param {MessagingClient} messaging
 * @param {Outcome | BulkOutcome} outcome
 */
function unrunnable(messaging, outcome) {
  if (outcome.kind === 'committed') return false;
  if (messaging.state() === 'unavailable') return true;
  const said = messaging.coordinator();
  if (said && said.status === 'degraded' && FALLBACK_REASONS.includes(said.reason ?? '')) return true;
  return outcome.kind === 'unavailable' && outcome.cause === 'coordinator' && FALLBACK_REASONS.includes(outcome.code);
}

/**
 * The readers #20's providers read IndexedDB through on recovery.html (health.js), on `host`
 * @param {RecoveryHost} host
 */
export function recoveryReadersOf(host) {
  return {
    secrets: createLegacySecretReader({ indexedDB: host.indexedDB, settings: /** @type {any} */ (host.secretSettings) }),
    // A verification holds the points lock shared, so the worker's purge never changes a point under it
    recovery: createRecoveryReader({
      indexedDB: host.indexedDB,
      keyRange: host.keyRange,
      crypto: /** @type {any} */ (host.crypto),
      locks: /** @type {any} */ (host.locks),
    }),
    vectors: createVectorsReader({ indexedDB: host.indexedDB }),
    // CanvasTabDB's version and the worker's last run, which storage's check reads at every version
    migration: createMigrationReader({ indexedDB: host.indexedDB, settings: host.settings }),
  };
}

/**
 * recovery.html's kernel, theme, and trust, on `host`
 * @param {{host?: RecoveryHost}} [options]
 * @returns {RecoveryRoot}
 */
export function createRecoveryRoot({ host = browserRecoveryHost() } = {}) {
  const clock = host.clock || systemClock;
  const ids = host.ids || randomIds;
  const timers = host.timers || hostTimers;
  const extensionVersion = host.manifest.version;

  // As the database is on disk, with no wait on the worker's run (no awaitUpgrade), so opening
  // the page never sets off a migration, and a profile with none is left with none
  const made = host.adapter
    ? null
    : createIndexedDbAdapter({ indexedDB: host.indexedDB, settings: host.settings, keyRange: host.keyRange, mode: 'existing' });
  const adapter = host.adapter || /** @type {NonNullable<typeof made>} */ (made);
  const kernel = kernelClient({ adapter, surface: 'recovery', handlers: RECOVERY_HANDLERS });

  /** @type {RecoveryRoot['theme']} */
  const theme = async () => {
    try {
      if (await kernel.whenReady()) return 'system';
      const state = await kernel.query({ type: 'getPreferences', keys: ['theme'] });
      const value = state.kind === 'ready' || state.kind === 'stale' ? state.data.theme : undefined;
      return typeof value === 'string' ? value : 'system';
    } catch {
      return 'system';
    }
  };

  const store = createTrustDatabase({ indexedDB: host.indexedDB, keyRange: host.keyRange });
  const records = createTrustRecords({ store, settings: host.settings, clock, ids, locks: host.locks, timers });
  const journal = createDiagnosticJournal({ records, clock });

  const registry = createRegistryRoot({ host: 'recovery' });
  registry.register(health, PROVIDERS);
  registry.register(remediation, REMEDIATIONS);
  const resolution = registry.resolve();
  const runtime = createRuntime(resolution);
  // #14's block types on this host, for the Block types check: the root that reads the
  // block-health query registers the `block` family, which the new tab's start no longer does
  const blocks = createBlockRegistry({ host: 'recovery' });

  // The messaging check asks the worker's router, the coordinator, for its health, as surface
  // `recovery` over the runtime port; a page with no runtime asks a router of its own
  const messaging = createClient({
    transport: pageTransport({
      surface: 'recovery',
      runtime: host.runtime,
      localRouter: () =>
        createRouter({ policy: createBaselinePolicy(), clock, timers, coordinatorId: ids.next(), extensionVersion }),
    }),
    surface: 'recovery',
    extensionVersion,
    lookup: createLookup({ ...SYSTEM_OPERATIONS, ...RECOVERY_PORT_OPERATIONS }),
    ids,
    clock,
    timers,
  });

  /** @type {Promise<import('./recovery-fallback.js').RecoveryFallback> | null} */
  let fallback = null;
  /**
   * rebuild-index's batch on the worker's queue, or on the fallback while the coordinator can't
   * run it (unrunnable)
   * @param {RebuildBatch} batch
   * @returns {Promise<Outcome>}
   */
  const rebuild = async batch => {
    const outcome = await messaging.execute(batch);
    if (!unrunnable(messaging, outcome)) return /** @type {Outcome} */ (outcome);
    fallback ||= import('./recovery-fallback.js').then(module =>
      module.createRecoveryFallback({ indexedDB: host.indexedDB, keyRange: host.keyRange, settings: host.settings, locks: host.locks }),
    );
    return (await fallback).execute(batch);
  };

  /** @type {ProviderContext & Record<string, unknown>} */
  const context = {
    storage: adapter,
    settings: host.settings,
    ...recoveryReadersOf(host),
    permissions: host.permissions,
    manifest: host.manifest,
    // No pipeline consumes #17's commit feed yet (#22 registers them), so the browser's list is empty
    pipelines: host.pipelines || [],
    ...(host.commitLog ? { commitLog: host.commitLog } : {}),
    messaging,
    resolutions: () => [resolution, blocks.resolution],
    blocks: Object.freeze({ health: blocks.health }),
    trust: records,
  };

  const useCases = createTrustUseCases({
    records,
    journal,
    clock,
    timers,
    locks: /** @type {any} */ (host.locks),
    registry: { resolution, runtime, context },
    versions: { extension: extensionVersion, browser: null, canvasSchema: DB_VERSION, trustSchema: TRUST_DB_VERSION },
  });
  const pipeline = createRemediationPipeline({
    records,
    journal,
    clock,
    ids,
    locks: /** @type {any} */ (host.locks),
    registry: { resolution, runtime },
    ports: { adapter, rebuild },
  });

  /** @type {Promise<unknown> | null} */
  let starting = null;
  /**
   * The trust code's start, once, on the first request: the records open (never rejecting:
   * a store that won't open leaves them on the settings copy), then the registry's probes run
   * and a run a closed page cut off is marked interrupted
   */
  const start = () => {
    starting =
      starting ||
      records.open().then(() => Promise.allSettled([runtime.probe(), pipeline.reconcile()]));
    return starting;
  };

  /** @type {Readonly<Record<string, Handler>>} */
  const handlers = Object.freeze({
    'trust.summary': queryHandler(start, () => useCases.summary()),
    'trust.report': queryHandler(start, () => useCases.report()),
    'recovery.incidents': queryHandler(start, payload =>
      useCases.incidents({ includeResolved: payload.includeResolved === true }),
    ),
    'trust.verify': commandHandler(start, payload => useCases.verify(payload)),
    'recovery.check': commandHandler(start, payload => useCases.check(payload)),
    'recovery.dismiss': commandHandler(start, payload => useCases.dismiss(payload)),
    'recovery.undismiss': commandHandler(start, payload => useCases.undismiss(payload)),
    'recovery.run': commandHandler(start, payload => pipeline.run(payload)),
  });

  const lookup = createLookup({ ...TRUST_OPERATIONS });
  const router = createRouter({
    lookup,
    handlers,
    // On the catalog the page's kernel table runs on, with the page's own rows for what it doesn't list
    policy: createBaselinePolicy(RECOVERY_HANDLERS.catalog, { rows: RECOVERY_PAGE_ROWS }),
    clock,
    timers,
    coordinatorId: ids.next(),
    extensionVersion,
  });
  const trust = createClient({
    transport: createInProcessTransport({ router, surface: 'recovery' }),
    surface: 'recovery',
    extensionVersion,
    lookup,
    ids,
    clock,
    timers,
  });

  return Object.freeze({
    kernel,
    theme,
    trust,
    ids,
    close: () => {
      trust.close();
      messaging.close();
      router.close();
      if (made) made.close();
    },
  });
}
