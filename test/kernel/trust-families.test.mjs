// #20 slice 1's families (AC1): `health` and `remediation` on #15's kit, run through #15's
// conformance suite with fixture providers and remediations, and the approved test plan's
// provider fixtures (healthy, unconfigured, stale, degraded, failed, recovering, unverifiable)
// aggregated by trust.summary and trust.report into truthful status. No fixture here is a
// real provider; slice 2 adds those.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as v from '../../js/lib/valibot/index.mjs';

import { createRegistryRoot } from '../../js/kernel/registry/root.js';
import { createRuntime } from '../../js/kernel/registry/runtime.js';
import { runCheck } from '../../js/trust/core/checks.js';
import { checkEvidence } from '../../js/trust/core/evidence.js';
import { health, remediation } from '../../js/trust/core/families.js';
import { createDiagnosticJournal } from '../../js/trust/core/journal.js';
import { createMemoryTrustStore } from '../../js/trust/core/memory-store.js';
import { summarySchema } from '../../js/trust/core/operations/trust-summary.js';
import { reportSchema } from '../../js/trust/core/operations/trust-report.js';
import { receiptSchema } from '../../js/trust/core/records.js';
import { createTrustRecords } from '../../js/trust/core/trust-records.js';
import { createTrustUseCases, runsOn } from '../../js/trust/core/use-cases.js';
import { REMEDIATION_CLASSES } from '../../js/trust/core/vocabulary.js';
import { describeRegistryConformance } from './registry-conformance.mjs';
import { hexIds, lockManager, manualClock, realTimers, settingsArea } from './trust-support.mjs';

/** @typedef {import('../../js/kernel/registry/validate.js').Descriptor} Descriptor */
/** @typedef {import('../../js/trust/core/checks.js').CheckResult} CheckResult */

const DAY = 24 * 60 * 60 * 1000;

/**
 * A fixture provider
 * @param {string} id
 * @param {import('../../js/trust/core/vocabulary.js').HealthGroup} group
 * @param {number} rank
 * @param {(context: Readonly<Record<string, unknown>>) => unknown} check
 * @param {Partial<Descriptor>} [extra]
 * @returns {Descriptor}
 */
const provider = (id, group, rank, check, extra = {}) => ({
  id,
  version: 1,
  apiVersion: 1,
  group,
  rank,
  hosts: ['workspace'],
  label: `Fixture ${id}`,
  owner: 20,
  operation: `fixture.${id}`,
  costClass: 'local-cheap',
  timeoutMs: 30,
  freshnessMs: DAY,
  triggers: ['open', 'verify-now'],
  fixtures: ['truthful-receipt'],
  implementation: { check },
  ...extra,
});

/** What the fixture storage provider answers next, so a test can break it */
const storageAnswer = /** @type {{next: CheckResult}} */ ({ next: { status: 'verified', capture: 'safe' } });

/** The approved test plan's provider fixtures, one per state */
const PROVIDERS = [
  // healthy: core, verified, capture safe
  provider(
    'capture',
    'storage',
    10,
    () => ({ status: 'verified', capture: 'safe', evidence: { durationMs: 2, seq: 41 } }),
    {
      core: true,
    },
  ),
  provider('storage', 'storage', 20, () => storageAnswer.next, { core: true }),
  // unconfigured
  provider('sync', 'sync', 10, () => ({ status: 'not-configured' })),
  // stale: verified, with a window the test moves the clock past
  provider('backup', 'backup', 10, () => ({ status: 'verified', evidence: { ageMs: 1000 } }), { freshnessMs: 60_000 }),
  // degraded, with a fault
  provider('index', 'indexing', 10, () => ({
    status: 'degraded',
    consequenceKey: 'indexing.lagging',
    preserved: ['capture', 'editing'],
    faults: [{ faultCode: 'lagging', severity: 'degraded', affected: ['search'] }],
  })),
  // failed, with a fault
  provider('permissions', 'permissions', 10, () => ({
    status: 'failed',
    faults: [{ faultCode: 'grant-missing', subjectId: 'contextMenus', severity: 'data-risk' }],
  })),
  // recovering: degraded with the remediation that's under way as its next action
  provider('local-inference', 'inference', 10, () => ({
    status: 'degraded',
    nextAction: 'rebuild-index',
    faults: [{ faultCode: 'model-rebuilding', severity: 'degraded' }],
  })),
  // unverifiable: never answers, so its check times out
  provider('remote-ai', 'inference', 20, () => new Promise(() => {}), { timeoutMs: 20 }),
  // a network check, which opening Trust never runs
  provider('webdav', 'sync', 20, () => ({ status: 'verified' }), { costClass: 'network', triggers: ['verify-now'] }),
];

