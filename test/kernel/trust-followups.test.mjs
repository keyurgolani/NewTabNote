// #20 slice 1a's follow-ups to #68: the fourth delta check's findings (D1 to D11), each as the
// test that fails on #68's merged code (13c3ded), from the reviewer's probes. D7 passed there
// and stays as a regression test. D9 (a store run that never settles holds the copy's lock) is
// answered in the port contract instead (ports.js), so it has no test here.

import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { createTrustDatabase } from '../../js/kernel/adapters/indexeddb/trust.js';
import { UnavailableError } from '../../js/kernel/core/contracts/outcomes.js';
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
  manualTimers,
  realTimers,
  trustProfile,
} from './trust-support.mjs';

/** @typedef {import('../../js/trust/core/ports.js').TrustStore} TrustStore */
/** @typedef {import('../../js/trust/core/ports.js').Timers} Timers */
/** @typedef {import('../../js/kernel/registry/validate.js').Descriptor} Descriptor */
/** @typedef {ReturnType<typeof trustProfile>} Profile */
/** @typedef {ReturnType<typeof createTrustRecords>} Records */

/** @type {TrustStore[]} */
const opened = [];
after(() => opened.forEach(store => store.close()));

const VERSIONS = Object.freeze({ extension: '1.4.1', browser: null, canvasSchema: 8, trustSchema: 1 });
const KEY = 'trust.lastStorageIncident';
const WRITE_FAILED = 'storage/write-failed/-';
const OPEN_FAILED = 'storage/open-failed/NewTabNoteTrust';
const CAP = Object.freeze({
  providerId: 'capture',
  faultCode: 'capture-failed',
  severity: /** @type {const} */ ('capture-risk'),
});

/**
 * @param {TrustStore} store
 * @param {Profile} profile
 * @param {{clock?: ReturnType<typeof manualClock>, prefix?: string, locks?: Profile['locks'] | null, timers?: Timers | null}} [options]
 */
