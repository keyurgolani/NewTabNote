// #20's slice 4 prerequisites, part 2 (on #17 PR 1b): the migration run's own event codes,
// raised from the worker's runner with value-free evidence, and the capture and storage probes
// below version 9. A probe probes the path capture uses (the existing-mode adapter below 9),
// storage reports a pending, failed, or blocked migration as `degraded` with a migration fault,
// `migration-required` is never `probe-failed`, and the run that completes resolves the
// migration incidents through storage's next check.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { webcrypto } from 'node:crypto';

import { UPGRADE_RECORD_KEY, createWorkerClient, migrationEvents } from '../../js/kernel/composition/background.js';
import { createMigrationReader } from '../../js/kernel/adapters/indexeddb/health.js';
import { createTrustDatabase } from '../../js/kernel/adapters/indexeddb/trust.js';
import { inspect } from '../../js/kernel/adapters/indexeddb/shapes.js';
import { createRegistryRoot } from '../../js/kernel/registry/root.js';
import { createRuntime } from '../../js/kernel/registry/runtime.js';
import { runCheck } from '../../js/trust/core/checks.js';
import { ERROR_CODES, FAULT_CODES } from '../../js/trust/core/codes.js';
import { EVENT_CODES, eventCodeProblems } from '../../js/trust/core/event-codes.js';
import { health } from '../../js/trust/core/families.js';
import { createDiagnosticJournal } from '../../js/trust/core/journal.js';
import { PROVIDERS } from '../../js/trust/core/providers/catalog.js';
import { createTrustRecords } from '../../js/trust/core/trust-records.js';
import { createTrustUseCases } from '../../js/trust/core/use-cases.js';
import { legacyEnv, profileWith, synthesized } from './migration-support.mjs';
import { adapterOn } from './storage-fixture.mjs';
import { MANIFEST, providerContext } from './trust-provider-support.mjs';
import { hexIds, lockManager, manualClock, realTimers } from './trust-support.mjs';

/** @type {{IDBKeyRange: typeof globalThis.IDBKeyRange}} */
const { IDBKeyRange: KeyRange } = createRequire(import.meta.url)('fake-indexeddb');
const FIXTURES = synthesized();
const MIGRATION_FAULTS = ['migration-pending', 'migration-failed', 'migration-blocked'];

/** A 1.4.x profile at version 8, with #17's adapter fixture's fields */
async function profileAt8() {
  const of = /** @type {any} */ (await profileWith(/** @type {any} */ (FIXTURES.get('v8.basic'))));
  of.adapters = [];
  return of;
}

/** The worker's host over `of` */
const hostOf = (/** @type {any} */ of, /** @type {Record<string, unknown>} */ extra = {}) => ({
  indexedDB: of.faults ? of.faults.factory : of.real,
  keyRange: KeyRange,
  settings: of.chrome.api.storage.local,
  locks: legacyEnv.createLockManager(),
  estimate: null,
  crypto: /** @type {any} */ (webcrypto),
  ...extra,
});

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
    { context, clock: manualClock(), timers: realTimers },
  );
}

/** The context the storage and capture probes get on `of`, with `adapter` as capture's path */
const probeContext = (/** @type {any} */ of, /** @type {any} */ adapter) => ({
  storage: adapter,
  migration: createMigrationReader({ indexedDB: of.faults.factory, settings: of.chrome.api.storage.local }),
});

