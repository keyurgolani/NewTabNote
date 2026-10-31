// #78's review round (#20 slice 2): a port that answers garbage verifies nothing, so no
// provider turns it into a definite state; local inference decides from the journal, never
// from its own incident; each provider declares the faults it observes, so the incidents this
// slice raises resolve once the fault is gone, end to end on NewTabNoteTrust; and the probe's
// edges: its own read-back code, no commit-log change, a key no note has, and a recovery
// point that vanished being discarded, not failed.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';

import { createRecoveryReader, createVectorsReader } from '../../js/kernel/adapters/indexeddb/health.js';
import { createTrustDatabase } from '../../js/kernel/adapters/indexeddb/trust.js';
import { ROWS_STORE, committed as txCommitted, discardPoint, DEFAULT_LIMITS, listPoints, openRecovery } from '../../js/kernel/adapters/indexeddb/recovery-points.js';
import { committed } from '../../js/kernel/core/contracts/outcomes.js';
import { createRegistryRoot } from '../../js/kernel/registry/root.js';
import { createRuntime } from '../../js/kernel/registry/runtime.js';
import { runCheck } from '../../js/trust/core/checks.js';
import { FAULT_CODES } from '../../js/trust/core/codes.js';
import { health } from '../../js/trust/core/families.js';
import { createDiagnosticJournal } from '../../js/trust/core/journal.js';
import { PROVIDERS } from '../../js/trust/core/providers/catalog.js';
import { PROBE_KEY, probeCommit } from '../../js/trust/core/providers/probe.js';
import { createTrustRecords } from '../../js/trust/core/trust-records.js';
import { createTrustUseCases } from '../../js/trust/core/use-cases.js';
import { KeyRange, legacyEnv, run as migrate } from './migration-support.mjs';
import { adapterOn } from './storage-fixture.mjs';
import { MANIFEST, freshProfile, providerContext } from './trust-provider-support.mjs';
import { hexIds, lockManager, manualClock, realTimers } from './trust-support.mjs';

/** @typedef {import('../../js/trust/core/checks.js').CheckRun} CheckRun */

/**
 * One provider's check, as its descriptor declares it, against `context`
 * @param {string} id
 * @param {Readonly<Record<string, unknown>>} context
 * @returns {Promise<CheckRun>}
 */
async function checkOf(id, context) {
  const descriptor = /** @type {any} */ (PROVIDERS.find(candidate => candidate.id === id));
  const implementation = /** @type {any} */ (await descriptor.load());
  const run = await runCheck(
    { ...descriptor, timeoutMs: 1000, check: (/** @type {Readonly<Record<string, unknown>>} */ given) => implementation.check(given) },
    { context, clock: manualClock(), timers: realTimers },
  );
  // Every fault a check reports is one it observes, or its incident could never resolve
  for (const fault of run.faults) assert.ok((descriptor.observes || []).includes(fault.faultCode), `${id} reported ${fault.faultCode}`);
  return run;
}

