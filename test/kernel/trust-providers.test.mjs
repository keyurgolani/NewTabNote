// #20 slice 2's health providers (AC4, AC5): every real and interim provider through #15's
// conformance suite and the `truthful-receipt` fixture, against the ports a root injects; each
// provider's states; interim providers never recording `verified`, with each legacy flag alone
// giving `unverified` or `not-configured`; and the providers aggregated by trust.summary.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { createRegistryRoot } from '../../js/kernel/registry/root.js';
import { createRuntime } from '../../js/kernel/registry/runtime.js';
import { defineFamily } from '../../js/kernel/registry/family.js';
import { failed, ready } from '../../js/kernel/core/contracts/outcomes.js';
import { runCheck } from '../../js/trust/core/checks.js';
import { PROVIDER_IDS } from '../../js/trust/core/codes.js';
import { health } from '../../js/trust/core/families.js';
import { createDiagnosticJournal } from '../../js/trust/core/journal.js';
import { createMemoryTrustStore } from '../../js/trust/core/memory-store.js';
import { INTERIM, PROVIDERS, REAL } from '../../js/trust/core/providers/catalog.js';
import { LEGACY_FACT_KEYS, interim } from '../../js/trust/core/providers/legacy.js';
import { BLOCK_FAMILY } from '../../js/trust/core/providers/platform.js';
import { createTrustRecords } from '../../js/trust/core/trust-records.js';
import { createTrustUseCases } from '../../js/trust/core/use-cases.js';
import { describeRegistryConformance } from './registry-conformance.mjs';
import { truthfulReceipt } from './trust-receipt-fixture.mjs';
import { MANIFEST, freshProfile, providerContext } from './trust-provider-support.mjs';
import { hexIds, lockManager, manualClock, realTimers, settingsArea } from './trust-support.mjs';

/** @typedef {import('../../js/kernel/registry/validate.js').Descriptor} Descriptor */
/** @typedef {import('../../js/trust/core/checks.js').CheckRun} CheckRun */

const { context: HEALTHY } = await providerContext();

/**
 * The provider's implementation, loaded as a root's runtime loads it
 * @param {string} id
 * @returns {Promise<{check(context: Readonly<Record<string, unknown>>): unknown}>}
 */
async function implementationOf(id) {
  const descriptor = /** @type {Descriptor} */ (PROVIDERS.find(candidate => candidate.id === id));
  return /** @type {any} */ (await /** @type {() => Promise<unknown>} */ (descriptor.load)());
}

/**
 * One provider's check, run into a receipt against `context`
 * @param {string} id
 * @param {Readonly<Record<string, unknown>>} context
 * @returns {Promise<CheckRun>}
 */
async function checkOf(id, context) {
  const descriptor = /** @type {any} */ (PROVIDERS.find(candidate => candidate.id === id));
  const implementation = await implementationOf(id);
  return runCheck(
    { ...descriptor, check: (/** @type {Readonly<Record<string, unknown>>} */ given) => implementation.check(given) },
    { context, clock: manualClock(), timers: realTimers },
  );
}

/** The statuses each provider answered against the healthy context, from the fixture's runs */
const healthyRuns = new Map();

describeRegistryConformance('health providers (#20 slice 2)', {
  family: health,
  builtIns: PROVIDERS,
  sample: (id, rank) => ({
    ...PROVIDERS[0],
    id,
    rank,
    group: 'recovery',
    core: undefined,
    load: undefined,
    implementation: { check: () => ({ status: 'unverified' }) },
  }),
  fixtures: {
    'truthful-receipt': truthfulReceipt({
      context: HEALTHY,
      answers: true,
      then: (contribution, run) => healthyRuns.set(contribution.id, run),
    }),
  },
});

