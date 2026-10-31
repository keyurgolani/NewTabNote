// #68's third review round (#20 slice 1a): the second delta check's probes (P1 to P10), each
// as the test that fails on 93fdee3, held to the scope's fallback: reads come from the store,
// only storage incidents are held (the latest sighting per key, in memory and in
// `trust.lastStorageIncident`), any other failed write is counted in the `storage/write-failed`
// incident and answered as not recorded, and the write that ends fallback replays first.

import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

import { createTrustDatabase } from '../../js/kernel/adapters/indexeddb/trust.js';
import { createRegistryRoot } from '../../js/kernel/registry/root.js';
import { createRuntime } from '../../js/kernel/registry/runtime.js';
import { checkEvidence } from '../../js/trust/core/evidence.js';
import { health } from '../../js/trust/core/families.js';
import { applyOp } from '../../js/trust/core/incidents.js';
import { createDiagnosticJournal } from '../../js/trust/core/journal.js';
import { createTrustRecords } from '../../js/trust/core/trust-records.js';
import { createTrustUseCases } from '../../js/trust/core/use-cases.js';
import {
  brokenFactory,
  databaseOn,
  flakyStore,
  hexIds,
  legacyId,
  manualClock,
  realTimers,
  trustProfile,
} from './trust-support.mjs';

/** @typedef {import('../../js/trust/core/ports.js').TrustStore} TrustStore */
/** @typedef {ReturnType<typeof trustProfile>} Profile */

/** @type {{forceCloseDatabase: (db: IDBDatabase) => void}} */
const { forceCloseDatabase } = createRequire(import.meta.url)('fake-indexeddb');

/** @type {TrustStore[]} */
const opened = [];
after(() => opened.forEach(store => store.close()));

const VERSIONS = Object.freeze({ extension: '1.4.1', browser: null, canvasSchema: 8, trustSchema: 1 });
const IDX = Object.freeze({ providerId: 'index', faultCode: 'lagging', severity: /** @type {const} */ ('degraded') });
const CAP = Object.freeze({
  providerId: 'capture',
  faultCode: 'capture-failed',
  severity: /** @type {const} */ ('capture-risk'),
});
const WRITE_FAILED = 'storage/write-failed/-';

/**
 * @param {TrustStore} store
 * @param {Profile} profile
 * @param {{clock?: ReturnType<typeof manualClock>, prefix?: string}} [options]
 */
async function recordsOn(store, profile, { clock = manualClock(), prefix = 'a1b2' } = {}) {
  const records = createTrustRecords({
    store,
    settings: profile.settings,
    clock,
    ids: hexIds(prefix),
    locks: profile.locks,
  });
  const result = await records.open();
  return { records, clock, result };
}

/** @param {Profile} profile */
function flaky(profile) {
  const database = databaseOn(profile);
  opened.push(database);
  return { database, ...flakyStore(database) };
}

/**
 * @param {ReturnType<typeof createTrustRecords>} records
 * @param {ReturnType<typeof manualClock>} clock
 * @param {boolean} [strict]
 */
function useCases(records, clock, strict = true) {
  const journal = createDiagnosticJournal({ records, clock, strict });
  const root = createRegistryRoot({ host: 'workspace' });
  root.register(health, []);
  const resolution = root.resolve();
  const trust = createTrustUseCases({
    records,
    journal,
    clock,
    timers: realTimers,
    registry: { resolution, runtime: createRuntime(resolution) },
    versions: VERSIONS,
  });
  return { trust, journal };
}

/**
 * @param {ReturnType<typeof createTrustRecords>} records
 * @param {ReturnType<typeof manualClock>} clock
 */
async function summaryOf(records, clock) {
  return /** @type {any} */ (await useCases(records, clock).trust.summary()).data;
}

/**
 * @param {ReturnType<typeof createTrustRecords>} records
 * @param {string} key
 */
async function incidentAt(records, key) {
  return (await records.incidents()).find(incident => incident.key === key);
}