/** @type {Descriptor[]} */
const REMEDIATIONS = [
  {
    id: 'retry-open',
    version: 1,
    apiVersion: 1,
    group: 'retry',
    rank: 10,
    hosts: ['workspace'],
    label: 'Retry',
    owner: 20,
    class: 'non-destructive',
    appliesTo: ['storage', 'capture'],
    fixtures: ['remediation-steps'],
    implementation: { preview: () => ({ changes: 0 }), apply: async () => {}, verify: async () => true },
  },
  {
    id: 'rebuild-index',
    version: 1,
    apiVersion: 1,
    group: 'repair',
    rank: 10,
    hosts: ['workspace'],
    label: 'Rebuild the search index',
    owner: 22,
    class: 'regenerable',
    appliesTo: ['index'],
    fixtures: ['remediation-steps'],
    load: async () => ({ preview: () => ({ changes: 1 }), apply: async () => {}, verify: async () => true }),
  },
];

describeRegistryConformance('health (#20)', {
  family: health,
  builtIns: PROVIDERS,
  sample: (id, rank) => provider(id, 'recovery', rank, () => ({ status: 'unverified' })),
  fixtures: {
    'truthful-receipt': async (contribution, implementation) => {
      const data = /** @type {Record<string, any>} */ (contribution.data);
      const clock = manualClock();
      const run = await runCheck(
        {
          id: /** @type {string} */ (contribution.id),
          operation: data.operation,
          costClass: data.costClass,
          timeoutMs: data.timeoutMs,
          freshnessMs: data.freshnessMs,
          core: data.core === true,
          check: context => /** @type {any} */ (implementation).check(context),
        },
        { clock, timers: realTimers },
      );
      const receipt = {
        ...run.receipt,
        id: '00000000-0000-4000-8000-000000000001',
        installId: '00000000-0000-4000-8000-000000000002',
        transition: true,
      };
      assert.ok(v.is(receiptSchema, receipt), `${contribution.ref} made a receipt outside the schema`);
      assert.equal(receipt.operation, data.operation, 'a receipt carries its declared operation');
      assert.equal(receipt.freshnessMs, data.freshnessMs, 'a receipt carries its declared freshness');
      assert.ok(checkEvidence(receipt.evidence).ok);
      assert.notEqual(run.outcome, 'invalid', `${contribution.ref} answered something a receipt can't hold`);
    },
  },
});

describeRegistryConformance('remediation (#20)', {
  family: remediation,
  builtIns: REMEDIATIONS,
  sample: (id, rank) => ({ ...REMEDIATIONS[0], id, rank, group: 'inspect' }),
  fixtures: {
    'remediation-steps': (contribution, implementation) => {
      const steps = /** @type {Record<string, unknown>} */ (implementation);
      for (const step of ['preview', 'apply', 'verify']) {
        assert.equal(typeof steps[step], 'function', `${contribution.ref} has no ${step}()`);
      }
      assert.ok(REMEDIATION_CLASSES.includes(/** @type {any} */ (contribution.data).class));
    },
  },
});

describe('the health and remediation families (#20 slice 1)', () => {
  it('refuses a provider without its operation, freshness, timeout, or cost class, and a remediation without a class', () => {
    const root = createRegistryRoot({ host: 'workspace' });
    const [base] = PROVIDERS;
    root.register(health, [
      { ...base, id: 'no-operation', rank: 1, operation: undefined },
      { ...base, id: 'no-freshness', rank: 2, freshnessMs: 0 },
      { ...base, id: 'no-timeout', rank: 3, timeoutMs: undefined },
      { ...base, id: 'bad-cost', rank: 4, costClass: 'free' },
      { ...base, id: 'no-triggers', rank: 5, triggers: [] },
      { ...base, id: 'a-destination', rank: 6, destinations: ['webdav'] },
    ]);
    root.register(remediation, [{ ...REMEDIATIONS[0], class: 'risky' }]);
    const resolution = root.resolve();
    for (const contribution of resolution.contributions) {
      assert.equal(contribution.state, 'unresolved', `${contribution.ref} resolved`);
    }
  });
});

