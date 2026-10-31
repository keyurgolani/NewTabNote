// #20 slice 1a's follow-ups to #80 (part 3): the delta check's findings (K6 to K9, K15), each
// as the test that fails on #80's merged code (0d96df7), from the reviewer's probes in
// _execution/artifacts/ntn-probes/80-delta/.

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
/** @typedef {ReturnType<typeof createTrustRecords>} Records */

/** @type {TrustStore[]} */
const opened = [];
after(() => opened.forEach(store => store.close()));

const VERSIONS = Object.freeze({ extension: '1.4.1', browser: null, canvasSchema: 8, trustSchema: 1 });
const OPEN_FAILED = 'storage/open-failed/NewTabNoteTrust';
const WRITE_FAILED = 'storage/write-failed/-';
const CANVAS = 'storage/open-failed/CanvasTabDB';

/** @param {number} count */
const event = count => ({ at: 0, code: 'trust.reconciled', fields: { count } });

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
  await records.open();
  return { records, clock };
}

/** @param {Profile} profile */
function databaseFor(profile) {
  const database = databaseOn(profile);
  opened.push(database);
  return database;
}

/**
 * @param {Records} records
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
 * A provider whose check answers what `check` returns
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
  timeoutMs: 5000,
  freshnessMs: 600_000,
  triggers: ['verify-now'],
  fixtures: ['truthful-receipt'],
  observes: [],
  implementation: { check },
  ...extra,
});

/**
 * @param {Records} records
 * @param {string} key
 */
const at = async (records, key) => (await records.incidents()).find(incident => incident.key === key);

/**
 * @param {TrustStore} store
 * @param {string} key
 */
const storedAt = async (store, key) =>
  (await store.run(['incidents'], 'readonly', tx => tx.getAllByIndex('incidents', 'key', key)))[0];

/** @param {{verify: (payload: unknown) => Promise<unknown>}} trust */
const verify = trust => trust.verify({ type: 'trust.verify', commandId: 'c1', trigger: 'verify-now' });

/**
 * B checks CanvasTabDB's open-failed; A, whose clock runs `skew` ms behind B's, sights it while
 * B's check runs
 * @param {number} skew
 * @param {{held?: boolean}} [options] - A's own store is broken, so its sighting is held
 */
async function skewed(skew, { held = false } = {}) {
  const profile = trustProfile();
  const clockB = manualClock(1_800_000_000_000);
  const clockA = manualClock(1_800_000_000_000 - skew);
  const database = databaseFor(profile);
  const rb = await recordsOn(database, profile, { clock: clockB, prefix: 'bbbb' });
  const ra = held
    ? await recordsOn(createTrustDatabase({ indexedDB: brokenFactory }), profile, { clock: clockA, prefix: 'aaaa' })
    : await recordsOn(database, profile, { clock: clockA, prefix: 'aaaa' });
  const journalA = createDiagnosticJournal({ records: ra.records, clock: clockA, strict: true });
  const journalB = createDiagnosticJournal({ records: rb.records, clock: clockB, strict: true });
  journalB.event('storage.open-failed', { errorCode: 'quota', subjectId: 'CanvasTabDB' });
  await journalB.flush();
  clockA.advance(120_000);
  clockB.advance(120_000);
  /** @type {() => void} */
  let release = () => {};
  const gate = new Promise(resolve => {
    release = () => resolve(undefined);
  });
  /** @type {() => void} */
  let started = () => {};
  const startedNow = new Promise(resolve => {
    started = () => resolve(undefined);
  });
  const check = async () => {
    started();
    await gate;
    return { status: 'verified', looked: [{ faultCode: 'open-failed', subjectId: 'CanvasTabDB' }] };
  };
  const { trust } = await useCases(rb.records, clockB, [
    provider('storage', check, { group: 'storage', observes: ['open-failed'] }),
  ]);
  const verifying = verify(trust);
  await startedNow;
  clockA.advance(100);
  clockB.advance(100);
  journalA.event('storage.open-failed', { errorCode: 'quota', subjectId: 'CanvasTabDB' });
  await journalA.flush();
  clockA.advance(100);
  clockB.advance(100);
  release();
  await verifying;
  return at(rb.records, CANVAS);
}

