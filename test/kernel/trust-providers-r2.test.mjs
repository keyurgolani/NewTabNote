// #78's delta check (#20 slice 2): two false all-clears through `looked`, each end to end on
// NewTabNoteTrust (a journal read that failed, and a stalled pipeline hiding a lagging one), and
// the garbage answers that still filled `looked`: a settings read answering nothing, pipelines
// that aren't a list, a verdict that isn't `ok: true`, points without a status. Local
// inference reads the vectors only when a failure is journaled, and stops at the first newer one.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { createLegacySecretReader } from '../../js/kernel/adapters/indexeddb/legacy-secrets.js';
import { createVectorsReader } from '../../js/kernel/adapters/indexeddb/health.js';
import { createTrustDatabase } from '../../js/kernel/adapters/indexeddb/trust.js';
import { UnavailableError } from '../../js/kernel/core/contracts/outcomes.js';
import { createRegistryRoot } from '../../js/kernel/registry/root.js';
import { createRuntime } from '../../js/kernel/registry/runtime.js';
import { runCheck } from '../../js/trust/core/checks.js';
import { health } from '../../js/trust/core/families.js';
import { createDiagnosticJournal } from '../../js/trust/core/journal.js';
import { PROVIDERS } from '../../js/trust/core/providers/catalog.js';
import { createTrustRecords } from '../../js/trust/core/trust-records.js';
import { createTrustUseCases } from '../../js/trust/core/use-cases.js';
import { KeyRange, legacyEnv } from './migration-support.mjs';
import { MANIFEST, freshProfile, providerContext } from './trust-provider-support.mjs';
import { hexIds, lockManager, manualClock, realTimers } from './trust-support.mjs';

/** @typedef {import('./trust-provider-support.mjs').Profile} Profile */

/** A migration reader at the latest version, for the probes these tests drive (#20 slice 4 prerequisites, part 2) */
const AT_LATEST = Object.freeze({ current: async () => ({ version: 9, latest: 9, status: 'migrated', code: null }) });

/**
 * One provider's check, as its descriptor declares it, against `context`
 * @param {string} id
 * @param {Readonly<Record<string, unknown>>} context
 */
async function checkOf(id, context) {
  const descriptor = /** @type {any} */ (PROVIDERS.find(candidate => candidate.id === id));
  const implementation = /** @type {any} */ (await descriptor.load());
  return runCheck(
    { ...descriptor, timeoutMs: 5000, check: (/** @type {Readonly<Record<string, unknown>>} */ given) => implementation.check(given) },
    { context: { migration: AT_LATEST, ...context }, clock: manualClock(), timers: realTimers },
  );
}

/**
 * The use cases over every provider on NewTabNoteTrust in `of`, or on `store`
 * @param {Profile} of
 * @param {Record<string, unknown>} [overrides]
 * @param {any} [store]
 */
async function trustOn(of, overrides = {}, store = createTrustDatabase({ indexedDB: of.faults.factory, keyRange: KeyRange })) {
  const clock = manualClock();
  const records = createTrustRecords({ store, settings: of.chrome.api.storage.local, clock, ids: hexIds(), locks: lockManager() });
  await records.open();
  const journal = createDiagnosticJournal({ records, clock, strict: true });
  const { context } = await providerContext(of);
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
    registry: { resolution, runtime, context: { ...context, trust: records, ...overrides } },
    versions: { extension: MANIFEST.version, browser: null, canvasSchema: 8, trustSchema: 1 },
  });
  let n = 0;
  const verify = (/** @type {string[]} */ providerIds) =>
    trust.verify({
      type: 'trust.verify',
      commandId: `00000000-0000-4000-8000-0000000003${(++n).toString(16).padStart(2, '0')}`,
      trigger: 'verify-now',
      providerIds,
    });
  /** @param {string} key */
  const stateOf = async key => (await records.incidents()).find(incident => incident.key === key)?.state;
  return { records, journal, clock, verify, stateOf };
}