describe('a port that answers garbage verifies nothing (#78 should-fix 2)', () => {
  it('credentials: a reader answering anything but a list of known places is unverified, never "no saved keys"', async () => {
    for (const answer of [null, 'settings', { 0: 'settings' }, ['settings', 'bogus']]) {
      const { receipt } = await checkOf('credentials', { secrets: { present: async () => answer } });
      assert.equal(receipt.status, 'unverified', `present() answering ${JSON.stringify(answer)}`);
    }
  });

  it('permissions: getAll without both lists, or a manifest without its permissions list, is unverified', async () => {
    const declared = { permissions: [...MANIFEST.permissions, 'newTabPageOverride'], origins: [...MANIFEST.host_permissions] };
    for (const granted of [{}, null, { permissions: 'storage', origins: 7 }, { permissions: declared.permissions }]) {
      const { receipt, faults } = await checkOf('permissions', { permissions: { getAll: async () => granted }, manifest: MANIFEST });
      assert.deepEqual([receipt.status, faults], ['unverified', []], `getAll answering ${JSON.stringify(granted)}`);
    }
    for (const manifest of [{}, { permissions: 'storage' }, { ...MANIFEST, host_permissions: 'all' }]) {
      const { receipt } = await checkOf('permissions', { permissions: { getAll: async () => declared }, manifest });
      assert.equal(receipt.status, 'unverified');
    }
  });

  it('contributions and block types: no roots, or no contributions, is not-configured, never verified', async () => {
    assert.equal((await checkOf('contributions', { resolutions: () => [] })).receipt.status, 'not-configured');
    const empty = createRegistryRoot({ host: 'workspace' }).resolve();
    assert.equal((await checkOf('contributions', { resolutions: () => [empty] })).receipt.status, 'not-configured');
    assert.equal((await checkOf('block-types', { resolutions: () => [] })).receipt.status, 'not-configured');
    assert.equal((await checkOf('contributions', { resolutions: () => 'nope' })).receipt.status, 'unverified');
  });

  it("index: a checkpoint past the head, as when the log was replaced under it, is degraded, stalled", async () => {
    const run = await checkOf('index', {
      commitLog: { head: async () => 3 },
      pipelines: [{ id: 'search', windowSeq: 10, checkpoint: async () => 500 }],
    });
    assert.equal(run.receipt.status, 'degraded');
    assert.deepEqual(run.faults.map(fault => fault.faultCode), ['stalled']);
  });

  it("capture and storage: an adapter that answers committed without running the probe verifies nothing", async () => {
    const liar = { readSettings: async () => ({}), commit: async () => ({ outcome: committed('x', []), replayed: false }) };
    assert.equal((await checkOf('capture', { storage: liar })).receipt.status, 'unverified');
    assert.equal((await checkOf('storage', { storage: liar })).receipt.status, 'unverified');
  });
});

describe('local inference decides from the journal (#78 should-fix 1)', () => {
  /** A journal reader over these events */
  const journalOf = (/** @type {Array<{code: string, at: number}>} */ events) => ({
    events: async () => events.map((event, index) => ({ seq: index + 1, fields: {}, ...event })),
  });
  /** A vectors reader whose newest write is at `at` */
  const vectorsAt = (/** @type {number | null} */ at) => ({ latest: async () => ({ stored: at !== null, at }) });

  it('a load failure newer than every vectors write is action-required, reporting the fault it observes', async () => {
    const run = await checkOf('local-inference', {
      trust: journalOf([{ code: 'embeddings.load-failed', at: 2000 }]),
      vectors: vectorsAt(1000),
    });
    assert.equal(run.receipt.status, 'action-required');
    assert.deepEqual(run.faults.map(fault => [fault.faultCode, fault.subjectId, fault.severity]), [['load-failed', null, 'degraded']]);
  });

  it('vectors written after the failure read unverified, with no fault, so the incident resolves', async () => {
    const run = await checkOf('local-inference', {
      trust: journalOf([{ code: 'embeddings.load-failed', at: 2000 }]),
      vectors: vectorsAt(3000),
    });
    assert.deepEqual([run.receipt.status, run.faults], ['unverified', []]);
  });

  it('no failure and no vectors is not-configured; vectors and no failure is unverified', async () => {
    assert.equal((await checkOf('local-inference', { trust: journalOf([]), vectors: vectorsAt(null) })).receipt.status, 'not-configured');
    assert.equal((await checkOf('local-inference', { trust: journalOf([]), vectors: vectorsAt(5) })).receipt.status, 'unverified');
    // A failure and vectors that never said when they were written: the failure can't be shown past
    const timeless = { latest: async () => ({ stored: true, at: null }) };
    const run = await checkOf('local-inference', { trust: journalOf([{ code: 'embeddings.load-failed', at: 2000 }]), vectors: timeless });
    assert.equal(run.receipt.status, 'action-required');
  });

  it("the vectors reader answers the newest updatedAt, as Storage.saveVector writes it", async () => {
    const of = freshProfile();
    await legacyEnv.createDatabase(of.real, {
      records: { vectors: [{ id: 'a', noteId: 'a', vector: [0.1], updatedAt: 10 }, { id: 'b', noteId: 'b', vector: [0.2], updatedAt: 30 }] },
    });
    assert.deepEqual(await createVectorsReader({ indexedDB: of.faults.factory }).latest(), { stored: true, at: 30 });
    assert.deepEqual(await createVectorsReader({ indexedDB: freshProfile().faults.factory }).latest(), { stored: false, at: null });
  });
});