describe("#80's follow-ups (part 3)", () => {
  it('K7 control: same clocks, a sighting during the check stays open', async () => {
    const incident = await skewed(0);
    assert.deepEqual([incident?.occurrences, incident?.state], [2, 'open']);
  });

  it("K7: with A's clock 60 s behind B's, A's sighting during B's check stays open", async () => {
    const incident = await skewed(60_000);
    assert.deepEqual(
      [incident?.occurrences, incident?.state],
      [2, 'open'],
      'a sighting from during the check resolved',
    );
  });

  it("K8: with A's clock 60 s behind and A's sighting held in the copy, it stays open", async () => {
    const incident = await skewed(60_000, { held: true });
    assert.deepEqual(
      [incident?.occurrences, incident?.state],
      [2, 'open'],
      'a held sighting from during the check resolved',
    );
  });

  it('K9: a sighting in the same millisecond the check started stays open', async () => {
    const profile = trustProfile();
    const { records, clock } = await recordsOn(databaseFor(profile), profile);
    await records.raise({ providerId: 'local-inference', faultCode: 'load-failed', severity: 'degraded' });
    clock.advance(1000);
    /** @type {ReturnType<typeof createDiagnosticJournal> | null} */
    let journal = null;
    const check = async () => {
      const page = /** @type {ReturnType<typeof createDiagnosticJournal>} */ (journal);
      page.event('embeddings.load-failed', { errorCode: 'quota' });
      await page.flush();
      return { status: 'verified', looked: [{ faultCode: 'load-failed' }] };
    };
    const built = await useCases(records, clock, [provider('local-inference', check, { observes: ['load-failed'] })]);
    journal = built.journal;
    await verify(built.trust);
    const incident = await at(records, 'local-inference/load-failed/-');
    assert.deepEqual([incident?.occurrences, incident?.state], [2, 'open']);
  });

  it('a check resolves what it looked at and saw before it started, whatever the clocks', async () => {
    const profile = trustProfile();
    const clockB = manualClock(1_800_000_000_000);
    const clockA = manualClock(1_800_000_000_000 + 600_000);
    const database = databaseFor(profile);
    const rb = await recordsOn(database, profile, { clock: clockB, prefix: 'bbbb' });
    const ra = await recordsOn(database, profile, { clock: clockA, prefix: 'aaaa' });
    // A's clock runs ten minutes ahead, and its sighting came before B's check
    await ra.records.raise({ providerId: 'local-inference', faultCode: 'load-failed', severity: 'degraded' });
    clockB.advance(1000);
    const { trust } = await useCases(rb.records, clockB, [
      provider('local-inference', () => ({ status: 'verified', looked: [{ faultCode: 'load-failed' }] }), {
        observes: ['load-failed'],
      }),
    ]);
    await verify(trust);
    assert.equal((await at(rb.records, 'local-inference/load-failed/-'))?.state, 'resolved');
  });

  it("K6: a direct records.resolve leaves the records' own two incidents open", async () => {
    const profile = trustProfile();
    const clock = manualClock();
    const ra = await recordsOn(createTrustDatabase({ indexedDB: brokenFactory }), profile, { clock, prefix: 'aaaa' });
    const database = databaseFor(profile);
    clock.advance(10);
    const rb = await recordsOn(database, profile, { clock, prefix: 'bbbb' });
    clock.advance(1000);
    await ra.records.append(event(1));
    await rb.records.append(event(1));
    assert.equal((await storedAt(database, OPEN_FAILED))?.state, 'open');
    assert.equal((await storedAt(database, WRITE_FAILED))?.state, 'open');
    clock.advance(1000);
    const done = await rb.records.resolve('storage', []);
    assert.ok(done.recorded);
    assert.deepEqual(
      done.resolved.map(incident => incident.key),
      [],
    );
    assert.equal((await storedAt(database, OPEN_FAILED))?.state, 'open');
    assert.equal((await storedAt(database, WRITE_FAILED))?.state, 'open');
  });

  it("K15: a context's first write that lands after its failed one resolves write-failed", async () => {
    const profile = trustProfile();
    const database = databaseFor(profile);
    const f = flakyStore(database);
    const { records, clock } = await recordsOn(f.store, profile);
    f.failNext(1, 'quota', { writesOnly: true });
    assert.equal((await records.append(event(1))).recorded, false);
    clock.advance(1000);
    assert.equal((await records.append(event(2))).recorded, true);
    const stored = await storedAt(database, WRITE_FAILED);
    assert.deepEqual([stored?.state, stored?.occurrences], ['resolved', 1]);
    const { trust } = await useCases(records, clock);
    const summary = /** @type {any} */ (await trust.summary()).data;
    assert.deepEqual([summary.actionRequired, summary.route], [0, 'trust']);
  });

  it("K15: another context's write-failed stays open until that context's own write lands", async () => {
    const profile = trustProfile();
    const clock = manualClock();
    const database = databaseFor(profile);
    const rb = await recordsOn(database, profile, { clock, prefix: 'bbbb' });
    const fa = flakyStore(databaseFor(profile));
    const ra = await recordsOn(fa.store, profile, { clock, prefix: 'aaaa' });
    fa.failNext(1000);
    await ra.records.append(event(1));
    clock.advance(1000);
    await rb.records.append(event(2));
    assert.equal((await storedAt(database, WRITE_FAILED))?.state, 'open', "B resolved A's failed write");
    clock.advance(1000);
    fa.failNext(0);
    await ra.records.append(event(3));
    assert.equal((await storedAt(database, WRITE_FAILED))?.state, 'resolved');
    // A failing again later reopens it, as any held sighting does
    clock.advance(1000);
    fa.failNext(1000);
    await ra.records.append(event(4));
    assert.equal((await at(rb.records, WRITE_FAILED))?.state, 'open');
  });
});