describe('the providers (#20 slice 2, "Providers")', () => {
  it('lists every registered provider once, and the registered ids are exactly these', () => {
    assert.deepEqual(PROVIDERS.map(descriptor => descriptor.id).sort(), [...PROVIDER_IDS].sort());
    assert.deepEqual(
      [...REAL].sort(),
      ['block-types', 'capture', 'contributions', 'index', 'messaging', 'permissions', 'recovery-readiness', 'storage'],
    );
    assert.deepEqual(Object.keys(INTERIM).sort(), ['ai-scope-grants', 'backup', 'credentials', 'local-inference', 'remote-ai', 'sync']);
    for (const descriptor of PROVIDERS) {
      assert.equal(typeof descriptor.load, 'function', `${descriptor.id} loads its check lazily`);
      assert.equal(descriptor.implementation, undefined);
    }
    // Only capture and storage say whether capture is safe
    assert.deepEqual(PROVIDERS.filter(descriptor => descriptor.core).map(descriptor => descriptor.id), ['capture', 'storage']);
  });

  it('on a fresh profile with every port working, the real providers verify and the interim ones never do', async () => {
    const statuses = Object.fromEntries(
      await Promise.all(PROVIDER_IDS.map(async id => [id, (await checkOf(id, HEALTHY)).receipt.status])),
    );
    assert.deepEqual(statuses, {
      capture: 'verified',
      storage: 'verified',
      // No verified recovery point on a fresh profile: no shipped root runs #17's migrations yet
      'recovery-readiness': 'unverified',
      backup: 'not-configured',
      sync: 'not-configured',
      credentials: 'not-configured',
      permissions: 'verified',
      'ai-scope-grants': 'not-configured',
      'remote-ai': 'not-configured',
      'local-inference': 'not-configured',
      // No pipeline consumes the commit feed before #22
      index: 'not-configured',
      messaging: 'verified',
      contributions: 'verified',
      // No root registers #14's block family yet
      'block-types': 'not-configured',
    });
  });

  it('with no ports at all, no provider verifies: each records unverified, or a fact that needs none', async () => {
    for (const id of PROVIDER_IDS) {
      const { receipt } = await checkOf(id, {});
      // AI scope grants needs nothing to say none exist before #21
      const expected = id === 'ai-scope-grants' ? 'not-configured' : 'unverified';
      assert.equal(receipt.status, expected, `${id} recorded ${receipt.status} with no ports`);
    }
  });
});

describe('interim providers never record verified (#20 AC5)', () => {
  /** Each legacy flag, set on its own, the way 1.4.x stores it */
  const FLAGS = Object.freeze({
    setting_syncProvider: 'webdav',
    setting_syncLastSyncAt: 1_760_000_000_000,
    setting_lastBackupAt: 1_760_000_000_000,
    setting_autoBackupEnabled: true,
    setting_autoBackupFrequency: 1,
    setting_llmProvider: 'openai',
    setting_llmApiKey: 'not-a-real-key',
    setting_embeddingsEnabled: true,
    setting_storageInitialized: true,
    setting_syncWebdavConfig: { serverUrl: 'https://dav.example.test', username: 'u', password: 'not-real' },
  });

  it('each legacy flag alone gives every provider unverified or not-configured, but a secret makes Credentials action-required', async () => {
    for (const [key, value] of Object.entries(FLAGS)) {
      const of = freshProfile();
      of.chrome.local[key] = value;
      // Every real port is missing, so only legacy facts are left to go on
      const { context } = await providerContext(of);
      const legacyOnly = { settings: context.settings, secrets: context.secrets, trust: context.trust, vectors: context.vectors };
      for (const id of PROVIDER_IDS) {
        const { receipt } = await checkOf(id, legacyOnly);
        const secret = id === 'credentials' && (key === 'setting_llmApiKey' || key === 'setting_syncWebdavConfig');
        const allowed = secret ? ['action-required'] : ['unverified', 'not-configured'];
        assert.ok(allowed.includes(receipt.status), `${key} alone made ${id} ${receipt.status}`);
      }
    }
  });

  it('the configured flags make backup, sync, and remote AI unverified, with the time as evidence', async () => {
    const of = freshProfile();
    Object.assign(of.chrome.local, {
      setting_syncProvider: 'webdav',
      setting_syncLastSyncAt: 1_760_000_000_000,
      setting_lastBackupAt: 1_760_000_000_001,
      setting_autoBackupEnabled: true,
      setting_llmProvider: 'anthropic',
    });
    const { context } = await providerContext(of);
    const backup = (await checkOf('backup', context)).receipt;
    assert.deepEqual([backup.status, backup.evidence], ['unverified', { since: 1_760_000_000_001 }]);
    const sync = (await checkOf('sync', context)).receipt;
    assert.deepEqual([sync.status, sync.evidence], ['unverified', { since: 1_760_000_000_000 }]);
    assert.equal((await checkOf('remote-ai', context)).receipt.status, 'unverified');
    // `none` is no provider, as 1.4.x's first run writes it
    of.chrome.local.setting_llmProvider = 'none';
    of.chrome.local.setting_syncProvider = null;
    assert.equal((await checkOf('remote-ai', context)).receipt.status, 'not-configured');
    assert.equal((await checkOf('sync', context)).receipt.status, 'not-configured');
    // Auto-backup on with no backup yet is still configured, so unverified
    delete of.chrome.local.setting_lastBackupAt;
    assert.deepEqual((await checkOf('backup', context)).receipt.evidence, {});
    assert.equal((await checkOf('backup', context)).receipt.status, 'unverified');
  });

  it('interim() turns any verified answer into unverified, and leaves the rest', async () => {
    const lying = interim(() => ({ status: 'verified', evidence: { count: 1 } }));
    assert.deepEqual(await lying.check({}), { status: 'unverified', evidence: { count: 1 } });
    assert.deepEqual(await interim(() => ({ status: 'action-required' })).check({}), { status: 'action-required' });
  });

  it('the legacy facts read only their listed keys, none of which holds a credential', () => {
    for (const key of LEGACY_FACT_KEYS) {
      assert.ok(!/apikey|password|webdavconfig|token|secret/i.test(key), `${key} could hold a credential`);
    }
  });

  it('local inference: not-configured, unverified once vectors are stored, and action-required while a journaled failure is newer', async () => {
    const of = freshProfile();
    const { context } = await providerContext(of);
    assert.equal((await checkOf('local-inference', context)).receipt.status, 'not-configured');
    // The vectors store gets a record, as the embedding model writes one
    await context.storage?.commit(/** @type {any} */ ({
      commandId: 'seed',
      command: { type: 'seed', commandId: 'seed' },
      effect: { kind: 'units', units: [{ stores: ['vectors'], run: async (/** @type {any} */ tx) => tx.put('vectors', { id: 'n1', vector: [0.1], updatedAt: 1000 }) }] },
      done: () => ({ kind: 'committed', code: 'seeded', changedIds: [], messageKey: 'committed.seeded', severity: 'success' }),
    }));
    assert.equal((await checkOf('local-inference', context)).receipt.status, 'unverified');
    const failure = { seq: 1, code: 'embeddings.load-failed', at: 2000, fields: {} };
    const failing = { ...context, trust: { eventsRead: async () => ({ events: [failure], ok: true }) } };
    const { receipt } = await checkOf('local-inference', failing);
    assert.deepEqual([receipt.status, receipt.evidence], ['action-required', { since: 2000 }]);
    const older = { ...context, trust: { eventsRead: async () => ({ events: [{ ...failure, at: 500 }], ok: true }) } };
    assert.equal((await checkOf('local-inference', older)).receipt.status, 'unverified');
  });
});