describe("#68's third review round", () => {
  it('P1: a passing check on the write that ends fallback resolves the storage incident held before it', async () => {
    const profile = trustProfile();
    const { store, failNext } = flaky(profile);
    const { records, clock } = await recordsOn(store, profile);
    failNext(1);
    const held = await records.raise(CAP);
    assert.equal(held.held, true);
    clock.advance(1000);
    await records.resolve('capture', []);
    const incident = await incidentAt(records, 'capture/capture-failed/-');
    assert.equal(incident?.state, 'resolved');
  });

  it('P1b: a dismissal on the write that ends fallback dismisses the held incident it was shown', async () => {
    const profile = trustProfile();
    const { store, failNext } = flaky(profile);
    const { records, clock } = await recordsOn(store, profile);
    failNext(1);
    const { incident } = await records.raise(CAP);
    clock.advance(1000);
    await records.dismiss(/** @type {any} */ (incident).id, true);
    assert.equal((await incidentAt(records, 'capture/capture-failed/-'))?.dismissed, true);
  });

  it('P2: after the clock moves back, a new sighting of a resolved incident reopens it', async () => {
    const profile = trustProfile();
    const database = databaseOn(profile);
    opened.push(database);
    const { records, clock } = await recordsOn(database, profile);
    await records.raise(CAP);
    clock.advance(60_000);
    await records.resolve('capture', []);
    clock.advance(-30_000);
    await records.raise(CAP);
    const [incident] = await records.incidents();
    assert.equal(incident.state, 'open');
    assert.equal((await summaryOf(records, clock)).actionRequired, 1);
  });

  it('P2b: after the clock moves back, a passing check resolves', async () => {
    const profile = trustProfile();
    const database = databaseOn(profile);
    opened.push(database);
    const { records, clock } = await recordsOn(database, profile);
    await records.raise(CAP);
    clock.advance(-30_000);
    const done = await records.resolve('capture', []);
    assert.ok(done.recorded);
    assert.equal(done.resolved.length, 1);
  });

  it('P3: a sighting written after a resolution in the same millisecond reopens', async () => {
    const profile = trustProfile();
    const database = databaseOn(profile);
    opened.push(database);
    const { records, clock } = await recordsOn(database, profile);
    await records.raise(CAP);
    clock.advance(10);
    await records.resolve('capture', []);
    await records.raise(CAP);
    assert.equal((await records.incidents())[0].state, 'open');
  });

  it('P3b: a sighting that ends a dismissal, written in the same millisecond, undismisses', async () => {
    const profile = trustProfile();
    const database = databaseOn(profile);
    opened.push(database);
    const { records, clock } = await recordsOn(database, profile);
    const { incident } = await records.raise(CAP);
    clock.advance(10);
    await records.dismiss(/** @type {any} */ (incident).id, true);
    // A check's re-sighting keeps it dismissed (#20 slice 4a); a failed capture, in the same millisecond, doesn't
    await records.raise({ ...CAP, from: 'check' });
    assert.equal((await records.incidents())[0].dismissed, true);
    await records.raise(CAP);
    assert.equal((await records.incidents())[0].dismissed, false);
  });

  it('P4: a held storage sighting counts once, however many repeats are held and replayed around it', async () => {
    const profile = trustProfile();
    const clock = manualClock();
    const a = flaky(profile);
    const ra = await recordsOn(a.store, profile, { clock, prefix: 'aaaa' });
    a.failNext(1);
    await ra.records.raise(CAP);
    clock.advance(10);
    const b = flaky(profile);
    const rb = await recordsOn(b.store, profile, { clock, prefix: 'bbbb' });
    b.failNext(10_000);
    for (let n = 0; n < 64; n++) {
      clock.advance(1);
      await rb.records.raise(CAP);
    }
    b.failNext(0);
    clock.advance(1);
    await rb.records.append({ at: clock.now(), code: 'trust.reconciled', fields: { count: 0 } });
    clock.advance(1);
    await ra.records.append({ at: clock.now(), code: 'trust.reconciled', fields: { count: 0 } });
    assert.equal((await incidentAt(rb.records, 'capture/capture-failed/-'))?.occurrences, 65);
  });

  it('P5: 17 capture failures while the store is broken are 17 failed writes, and nothing reads as fine', async () => {
    const profile = trustProfile();
    const clock = manualClock();
    const a = await recordsOn(createTrustDatabase({ indexedDB: brokenFactory }), profile, { clock, prefix: 'aaaa' });
    for (let n = 0; n < 17; n++) {
      clock.advance(1);
      await a.records.raise({ ...CAP, subjectId: legacyId(n) });
    }
    assert.equal((await incidentAt(a.records, WRITE_FAILED))?.occurrences, 17);
    const summary = await summaryOf(a.records, clock);
    assert.ok(summary.actionRequired >= 1);
    assert.equal(summary.capture, 'at-risk');
    assert.equal(summary.route, 'recovery');
    // A's tab closes; the next context that opens the store reconciles the count
    const fresh = databaseOn(profile);
    opened.push(fresh);
    const b = await recordsOn(fresh, profile, { clock, prefix: 'bbbb' });
    assert.equal((await incidentAt(b.records, WRITE_FAILED))?.occurrences, 17);
  });

  it('P7: a held storage incident survives any number of other failed writes', async () => {
    const profile = trustProfile();
    const { store, failNext } = flaky(profile);
    const { records, clock } = await recordsOn(store, profile);
    failNext(100_000);
    await records.raise(CAP);
    for (let n = 0; n < 200; n++) {
      clock.advance(1);
      const answer = await records.raise({ ...IDX, subjectId: legacyId(n) });
      assert.equal(answer.recorded, false);
      assert.equal(answer.held, false);
    }
    failNext(0);
    clock.advance(1);
    await records.append({ at: clock.now(), code: 'trust.reconciled', fields: { count: 0 } });
    const caps = (await records.incidents()).filter(incident => incident.providerId === 'capture');
    assert.equal(caps.length, 1);
    assert.equal(caps[0].state, 'open');
    assert.equal((await incidentAt(records, WRITE_FAILED))?.occurrences, 201);
    assert.equal((await records.incidents()).filter(incident => incident.providerId === 'index').length, 0);
  });

  it('P8: a real legacy id with a short suffix is a subject', async () => {
    const profile = trustProfile();
    const database = databaseOn(profile);
    opened.push(database);
    const { records, clock } = await recordsOn(database, profile);
    const { journal } = useCases(records, clock, false);
    for (const id of ['1730000000000-k3j9x2a', '1730000000000-k3j9x2ab', '1730000000000-']) {
      assert.equal(checkEvidence({ subjectId: id }).ok, true, id);
    }
    assert.equal(journal.event('capture.failed', { subjectId: '1730000000000-k3j9x2a' }), true);
    await journal.flush();
    await records.raise({ ...CAP, subjectId: '1730000000000-k3j9x2ab' });
    assert.equal((await records.incidents()).length, 2);
    // A tenth suffix character is still refused
    assert.equal(checkEvidence({ subjectId: '1730000000000-k3j9x2abcd' }).ok, false);
  });

  it('P9: a write after Chrome closes the connection lands once', async () => {
    const profile = trustProfile();
    const database = databaseOn(profile);
    opened.push(database);
    const { records } = await recordsOn(database, profile);
    for (const connection of profile.faults.connections) forceCloseDatabase(connection);
    const raised = await records.raise(CAP);
    assert.equal(raised.held, false);
    assert.equal((await records.incidents())[0].occurrences, 1);
  });

  it('P10: an older dismissal replayed after a newer undismiss changes nothing', () => {
    const base = {
      id: '00000000-0000-4000-8000-000000000001',
      ref: '000000',
      key: 'sync/conflict/-',
      providerId: 'sync',
      faultCode: 'conflict',
      subjectId: null,
      severity: /** @type {const} */ ('data-risk'),
      state: /** @type {const} */ ('open'),
      dismissed: false,
      dismissChangedAt: null,
      firstSeenAt: 1,
      lastSeenAt: 1,
      resolvedAt: null,
      occurrences: 1,
      affected: [],
      preserved: [],
      evidence: {},
      appliedOps: [],
    };
    const undismissed = applyOp(/** @type {any} */ (base), {
      opId: 'u',
      kind: 'dismiss',
      at: 30,
      key: base.key,
      dismissed: false,
    });
    const after = applyOp(undismissed, { opId: 'd', kind: 'dismiss', at: 20, key: base.key, dismissed: true });
    assert.equal(after?.dismissed, false);
  });

  it('any other failed write is not held, is answered as not recorded, and counts in the write-failed incident', async () => {
    const profile = trustProfile();
    const { store, failNext } = flaky(profile);
    const { records, clock } = await recordsOn(store, profile);
    const { trust } = useCases(records, clock);
    // Four writes fail; the reads around them (round 4 reads the store to time a held sighting) don't
    failNext(4, 'unreadable', { writesOnly: true });
    const raised = await trust.raise({ type: 'recovery.raise', commandId: 'c1', ...IDX });
    assert.equal(raised.kind, 'unavailable');
    assert.equal(/** @type {any} */ (raised).code, 'not-recorded');
    const run = await records.putRun({
      id: legacyId(1),
      commandId: 'retry-open',
      incidentId: null,
      state: 'running',
      outcome: null,
      startedAt: clock.now(),
      updatedAt: clock.now(),
    });
    assert.equal(run.recorded, false);
    const appended = await records.append({ at: clock.now(), code: 'trust.reconciled', fields: { count: 0 } });
    assert.equal(appended.recorded, false);
    const receipt = await records.record({
      providerId: 'storage',
      status: 'verified',
      verifiedAt: clock.now(),
      durationMs: 1,
      freshnessMs: 1000,
      operation: 'storage.probe-readwrite',
      evidence: {},
      consequenceKey: null,
      preserved: [],
      nextAction: null,
    });
    assert.equal(receipt.recorded, false);
    // Reads come from the store: nothing a failed write tried shows, and the failure does
    assert.deepEqual(await records.runs(), []);
    assert.deepEqual(await records.events(), []);
    assert.deepEqual(await records.receipts(), []);
    const all = await records.incidents();
    assert.deepEqual(
      all.map(incident => [incident.key, incident.occurrences]),
      [[WRITE_FAILED, 4]],
    );
    const summary = await summaryOf(records, clock);
    assert.equal(summary.actionRequired, 1);
    assert.equal(summary.capture, 'unknown');
    assert.equal(summary.route, 'recovery');
  });

  it('a failed write leaves what the store already holds readable', async () => {
    const profile = trustProfile();
    const { store, failNext } = flaky(profile);
    const { records, clock } = await recordsOn(store, profile);
    await records.raise({ providerId: 'index', faultCode: 'scan-findings', severity: 'data-risk' });
    await records.append({ at: clock.now(), code: 'trust.reconciled', fields: { count: 1 } });
    failNext(1);
    await records.append({ at: clock.now(), code: 'trust.reconciled', fields: { count: 2 } });
    assert.deepEqual(
      (await records.events()).map(event => event.fields.count),
      [1],
    );
    assert.ok(await incidentAt(records, 'index/scan-findings/-'));
  });
});
