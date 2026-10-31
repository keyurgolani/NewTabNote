// #20 slice 1a's follow-ups to #75 (part 2): the high review's findings, each as the test that
// fails on #75's merged code (99345bb), from the reviewer's probes (P1 to P5, N6), plus the
// lead's resolution rule for what a check observes (6b) and the unbounded install id read.
// I1 and I2 are the known limit the records' doc comment states (a copy set that fails while
// reads work leaves a context's failures in its memory), so they have no test here.

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
  fakeKeyRange,
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

/** An IndexedDB factory whose open never answers, as a stuck backing store */
const stuckFactory = /** @type {IDBFactory} */ (/** @type {unknown} */ ({ open: () => ({}) }));

/** @param {number} count */
const event = count => ({ at: 0, code: 'trust.reconciled', fields: { count } });

/**
 * @param {TrustStore} store
 * @param {Profile} profile
 * @param {{clock?: ReturnType<typeof manualClock>, prefix?: string, timers?: Timers | null}} [options]
 */
async function recordsOn(store, profile, { clock = manualClock(), prefix = 'a1b2', timers = null } = {}) {
  const records = createTrustRecords({
    store,
    settings: profile.settings,
    clock,
    ids: hexIds(prefix),
    locks: profile.locks,
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
  freshnessMs: 600_000,
  triggers: ['verify-now'],
  fixtures: ['truthful-receipt'],
  observes: [],
  implementation: { check },
  ...extra,
});

/** Lets pending promise callbacks run */
const settle = async () => {
  for (let n = 0; n < 5; n++) await new Promise(resolve => setImmediate(resolve));
};

describe("#75's follow-ups (part 2)", () => {
  it("P5a: B's open doesn't hide that A still can't open NewTabNoteTrust", async () => {
    const profile = trustProfile();
    const clock = manualClock();
    const ra = await recordsOn(createTrustDatabase({ indexedDB: brokenFactory }), profile, { clock, prefix: 'aaaa' });
    assert.equal(ra.result.ok, false);
    const up = databaseOn(profile);
    opened.push(up);
    clock.advance(10);
    const rb = await recordsOn(up, profile, { clock, prefix: 'bbbb' });
    // B's open resolves A's earlier sighting; A, still unable to open, writes again
    assert.equal((await storedAt(up, OPEN_FAILED))?.state, 'resolved');
    clock.advance(1000);
    assert.equal((await ra.records.append(event(1))).recorded, false);
    assert.equal((await at(rb.records, OPEN_FAILED))?.state, 'open');
    assert.equal((await summaryOf(rb.records, clock)).route, 'recovery');
  });

  it("P5b: B's reconnect doesn't resolve an open failure A sighted after B first opened", async () => {
    const profile = trustProfile();
    const clock = manualClock();
    const db = databaseOn(profile);
    opened.push(db);
    let closeNext = false;
    /** @type {TrustStore} */
    const store = {
      open: () => db.open(),
      close: () => db.close(),
      run: (stores, mode, unit) => {
        if (closeNext) {
          closeNext = false;
          return Promise.reject(new UnavailableError('storage', 'database-closed', true));
        }
        return db.run(stores, mode, unit);
      },
    };
    const rb = await recordsOn(store, profile, { clock, prefix: 'bbbb' });
    clock.advance(1000);
    await recordsOn(createTrustDatabase({ indexedDB: brokenFactory }), profile, { clock, prefix: 'aaaa' });
    clock.advance(1000);
    closeNext = true;
    await rb.records.append(event(1));
    clock.advance(10);
    await rb.records.append(event(2));
    assert.equal((await storedAt(db, OPEN_FAILED))?.state, 'open', "B's reconnect resolved A's later open failure");
  });

  it('P1a: an open that stays pending past the retry window holds open-failed', async () => {
    const profile = trustProfile();
    const clock = manualClock();
    const store = createTrustDatabase({ indexedDB: stuckFactory, keyRange: fakeKeyRange, openWithinMs: 20 });
    const ra = await recordsOn(store, profile, { clock, prefix: 'aaaa' });
    assert.equal(ra.result.ok, false);
    assert.equal(/** @type {any} */ (ra.result).code, 'open-pending');
    for (let n = 0; n < 4; n++) {
      clock.advance(60_000);
      await ra.records.append(event(n));
    }
    const held = await at(ra.records, OPEN_FAILED);
    assert.ok(held, 'four minutes of open-pending never became open-failed');
    assert.equal(held.state, 'open');
    assert.deepEqual(held.evidence, { errorCode: 'open-pending' });
  });

  it("P1b: a pending open in A doesn't hold B's writes behind the copy lock", async () => {
    const profile = trustProfile();
    const clock = manualClock();
    const WITHIN = 100;
    const stuck = createTrustDatabase({ indexedDB: stuckFactory, keyRange: fakeKeyRange, openWithinMs: WITHIN });
    const ra = await recordsOn(stuck, profile, { clock, prefix: 'aaaa' });
    const up = databaseOn(profile);
    opened.push(up);
    const rb = await recordsOn(up, profile, { clock, prefix: 'bbbb' });
    // Past the short retry after an open-pending answer, so A's writes ask the adapter again
    clock.advance(60_000);
    const writes = [1, 2, 3, 4, 5].map(n => ra.records.append(event(n)));
    await new Promise(resolve => setImmediate(resolve));
    const started = Date.now();
    await rb.records.append(event(9));
    const waited = Date.now() - started;
    await Promise.all(writes);
    assert.ok(waited < WITHIN, `B waited ${waited} ms behind A's pending open`);
  });

  it("P3: the summary goes by its own read of the copy, not a concurrent write's", async () => {
    const profile = trustProfile();
    const clock = manualClock();
    const a = flaky(profile);
    const ra = await recordsOn(a.store, profile, { clock, prefix: 'aaaa' });
    const up = databaseOn(profile);
    opened.push(up);
    const rb = await recordsOn(up, profile, { clock, prefix: 'bbbb' });
    const providers = [provider('capture', () => ({ status: 'verified', capture: 'safe' }), { core: true })];
    const { trust } = await useCases(rb.records, clock, providers);
    await trust.verify({ type: 'trust.verify', commandId: 'c1', trigger: 'verify-now' });
    clock.advance(10);
    a.failNext(5);
    await ra.records.raise(CAP);
    assert.ok(profile.settings.items.get(KEY));
    // The summary's copy read fails; a write's read, issued meanwhile, answers
    const realGet = profile.settings.get;
    /** @type {{res: (value: any) => void, rej: (error: unknown) => void, real: () => Promise<any>}[]} */
    const gates = [];
    profile.settings.get = keys =>
      new Promise((res, rej) => {
        gates.push({ res, rej, real: () => realGet(keys) });
      });
    const summarized = trust.summary();
    for (let n = 0; n < 50 && gates.length < 1; n++) await new Promise(resolve => setImmediate(resolve));
    const written = rb.records.append(event(1));
    for (let n = 0; n < 50 && gates.length < 2; n++) await new Promise(resolve => setImmediate(resolve));
    assert.equal(gates.length, 2);
    const answer = await gates[1].real();
    profile.settings.get = realGet;
    gates[0].rej(new Error('settings read failed'));
    gates[1].res(answer);
    const summary = /** @type {any} */ (await summarized).data;
    await written;
    assert.notEqual(summary.capture, 'safe', 'capture safe while A holds capture-risk');
    assert.ok(summary.actionRequired >= 1);
    assert.equal(summary.route, 'recovery');
  });

  it('P3b: trust.report and recovery.incidents say when the copy went unread', async () => {
    const profile = trustProfile();
    const db = databaseOn(profile);
    opened.push(db);
    const { records, clock } = await recordsOn(db, profile);
    const { trust } = await useCases(records, clock);
    const read = /** @type {any} */ (await trust.report()).data;
    assert.equal(read.copyRead, true);
    profile.settings.failGets = 1;
    assert.equal(/** @type {any} */ (await trust.report()).data.copyRead, false);
    profile.settings.failGets = 1;
    assert.equal(/** @type {any} */ (await trust.incidents()).data.copyRead, false);
    assert.equal(/** @type {any} */ (await trust.incidents()).data.copyRead, true);
  });

  it('P4a: a memory remainder replayed after a clock step back reopens what it counts', async () => {
    const profile = trustProfile();
    const clock = manualClock();
    const a = flaky(profile);
    const ra = await recordsOn(a.store, profile, { clock, prefix: 'aaaa' });
    const up = databaseOn(profile);
    opened.push(up);
    const rb = await recordsOn(up, profile, { clock, prefix: 'bbbb' });
    a.failNext(5);
    await ra.records.append(event(0));
    await rb.records.append(event(0));
    clock.advance(10_000);
    await rb.records.resolve('storage', []);
    assert.equal((await storedAt(up, WRITE_FAILED))?.state, 'resolved');
    // The clock steps back; A fails a write and its copy set fails too: memory only
    clock.advance(-60_000);
    a.failNext(5);
    profile.settings.failSets = 10;
    assert.equal((await ra.records.append(event(1))).recorded, false);
    profile.settings.failSets = 0;
    a.failNext(0);
    await ra.records.append(event(2));
    assert.equal(
      (await storedAt(up, WRITE_FAILED))?.state,
      'open',
      'a failed write replayed from memory stayed resolved',
    );
  });

  it('P4b: a later failing write undismisses write-failed after a clock step back', async () => {
    const profile = trustProfile();
    const clock = manualClock();
    const up = databaseOn(profile);
    opened.push(up);
    const rb = await recordsOn(up, profile, { clock, prefix: 'bbbb' });
    const fa = flaky(profile);
    const ra = await recordsOn(fa.store, profile, { clock, prefix: 'aaaa' });
    fa.failNext(1000);
    await ra.records.append(event(0));
    await rb.records.append(event(0));
    const incident = await storedAt(up, WRITE_FAILED);
    clock.advance(10_000);
    await rb.records.dismiss(incident.id, true);
    clock.advance(-60_000);
    await ra.records.append(event(1));
    assert.equal((await at(rb.records, WRITE_FAILED))?.dismissed, false);
    assert.ok((await summaryOf(rb.records, clock)).actionRequired >= 1);
  });

  it('N6: an incident event whose append fails while its raise lands still counts the failed write', async () => {
    const profile = trustProfile();
    const clock = manualClock();
    const database = databaseOn(profile);
    opened.push(database);
    let failAppend = false;
    /** @type {TrustStore} */
    const store = {
      open: () => database.open(),
      close: () => database.close(),
      // Only the event's own append fails: a write to the journal alone
      run: (stores, mode, unit) => {
        if (failAppend && mode === 'readwrite' && stores.length === 1 && stores[0] === 'journal') {
          failAppend = false;
          return Promise.reject(new UnavailableError('storage', 'unreadable', false));
        }
        return database.run(stores, mode, unit);
      },
    };
    const { records } = await recordsOn(store, profile, { clock });
    const journal = createDiagnosticJournal({ records, clock, strict: true });
    failAppend = true;
    journal.event('capture.failed', { errorCode: 'quota' });
    await journal.flush();
    await records.append(event(0));
    assert.equal((await storedAt(database, 'capture/capture-failed/-'))?.occurrences, 1);
    assert.equal((await storedAt(database, WRITE_FAILED))?.occurrences, 1, 'the failed append was counted nowhere');
  });

  it('nit 7: an install id read that never settles answers within the bound', async () => {
    const profile = trustProfile();
    const db = databaseOn(profile);
    opened.push(db);
    const timers = manualTimers();
    const { records } = await recordsOn(db, profile, { timers });
    profile.settings.get = () => new Promise(() => {});
    const answered = records.installId().then(
      () => 'answered',
      () => 'refused',
    );
    for (let n = 0; n < 20 && timers.pending.size === 0; n++) await new Promise(resolve => setImmediate(resolve));
    timers.fireAll();
    const raced = await Promise.race([answered, new Promise(resolve => setTimeout(() => resolve('hung'), 200))]);
    assert.notEqual(raced, 'hung');
  });
});

describe('a check resolves what it observes (6b)', () => {
  it('the health family refuses a provider without observes, or with a fault that is not registered', () => {
    const root = createRegistryRoot({ host: 'workspace' });
    const base = provider('credentials', () => ({ status: 'verified' }));
    root.register(health, [
      { ...base, id: 'credentials', rank: 1, observes: undefined },
      { ...base, id: 'permissions', rank: 2, observes: ['made-up'] },
      { ...base, id: 'sync', rank: 3, observes: ['conflict', 'conflict'] },
      { ...base, id: 'backup', rank: 4, observes: ['stale-backup'] },
      { ...base, id: 'index', rank: 5, observes: [] },
    ]);
    const states = Object.fromEntries(root.resolve().contributions.map(item => [item.id, item.state]));
    assert.deepEqual(states, {
      credentials: 'unresolved',
      permissions: 'unresolved',
      sync: 'unresolved',
      backup: 'enabled',
      index: 'enabled',
    });
  });

  it('a not-configured check resolves the faults it looked at and no longer reports, and leaves the rest', async () => {
    const profile = trustProfile();
    const db = databaseOn(profile);
    opened.push(db);
    const { records, clock } = await recordsOn(db, profile);
    let answer = /** @type {unknown} */ ({
      status: 'degraded',
      faults: [{ faultCode: 'legacy-secret', severity: 'degraded' }],
    });
    const providers = [provider('credentials', () => answer, { observes: ['legacy-secret'] })];
    const { trust } = await useCases(records, clock, providers);
    await trust.verify({ type: 'trust.verify', commandId: 'c1', trigger: 'verify-now' });
    // A failure event this check can't observe
    await records.raise({ providerId: 'credentials', faultCode: 'load-failed', severity: 'degraded' });
    assert.equal((await at(records, 'credentials/legacy-secret/-'))?.state, 'open');
    // The user clears the key: the check answers not-configured, never verified, having looked
    clock.advance(1000);
    answer = { status: 'not-configured', looked: [{ faultCode: 'legacy-secret' }] };
    const outcome = await trust.verify({ type: 'trust.verify', commandId: 'c2', trigger: 'verify-now' });
    assert.equal(outcome.kind, 'committed');
    assert.equal((await at(records, 'credentials/legacy-secret/-'))?.state, 'resolved');
    assert.equal(
      (await at(records, 'credentials/load-failed/-'))?.state,
      'open',
      'resolved a fault the check cannot observe',
    );
  });

  it("a verified check leaves a fault it doesn't observe open", async () => {
    const profile = trustProfile();
    const db = databaseOn(profile);
    opened.push(db);
    const { records, clock } = await recordsOn(db, profile);
    const providers = [
      provider('index', () => ({ status: 'verified', looked: [{ faultCode: 'lagging' }, { faultCode: 'stalled' }] }), {
        observes: ['lagging', 'stalled'],
      }),
    ];
    const { trust } = await useCases(records, clock, providers);
    await records.raise({ providerId: 'index', faultCode: 'indexer-start-failed', severity: 'degraded' });
    await records.raise({ providerId: 'index', faultCode: 'lagging', severity: 'degraded' });
    clock.advance(1000);
    await trust.verify({ type: 'trust.verify', commandId: 'c1', trigger: 'verify-now' });
    assert.equal((await at(records, 'index/lagging/-'))?.state, 'resolved');
    assert.equal((await at(records, 'index/indexer-start-failed/-'))?.state, 'open');
  });

  for (const status of ['not-configured', 'unverified', 'degraded', 'failed']) {
    it(`a check that answers ${status} still resolves the faults it looked at and no longer reports`, async () => {
      const profile = trustProfile();
      const db = databaseOn(profile);
      opened.push(db);
      const { records, clock } = await recordsOn(db, profile);
      const providers = [
        provider('sync', () => ({ status, looked: [{ faultCode: 'conflict' }] }), {
          observes: ['conflict', 'stale-backup'],
        }),
      ];
      const { trust } = await useCases(records, clock, providers);
      await records.raise({ providerId: 'sync', faultCode: 'conflict', severity: 'data-risk' });
      clock.advance(1000);
      await trust.verify({ type: 'trust.verify', commandId: 'c1', trigger: 'verify-now' });
      assert.equal((await at(records, 'sync/conflict/-'))?.state, 'resolved');
    });
  }

  it("#78's recovery readiness: degraded, then unverified once the point is discarded, resolves point-unverified", async () => {
    const profile = trustProfile();
    const db = databaseOn(profile);
    opened.push(db);
    const { records, clock } = await recordsOn(db, profile);
    let answer = /** @type {unknown} */ ({
      status: 'degraded',
      faults: [{ faultCode: 'point-unverified', severity: 'data-risk' }],
    });
    const providers = [provider('recovery-readiness', () => answer, { observes: ['point-unverified'] })];
    const { trust } = await useCases(records, clock, providers);
    await trust.verify({ type: 'trust.verify', commandId: 'c1', trigger: 'verify-now' });
    assert.equal((await at(records, 'recovery-readiness/point-unverified/-'))?.state, 'open');
    clock.advance(1000);
    // The point is gone, and the check looked: there's nothing left to verify
    answer = { status: 'unverified', looked: [{ faultCode: 'point-unverified' }] };
    await trust.verify({ type: 'trust.verify', commandId: 'c2', trigger: 'verify-now' });
    assert.equal((await at(records, 'recovery-readiness/point-unverified/-'))?.state, 'resolved');
  });

  it("#78's local inference: a status-only reporter leaves 1b's load-failed open; a check that looked resolves it", async () => {
    const profile = trustProfile();
    const db = databaseOn(profile);
    opened.push(db);
    const { records, clock } = await recordsOn(db, profile);
    const journal = createDiagnosticJournal({ records, clock, strict: true });
    journal.event('embeddings.load-failed', { errorCode: 'quota' });
    await journal.flush();
    assert.equal((await at(records, 'local-inference/load-failed/-'))?.state, 'open');
    clock.advance(1000);
    // #80's review (R6e): reading its own incident and answering by status alone isn't looking
    const statusOnly = await useCases(records, clock, [
      provider(
        'local-inference',
        async () => {
          const failing = (await records.incidents()).some(
            incident => incident.faultCode === 'load-failed' && incident.state !== 'resolved',
          );
          return failing ? { status: 'action-required' } : { status: 'not-configured' };
        },
        { observes: ['load-failed'] },
      ),
    ]);
    await statusOnly.trust.verify({ type: 'trust.verify', commandId: 'c1', trigger: 'verify-now' });
    assert.equal(
      (await at(records, 'local-inference/load-failed/-'))?.state,
      'open',
      'a status-only reporter resolved its own incident',
    );
    clock.advance(1000);
    const looking = await useCases(records, clock, [
      provider('local-inference', () => ({ status: 'verified', looked: [{ faultCode: 'load-failed' }] }), {
        observes: ['load-failed'],
      }),
    ]);
    await looking.trust.verify({ type: 'trust.verify', commandId: 'c2', trigger: 'verify-now' });
    assert.equal((await at(records, 'local-inference/load-failed/-'))?.state, 'resolved');
  });

  it('a check that times out or throws resolves nothing', async () => {
    const profile = trustProfile();
    const db = databaseOn(profile);
    opened.push(db);
    const { records, clock } = await recordsOn(db, profile);
    const providers = [
      provider(
        'index',
        () => {
          throw new Error('broke');
        },
        { observes: ['lagging'] },
      ),
    ];
    const { trust } = await useCases(records, clock, providers);
    await records.raise({ providerId: 'index', faultCode: 'lagging', severity: 'degraded' });
    clock.advance(1000);
    await trust.verify({ type: 'trust.verify', commandId: 'c1', trigger: 'verify-now' });
    await settle();
    assert.equal((await at(records, 'index/lagging/-'))?.state, 'open');
  });
});

describe("#80's review round", () => {
  it("R6a: a check whose read failed answers unverified, and doesn't resolve what it couldn't look at", async () => {
    const profile = trustProfile();
    const db = databaseOn(profile);
    opened.push(db);
    const { records, clock } = await recordsOn(db, profile);
    let portFails = false;
    const check = async () =>
      portFails
        ? { status: 'unverified', evidence: { errorCode: 'unreadable' } }
        : {
            status: 'action-required',
            faults: [{ faultCode: 'legacy-secret', severity: 'data-risk' }],
            looked: [{ faultCode: 'legacy-secret' }],
          };
    const { trust } = await useCases(records, clock, [provider('credentials', check, { observes: ['legacy-secret'] })]);
    await trust.verify({ type: 'trust.verify', commandId: 'c1', trigger: 'verify-now' });
    assert.equal((await at(records, 'credentials/legacy-secret/-'))?.state, 'open');
    clock.advance(1000);
    portFails = true;
    await trust.verify({ type: 'trust.verify', commandId: 'c2', trigger: 'verify-now' });
    assert.equal(
      (await at(records, 'credentials/legacy-secret/-'))?.state,
      'open',
      'a check that could not look resolved it',
    );
  });

  it('looked is per subject: a check that looked at one subject resolves only that one', async () => {
    const profile = trustProfile();
    const db = databaseOn(profile);
    opened.push(db);
    const { records, clock } = await recordsOn(db, profile);
    await records.raise({
      providerId: 'credentials',
      faultCode: 'legacy-secret',
      subjectId: 'settings',
      severity: 'data-risk',
    });
    await records.raise({
      providerId: 'credentials',
      faultCode: 'legacy-secret',
      subjectId: 'canvases',
      severity: 'data-risk',
    });
    clock.advance(1000);
    const providers = [
      provider(
        'credentials',
        () => ({ status: 'verified', looked: [{ faultCode: 'legacy-secret', subjectId: 'settings' }] }),
        {
          observes: ['legacy-secret'],
        },
      ),
    ];
    const { trust } = await useCases(records, clock, providers);
    await trust.verify({ type: 'trust.verify', commandId: 'c1', trigger: 'verify-now' });
    assert.equal((await at(records, 'credentials/legacy-secret/settings'))?.state, 'resolved');
    assert.equal((await at(records, 'credentials/legacy-secret/canvases'))?.state, 'open');
  });

  it('R6b: a check resolves only sightings from before it started', async () => {
    const profile = trustProfile();
    const db = databaseOn(profile);
    opened.push(db);
    const { records, clock } = await recordsOn(db, profile);
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
      return { status: 'verified', looked: [{ faultCode: 'load-failed' }] };
    };
    const { trust, journal } = await useCases(records, clock, [
      provider('local-inference', check, { observes: ['load-failed'] }),
    ]);
    const verifying = trust.verify({ type: 'trust.verify', commandId: 'c1', trigger: 'verify-now' });
    await startedNow;
    clock.advance(100);
    journal.event('embeddings.load-failed', { errorCode: 'quota' });
    await journal.flush();
    clock.advance(100);
    release();
    await verifying;
    assert.equal(
      (await at(records, 'local-inference/load-failed/-'))?.state,
      'open',
      'resolved a sighting from while it ran',
    );
  });

  it('R6d: observes refuses write-failed, and allows open-failed, whose NewTabNoteTrust subject no check resolves', () => {
    const root = createRegistryRoot({ host: 'workspace' });
    const base = provider('storage', () => ({ status: 'verified' }), { group: 'storage' });
    root.register(health, [
      { ...base, id: 'storage', rank: 1, observes: ['open-failed'] },
      { ...base, id: 'capture', rank: 2, observes: ['write-failed'] },
      { ...base, id: 'backup', rank: 3, observes: ['quota'] },
    ]);
    const states = Object.fromEntries(root.resolve().contributions.map(item => [item.id, item.state]));
    assert.deepEqual(states, { storage: 'enabled', capture: 'unresolved', backup: 'enabled' });
  });

  it("R6d: a storage check in B that looked at open-failed, for every subject or by name, leaves A's NewTabNoteTrust sighting open", async () => {
    const profile = trustProfile();
    const clock = manualClock();
    const ra = await recordsOn(createTrustDatabase({ indexedDB: brokenFactory }), profile, { clock, prefix: 'aaaa' });
    const db = databaseOn(profile);
    opened.push(db);
    clock.advance(10);
    const rb = await recordsOn(db, profile, { clock, prefix: 'bbbb' });
    clock.advance(1000);
    await ra.records.append(event(1));
    await rb.records.append(event(1));
    assert.equal((await storedAt(db, OPEN_FAILED))?.state, 'open');
    clock.advance(1000);
    for (const looked of [
      [{ faultCode: 'open-failed' }],
      [{ faultCode: 'open-failed', subjectId: 'NewTabNoteTrust' }],
    ]) {
      const { trust } = await useCases(rb.records, clock, [
        provider('storage', () => ({ status: 'verified', looked }), { group: 'storage', observes: ['open-failed'] }),
      ]);
      await trust.verify({ type: 'trust.verify', commandId: 'c1', trigger: 'verify-now' });
      assert.equal((await storedAt(db, OPEN_FAILED))?.state, 'open', JSON.stringify(looked));
    }
    const summary = await summaryOf(rb.records, clock);
    assert.equal(summary.route, 'recovery');
  });

  it('nit 9: a result that looked at a fault outside observes is answered as outside the schema', async () => {
    const profile = trustProfile();
    const db = databaseOn(profile);
    opened.push(db);
    const { records, clock } = await recordsOn(db, profile);
    await records.raise({ providerId: 'index', faultCode: 'lagging', severity: 'degraded' });
    clock.advance(1000);
    const providers = [
      provider('index', () => ({ status: 'verified', looked: [{ faultCode: 'lagging' }, { faultCode: 'stalled' }] }), {
        observes: ['lagging'],
      }),
    ];
    const { trust } = await useCases(records, clock, providers);
    await trust.verify({ type: 'trust.verify', commandId: 'c1', trigger: 'verify-now' });
    assert.equal((await at(records, 'index/lagging/-'))?.state, 'open');
    const [receipt] = await records.latestReceipts();
    assert.deepEqual([receipt.status, receipt.evidence.errorCode], ['unverified', 'invalid-check-result']);
    assert.ok((await records.events()).some(item => item.code === 'trust.check-failed'));
  });

  it('nit 9: a result that reports a fault outside observes is answered as outside the schema', async () => {
    const profile = trustProfile();
    const db = databaseOn(profile);
    opened.push(db);
    const { records, clock } = await recordsOn(db, profile);
    const providers = [
      provider('index', () => ({ status: 'degraded', faults: [{ faultCode: 'stalled', severity: 'degraded' }] }), {
        observes: ['lagging'],
      }),
    ];
    const { trust } = await useCases(records, clock, providers);
    await trust.verify({ type: 'trust.verify', commandId: 'c1', trigger: 'verify-now' });
    const [receipt] = await records.latestReceipts();
    assert.deepEqual([receipt.status, receipt.evidence.errorCode], ['unverified', 'invalid-check-result']);
    assert.equal(await at(records, 'index/stalled/-'), undefined);
  });

  it('I-a: a summary whose store read fails says nothing is safe', async () => {
    const profile = trustProfile();
    const clock = manualClock();
    const db = databaseOn(profile);
    opened.push(db);
    const f = flakyStore(db);
    const rb = await recordsOn(f.store, profile, { clock, prefix: 'bbbb' });
    const providers = [provider('capture', () => ({ status: 'verified', capture: 'safe' }), { core: true })];
    const { trust } = await useCases(rb.records, clock, providers);
    await trust.verify({ type: 'trust.verify', commandId: 'c1', trigger: 'verify-now' });
    await rb.records.raise(CAP);
    assert.equal(/** @type {any} */ (await trust.summary()).data.capture, 'at-risk');
    // The receipts read answers, the incidents read doesn't
    f.failNext(1, 'retries-exhausted', { after: 1 });
    const summary = /** @type {any} */ (await trust.summary()).data;
    assert.equal(rb.records.state(), 'open');
    assert.notEqual(summary.capture, 'safe');
    assert.ok(summary.actionRequired >= 1);
    assert.equal(summary.route, 'recovery');
  });

  it('I-a: trust.report and recovery.incidents say when the store read failed', async () => {
    const profile = trustProfile();
    const db = databaseOn(profile);
    opened.push(db);
    const f = flakyStore(db);
    const { records, clock } = await recordsOn(f.store, profile);
    const { trust } = await useCases(records, clock);
    assert.equal(/** @type {any} */ (await trust.report()).data.recordsRead, true);
    // trust.report reads receipts, runs, then incidents
    f.failNext(1, 'retries-exhausted', { after: 2 });
    assert.equal(/** @type {any} */ (await trust.report()).data.recordsRead, false);
    f.failNext(1, 'retries-exhausted');
    assert.equal(/** @type {any} */ (await trust.incidents()).data.recordsRead, false);
  });

  it('R1a: a context that recovers from a failed reconnect resolves its own open-failed', async () => {
    const profile = trustProfile();
    const clock = manualClock();
    const db = databaseOn(profile);
    opened.push(db);
    let open = 'ok';
    let closeNext = 0;
    /** @type {TrustStore} */
    const store = {
      open: () => (open === 'ok' ? db.open() : Promise.reject(new UnavailableError('storage', 'open-failed', true))),
      close: () => db.close(),
      run: (stores, mode, unit) => {
        if (closeNext > 0) {
          closeNext--;
          return Promise.reject(new UnavailableError('storage', 'database-closed', true));
        }
        if (open !== 'ok') return Promise.reject(new UnavailableError('storage', 'database-closed', true));
        return db.run(stores, mode, unit);
      },
    };
    const rb = await recordsOn(store, profile, { clock, prefix: 'bbbb' });
    clock.advance(1000);
    closeNext = 1;
    open = 'fail';
    assert.equal((await rb.records.append(event(1))).recorded, false);
    clock.advance(31_000);
    open = 'ok';
    assert.equal((await rb.records.append(event(2))).recorded, true);
    clock.advance(1000);
    await rb.records.append(event(3));
    assert.equal((await storedAt(db, OPEN_FAILED))?.state, 'resolved');
  });

  it('nit 8: the diagnostics preview says when the incidents it holds may be incomplete', async () => {
    const profile = trustProfile();
    const db = databaseOn(profile);
    opened.push(db);
    const { records, clock } = await recordsOn(db, profile);
    const { trust } = await useCases(records, clock);
    const healthy = /** @type {any} */ (await trust.exportDiagnostics());
    assert.ok(!healthy.notices.includes('incidents-incomplete'));
    // Only the settings copy's read fails
    const get = profile.settings.get;
    profile.settings.get = async keys => {
      if (keys.includes(KEY)) throw new Error('settings read failed');
      return get(keys);
    };
    const exported = /** @type {any} */ (await trust.exportDiagnostics());
    profile.settings.get = get;
    assert.ok(exported.notices.includes('incidents-incomplete'), JSON.stringify(exported.notices));
  });
});