describe('the migration event codes (#20 slice 4 prerequisites, part 2)', () => {
  it('a completed, failed, and blocked run each has a code with value-free fields, and none raises an incident', () => {
    assert.deepEqual(eventCodeProblems(), []);
    for (const code of ['storage.migration-completed', 'storage.migration-failed', 'storage.migration-blocked']) {
      const entry = EVENT_CODES[code];
      assert.ok(entry, `${code} isn't registered`);
      assert.equal(entry.incident, undefined, `${code} raises an incident`);
      assert.ok(entry.fields.includes('schemaVersion'));
    }
    for (const code of ['migration-required', 'space-short', 'schema-mismatch', 'recovery-point-unverified', 'point-missing', 'locks-unavailable']) {
      assert.ok(ERROR_CODES.includes(code), `${code} isn't a registered error code`);
    }
    for (const fault of MIGRATION_FAULTS) assert.ok(FAULT_CODES.includes(fault));
  });

  it("the worker's runner reports each run it makes: short of space, failed, blocked, and migrated, and not a record it keeps", async () => {
    const reports = /** @type {any[]} */ ([]);
    const report = (/** @type {any} */ seen) => reports.push(seen.kind === 'blocked' ? ['blocked'] : [seen.outcome.status, seen.outcome.failure?.code ?? null]);
    const cramped = await profileAt8();
    await createWorkerClient(hostOf(cramped, { estimate: async () => ({ quota: 100 * 1024 ** 2, usage: 99 * 1024 ** 2 }), report })).migration.done;
    assert.deepEqual(reports, [['space-blocked', 'space-short']]);
    // A start within the window keeps the record and runs nothing, so it reports nothing
    await createWorkerClient(hostOf(cramped, { estimate: null, report })).migration.done;
    assert.deepEqual(reports, [['space-blocked', 'space-short']]);
    reports.length = 0;
    const locked = await profileAt8();
    const locks = { request: () => { throw new DOMException('no locks', 'InvalidStateError'); } };
    await createWorkerClient(hostOf(locked, { locks, report, version: '1.5.0' })).migration.done;
    assert.deepEqual(reports.map(([status]) => status), ['failed']);
    reports.length = 0;
    const held = await profileAt8();
    const blocker = /** @type {IDBDatabase} */ (await legacyEnv.requestToPromise(held.real.open('CanvasTabDB')));
    const worker = createWorkerClient(hostOf(held, { report }));
    await legacyEnv.waitFor(async () => (reports.length > 0 ? true : null), { withinMs: 10_000, message: 'the blocked report' });
    assert.deepEqual(reports, [['blocked']]);
    blocker.close();
    await worker.migration.done;
    assert.deepEqual(reports, [['blocked'], ['migrated', null]]);
  });

  it('migrationEvents journals each event once until a run completes, and nothing for a fresh profile or a current one', () => {
    const sent = /** @type {any[]} */ ([]);
    const report = migrationEvents((code, fields, failure) => sent.push([code, fields, failure && /** @type {any} */ (failure).code]));
    const failed = { status: 'failed', shape: 'legacy', to: null, steps: [], recoveryPointId: null, failure: { code: 'schema-mismatch' } };
    report({ kind: 'ended', outcome: /** @type {any} */ (failed) });
    report({ kind: 'ended', outcome: /** @type {any} */ (failed) });
    report({ kind: 'blocked' });
    report({ kind: 'blocked' });
    report({ kind: 'ended', outcome: /** @type {any} */ ({ ...failed, status: 'current', failure: null }) });
    report({ kind: 'ended', outcome: /** @type {any} */ ({ ...failed, status: 'migrated', shape: 'none', to: 9, failure: null }) });
    assert.deepEqual(sent, [
      ['storage.migration-failed', { schemaVersion: 9 }, 'schema-mismatch'],
      ['storage.migration-blocked', { schemaVersion: 9, errorCode: 'blocked-upgrade' }, undefined],
    ]);
    report({ kind: 'ended', outcome: /** @type {any} */ ({ ...failed, status: 'migrated', to: 9, failure: null }) });
    report({ kind: 'ended', outcome: /** @type {any} */ (failed) });
    assert.deepEqual(sent.slice(2).map(([code]) => code), ['storage.migration-completed', 'storage.migration-failed']);
  });

  it("a runner whose report throws runs and records exactly as without one", async () => {
    const of = await profileAt8();
    const worker = createWorkerClient(hostOf(of, { report: () => { throw new Error('broken report'); } }));
    assert.equal((await worker.migration.done).status, 'migrated');
    assert.equal(/** @type {any} */ (of.chrome.local[UPGRADE_RECORD_KEY]).status, 'migrated');
    assert.equal(await worker.whenReady(), null);
  });
});