describe('index lag, messaging, contributions, and block types (#20 slice 2)', () => {
  it('index: lag is the head minus each checkpoint, degraded past its window, verified within it', async () => {
    const commitLog = { head: async () => 120, readChangesSince: async () => /** @type {any} */ ({}) };
    const within = [{ id: 'search', windowSeq: 50, checkpoint: async () => 100 }];
    const ok = (await checkOf('index', { commitLog, pipelines: within })).receipt;
    assert.deepEqual([ok.status, ok.evidence], ['verified', { records: 1, lag: 20, seq: 120 }]);
    const behind = [...within, { id: 'links', windowSeq: 10, checkpoint: async () => 90 }];
    const run = await checkOf('index', { commitLog, pipelines: behind });
    assert.deepEqual([run.receipt.status, run.receipt.evidence], ['degraded', { records: 2, lag: 30, seq: 120, count: 1 }]);
    assert.deepEqual(run.faults.map(fault => [fault.faultCode, fault.severity]), [['lagging', 'degraded']]);
    // A checkpoint that isn't a commit position verifies nothing
    const broken = [{ id: 'bad', windowSeq: 1, checkpoint: async () => -1 }];
    assert.equal((await checkOf('index', { commitLog, pipelines: broken })).receipt.status, 'unverified');
  });

  it('messaging: verified by the coordinator answering, degraded when it fails, unverified on an answer its schema refuses', async () => {
    const run = await checkOf('messaging', HEALTHY);
    assert.equal(run.receipt.status, 'verified');
    assert.ok(/** @type {number} */ (run.receipt.evidence.count) >= 1, 'the round trip handshook');
    const down = { messaging: { query: async () => failed('coordinator', 'unavailable') } };
    const failedRun = await checkOf('messaging', down);
    assert.deepEqual([failedRun.receipt.status, failedRun.receipt.evidence], ['degraded', { cause: 'coordinator', errorCode: 'unavailable' }]);
    assert.deepEqual(failedRun.faults.map(fault => fault.faultCode), ['unreachable']);
    const odd = { messaging: { query: async () => ready(1, { protocol: 'nope' }) } };
    assert.equal((await checkOf('messaging', odd)).receipt.status, 'unverified');
  });

  it('contributions: degraded while one is unresolved or temporarily unavailable, and block types waits for #14', async () => {
    const thing = defineFamily({ id: BLOCK_FAMILY, apiVersion: 1, groups: ['text'], hosts: ['workspace'] });
    const root = createRegistryRoot({ host: 'workspace' });
    root.register(thing, [
      { id: 'paragraph', version: 1, apiVersion: 1, group: 'text', rank: 1, hosts: ['workspace'], label: 'Paragraph' },
      // A built-in with a field its family doesn't know resolves unresolved
      { id: 'broken', version: 1, apiVersion: 1, group: 'text', rank: 2, hosts: ['workspace'], label: 'Broken', bogus: true },
    ]);
    const resolution = root.resolve();
    const context = { resolutions: () => [resolution] };
    const contributions = await checkOf('contributions', context);
    assert.deepEqual([contributions.receipt.status, contributions.receipt.evidence], ['degraded', { records: 2, count: 1 }]);
    assert.deepEqual(contributions.faults.map(fault => fault.faultCode), ['contribution-unavailable']);
    assert.equal((await checkOf('block-types', context)).receipt.status, 'degraded');
    // A probe that can't answer makes a contribution temporarily unavailable
    const fine = createRegistryRoot({ host: 'workspace' });
    fine.register(thing, [
      { id: 'paragraph', version: 1, apiVersion: 1, group: 'text', rank: 1, hosts: ['workspace'], label: 'Paragraph' },
      {
        id: 'embed',
        version: 1,
        apiVersion: 1,
        group: 'text',
        rank: 2,
        hosts: ['workspace'],
        label: 'Embed',
        probe: () => ({ state: 'temporarily-unavailable', reason: 'offline' }),
      },
    ]);
    const runtime = createRuntime(fine.resolve());
    await runtime.probe();
    const probed = await checkOf('contributions', { resolutions: () => [runtime.snapshot()] });
    assert.equal(probed.receipt.status, 'degraded');
    const onlyFine = createRegistryRoot({ host: 'workspace' });
    onlyFine.register(thing, [
      { id: 'paragraph', version: 1, apiVersion: 1, group: 'text', rank: 1, hosts: ['workspace'], label: 'Paragraph' },
    ]);
    const healthy = { resolutions: () => [onlyFine.resolve()] };
    assert.equal((await checkOf('block-types', healthy)).receipt.status, 'verified');
    assert.equal((await checkOf('contributions', healthy)).receipt.status, 'verified');
  });
});

