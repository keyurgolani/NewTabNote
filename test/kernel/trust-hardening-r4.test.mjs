// #68's fourth review round (#20 slice 1a): the third delta check's findings, each as the test
// that fails on 600e173. The reviewer's probe files weren't in the folder the lead named, so
// these are written from the findings (Q1b to Q7, C2, and the lead's open failure).

import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { createTrustDatabase } from '../../js/kernel/adapters/indexeddb/trust.js';
import { createRegistryRoot } from '../../js/kernel/registry/root.js';
import { createRuntime } from '../../js/kernel/registry/runtime.js';
import { health } from '../../js/trust/core/families.js';
import { createDiagnosticJournal } from '../../js/trust/core/journal.js';
import { createTrustRecords } from '../../js/trust/core/trust-records.js';
import { createTrustUseCases } from '../../js/trust/core/use-cases.js';
import {
  brokenFactory,
  databaseOn,
  flakyStore,
  hexIds,
  manualClock,
  realTimers,
  trustProfile,
} from './trust-support.mjs';

/** @typedef {import('../../js/trust/core/ports.js').TrustStore} TrustStore */
/** @typedef {import('../../js/kernel/registry/validate.js').Descriptor} Descriptor */
/** @typedef {ReturnType<typeof trustProfile>} Profile */

/** @type {TrustStore[]} */
const opened = [];
after(() => opened.forEach(store => store.close()));

const VERSIONS = Object.freeze({ extension: '1.4.1', browser: null, canvasSchema: 8, trustSchema: 1 });
const KEY = 'trust.lastStorageIncident';
const WRITE_FAILED = 'storage/write-failed/-';
const CAP = Object.freeze({
  providerId: 'capture',
  faultCode: 'capture-failed',
  severity: /** @type {const} */ ('capture-risk'),
});

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
 * @param {Descriptor[]} [providers]
 */
async function useCases(records, clock, providers = []) {
  const journal = createDiagnosticJournal({ records, clock, strict: true });
  const root = createRegistryRoot({ host: 'workspace' });
  root.register(health, providers);
  const resolution = root.resolve();
  const runtime = createRuntime(resolution);
  await runtime.probe();
  const trust = createTrustUseCases({
    records,
    journal,
    clock,
    timers: realTimers,
    registry: { resolution, runtime },
    versions: VERSIONS,
  });
  return { trust, journal };
}

/**
 * @param {ReturnType<typeof createTrustRecords>} records
 * @param {ReturnType<typeof manualClock>} clock
 */
async function summaryOf(records, clock) {
  return /** @type {any} */ (await (await useCases(records, clock)).trust.summary()).data;
}

/**
 * @param {ReturnType<typeof createTrustRecords>} records
 * @param {string} key
 */
const at = async (records, key) => (await records.incidents()).find(incident => incident.key === key);

/**
 * What NewTabNoteTrust holds under `key`, read straight from the store
 * @param {TrustStore} store
 * @param {string} key
 */
const storedAt = async (store, key) =>
  (await store.run(['incidents'], 'readonly', tx => tx.getAllByIndex('incidents', 'key', key)))[0];

/**
 * A provider whose check answers `answer`
 * @param {string} id
 * @param {() => unknown} check
 * @param {Record<string, unknown>} [extra]
 * @returns {Descriptor}
 */
const provider = (id, check, extra = {}) => ({
  id,
  version: 1,
  apiVersion: 1,
  group: 'indexing',
  rank: 1,
  hosts: ['workspace'],
  label: id,
  owner: 20,
  operation: `fixture.${id}`,
  costClass: 'local-cheap',
  timeoutMs: 50,
  freshnessMs: 60_000,
  triggers: ['verify-now'],
  fixtures: ['truthful-receipt'],
  observes: [],
  implementation: { check },
  ...extra,
});