/**
 * Use cases over the fixture providers, in a fresh profile
 */
async function trustCenter() {
  const clock = manualClock();
  const settings = settingsArea();
  const records = createTrustRecords({
    store: createMemoryTrustStore(),
    settings,
    clock,
    ids: hexIds(),
    locks: lockManager(),
  });
  await records.open();
  const journal = createDiagnosticJournal({ records, clock, strict: true });
  const root = createRegistryRoot({ host: 'workspace' });
  root.register(health, PROVIDERS);
  root.register(remediation, REMEDIATIONS);
  const resolution = root.resolve();
  const runtime = createRuntime(resolution);
  await runtime.probe();
  const trust = createTrustUseCases({
    records,
    journal,
    clock,
    timers: realTimers,
    locks: lockManager(),
    registry: { resolution, runtime },
    versions: { extension: '1.4.1', browser: null, canvasSchema: 8, trustSchema: 1 },
  });
  return { clock, records, journal, trust };
}

/**
 * @param {Awaited<ReturnType<typeof trustCenter>>['trust']} trust
 */
async function statusesOf(trust) {
  const report = await trust.report();
  assert.equal(report.kind, 'ready');
  const data = /** @type {import('../../js/trust/core/operations/trust-report.js').TrustReport} */ (
    /** @type {any} */ (report).data
  );
  assert.ok(v.is(reportSchema, data));
  return Object.fromEntries(data.providers.map(item => [item.providerId, item.status]));
}

/**
 * @param {Awaited<ReturnType<typeof trustCenter>>['trust']} trust
 * @returns {Promise<import('../../js/trust/core/operations/trust-summary.js').TrustSummary>}
 */
async function summaryOf(trust) {
  const summary = await trust.summary();
  assert.equal(summary.kind, 'ready');
  const data = /** @type {any} */ (summary).data;
  assert.ok(v.is(summarySchema, data), 'trust.summary holds only what its schema allows');
  return data;
}

