// #20's slice 4 prerequisites, part 2 (on #17 PR 1b): the migration run's own event codes,
// raised from the worker's runner with value-free evidence, and the capture and storage probes
// below this build's version. A probe probes the path capture uses (the existing-mode adapter
// below it), storage reports a pending, failed, or blocked migration as `degraded` with a
// migration fault, `migration-required` is never `probe-failed`, and the run that completes
// resolves the migration incidents through storage's next check.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { webcrypto } from 'node:crypto';

import { UPGRADE_BLOCKED_KEY, UPGRADE_RECORD_KEY, createWorkerClient, migrationEvents } from '../../js/kernel/composition/background.js';
import { createIndexedDbAdapter } from '../../js/kernel/adapters/indexeddb/adapter.js';
import { createMigrationReader } from '../../js/kernel/adapters/indexeddb/health.js';
import { createTrustDatabase } from '../../js/kernel/adapters/indexeddb/trust.js';
import { LATEST_STRUCTURAL } from '../../js/kernel/adapters/indexeddb/registry.js';
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

/** @type {{IDBKeyRange: typeof globalThis.IDBKeyRange, IDBFactory: typeof globalThis.IDBFactory}} */
const { IDBKeyRange: KeyRange, IDBFactory } = createRequire(import.meta.url)('fake-indexeddb');
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
    // The run's codes, and the data transforms' own for a meta.schema they can't read (#17 PR 3a)
    for (const code of ['migration-required', 'space-short', 'schema-mismatch', 'recovery-point-unverified', 'point-missing', 'locks-unavailable', 'unknown-shape', 'meta-unreadable']) {
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
      ['storage.migration-failed', { schemaVersion: LATEST_STRUCTURAL }, 'schema-mismatch'],
      ['storage.migration-blocked', { schemaVersion: LATEST_STRUCTURAL, errorCode: 'blocked-upgrade' }, undefined],
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

describe("the capture and storage probes below this build's version (#20 slice 4 prerequisites, part 2)", () => {
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

  it("at this build's version, storage verifies and looks at every migration fault, and with a migration state it can't read it probes anyway, looking at no migration fault", async () => {
    const of = await profileAt8();
    assert.equal((await createWorkerClient(hostOf(of)).migration.done).status, 'migrated');
    const adapter = adapterOn(of, { mode: 'versioned' });
    await adapter.open();
    const stored = await checkOf('storage', probeContext(of, adapter));
    assert.deepEqual([stored.receipt.status, stored.faults], ['verified', []]);
    assert.ok(MIGRATION_FAULTS.every(fault => stored.looked.some(item => item.faultCode === fault)));
    for (const current of [async () => { throw new Error('no read'); }, async () => ({ version: 'nine' })]) {
      const unknown = await checkOf('storage', { storage: adapter, migration: { current } });
      assert.deepEqual([unknown.receipt.status, unknown.receipt.capture, unknown.faults], ['verified', 'safe', []]);
      assert.ok(!unknown.looked.some(item => MIGRATION_FAULTS.includes(item.faultCode)), JSON.stringify(unknown.looked));
    }
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

  it("the providers' test context opens the adapter capture uses: existing below this build's version", async () => {
    const of = await profileAt8();
    const { context } = await providerContext(of);
    assert.equal(/** @type {any} */ (context.storage).mode, 'existing');
    assert.equal((await checkOf('capture', context)).receipt.status, 'verified');
  });
});

/** A factory whose open of CanvasTabDB answers an error, as a damaged profile's does */
function brokenFactory() {
  const real = new IDBFactory();
  return /** @type {any} */ ({
    open(/** @type {string} */ name, /** @type {number | undefined} */ version) {
      if (name !== 'CanvasTabDB') return version === undefined ? real.open(name) : real.open(name, version);
      const request = /** @type {any} */ ({ result: undefined, error: new DOMException('broken', 'UnknownError'), transaction: null });
      setTimeout(() => request.onerror && request.onerror({ target: request, preventDefault() {} }), 0);
      return request;
    },
    deleteDatabase: (/** @type {string} */ name) => real.deleteDatabase(name),
    databases: () => real.databases(),
    cmp: (/** @type {unknown} */ a, /** @type {unknown} */ b) => real.cmp(a, b),
  });
}

/** A chrome.storage.local stand-in holding `items` */
const areaOf = (/** @type {Record<string, unknown>} */ items = {}) => ({
  get: async (/** @type {string[]} */ keys) => Object.fromEntries(keys.filter(key => key in items).map(key => [key, items[key]])),
  set: async (/** @type {Record<string, unknown>} */ more) => { Object.assign(items, more); },
  remove: async (/** @type {string | string[]} */ keys) => { for (const key of [keys].flat()) delete items[key]; },
});

/** `promise`, or 'no answer' when it hasn't settled within `ms` */
const within = (/** @type {Promise<unknown>} */ promise, /** @type {number} */ ms) =>
  Promise.race([promise.then(value => ({ value }), error => ({ error: error && (error.code || String(error)) })), new Promise(resolve => setTimeout(() => resolve('no answer'), ms))]);

describe("the migration state storage reads, and the worker's blocked marker (#20 slice 4 prerequisites, part 2, review)", () => {
  it("a database that won't open fails storage's check as before, whatever the migration state reads", async () => {
    const factory = brokenFactory();
    const settings = areaOf();
    const adapter = createIndexedDbAdapter({ indexedDB: factory, settings, mode: 'existing', requireCore: true });
    const stored = await checkOf('storage', { storage: adapter, migration: createMigrationReader({ indexedDB: factory, settings }) });
    assert.equal(stored.receipt.status, 'failed');
    assert.equal(stored.receipt.capture, 'at-risk');
    assert.deepEqual(stored.faults.map(fault => [fault.subjectId, fault.severity]), [['CanvasTabDB', 'capture-risk']]);
  });

  it('the reader answers while an upgrade waits on an open connection', async () => {
    const factory = new IDBFactory();
    const old = /** @type {IDBDatabase} */ (await legacyEnv.requestToPromise((() => {
      const request = factory.open('CanvasTabDB', 8);
      request.onupgradeneeded = () => request.result.createObjectStore('canvases');
      return request;
    })()));
    old.onversionchange = () => {};
    const upgrading = factory.open('CanvasTabDB', 9);
    upgrading.onblocked = () => {};
    await new Promise(resolve => setTimeout(resolve, 20));
    const reader = createMigrationReader({ indexedDB: factory, settings: areaOf() });
    const got = /** @type {any} */ (await within(reader.current(), 300));
    assert.notEqual(got, 'no answer');
    assert.equal(got.value.version, 8);
    old.close();
  });

  it('a factory that lists no databases leaves the version unknown, and storage probes anyway', async () => {
    const of = await profileAt8();
    const adapter = adapterOn(of, { mode: 'existing' });
    await adapter.open();
    const listless = /** @type {any} */ ({ open: of.faults.factory.open.bind(of.faults.factory), cmp: of.faults.factory.cmp.bind(of.faults.factory) });
    const reader = createMigrationReader({ indexedDB: listless, settings: of.chrome.api.storage.local });
    await assert.rejects(reader.current());
    const stored = await checkOf('storage', { storage: adapter, migration: reader });
    assert.deepEqual([stored.receipt.status, stored.faults], ['verified', []]);
    adapter.close();
  });

  it("a standing blocked marker reads migration-blocked below this build's version, and its key is outside the settings' keys", async () => {
    assert.equal(UPGRADE_BLOCKED_KEY.startsWith('setting_'), false);
    const of = await profileAt8();
    of.chrome.local[UPGRADE_BLOCKED_KEY] = { at: Date.now() };
    const adapter = adapterOn(of, { mode: 'existing' });
    await adapter.open();
    const stored = await checkOf('storage', probeContext(of, adapter));
    assert.deepEqual([stored.receipt.status, stored.faults.map(fault => fault.faultCode)], ['degraded', ['migration-blocked']]);
    adapter.close();
  });

  it('the runner sets the marker while its upgrade is blocked, and clears it when an attempt starts and when the run ends', async () => {
    const of = await profileAt8();
    of.chrome.local[UPGRADE_BLOCKED_KEY] = { at: 1 };
    const blocker = /** @type {IDBDatabase} */ (await legacyEnv.requestToPromise(of.real.open('CanvasTabDB')));
    const reports = /** @type {any[]} */ ([]);
    const worker = createWorkerClient(hostOf(of, { report: (/** @type {any} */ seen) => reports.push(seen) }));
    await legacyEnv.waitFor(async () => (reports.length > 0 ? true : null), { withinMs: 10_000, message: 'the blocked report' });
    assert.equal(reports[0].kind, 'blocked');
    assert.equal(reports[0].standing, true, 'a marker stood when the attempt started');
    const marker = /** @type {any} */ (of.chrome.local[UPGRADE_BLOCKED_KEY]);
    assert.ok(marker && marker.at !== 1, 'the blocked run set its own marker');
    blocker.close();
    assert.equal((await worker.migration.done).status, 'migrated');
    assert.equal(of.chrome.local[UPGRADE_BLOCKED_KEY] ?? null, null, "the run cleared its marker");
  });

  it("an ended run's report carries the record it replaced, and migrationEvents skips a failure that record already held", async () => {
    const of = await profileAt8();
    of.chrome.local[UPGRADE_RECORD_KEY] = { status: 'failed', code: 'locks-unavailable', at: Date.now(), version: '1.4.1', costly: false };
    const reports = /** @type {any[]} */ ([]);
    const locks = { request: () => { throw new DOMException('no locks', 'InvalidStateError'); } };
    await createWorkerClient(hostOf(of, { locks, report: (/** @type {any} */ seen) => reports.push(seen) })).migration.done;
    assert.deepEqual(reports.map(seen => [seen.kind, seen.outcome.status, seen.previous]), [['ended', 'failed', { status: 'failed', code: 'locks-unavailable' }]]);

    const sent = /** @type {any[]} */ ([]);
    const report = migrationEvents((code, fields, failure) => sent.push([code, failure && /** @type {any} */ (failure).code]));
    const failed = /** @type {any} */ ({ status: 'failed', shape: 'legacy', to: null, steps: [], recoveryPointId: null, failure: { code: 'locks-unavailable' } });
    report({ kind: 'ended', outcome: failed, previous: { status: 'failed', code: 'locks-unavailable' } });
    report({ kind: 'blocked', standing: true });
    assert.deepEqual(sent, []);
    report({ kind: 'ended', outcome: failed, previous: { status: 'failed', code: 'schema-mismatch' } });
    report({ kind: 'blocked', standing: false });
    assert.deepEqual(/** @type {any[]} */ (sent).map(([code]) => code), ['storage.migration-failed', 'storage.migration-blocked']);
  });

  it("a refused run journals storage.migration-failed with its code, except a refusal the open journals itself", () => {
    const sent = /** @type {any[]} */ ([]);
    const report = migrationEvents((code, fields, failure) => sent.push([code, failure && /** @type {any} */ (failure).code]));
    const refused = (/** @type {string} */ code) => /** @type {any} */ ({ status: 'refused', shape: 'unknown', to: null, steps: [], recoveryPointId: 'p', failure: { code } });
    report({ kind: 'ended', outcome: refused('unknown-shape'), previous: null });
    report({ kind: 'ended', outcome: refused('missing-core-stores'), previous: null });
    report({ kind: 'ended', outcome: refused('version-too-new'), previous: null });
    assert.deepEqual(sent, [['storage.migration-failed', 'unknown-shape']]);
  });

  it('a report that rejects later never leaves a rejection unhandled', async () => {
    const unhandled = /** @type {unknown[]} */ ([]);
    const listen = (/** @type {unknown} */ reason) => unhandled.push(reason);
    process.on('unhandledRejection', listen);
    try {
      const of = await profileAt8();
      const worker = createWorkerClient(hostOf(of, { report: async () => { throw new Error('report failed later'); } }));
      assert.equal((await worker.migration.done).status, 'migrated');
      await new Promise(resolve => setTimeout(resolve, 50));
      assert.deepEqual(unhandled, []);
    } finally {
      process.off('unhandledRejection', listen);
    }
  });

  it('a storage area that throws as the attempt writes its marker, or reads the record after a run that never started, leaves the runner as without the throw', async () => {
    const of = await profileAt8();
    of.chrome.local[UPGRADE_BLOCKED_KEY] = { at: 1 };
    const area = of.chrome.api.storage.local;
    const throwing = {
      get: (/** @type {string[]} */ keys) => area.get(keys),
      set: (/** @type {Record<string, unknown>} */ items) => {
        if (UPGRADE_BLOCKED_KEY in items) throw new Error('storage gone');
        return area.set(items);
      },
    };
    assert.equal((await createWorkerClient(hostOf(of, { settings: throwing })).migration.done).status, 'migrated');

    const locked = await profileAt8();
    const locks = { request: () => { throw new DOMException('no locks', 'InvalidStateError'); } };
    let reads = 0;
    const reading = {
      get: (/** @type {string[]} */ keys) => {
        reads += 1;
        if (reads > 1) throw new Error('storage gone');
        return locked.chrome.api.storage.local.get(keys);
      },
      set: (/** @type {Record<string, unknown>} */ items) => locked.chrome.api.storage.local.set(items),
    };
    const ended = await createWorkerClient(hostOf(locked, { locks, settings: reading, version: '1.5.0' })).migration.done;
    assert.equal(ended.status, 'failed');
  });
});