describe("#84's check: write-failed resolves by counting", () => {
  /** @param {Profile} profile */
  const flakyContext = profile => {
    const database = databaseFor(profile);
    return { database, ...flakyStore(database) };
  };

  it("W1: B's landed write leaves write-failed open while A, whose failure B's merged into, still fails", async () => {
    const profile = trustProfile();
    const clock = manualClock();
    const a = flakyContext(profile);
    const b = flakyContext(profile);
    const ra = await recordsOn(a.store, profile, { clock, prefix: 'aaaa' });
    const rb = await recordsOn(b.store, profile, { clock, prefix: 'bbbb' });
    a.failNext(1000, 'unreadable', { writesOnly: true });
    clock.advance(10);
    assert.equal((await ra.records.append(event(1))).recorded, false);
    b.failNext(1, 'unreadable', { writesOnly: true });
    clock.advance(10);
    assert.equal((await rb.records.append(event(2))).recorded, false);
    clock.advance(10);
    assert.equal((await rb.records.append(event(3))).recorded, true);
    const stored = await storedAt(a.database, WRITE_FAILED);
    assert.deepEqual([stored?.state, stored?.occurrences], ['open', 2], "B's write resolved A's failure");
    const summary = /** @type {any} */ (await (await useCases(rb.records, clock)).trust.summary()).data;
    assert.deepEqual([summary.actionRequired >= 1, summary.route], [true, 'recovery']);
  });

  it("W2: B's landed write leaves A's failure open after a healthy C replayed B's entry, then A's", async () => {
    const profile = trustProfile();
    const clock = manualClock();
    const b = flakyContext(profile);
    const c = databaseFor(profile);
    const rb = await recordsOn(b.store, profile, { clock, prefix: 'bbbb' });
    const rc = await recordsOn(c, profile, { clock, prefix: 'cccc' });
    const ra = await recordsOn(createTrustDatabase({ indexedDB: brokenFactory }), profile, { clock, prefix: 'aaaa' });
    b.failNext(1, 'unreadable', { writesOnly: true });
    clock.advance(10);
    assert.equal((await rb.records.append(event(1))).recorded, false);
    clock.advance(10);
    await rc.records.append(event(2));
    clock.advance(10);
    assert.equal((await ra.records.append(event(3))).recorded, false);
    clock.advance(10);
    await rc.records.append(event(4));
    clock.advance(10);
    assert.equal((await rb.records.append(event(5))).recorded, true);
    const stored = await storedAt(c, WRITE_FAILED);
    assert.deepEqual([stored?.state, stored?.occurrences], ['open', 2], "B's write resolved A's failure");
  });

  it('W3 control: A keeps failing, B never failed, and B leaves it open', async () => {
    const profile = trustProfile();
    const clock = manualClock();
    const database = databaseFor(profile);
    const rb = await recordsOn(database, profile, { clock, prefix: 'bbbb' });
    const ra = await recordsOn(createTrustDatabase({ indexedDB: brokenFactory }), profile, { clock, prefix: 'aaaa' });
    clock.advance(10);
    await ra.records.append(event(1));
    clock.advance(10);
    await rb.records.append(event(2));
    await rb.records.append(event(3));
    assert.equal((await storedAt(database, WRITE_FAILED))?.state, 'open');
  });

  it("W4: after a clock step back, this context's failure resolves once its next write lands", async () => {
    const profile = trustProfile();
    const a = flakyContext(profile);
    const { records, clock } = await recordsOn(a.store, profile);
    a.failNext(1, 'unreadable', { writesOnly: true });
    await records.append(event(1));
    clock.advance(1000);
    await records.append(event(2));
    assert.equal((await storedAt(a.database, WRITE_FAILED))?.state, 'resolved');
    clock.advance(-60_000);
    a.failNext(1, 'unreadable', { writesOnly: true });
    await records.append(event(3));
    clock.advance(30_000);
    await records.append(event(4));
    const stored = await storedAt(a.database, WRITE_FAILED);
    assert.deepEqual([stored?.state, stored?.occurrences], ['resolved', 2], 'stuck open after the clock stepped back');
  });

  it("W5: an unreadable copy's extra failed write is this context's own, and still resolves", async () => {
    const profile = trustProfile();
    const a = flakyContext(profile);
    const { records, clock } = await recordsOn(a.store, profile);
    profile.settings.items.set('trust.lastStorageIncident', { entries: 'not entries' });
    a.failNext(1, 'unreadable', { writesOnly: true });
    await records.raise({ providerId: 'capture', faultCode: 'capture-failed', severity: 'capture-risk' });
    // The copy is fixed: the next write replays what memory holds
    profile.settings.items.delete('trust.lastStorageIncident');
    clock.advance(1000);
    await records.append(event(2));
    const stored = await storedAt(a.database, WRITE_FAILED);
    assert.equal(stored?.state, 'resolved');
  });
});