describe('each provider declares what it observes (#78 should-fix 3)', () => {
  it('every descriptor lists its observed faults, each a registered fault, once', () => {
    const observed = Object.fromEntries(PROVIDERS.map(descriptor => [descriptor.id, descriptor.observes]));
    assert.deepEqual(observed, {
      capture: ['quota', 'version-too-new', 'probe-failed'],
      storage: ['quota', 'version-too-new', 'probe-failed'],
      'recovery-readiness': ['point-unverified'],
      backup: [],
      sync: [],
      credentials: ['legacy-secret'],
      permissions: ['grant-missing', 'permission-changed'],
      'ai-scope-grants': [],
      'remote-ai': [],
      'local-inference': ['load-failed'],
      index: ['lagging', 'stalled'],
      messaging: ['unreachable'],
      contributions: ['contribution-unavailable'],
      'block-types': ['contribution-unavailable'],
    });
    for (const descriptor of PROVIDERS) {
      for (const fault of /** @type {string[]} */ (descriptor.observes)) assert.ok(FAULT_CODES.includes(fault));
    }
  });

  /**
   * The use cases over every provider, on NewTabNoteTrust in `of`
   * @param {import('./trust-provider-support.mjs').Profile} of
   * @param {Record<string, unknown>} [overrides]
   */
  async function trustOn(of, overrides = {}) {
    const clock = manualClock();
    const store = createTrustDatabase({ indexedDB: of.faults.factory, keyRange: KeyRange });
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
        commandId: `00000000-0000-4000-8000-0000000001${(++n).toString(16).padStart(2, '0')}`,
        trigger: 'verify-now',
        providerIds,
      });
    /** @param {string} key */
    const stateOf = async key => (await records.incidents()).find(incident => incident.key === key)?.state;
    return { records, journal, clock, verify, stateOf };
  }

  it('credentials: the legacy-secret incident resolves once the key is cleared', async () => {
    const of = freshProfile();
    of.chrome.local.setting_llmApiKey = 'ntn-canary-r1-key';
    const { clock, verify, stateOf } = await trustOn(of);
    await verify(['credentials']);
    assert.equal(await stateOf('credentials/legacy-secret/setting_llmApiKey'), 'open');
    of.chrome.local.setting_llmApiKey = '';
    clock.advance(1000);
    await verify(['credentials']);
    assert.equal(await stateOf('credentials/legacy-secret/setting_llmApiKey'), 'resolved');
  });

  it("local inference: 1b's load-failed incident resolves once vectors are written after the failure", async () => {
    const of = freshProfile();
    await legacyEnv.createDatabase(of.real, {});
    const { journal, clock, verify, stateOf } = await trustOn(of);
    journal.event('embeddings.load-failed', { errorCode: 'quota' });
    await journal.flush();
    clock.advance(1000);
    await verify(['local-inference']);
    assert.equal(await stateOf('local-inference/load-failed/-'), 'open');
    // The model loads and indexes a note after the failure
    const adapter = adapterOn(of);
    await adapter.open();
    await adapter.commit(/** @type {any} */ ({
      commandId: 'seed',
      command: { type: 'seed', commandId: 'seed' },
      effect: { kind: 'units', units: [{ stores: ['vectors'], run: async (/** @type {any} */ tx) => tx.put('vectors', { id: 'n1', noteId: 'n1', vector: [0.1], updatedAt: clock.now() + 1 }) }] },
      done: () => committed('seeded', []),
    }));
    clock.advance(1000);
    await verify(['local-inference']);
    assert.equal(await stateOf('local-inference/load-failed/-'), 'resolved');
    adapter.close();
  });

  it('recovery readiness: point-unverified resolves once the failing point is discarded', async () => {
    const of = freshProfile();
    await legacyEnv.createDatabase(of.real, {
      records: { canvases: [{ id: '1730000000000-abc', name: 'Groceries', createdAt: 1, updatedAt: 1 }] },
    });
    assert.equal((await migrate(/** @type {any} */ (of))).status, 'migrated');
    const recovery = /** @type {IDBDatabase} */ (await openRecovery(of.real, { create: false }));
    const tx = recovery.transaction(ROWS_STORE, 'readwrite');
    const done = txCommitted(tx);
    const request = tx.objectStore(ROWS_STORE).openCursor();
    request.onsuccess = () => {
      const cursor = request.result;
      if (cursor) cursor.update({ ...cursor.value, value: { ...cursor.value.value, name: 'Changed' } });
    };
    await done;
    const { clock, verify, stateOf } = await trustOn(of);
    await verify(['recovery-readiness']);
    assert.equal(await stateOf('recovery-readiness/point-unverified/NewTabNoteRecovery'), 'open');
    for (const point of await listPoints(recovery)) await discardPoint(recovery, point.id, { keyRange: KeyRange, limits: DEFAULT_LIMITS });
    recovery.close();
    clock.advance(1000);
    await verify(['recovery-readiness']);
    assert.equal(await stateOf('recovery-readiness/point-unverified/NewTabNoteRecovery'), 'resolved');
  });
});