describe("#68's fourth review round", () => {
  it('Q1b: a healthy context reports, and replays, a storage incident another context holds in the copy', async () => {
    const profile = trustProfile();
    const clock = manualClock();
    const a = flaky(profile);
    const ra = await recordsOn(a.store, profile, { clock, prefix: 'aaaa' });
    const healthy = databaseOn(profile);
    opened.push(healthy);
    const rb = await recordsOn(healthy, profile, { clock, prefix: 'bbbb' });
    // A's capture write fails after B opened, so only the copy holds it
    clock.advance(10);
    a.failNext(1);
    await ra.records.raise(CAP);
    const summary = await summaryOf(rb.records, clock);
    assert.equal(summary.capture, 'at-risk');
    assert.ok(summary.actionRequired >= 1);
    assert.equal(summary.route, 'recovery');
    // B's next write replays it
    await rb.records.append({ at: clock.now(), code: 'trust.reconciled', fields: { count: 0 } });
    assert.equal((await storedAt(healthy, 'capture/capture-failed/-'))?.occurrences, 1);
    assert.equal(profile.settings.items.get(KEY), null);
  });

  it('Q2c: failed writes racing the writes that end fallback are each counted once', async () => {
    const profile = trustProfile();
    const { store, failNext, database } = flaky(profile);
    const { records, clock } = await recordsOn(store, profile);
    // In fallback first
    failNext(1);
    await records.append({ at: clock.now(), code: 'trust.reconciled', fields: { count: 0 } });
    for (let n = 1; n <= 5; n++) {
      clock.advance(1);
      failNext(1);
      await Promise.all([
        records.append({ at: clock.now(), code: 'trust.reconciled', fields: { count: n } }),
        records.append({ at: clock.now(), code: 'trust.reconciled', fields: { count: n } }),
      ]);
      assert.equal((await at(records, WRITE_FAILED))?.occurrences, n + 1, `after round ${n}`);
    }
    await records.append({ at: clock.now(), code: 'trust.reconciled', fields: { count: 9 } });
    assert.equal((await storedAt(database, WRITE_FAILED))?.occurrences, 6);
  });

  it("Q2d: when the copy can't take the count, memory keeps it, races included", async () => {
    const profile = trustProfile();
    const { store, failNext, database } = flaky(profile);
    const { records, clock } = await recordsOn(store, profile);
    failNext(1);
    await records.append({ at: clock.now(), code: 'trust.reconciled', fields: { count: 0 } });
    profile.settings.failSets = 1_000_000;
    for (let n = 1; n <= 5; n++) {
      clock.advance(1);
      failNext(1);
      await Promise.all([
        records.append({ at: clock.now(), code: 'trust.reconciled', fields: { count: n } }),
        records.append({ at: clock.now(), code: 'trust.reconciled', fields: { count: n } }),
      ]);
      assert.equal((await at(records, WRITE_FAILED))?.occurrences, n + 1, `after round ${n}`);
    }
    profile.settings.failSets = 0;
    await records.append({ at: clock.now(), code: 'trust.reconciled', fields: { count: 9 } });
    assert.equal((await storedAt(database, WRITE_FAILED))?.occurrences, 6);
  });

  it('Q3: with chrome.storage.local full after one copied failure, every failed write still counts once', async () => {
    const profile = trustProfile();
    const { store, failNext, database } = flaky(profile);
    const { records, clock } = await recordsOn(store, profile);
    // The first failure reaches the copy; then the settings area fills up, so it's never trimmed
    failNext(1);
    await records.append({ at: clock.now(), code: 'trust.reconciled', fields: { count: 0 } });
    profile.settings.failSets = 1_000_000;
    await records.append({ at: clock.now(), code: 'trust.reconciled', fields: { count: 0 } });
    for (let n = 1; n < 71; n++) {
      clock.advance(1);
      failNext(1);
      await records.append({ at: clock.now(), code: 'trust.reconciled', fields: { count: n } });
      await records.append({ at: clock.now(), code: 'trust.reconciled', fields: { count: n } });
    }
    assert.equal((await storedAt(database, WRITE_FAILED))?.occurrences, 71);
  });

  it("Q4: a copy entry replayed but not trimmed, then grown by another context, adds only what's new", async () => {
    const profile = trustProfile();
    const clock = manualClock();
    const y = flaky(profile);
    const ry = await recordsOn(y.store, profile, { clock, prefix: 'aaaa' });
    y.failNext(1);
    await ry.records.raise(CAP);
    // X replays it, and can't trim the copy
    profile.settings.failSets = 1;
    const x = databaseOn(profile);
    opened.push(x);
    await recordsOn(x, profile, { clock, prefix: 'bbbb' });
    profile.settings.failSets = 0;
    assert.equal((await storedAt(x, 'capture/capture-failed/-'))?.occurrences, 1);
    // Nine more failures in Y
    for (let n = 0; n < 9; n++) {
      clock.advance(1);
      y.failNext(1);
      await ry.records.raise(CAP);
    }
    const z = databaseOn(profile);
    opened.push(z);
    await recordsOn(z, profile, { clock, prefix: 'cccc' });
    assert.equal((await storedAt(z, 'capture/capture-failed/-'))?.occurrences, 10);
  });

  it('Q5: a clock step back after a resolution still shows the writes that fail', async () => {
    const profile = trustProfile();
    const { store, failNext } = flaky(profile);
    const { records, clock } = await recordsOn(store, profile);
    failNext(1);
    await records.append({ at: clock.now(), code: 'trust.reconciled', fields: { count: 0 } });
    await records.append({ at: clock.now(), code: 'trust.reconciled', fields: { count: 1 } });
    clock.advance(1000);
    await records.resolve('storage', []);
    assert.equal((await at(records, WRITE_FAILED))?.state, 'resolved');
    clock.advance(-5000);
    failNext(1);
    await records.append({ at: clock.now(), code: 'trust.reconciled', fields: { count: 2 } });
    assert.equal((await at(records, WRITE_FAILED))?.state, 'open');
    assert.ok((await summaryOf(records, clock)).actionRequired >= 1);
  });

  it('Q5b: while writes fail, the summary always counts an action', async () => {
    const profile = trustProfile();
    const clock = manualClock();
    const { records } = await recordsOn(createTrustDatabase({ indexedDB: brokenFactory }), profile, { clock });
    profile.settings.failGets = 1_000_000;
    const summary = await summaryOf(records, clock);
    assert.equal(summary.records, 'fallback');
    assert.ok(summary.actionRequired >= 1);
  });

  it("Q6: trust.verify doesn't answer committed when a fault's incident wasn't recorded", async () => {
    const profile = trustProfile();
    const { store, failNext } = flaky(profile);
    const { records, clock } = await recordsOn(store, profile);
    const { trust } = await useCases(records, clock, [
      provider('index', () => ({ status: 'degraded', faults: [{ faultCode: 'lagging', severity: 'degraded' }] })),
    ]);
    // The receipt's write goes through, the incident's fails
    failNext(1, 'unreadable', { after: 1 });
    const outcome = await trust.verify({ type: 'trust.verify', commandId: 'c1', trigger: 'verify-now' });
    assert.equal(outcome.kind, 'unavailable');
    assert.equal(/** @type {any} */ (outcome).code, 'not-recorded');
  });

  it("Q7: trust.verify doesn't answer committed when a passing check's resolve wasn't recorded", async () => {
    const profile = trustProfile();
    const { store, failNext } = flaky(profile);
    const { records, clock } = await recordsOn(store, profile);
    await records.raise({ providerId: 'index', faultCode: 'lagging', severity: 'degraded' });
    clock.advance(10);
    const { trust } = await useCases(records, clock, [
      provider('index', () => ({ status: 'verified', looked: [{ faultCode: 'lagging' }] }), { observes: ['lagging'] }),
    ]);
    failNext(1, 'unreadable', { after: 1 });
    const outcome = await trust.verify({ type: 'trust.verify', commandId: 'c1', trigger: 'verify-now' });
    assert.equal(outcome.kind, 'unavailable');
    assert.equal((await at(records, 'index/lagging/-'))?.state, 'open');
    const answer = await records.resolve('index', []);
    assert.equal(answer.recorded, true);
  });

  it("the lead's: a failed open() holds storage/open-failed itself", async () => {
    const profile = trustProfile();
    const clock = manualClock();
    const { records, result } = await recordsOn(createTrustDatabase({ indexedDB: brokenFactory }), profile, { clock });
    assert.equal(result.ok, false);
    const held = await at(records, 'storage/open-failed/NewTabNoteTrust');
    assert.equal(held?.state, 'open');
    const summary = await summaryOf(records, clock);
    assert.ok(summary.actionRequired >= 1);
    // and it reaches the store from the copy once one opens
    const up = databaseOn(profile);
    opened.push(up);
    await recordsOn(up, profile, { clock, prefix: 'bbbb' });
    assert.equal((await storedAt(up, 'storage/open-failed/NewTabNoteTrust'))?.occurrences, 1);
  });

  it('C2: one recovery.raise that fails counts one failed write', async () => {
    const profile = trustProfile();
    const clock = manualClock();
    const { records } = await recordsOn(createTrustDatabase({ indexedDB: brokenFactory }), profile, { clock });
    const before = (await at(records, WRITE_FAILED))?.occurrences ?? 0;
    const { trust, journal } = await useCases(records, clock);
    await trust.raise({ type: 'recovery.raise', commandId: 'c1', ...CAP });
    await journal.flush();
    assert.equal((await at(records, WRITE_FAILED))?.occurrences, before + 1);
  });

  it('a held recovery.raise answers its own kind, not committed', async () => {
    const profile = trustProfile();
    const clock = manualClock();
    const { records } = await recordsOn(createTrustDatabase({ indexedDB: brokenFactory }), profile, { clock });
    const { trust } = await useCases(records, clock);
    const outcome = await trust.raise({ type: 'recovery.raise', commandId: 'c1', ...CAP });
    assert.equal(outcome.kind, 'held');
  });

  it("a copy that isn't readable is left as it is, and the failed write still counts", async () => {
    const profile = trustProfile();
    const clock = manualClock();
    profile.settings.items.set(KEY, { entries: 'not entries' });
    const { records } = await recordsOn(createTrustDatabase({ indexedDB: brokenFactory }), profile, { clock });
    await records.raise(CAP);
    assert.deepEqual(profile.settings.items.get(KEY), { entries: 'not entries' });
    assert.ok(((await at(records, WRITE_FAILED))?.occurrences ?? 0) >= 1);
    assert.equal((await at(records, 'capture/capture-failed/-'))?.state, 'open');
  });
});