async function recordsOn(store, profile, { clock = manualClock(), prefix = 'a1b2', locks, timers = null } = {}) {
  const records = createTrustRecords({
    store,
    settings: profile.settings,
    clock,
    ids: hexIds(prefix),
    locks: locks === undefined ? profile.locks : locks,
    timers,
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
 * @param {Records} records
 * @param {ReturnType<typeof manualClock>} clock
 */
async function summaryOf(records, clock) {
  return /** @type {any} */ (await (await useCases(records, clock)).trust.summary()).data;
}

/**
 * @param {Records} records
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
  timeoutMs: 50,
  freshnessMs: 60_000,
  triggers: ['verify-now'],
  fixtures: ['truthful-receipt'],
  implementation: { check },
  ...extra,
});

describe("#68's follow-ups (the fourth delta check)", () => {
  it('D1: an open() that answers open-pending holds no data-risk incident, and the next write uses the connection', async () => {
    const profile = trustProfile();
    const db = databaseOn(profile);
    opened.push(db);
    let first = true;
    /** @type {TrustStore} */
    const store = {
      open: async () => {
        if (first) {
          first = false;
          // The connection finishes, just after the adapter's 5 s answer
          await db.open();
          throw new UnavailableError('storage', 'open-pending', true);
        }
        return db.open();
      },
      run: (stores, mode, unit) => db.run(stores, mode, unit),
      close: () => db.close(),
    };
    const clock = manualClock();
    const { records, result } = await recordsOn(store, profile, { clock });
    assert.equal(result.ok, false);
    assert.equal(profile.settings.items.get(KEY), undefined, 'a slow open holds nothing');
    clock.advance(1000);
    const appended = await records.append({ at: clock.now(), code: 'trust.reconciled', fields: { count: 0 } });
    assert.equal(appended.recorded, true, 'a write 1 s after a slow open still failed though the connection is up');
    assert.equal(records.state(), 'open');
    assert.equal(await storedAt(db, OPEN_FAILED), undefined);
    assert.equal(await storedAt(db, WRITE_FAILED), undefined);
  });

  it("D2: trust.verify doesn't answer committed when a fault's incident was only held", async () => {
    const profile = trustProfile();
    const { store, failNext, database } = flaky(profile);
    const { records, clock } = await recordsOn(store, profile);
    const { trust } = await useCases(records, clock, [
      provider(
        'capture',
        () => ({ status: 'degraded', faults: [{ faultCode: 'capture-failed', severity: 'capture-risk' }] }),
        { core: true },
      ),
    ]);
    // The receipt lands; the capture incident's write fails, so it's held
    failNext(1, 'unreadable', { after: 1, writesOnly: true });
    const outcome = await trust.verify({ type: 'trust.verify', commandId: 'c1', trigger: 'verify-now' });
    assert.equal(await storedAt(database, 'capture/capture-failed/-'), undefined);
    assert.notEqual(outcome.kind, 'committed');
    assert.deepEqual([outcome.kind, /** @type {any} */ (outcome).code], ['unavailable', 'not-recorded']);
  });

  it('D3: a healthy context whose copy read fails still says something needs action', async () => {
    const profile = trustProfile();
    const clock = manualClock();
    const a = flaky(profile);
    const ra = await recordsOn(a.store, profile, { clock, prefix: 'aaaa' });
    const healthy = databaseOn(profile);
    opened.push(healthy);
    const rb = await recordsOn(healthy, profile, { clock, prefix: 'bbbb' });
    clock.advance(10);
    a.failNext(1);
    await ra.records.raise(CAP);
    assert.ok(profile.settings.items.get(KEY));
    profile.settings.failGets = 1;
    const summary = await summaryOf(rb.records, clock);
    assert.equal(summary.capture, 'unknown');
    assert.ok(summary.actionRequired >= 1, 'B claims nothing needs action without having read the copy');
    assert.equal(summary.route, 'recovery');
  });

  it("D3b: a healthy context whose copy read fails doesn't call capture safe while another holds capture-risk", async () => {
    const profile = trustProfile();
    const clock = manualClock();
    const a = flaky(profile);
    const ra = await recordsOn(a.store, profile, { clock, prefix: 'aaaa' });
    const healthy = databaseOn(profile);
    opened.push(healthy);
    const rb = await recordsOn(healthy, profile, { clock, prefix: 'bbbb' });
    const providers = [provider('capture', () => ({ status: 'verified', capture: 'safe' }), { core: true })];
    const { trust } = await useCases(rb.records, clock, providers);
    await trust.verify({ type: 'trust.verify', commandId: 'c1', trigger: 'verify-now' });
    clock.advance(10);
    a.failNext(1);
    await ra.records.raise(CAP);
    assert.equal(/** @type {any} */ (await trust.summary()).data.capture, 'at-risk');
    profile.settings.failGets = 1;
    const summary = /** @type {any} */ (await trust.summary()).data;
    assert.notEqual(summary.capture, 'safe');
    assert.equal(summary.route, 'recovery');
  });

  it('D11: a copy read that never settles answers within the bound, and counts as unread', async () => {
    const profile = trustProfile();
    const db = databaseOn(profile);
    opened.push(db);
    const timers = manualTimers();
    const { records, clock } = await recordsOn(db, profile, { timers });
    const get = profile.settings.get;
    profile.settings.get = () => new Promise(() => {});
    const answered = records.incidents().then(() => 'answered');
    // Let the read start, then let its bound pass
    for (let n = 0; n < 20 && timers.pending.size === 0; n++) await new Promise(resolve => setImmediate(resolve));
    timers.fireAll();
    const raced = await Promise.race([answered, new Promise(resolve => setTimeout(() => resolve('hung'), 200))]);
    assert.equal(raced, 'answered');
    profile.settings.get = get;
    profile.settings.failGets = 1;
    assert.ok((await summaryOf(records, clock)).actionRequired >= 1);
  });

  it('D4: one journal.event that raises an incident, in fallback, counts one failed write', async () => {
    const profile = trustProfile();
    const clock = manualClock();
    const { records } = await recordsOn(createTrustDatabase({ indexedDB: brokenFactory }), profile, { clock });
    const before = (await at(records, WRITE_FAILED))?.occurrences ?? 0;
    const journal = createDiagnosticJournal({ records, clock, strict: true });
    journal.event('capture.failed', { errorCode: 'quota' });
    await journal.flush();
    assert.equal((await at(records, WRITE_FAILED))?.occurrences, before + 1);
  });

  it('D5: one failed storage raise with an unreadable copy counts one failed write', async () => {
    const profile = trustProfile();
    const clock = manualClock();
    const { store, failNext } = flaky(profile);
    const { records } = await recordsOn(store, profile, { clock });
    profile.settings.items.set(KEY, { entries: 'not entries' });
    failNext(1, 'unreadable', { writesOnly: true });
    await records.raise(CAP);
    assert.equal((await at(records, WRITE_FAILED))?.occurrences, 1);
  });

  it('D6: after a clock step back across contexts, writes failing in one still show in the other', async () => {
    const profile = trustProfile();
    const clock = manualClock();
    const healthy = databaseOn(profile);
    opened.push(healthy);
    const rb = await recordsOn(healthy, profile, { clock, prefix: 'bbbb' });
    const ra = await recordsOn(createTrustDatabase({ indexedDB: brokenFactory }), profile, { clock, prefix: 'aaaa' });
    // A fails a write; B replays it, then a storage check passes in B
    await ra.records.append({ at: clock.now(), code: 'trust.reconciled', fields: { count: 0 } });
    await rb.records.append({ at: clock.now(), code: 'trust.reconciled', fields: { count: 0 } });
    clock.advance(1000);
    await rb.records.resolve('storage', []);
    assert.equal((await storedAt(healthy, WRITE_FAILED))?.state, 'resolved');
    clock.advance(-5000);
    const failed = await ra.records.append({ at: clock.now(), code: 'trust.reconciled', fields: { count: 1 } });
    assert.equal(failed.recorded, false);
    assert.equal((await at(rb.records, WRITE_FAILED))?.state, 'open');
    assert.ok((await summaryOf(rb.records, clock)).actionRequired >= 1, 'B: nothing needs action while A fails writes');
    // And B's next write stores it reopened
    await rb.records.append({ at: clock.now(), code: 'trust.reconciled', fields: { count: 2 } });
    assert.equal((await storedAt(healthy, WRITE_FAILED))?.state, 'open');
  });

  it('D7: a lineage replayed but not trimmed, replayed again while another context grows it, counts exactly', async () => {
    const profile = trustProfile();
    const clock = manualClock();
    const y = flaky(profile);
    const ry = await recordsOn(y.store, profile, { clock, prefix: 'aaaa' });
    for (let n = 0; n < 3; n++) {
      clock.advance(1);
      y.failNext(1, 'unreadable', { writesOnly: true });
      await ry.records.raise(CAP);
    }
    // X opens: replays the copy, and its trim fails
    const x = databaseOn(profile);
    opened.push(x);
    profile.settings.failSets = 1;
    await recordsOn(x, profile, { clock, prefix: 'bbbb' });
    profile.settings.failSets = 0;
    assert.equal((await storedAt(x, 'capture/capture-failed/-'))?.occurrences, 3);
    // Z opens (replaying the same lineage) while Y grows it
    const z = databaseOn(profile);
    opened.push(z);
    await Promise.all([
      recordsOn(z, profile, { clock, prefix: 'cccc' }),
      (async () => {
        clock.advance(1);
        y.failNext(1, 'unreadable', { writesOnly: true });
        await ry.records.raise(CAP);
      })(),
    ]);
    await ry.records.append({ at: clock.now(), code: 'trust.reconciled', fields: { count: 0 } });
    const w = databaseOn(profile);
    opened.push(w);
    await recordsOn(w, profile, { clock, prefix: 'dddd' });
    assert.equal((await storedAt(x, 'capture/capture-failed/-'))?.occurrences, 4);
    assert.equal((await storedAt(x, WRITE_FAILED))?.occurrences, 4);
  });

  it('D8: the first write after NewTabNoteTrust opens resolves the open-failed sightings before it, and a later one reopens it', async () => {
    const profile = trustProfile();
    const clock = manualClock();
    const ra = await recordsOn(createTrustDatabase({ indexedDB: brokenFactory }), profile, { clock, prefix: 'aaaa' });
    await recordsOn(createTrustDatabase({ indexedDB: brokenFactory }), profile, { clock, prefix: 'cccc' });
    const up = databaseOn(profile);
    opened.push(up);
    const rb = await recordsOn(up, profile, { clock, prefix: 'bbbb' });
    const stored = await storedAt(up, OPEN_FAILED);
    assert.equal(stored?.state, 'resolved', 'open-failed stays open after the store opened');
    assert.equal(stored?.occurrences, 2);
    // Part 2: A still can't open, and its next write says so, so B doesn't answer all clear
    clock.advance(60_000);
    assert.equal(
      (await ra.records.append({ at: clock.now(), code: 'trust.reconciled', fields: { count: 0 } })).recorded,
      false,
    );
    const summary = await summaryOf(rb.records, clock);
    assert.equal((await at(rb.records, OPEN_FAILED))?.state, 'open');
    assert.deepEqual([summary.actionRequired >= 1, summary.route], [true, 'recovery']);
  });

  it('D10: without locks, two concurrent writes in one context replay a memory remainder once', async () => {
    const profile = trustProfile();
    const { store, failNext, database } = flaky(profile);
    const { records, clock } = await recordsOn(store, profile, { locks: null });
    // The copy can't take it, so memory holds the count
    profile.settings.failSets = 1_000_000;
    failNext(1, 'unreadable', { writesOnly: true });
    await records.append({ at: clock.now(), code: 'trust.reconciled', fields: { count: 0 } });
    profile.settings.failSets = 0;
    await Promise.all([
      records.append({ at: clock.now(), code: 'trust.reconciled', fields: { count: 1 } }),
      records.append({ at: clock.now(), code: 'trust.reconciled', fields: { count: 2 } }),
    ]);
    assert.equal((await storedAt(database, WRITE_FAILED))?.occurrences, 1);
  });
});
