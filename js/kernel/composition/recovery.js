/**
 * recovery.html's composition root (#20 slice 4b): what its Trust Center and Recovery Center
 * run on, all in the page. Checks run in the page that asks (#20's scope), and the worker
 * serves none of the trust operations.
 *
 * - A kernel client on CanvasTabDB as it is (mode `existing`, as Side Panel's root opens it:
 *   no repair, upgrade, or maintenance, and none made on a profile without one). The page
 *   reads only its theme through it, with the settings client. Its adapter is also what
 *   capture and storage probe, and what rebuild-index rewrites the search index through.
 * - NewTabNoteTrust's records and journal, a #15 registry root on the `recovery` host with
 *   slice 2's providers and slice 3's remediations, the use cases over the providers' ports,
 *   and the remediation pipeline.
 * - #14's block registry on the same host, the `block` family with the built-ins, whose
 *   resolution and block-health query the Block types check reads. The page reads no block.
 * - #13's router over them, in the page, reached through the in-process transport as surface
 *   `recovery`, under recovery.html's rows (js/trust/core/router-rows.js), and the client the
 *   views send through, so every call passes the router's schema, deadline, and policy checks.
 *
 * The provider context has a slot for the `migration` port, which storage's check reads once
 * #79 and #90 land. On `next` the notes database is still at version 8 and nothing reads it,
 * so the root passes none until the rebase that brings them.
 *
 * Building the root starts the kernel's open of CanvasTabDB as it is (`existing`), as every
 * root's open starts when it's made: the open writes nothing, and never creates, upgrades, or
 * blocks the database, since another context's upgrade closes this connection
 * (js/kernel/adapters/legacy/adapter.js). The trust records open, and the registry's probes
 * run, on the first request the router serves.
 */

import { createLegacyAdapter } from '../adapters/legacy/adapter.js';
import { createRecoveryReader, createVectorsReader } from '../adapters/indexeddb/health.js';
import { createLegacySecretReader } from '../adapters/indexeddb/legacy-secrets.js';
import { DB_VERSION } from '../adapters/indexeddb/schema.js';
import { TRUST_DB_VERSION, createTrustDatabase } from '../adapters/indexeddb/trust.js';
import { rejected } from '../core/contracts/outcomes.js';
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
import { kernelClient, legacyHost } from './host.js';
import { hostTimers, pageTransport, randomIds } from './messaging.js';
import { createSettingsClient } from './settings.js';

/** @typedef {import('./host.js').Client} KernelPageClient */
/** @typedef {import('./host.js').LegacyHost} LegacyHost */
/** @typedef {import('./settings.js').SettingsClient} SettingsClient */
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

/**
 * What recovery.html's root runs on: the browser's (browserRecoveryHost), or a test's
 * @typedef {object} RecoveryHost
 * @property {LegacyHost} [legacy] - js/storage.js's Storage and chrome.storage.local, under the kernel's adapter
 * @property {KernelAdapter & {open(): Promise<void>}} [adapter]
 *   The notes database's adapter: the legacy one over `legacy`, opened as it is, unless a test passes #17's
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
 * @property {KernelPageClient} kernel - the notes database's client, for `whenReady` and the theme
 * @property {SettingsClient} settings
 * @property {MessagingClient} trust - #13's client to the page's router, for the rows only
 * @property {Ids} ids - for a command's id, made when the user asks
 * @property {() => void} close - closes both clients
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
 * The host's legacy storage, which a host with no adapter of its own must have
 * @param {RecoveryHost} host
 * @returns {LegacyHost}
 */
function legacyOf(host) {
  if (!host.legacy) throw new TypeError('recovery.html needs js/storage.js or an adapter');
  return host.legacy;
}

/**
 * This page's host: the browser's APIs, each read when the root is made
 * @returns {RecoveryHost}
 */
export function browserRecoveryHost() {
  const scope = /** @type {{navigator?: {locks?: RecoveryHost['locks']}}} */ (globalThis);
  return {
    legacy: legacyHost(),
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
 * recovery.html's kernel, settings, and trust, on `host`
 * @param {{host?: RecoveryHost}} [options]
 * @returns {RecoveryRoot}
 */
export function createRecoveryRoot({ host = browserRecoveryHost() } = {}) {
  const clock = host.clock || systemClock;
  const ids = host.ids || randomIds;
  const timers = host.timers || hostTimers;
  const extensionVersion = host.manifest.version;

  const adapter = host.adapter || createLegacyAdapter({ ...legacyOf(host), mode: 'existing' });
  const kernel = kernelClient({ adapter, surface: 'recovery' });
  const settings = createSettingsClient(kernel);

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
    lookup: createLookup({ ...SYSTEM_OPERATIONS }),
    ids,
    clock,
    timers,
  });

  /** @type {ProviderContext & Record<string, unknown>} */
  const context = {
    storage: adapter,
    settings: host.settings,
    secrets: createLegacySecretReader({ indexedDB: host.indexedDB, settings: /** @type {any} */ (host.secretSettings) }),
    recovery: createRecoveryReader({ indexedDB: host.indexedDB, keyRange: host.keyRange, crypto: /** @type {any} */ (host.crypto) }),
    vectors: createVectorsReader({ indexedDB: host.indexedDB }),
    permissions: host.permissions,
    manifest: host.manifest,
    // No pipeline consumes #17's commit feed yet (#22 registers them), so the browser's list is empty
    pipelines: host.pipelines || [],
    ...(host.commitLog ? { commitLog: host.commitLog } : {}),
    messaging,
    resolutions: () => [resolution, blocks.resolution],
    blocks: Object.freeze({ health: blocks.health }),
    trust: records,
    // migration: #79 and #90's port, which storage's check reads once they land
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
    ports: { adapter },
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
    policy: createBaselinePolicy({ rows: RECOVERY_PAGE_ROWS }),
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
    settings,
    trust,
    ids,
    close: () => {
      trust.close();
      messaging.close();
      router.close();
    },
  });
}