describe("1b's failure incidents under observes and looked (#81)", () => {
  const SITES = [
    ['capture.failed', 'capture', 'capture-failed'],
    ['embeddings.load-failed', 'local-inference', 'load-failed'],
    ['backup.auto-failed', 'backup', 'auto-backup-failed'],
    ['indexer.start-failed', 'index', 'indexer-start-failed'],
  ];
  for (const [code, providerId, faultCode] of SITES) {
    it(`${code}'s incident stays open for a check that didn't look, and resolves for one that did`, async () => {
      const profile = trustProfile();
      const db = databaseOn(profile);
      opened.push(db);
      const { records, clock } = await recordsOn(db, profile);
      const journal = createDiagnosticJournal({ records, clock, strict: true });
      journal.event(code, { errorCode: 'quota' });
      await journal.flush();
      const key = `${providerId}/${faultCode}/-`;
      assert.equal((await at(records, key))?.state, 'open');
      clock.advance(1000);
      const blind = await useCases(records, clock, [
        provider(providerId, () => ({ status: 'verified' }), { observes: [faultCode] }),
      ]);
      await blind.trust.verify({ type: 'trust.verify', commandId: 'c1', trigger: 'verify-now' });
      assert.equal((await at(records, key))?.state, 'open');
      clock.advance(1000);
      const looking = await useCases(records, clock, [
        provider(providerId, () => ({ status: 'verified', looked: [{ faultCode }] }), { observes: [faultCode] }),
      ]);
      await looking.trust.verify({ type: 'trust.verify', commandId: 'c2', trigger: 'verify-now' });
      assert.equal((await at(records, key))?.state, 'resolved');
    });
  }

  it("storage.open-failed's CanvasTabDB incident resolves for a check that looked at it, and only sightings from before it started", async () => {
    const profile = trustProfile();
    const db = databaseOn(profile);
    opened.push(db);
    const { records, clock } = await recordsOn(db, profile);
    const journal = createDiagnosticJournal({ records, clock, strict: true });
    journal.event('storage.open-failed', { errorCode: 'quota', subjectId: 'CanvasTabDB' });
    await journal.flush();
    clock.advance(1000);
    // A probe that opened CanvasTabDB, during which the site fails again
    let during = false;
    const check = async () => {
      if (during) {
        clock.advance(100);
        journal.event('storage.open-failed', { errorCode: 'quota', subjectId: 'CanvasTabDB' });
        await journal.flush();
        clock.advance(100);
      }
      return { status: 'verified', looked: [{ faultCode: 'open-failed', subjectId: 'CanvasTabDB' }] };
    };
    const { trust } = await useCases(records, clock, [
      provider('storage', check, { group: 'storage', observes: ['open-failed'] }),
    ]);
    during = true;
    await trust.verify({ type: 'trust.verify', commandId: 'c1', trigger: 'verify-now' });
    assert.equal(
      (await at(records, 'storage/open-failed/CanvasTabDB'))?.state,
      'open',
      'resolved a sighting from while it ran',
    );
    clock.advance(1000);
    during = false;
    await trust.verify({ type: 'trust.verify', commandId: 'c2', trigger: 'verify-now' });
    assert.equal((await at(records, 'storage/open-failed/CanvasTabDB'))?.state, 'resolved');
  });
});