describe('the capture and storage probes below version 9 (#20 slice 4 prerequisites, part 2)', () => {
  it("at 8 with the run short of space: capture probes the existing-mode path and verifies, storage is degraded, migration-blocked", async () => {
    const of = await profileAt8();
    of.chrome.local[UPGRADE_RECORD_KEY] = { status: 'space-blocked', code: 'space-short', at: Date.now(), version: '1.4.1', costly: true };
    const adapter = adapterOn(of, { mode: 'existing' });
    await adapter.open();
    const context = probeContext(of, adapter);
    const captured = await checkOf('capture', context);
    assert.deepEqual([captured.receipt.status, captured.receipt.capture, captured.faults], ['verified', 'safe', []]);
    const stored = await checkOf('storage', context);
    assert.deepEqual([stored.receipt.status, stored.receipt.capture], ['degraded', 'safe']);
    assert.deepEqual(stored.faults.map(fault => [fault.faultCode, fault.subjectId, fault.severity]), [['migration-blocked', 'CanvasTabDB', 'degraded']]);
    assert.ok(MIGRATION_FAULTS.every(fault => stored.looked.some(item => item.faultCode === fault)), JSON.stringify(stored.looked));
    assert.equal((await inspect(of.real)).version, 8, 'a probe upgraded nothing');
    adapter.close();
  });

  it('a failed run is migration-failed, and no record yet is migration-pending', async () => {
    const of = await profileAt8();
    const adapter = adapterOn(of, { mode: 'existing' });
    await adapter.open();
    const pending = await checkOf('storage', probeContext(of, adapter));
    assert.deepEqual(pending.faults.map(fault => fault.faultCode), ['migration-pending']);
    of.chrome.local[UPGRADE_RECORD_KEY] = { status: 'failed', code: 'schema-mismatch', at: Date.now(), version: '1.4.1', costly: false };
    const failed = await checkOf('storage', probeContext(of, adapter));
    assert.deepEqual([failed.receipt.status, failed.faults.map(fault => fault.faultCode)], ['degraded', ['migration-failed']]);
    adapter.close();
  });

  it("a versioned adapter that answers migration-required is never probe-failed: storage degraded with the migration fault, capture unverified", async () => {
    const of = await profileAt8();
    of.chrome.local[UPGRADE_RECORD_KEY] = { status: 'failed', code: 'schema-mismatch', at: Date.now(), version: '1.4.1', costly: false };
    const adapter = adapterOn(of, { mode: 'versioned' });
    await adapter.open().catch(() => {});
    const context = probeContext(of, adapter);
    const stored = await checkOf('storage', context);
    assert.equal(stored.receipt.status, 'degraded');
    assert.deepEqual(stored.faults.map(fault => fault.faultCode), ['migration-failed']);
    assert.equal(stored.receipt.capture, undefined, 'it probed nothing capture uses');
    // It read the record, so it looked at the migration faults, and at no probe fault
    assert.deepEqual([...new Set(stored.looked.map(item => item.faultCode))].sort(), [...MIGRATION_FAULTS].sort());
    const captured = await checkOf('capture', context);
    assert.deepEqual([captured.receipt.status, captured.receipt.evidence.errorCode, captured.faults], ['unverified', 'migration-required', []]);
    adapter.close();
  });

  it('at 9, storage verifies and looks at every migration fault, and a migration record that fails to read verifies nothing', async () => {
    const of = await profileAt8();
    assert.equal((await createWorkerClient(hostOf(of)).migration.done).status, 'migrated');
    const adapter = adapterOn(of, { mode: 'versioned' });
    await adapter.open();
    const stored = await checkOf('storage', probeContext(of, adapter));
    assert.deepEqual([stored.receipt.status, stored.faults], ['verified', []]);
    assert.ok(MIGRATION_FAULTS.every(fault => stored.looked.some(item => item.faultCode === fault)));
    const broken = { storage: adapter, migration: { current: async () => { throw new Error('no read'); } } };
    assert.equal((await checkOf('storage', broken)).receipt.status, 'unverified');
    const garbage = { storage: adapter, migration: { current: async () => ({ version: 'nine' }) } };
    assert.equal((await checkOf('storage', garbage)).receipt.status, 'unverified');
    adapter.close();
  });

  it('end to end: the migration-failed incident is open at 8, and the run that completes resolves it at storage\'s next check', async () => {
    const of = await profileAt8();
    of.chrome.local[UPGRADE_RECORD_KEY] = { status: 'failed', code: 'schema-mismatch', at: Date.now(), version: '1.4.1', costly: false };
    const clock = manualClock();
    const records = createTrustRecords({
      store: createTrustDatabase({ indexedDB: of.faults.factory, keyRange: KeyRange }),
      settings: of.chrome.api.storage.local,
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
    let adapter = adapterOn(of, { mode: 'existing' });
    await adapter.open();
    const context = { ...probeContext(of, adapter), trust: records };
    const trust = createTrustUseCases({
      records,
      journal,
      clock,
      timers: realTimers,
      locks: lockManager(),
      registry: { resolution, runtime, context },
      versions: { extension: MANIFEST.version, browser: null, canvasSchema: 8, trustSchema: 1 },
    });
    const key = 'storage/migration-failed/CanvasTabDB';
    const stateOf = async () => (await records.incidents()).find(incident => incident.key === key)?.state;
    await trust.verify({ type: 'trust.verify', commandId: '00000000-0000-4000-8000-000000000c01', trigger: 'verify-now', providerIds: ['storage'] });
    assert.equal(await stateOf(), 'open');
    const severity = (await records.incidents()).find(incident => incident.key === key)?.severity;
    assert.equal(severity, 'degraded', 'nothing the user has is at risk at 8');
    adapter.close();
    assert.equal((await createWorkerClient(hostOf(of)).migration.done).status, 'migrated');
    adapter = adapterOn(of, { mode: 'versioned' });
    await adapter.open();
    context.storage = adapter;
    clock.advance(1000);
    await trust.verify({ type: 'trust.verify', commandId: '00000000-0000-4000-8000-000000000c02', trigger: 'verify-now', providerIds: ['storage'] });
    assert.equal(await stateOf(), 'resolved');
    adapter.close();
  });

  it("the providers' test context opens the adapter capture uses: existing below 9", async () => {
    const of = await profileAt8();
    const { context } = await providerContext(of);
    assert.equal(/** @type {any} */ (context.storage).mode, 'existing');
    assert.equal((await checkOf('capture', context)).receipt.status, 'verified');
  });
});