describe('false all-clears through looked (#78 delta, should-fix 1 and 2)', () => {
  it("local inference: a journal read that fails reads unverified and leaves 1b's load-failed open", async () => {
    const of = freshProfile();
    await legacyEnv.createDatabase(of.real, {});
    const real = createTrustDatabase({ indexedDB: of.faults.factory, keyRange: KeyRange });
    let failJournal = false;
    const store = {
      open: () => real.open(),
      close: () => real.close(),
      run: (/** @type {any} */ stores, /** @type {any} */ mode, /** @type {any} */ unit) => {
        if (failJournal && mode === 'readonly' && stores.includes('journal')) {
          failJournal = false;
          return Promise.reject(new UnavailableError('storage', 'retries-exhausted', true));
        }
        return real.run(stores, mode, unit);
      },
    };
    const { journal, clock, verify, stateOf, records } = await trustOn(of, {}, store);
    journal.event('embeddings.load-failed', { errorCode: 'quota' });
    await journal.flush();
    clock.advance(1000);
    await verify(['local-inference']);
    assert.equal(await stateOf('local-inference/load-failed/-'), 'open');
    failJournal = true;
    clock.advance(1000);
    await verify(['local-inference']);
    const latest = (await records.latestReceipts()).find(receipt => receipt.providerId === 'local-inference');
    assert.equal(latest?.status, 'unverified');
    assert.equal(await stateOf('local-inference/load-failed/-'), 'open', 'a failed journal read resolved load-failed');
  });

  it('the records answer whether their journal read answered', async () => {
    const of = freshProfile();
    const { records, journal } = await trustOn(of);
    journal.event('embeddings.load-failed', { errorCode: 'quota' });
    await journal.flush();
    const read = await records.eventsRead();
    assert.equal(read.ok, true);
    assert.deepEqual(read.events.map(event => event.code).filter(code => code === 'embeddings.load-failed'), ['embeddings.load-failed']);
  });

  it('index: a pipeline past the head never resolves another one still lagging; both faults are reported', async () => {
    const of = freshProfile();
    const pipelines = [{ id: 'search', windowSeq: 1, checkpoint: async () => 0 }];
    const commitLog = { head: async () => 10 };
    const { clock, verify, stateOf } = await trustOn(of, { commitLog, pipelines });
    await verify(['index']);
    assert.equal(await stateOf('index/lagging/-'), 'open');
    pipelines.push({ id: 'graph', windowSeq: 1, checkpoint: async () => 500 });
    clock.advance(1000);
    await verify(['index']);
    assert.equal(await stateOf('index/lagging/-'), 'open', 'resolved lagging while a pipeline still lags');
    assert.equal(await stateOf('index/stalled/-'), 'open');
    const run = await checkOf('index', { commitLog, pipelines });
    assert.deepEqual(run.faults.map(fault => fault.faultCode).sort(), ['lagging', 'stalled']);
  });
});

describe('garbage that filled looked (#78 delta, nits 3 to 5)', () => {
  it("credentials: a settings read that answers nothing isn't no saved keys", async () => {
    const of = freshProfile();
    for (const answer of [undefined, null, 'x']) {
      const reader = createLegacySecretReader({ indexedDB: of.faults.factory, settings: /** @type {any} */ ({ get: async () => answer, set: async () => {} }) });
      const run = await checkOf('credentials', { secrets: reader });
      assert.deepEqual([run.receipt.status, run.looked], ['unverified', []], `get answering ${JSON.stringify(answer)}`);
    }
  });

  it("index: pipelines that aren't a list verify nothing", async () => {
    for (const pipelines of ['', 0, null, { length: 0 }]) {
      const run = await checkOf('index', { pipelines, commitLog: { head: async () => 1 } });
      assert.deepEqual([run.receipt.status, run.looked], ['unverified', []], `pipelines ${JSON.stringify(pipelines)}`);
    }
  });

  it("recovery readiness: a verdict that isn't ok: true, or points without a status, verify nothing", async () => {
    const point = { id: 'p1', kind: 'pre-migration', status: 'verified', createdAt: 1, verifiedAt: 2 };
    for (const verdict of [undefined, null, {}, { ok: 'yes' }]) {
      const run = await checkOf('recovery-readiness', { recovery: { points: async () => [point], verify: async () => verdict } });
      assert.deepEqual([run.receipt.status, run.looked], ['unverified', []], `verify answering ${JSON.stringify(verdict)}`);
    }
    for (const listed of [[null], [{ id: 'p1' }], [{ ...point, verifiedAt: 'x' }], [{ ...point, kind: 7 }]]) {
      const run = await checkOf('recovery-readiness', { recovery: { points: async () => listed, verify: async () => ({ ok: true }) } });
      assert.deepEqual([run.receipt.status, run.looked], ['unverified', []], `points ${JSON.stringify(listed)}`);
    }
  });
});

describe("local inference reads the vectors only when it has to (#78 delta, nit 7)", () => {
  it('with no failure journaled it asks only whether any vector is stored', async () => {
    const asked = /** @type {string[]} */ ([]);
    const vectors = {
      stored: async () => (asked.push('stored'), true),
      newerThan: async () => (asked.push('newerThan'), true),
    };
    const run = await checkOf('local-inference', { trust: { eventsRead: async () => ({ events: [], ok: true }) }, vectors });
    assert.equal(run.receipt.status, 'unverified');
    assert.deepEqual(asked, ['stored']);
  });

  it('the vectors reader stops at the first vector newer than the failure', async () => {
    const of = freshProfile();
    const many = Array.from({ length: 200 }, (_, i) => ({ id: `n${String(i).padStart(3, '0')}`, noteId: `n${i}`, vector: [0.1], updatedAt: i === 0 ? 5000 : 10 }));
    await legacyEnv.createDatabase(of.real, { records: { vectors: many } });
    const reader = createVectorsReader({ indexedDB: of.faults.factory });
    assert.equal(await reader.stored(), true);
    assert.equal(await reader.newerThan(1000), true);
    assert.equal(await reader.newerThan(6000), false);
    const empty = createVectorsReader({ indexedDB: freshProfile().faults.factory });
    assert.deepEqual([await empty.stored(), await empty.newerThan(0)], [false, false]);
  });
});
