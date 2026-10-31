// What slice 2's health providers run on in tests: one browser profile (fake-indexeddb behind
// the fault wrapper, legacy-env's chrome.storage.local stub) with #17's IndexedDB adapter open
// on it, the legacy secret reader and the IndexedDB readers over the same factory, a
// coordinator that answers system.messagingHealth through #13's client, a registry root, and
// the trust records, put together as a root would pass them in the registry context.

import fs from 'node:fs';
import path from 'node:path';
import { webcrypto } from 'node:crypto';

import { createLegacySecretReader } from '../../js/kernel/adapters/indexeddb/legacy-secrets.js';
import { createRecoveryReader, createVectorsReader } from '../../js/kernel/adapters/indexeddb/health.js';
import { createClient } from '../../js/kernel/core/messaging/client.js';
import { createInProcessTransport } from '../../js/kernel/core/messaging/in-process.js';
import { createLookup } from '../../js/kernel/core/messaging/operations.js';
import { createRouter } from '../../js/kernel/core/messaging/router.js';
import { SYSTEM_OPERATIONS } from '../../js/kernel/core/messaging/system-operations.js';
import { createMemoryCommitLog } from '../../js/kernel/core/memory/commit-log.js';
import { createBaselinePolicy } from '../../js/kernel/core/ports/policy.js';
import { createRegistryRoot } from '../../js/kernel/registry/root.js';
import { health } from '../../js/trust/core/families.js';
import { PROVIDERS } from '../../js/trust/core/providers/catalog.js';
import { KeyRange } from './migration-support.mjs';
import { adapterOn, profile } from './storage-fixture.mjs';
import { realTimers } from './trust-support.mjs';

/** @typedef {import('./storage-fixture.mjs').Profile & {logs: Array<{event: string, detail: Record<string, unknown>}>}} Profile */
/** @typedef {import('../../js/trust/core/providers/context.js').ProviderContext} ProviderContext */

/** The manifest this build ships */
export const MANIFEST = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, '..', '..', 'manifest.json'), 'utf8'));

/** chrome.permissions as Chromium answers it for this manifest: everything declared, and the new tab override it implies */
export const grantedAsDeclared = () => ({
  getAll: async () => ({ permissions: [...MANIFEST.permissions, 'newTabPageOverride'], origins: [...MANIFEST.host_permissions] }),
});

/**
 * A fresh profile, which both #17's adapter fixture and its migration runs take
 * @returns {Profile}
 */
export const freshProfile = () => ({ ...profile(), logs: [] });

/**
 * A client of a router of its own, as a page's in-process transport gives it
 */
export function messagingClient() {
  const clock = { now: () => Date.now() };
  const router = createRouter({
    policy: createBaselinePolicy(),
    clock,
    timers: realTimers,
    coordinatorId: 'coordinator-test',
    extensionVersion: MANIFEST.version,
  });
  const client = createClient({
    transport: createInProcessTransport({ router, surface: 'newtab' }),
    surface: 'newtab',
    extensionVersion: MANIFEST.version,
    lookup: createLookup({ ...SYSTEM_OPERATIONS }),
    ids: { next: (() => { let n = 0; return () => `trust-client-${++n}`; })() },
    clock,
    timers: realTimers,
  });
  return client;
}

/**
 * chrome.storage.local's stub with getKeys, as Chrome 130 has it
 * @param {Profile} of
 */
export function settingsOf(of) {
  const local = of.chrome.api.storage.local;
  return {
    /** @param {string[]} keys */
    get: keys => local.get(keys),
    /** @param {Record<string, unknown>} items */
    set: items => local.set(items),
    getKeys: async () => Object.keys(of.chrome.local),
  };
}

/**
 * The registry context for slice 2's providers over `of`, every port working, and the adapter
 * it opened. `events` is what the trust records' journal answers.
 * @param {Profile} [of]
 * @param {{events?: () => Promise<any[]>}} [options]
 */
export async function providerContext(of = freshProfile(), { events = async () => [] } = {}) {
  const adapter = adapterOn(of);
  // A profile the adapter refuses (a newer schema, say) still gets a context, whose probes say so
  await adapter.open().catch(() => {});
  const root = createRegistryRoot({ host: 'workspace' });
  root.register(health, PROVIDERS);
  const resolution = root.resolve();
  /** @type {ProviderContext} */
  const context = {
    storage: adapter,
    settings: settingsOf(of),
    secrets: createLegacySecretReader({ indexedDB: of.faults.factory, settings: of.chrome.api.storage.local }),
    recovery: createRecoveryReader({ indexedDB: of.faults.factory, keyRange: KeyRange, crypto: /** @type {any} */ (webcrypto) }),
    vectors: createVectorsReader({ indexedDB: of.faults.factory }),
    permissions: grantedAsDeclared(),
    manifest: MANIFEST,
    commitLog: createMemoryCommitLog(),
    pipelines: [],
    messaging: messagingClient(),
    resolutions: () => [resolution],
    trust: { eventsRead: async () => ({ events: await events(), ok: true }) },
  };
  return { of, adapter, context, resolution };
}