describe('trust.summary over the providers (#20 AC1, AC3)', () => {
  /**
   * The use cases over the providers, on `context`
   * @param {Readonly<Record<string, unknown>>} context
   */
  async function trustOn(context) {
    const clock = manualClock();
    const records = createTrustRecords({
      store: createMemoryTrustStore(),
      settings: settingsArea(),
      clock,
      ids: hexIds(),
      locks: lockManager(),
    });
    await records.open();
    const journal = createDiagnosticJournal({ records, clock, strict: true });
    const root = createRegistryRoot({ host: 'workspace' });
    root.register(health, PROVIDERS);
    const resolution = root.resolve();
    const runtime = createRuntime(resolution);
    await runtime.probe();
    const trust = createTrustUseCases({
      records,
      journal,
      clock,
      timers: realTimers,
      locks: lockManager(),
      registry: { resolution, runtime, context: { ...context, trust: records } },
      versions: { extension: MANIFEST.version, browser: null, canvasSchema: 8, trustSchema: 1 },
    });
    return { trust, records, clock };
  }

  it('is healthy only once capture and storage verified, and opening Trust never runs the expensive check', async () => {
    const { trust, records } = await trustOn(HEALTHY);
    const before = /** @type {any} */ (await trust.summary()).data;
    assert.equal(before.worstCore, 'unverified');
    assert.equal(before.capture, 'unknown');
    const opened = await trust.verify({ type: 'trust.verify', commandId: '00000000-0000-4000-8000-0000000000a1', trigger: 'open' });
    assert.equal(opened.kind, 'committed');
    const ran = new Set((await records.latestReceipts()).map(receipt => receipt.providerId));
    assert.ok(!ran.has('recovery-readiness'), 'opening Trust ran a local-expensive check');
    const after = /** @type {any} */ (await trust.summary()).data;
    assert.equal(after.worstCore, 'verified');
    assert.equal(after.capture, 'safe');
    assert.equal(after.route, 'trust');
  });

  it('a storage probe the disk refuses puts capture at risk and routes to recovery', async () => {
    const of = freshProfile();
    const { context } = await providerContext(of);
    const { trust, records } = await trustOn(context);
    of.faults.abortAfterNextWrite('canvases', 'QuotaExceededError');
    await trust.verify({
      type: 'trust.verify',
      commandId: '00000000-0000-4000-8000-0000000000a2',
      trigger: 'verify-now',
      providerIds: ['storage'],
    });
    const summary = /** @type {any} */ (await trust.summary()).data;
    assert.equal(summary.capture, 'at-risk');
    assert.equal(summary.worstCore, 'action-required');
    assert.equal(summary.route, 'recovery');
    const [incident] = await records.incidents();
    assert.deepEqual([incident.providerId, incident.faultCode, incident.subjectId, incident.severity], [
      'storage',
      'quota',
      'CanvasTabDB',
      'capture-risk',
    ]);
  });
});