describe("the probe's edges (#78 nits 4 to 6)", () => {
  it('a read-back that differs has its own code', async () => {
    const swapping = {
      readSettings: async () => ({}),
      commit: async (/** @type {any} */ work) => {
        /** @type {unknown} */
        let stored;
        const tx = {
          get: async () => (stored === undefined ? undefined : { id: 'something-else' }),
          put: (/** @type {string} */ _store, /** @type {unknown} */ record) => {
            stored = record;
          },
          delete: () => {},
        };
        const stop = await work.effect.units[0].run(tx);
        return { outcome: stop || work.done(), replayed: false };
      },
    };
    const outcome = await probeCommit(/** @type {any} */ (swapping), ['notes']);
    assert.deepEqual([outcome.kind, 'code' in outcome && outcome.code], ['rejected', 'probe-readback-mismatch']);
  });

  it('changes no entity, so a commit log that appends one entry per changed id gets none, and a replayed answer verifies nothing', async () => {
    const of = freshProfile();
    const adapter = adapterOn(of);
    await adapter.open();
    const outcome = await probeCommit(adapter, ['notes']);
    assert.equal(outcome.kind, 'committed');
    assert.deepEqual(/** @type {any} */ (outcome).changedIds, []);
    assert.equal(/** @type {any} */ (outcome).commitSeq, undefined);
    const replaying = { readSettings: async () => ({}), commit: async () => ({ outcome: committed('trust-probe', []), replayed: true }) };
    assert.equal((await checkOf('storage', { storage: replaying })).receipt.status, 'unverified');
    adapter.close();
  });

  it("a note whose id is the old probe key doesn't stop the probe, and is left as it was", async () => {
    const of = freshProfile();
    await legacyEnv.createDatabase(of.real, { records: { canvases: [{ id: 'trust-probe', name: 'Imported' }] } });
    const adapter = adapterOn(of);
    await adapter.open();
    assert.notEqual(PROBE_KEY, 'trust-probe');
    assert.equal((await checkOf('storage', { storage: adapter })).receipt.status, 'verified');
    const kept = await adapter.read(['notes'], tx => tx.get('notes', 'trust-probe'));
    assert.equal(/** @type {any} */ (kept).name, 'Imported');
    adapter.close();
  });

  it('a point that vanished between listing and verifying is discarded, not failed: no incident', async () => {
    const recovery = {
      points: async () => [{ id: 'p1', kind: 'pre-migration', status: 'verified', createdAt: 1, verifiedAt: 2 }],
      verify: async () => ({ ok: false, code: 'point-discarded' }),
    };
    const run = await checkOf('recovery-readiness', { recovery });
    assert.deepEqual([run.receipt.status, run.faults], ['unverified', []]);
    // The reader says so for a point it can't find
    const of = freshProfile();
    await openRecovery(of.real, { create: true }).then(db => db && db.close());
    const reader = createRecoveryReader({ indexedDB: of.faults.factory, keyRange: KeyRange, crypto: /** @type {any} */ (webcrypto) });
    assert.deepEqual(await reader.verify('gone'), { ok: false, code: 'point-discarded' });
  });
});