describe('provider fixtures aggregate into truthful status (#20, approved test plan)', () => {
  it('nothing is healthy before a check ran: every provider reads unverified, and capture unknown', async () => {
    const { trust } = await trustCenter();
    const statuses = await statusesOf(trust);
    assert.ok(Object.values(statuses).every(status => status === 'unverified'));
    const summary = await summaryOf(trust);
    assert.equal(summary.worstCore, 'unverified');
    assert.equal(summary.capture, 'unknown');
    assert.equal(summary.route, 'trust');
    assert.equal(summary.actionRequired, 0);
  });

  it('opening Trust runs local-cheap checks only, and Verify now runs the network one too', async () => {
    assert.equal(runsOn('network', 'open'), false);
    assert.equal(runsOn('local-expensive', 'open'), false);
    assert.equal(runsOn('local-expensive', 'idle'), true);
    assert.equal(runsOn('network', 'idle'), false);
    const { trust } = await trustCenter();
    const outcome = await trust.verify({ type: 'trust.verify', commandId: 'c1', trigger: 'open' });
    assert.equal(outcome.kind, 'committed');
    assert.equal((await statusesOf(trust)).webdav, 'unverified');
    await trust.verify({ type: 'trust.verify', commandId: 'c2', trigger: 'verify-now', providerIds: ['webdav'] });
    assert.equal((await statusesOf(trust)).webdav, 'verified');
  });

  it('each fixture reads as its state, a past window reads stale, and a timeout reads unverified', async () => {
    const { trust, clock } = await trustCenter();
    await trust.verify({ type: 'trust.verify', commandId: 'c1', trigger: 'verify-now' });
    assert.deepEqual(await statusesOf(trust), {
      capture: 'verified',
      storage: 'verified',
      sync: 'not-configured',
      backup: 'verified',
      index: 'degraded',
      permissions: 'failed',
      'local-inference': 'degraded',
      'remote-ai': 'unverified',
      webdav: 'verified',
    });
    const summary = await summaryOf(trust);
    assert.equal(summary.worstCore, 'verified');
    assert.equal(summary.capture, 'safe');
    assert.equal(summary.route, 'trust');
    assert.equal(summary.actionRequired, 3);
    assert.deepEqual(
      summary.groups.map(group => [group.group, group.providers, group.needsAction, group.worst]),
      [
        ['storage', 2, 0, 'verified'],
        ['backup', 1, 0, 'verified'],
        ['sync', 2, 0, 'not-configured'],
        ['indexing', 1, 1, 'degraded'],
        ['inference', 2, 1, 'degraded'],
        ['permissions', 1, 1, 'failed'],
      ],
    );
    clock.advance(60_001);
    assert.equal((await statusesOf(trust)).backup, 'stale');
    // Dated in the future reads stale too
    clock.set(clock.now() - 2 * 60_001);
    assert.equal((await statusesOf(trust)).capture, 'stale');
  });

  it('capture at risk or storage failing routes to the Recovery Center', async () => {
    const { trust } = await trustCenter();
    storageAnswer.next = {
      status: 'failed',
      capture: 'at-risk',
      faults: [{ faultCode: 'open-failed', severity: 'capture-risk' }],
    };
    try {
      await trust.verify({
        type: 'trust.verify',
        commandId: 'c1',
        trigger: 'verify-now',
        providerIds: ['capture', 'storage'],
      });
      const summary = await summaryOf(trust);
      assert.equal(summary.worstCore, 'failed');
      assert.equal(summary.capture, 'at-risk');
      assert.equal(summary.route, 'recovery');
    } finally {
      storageAnswer.next = { status: 'verified', capture: 'safe' };
    }
  });

  it('a dismissed incident leaves Needs action until the next failing check, and a passing one resolves it', async () => {
    const { trust, records } = await trustCenter();
    storageAnswer.next = {
      status: 'degraded',
      capture: 'safe',
      faults: [{ faultCode: 'scan-findings', severity: 'degraded' }],
    };
    try {
      await trust.verify({ type: 'trust.verify', commandId: 'c1', trigger: 'verify-now', providerIds: ['storage'] });
      const [incident] = await records.incidents();
      await records.dismiss(incident.id, true);
      let summary = await summaryOf(trust);
      assert.equal(summary.actionRequired, 0);
      assert.equal(summary.groups.find(group => group.group === 'storage')?.needsAction, 0);
      const listed = await trust.incidents();
      assert.equal(/** @type {any} */ (listed).data.incidents.length, 1, 'a dismissed incident stays listed');
      await trust.verify({ type: 'trust.verify', commandId: 'c2', trigger: 'verify-now', providerIds: ['storage'] });
      summary = await summaryOf(trust);
      assert.equal(summary.actionRequired, 1);
      storageAnswer.next = { status: 'verified', capture: 'safe' };
      await trust.verify({ type: 'trust.verify', commandId: 'c3', trigger: 'verify-now', providerIds: ['storage'] });
      const [resolved] = await records.incidents();
      assert.equal(resolved.state, 'resolved');
      assert.equal((await summaryOf(trust)).actionRequired, 0);
      assert.equal(/** @type {any} */ (await trust.incidents()).data.incidents.length, 0);
      assert.equal(/** @type {any} */ (await trust.incidents({ includeResolved: true })).data.incidents.length, 1);
    } finally {
      storageAnswer.next = { status: 'verified', capture: 'safe' };
    }
  });

  it('a check that throws or answers outside the schema records unverified, never verified', async () => {
    const clock = manualClock();
    const base = {
      id: 'x',
      operation: 'fixture.x',
      costClass: /** @type {const} */ ('local-cheap'),
      timeoutMs: 50,
      freshnessMs: DAY,
    };
    const threw = await runCheck(
      {
        ...base,
        check: () => {
          throw new TypeError('secret text in a message');
        },
      },
      { clock, timers: realTimers },
    );
    assert.equal(threw.receipt.status, 'unverified');
    assert.deepEqual(threw.receipt.evidence, { errorCode: 'check-threw', exception: 'TypeError' });
    const loose = await runCheck(
      { ...base, check: () => ({ status: 'verified', evidence: { note: 'x' } }) },
      { clock, timers: realTimers },
    );
    assert.equal(loose.receipt.status, 'unverified');
    // Only a core provider may say capture is safe
    const notCore = await runCheck(
      { ...base, check: () => ({ status: 'verified', capture: 'safe' }) },
      { clock, timers: realTimers },
    );
    assert.equal(notCore.receipt.status, 'unverified');
    assert.equal(notCore.outcome, 'invalid');
  });
});
