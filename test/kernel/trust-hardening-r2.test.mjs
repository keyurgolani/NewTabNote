// #68's second review round (#20 slice 1a): each finding of the delta check on 31a8548 as
// the probe that showed it, so each fails there and passes once fixed. The names are the
// review's (B1, S1 to S6, N1 to N4).

import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

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
  dumpTrustDatabase,
  flakyStore,
  hexIds,
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

/**
 * A legacy record id, as Utils.generateId makes one: a millisecond time, a hyphen, and nine
 * base-36 characters
 * @param {number} n
 */
const legacyId = n => `${1730000000000 + n}-${n.toString(36).padStart(9, '0')}`;

/**
 * Records over `store` in `profile`, opened
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

/**
 * NewTabNoteTrust in `profile`, behind a store whose runs a test can fail
 * @param {Profile} profile
 */
function flakyDatabase(profile) {
  const database = databaseOn(profile);
  opened.push(database);
  return { database, ...flakyStore(database) };
}

/**
 * @param {ReturnType<typeof createTrustRecords>} records
 * @param {ReturnType<typeof manualClock>} clock
 */
async function summaryOf(records, clock) {
  const journal = createDiagnosticJournal({ records, clock, strict: true });
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
  return /** @type {any} */ (await trust.summary()).data;
}

describe("#68's second review round", () => {
  it('B1: a storage incident raised in fallback stays open once a later write succeeds', async () => {
    const profile = trustProfile();
    const { store, failNext } = flakyDatabase(profile);
    const { records, clock } = await recordsOn(store, profile);
    await records.raise({ providerId: 'capture', faultCode: 'capture-failed', severity: 'capture-risk' });
    clock.advance(10);
    await records.resolve('capture', []);
    clock.advance(10);
    failNext(1);
    const held = await records.raise({ providerId: 'capture', faultCode: 'capture-failed', severity: 'capture-risk' });
    assert.equal(held.held, true);
    clock.advance(10);
    await records.append({ at: clock.now(), code: 'trust.reconciled', fields: { count: 0 } });
    const [incident] = await records.incidents();
    assert.equal(incident.state, 'open');
    const summary = await summaryOf(records, clock);
    assert.equal(summary.actionRequired, 1);
    assert.equal(summary.capture, 'at-risk');
    // and a fresh context agrees, counting it once
    const fresh = databaseOn(profile);
    opened.push(fresh);
    const other = await recordsOn(fresh, profile, { clock, prefix: 'bbbb' });
    const [seen] = await other.records.incidents();
    assert.equal(seen.state, 'open');
    assert.equal(seen.occurrences, 2);
  });

  it('S1: each occurrence counts once, before, during, and after reconciling', async () => {
    const profile = trustProfile();
    const { store, failNext } = flakyDatabase(profile);
    const { records, clock } = await recordsOn(store, profile);
    failNext(2);
    await records.raise({ providerId: 'capture', faultCode: 'capture-failed', severity: 'capture-risk' });
    clock.advance(1);
    await records.raise({ providerId: 'capture', faultCode: 'capture-failed', severity: 'capture-risk' });
    assert.equal((await records.incidents())[0].occurrences, 2);
    await records.append({ at: clock.now(), code: 'trust.reconciled', fields: { count: 0 } });
    assert.equal((await records.incidents())[0].occurrences, 2);
    const fresh = databaseOn(profile);
    opened.push(fresh);
    const other = await recordsOn(fresh, profile, { clock, prefix: 'bbbb' });
    assert.equal((await other.records.incidents())[0].occurrences, 2);
  });

  it('S2: a held sighting older than a later resolution only adds an occurrence', async () => {
    const profile = trustProfile();
    const { store, failNext } = flakyDatabase(profile);
    const { records, clock } = await recordsOn(store, profile);
    await records.raise({ providerId: 'index', faultCode: 'lagging', severity: 'degraded' });
    clock.advance(1000);
    failNext(1);
    await records.raise({ providerId: 'index', faultCode: 'lagging', severity: 'degraded' });
    clock.advance(1000);
    await records.resolve('index', []);
    const [incident] = await records.incidents();
    assert.equal(incident.state, 'resolved');
    assert.equal(incident.resolvedAt, clock.now());
    assert.equal(incident.occurrences, 2);
  });

  it('S3: a held dismissal older than a newer sighting is dropped', async () => {
    const profile = trustProfile();
    const clock = manualClock();
    const { store, failNext } = flakyDatabase(profile);
    const a = await recordsOn(store, profile, { clock, prefix: 'aaaa' });
    const { incident } = await a.records.raise({ providerId: 'sync', faultCode: 'conflict', severity: 'data-risk' });
    clock.advance(10);
    failNext(1);
    await a.records.dismiss(incident.id, true);
    clock.advance(10);
    const other = databaseOn(profile);
    opened.push(other);
    const b = await recordsOn(other, profile, { clock, prefix: 'bbbb' });
    await b.records.raise({ providerId: 'sync', faultCode: 'conflict', severity: 'data-risk' });
    clock.advance(10);
    await a.records.append({ at: clock.now(), code: 'trust.reconciled', fields: { count: 0 } });
    const [after] = await a.records.incidents();
    assert.equal(after.occurrences, 2);
    assert.equal(after.dismissed, false);
    assert.equal((await summaryOf(a.records, clock)).actionRequired, 1);
  });

  it('S4: no provider, remediation, subject, or command id holds free text', async () => {
    const profile = trustProfile();
    const database = databaseOn(profile);
    opened.push(database);
    const { records, clock } = await recordsOn(database, profile);
    const journal = createDiagnosticJournal({ records, clock });
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
    const answers = [
      await trust.raise({
        type: 'recovery.raise',
        commandId: 'c1',
        providerId: 'my-divorce-plans',
        faultCode: 'open-failed',
        severity: 'degraded',
      }),
      await trust.raise({
        type: 'recovery.raise',
        commandId: 'c2',
        providerId: 'storage',
        faultCode: 'open-failed',
        severity: 'degraded',
        evidence: { remediationId: 'mail.google.com', providerId: 'canary.example.test' },
      }),
    ];
    assert.deepEqual(
      answers.map(answer => answer.kind),
      ['rejected', 'rejected'],
    );
    assert.equal(journal.event('trust.check-failed', { providerId: 'john.smith.at.example.com' }), false);
    assert.equal(
      journal.event('capture.failed', { subjectId: '1730000000000-hunter2', commandId: '1730000000000-mypassword' }),
      false,
    );
    await assert.rejects(
      records.raise({ providerId: 'my-divorce-plans', faultCode: 'open-failed', severity: 'degraded' }),
      TypeError,
    );
    await journal.flush();
    const dump = await dumpTrustDatabase(profile.real);
    for (const canary of ['divorce', 'mail.google', 'canary.example', 'john.smith', 'hunter2', 'mypassword']) {
      assert.ok(!dump.includes(canary), `NewTabNoteTrust holds "${canary}"`);
    }
  });

  it('S5: a reconcile that fails, or throws, keeps the settings copy, and open() still answers', async () => {
    const profile = trustProfile();
    const clock = manualClock();
    const down = await recordsOn(createTrustDatabase({ indexedDB: brokenFactory }), profile, { clock, prefix: 'aaaa' });
    await down.records.raise({ providerId: 'storage', faultCode: 'quota', severity: 'capture-risk' });
    // The store opens, then its reconcile fails, and the settings area refuses writes too
    const first = flakyDatabase(profile);
    first.failNext(1);
    profile.settings.failSets = 5;
    await recordsOn(first.store, profile, { clock, prefix: 'bbbb' });
    profile.settings.failSets = 0;
    assert.notEqual(profile.settings.items.get('trust.lastStorageIncident'), null);
    // A reconcile that throws something else
    const second = flakyDatabase(profile);
    second.failNext(1, 'unreadable', { typeError: true });
    const { result } = await recordsOn(second.store, profile, { clock, prefix: 'cccc' });
    assert.equal(result.ok, false);
    assert.notEqual(profile.settings.items.get('trust.lastStorageIncident'), null);
    // The next open reconciles it, once
    const third = databaseOn(profile);
    opened.push(third);
    const up = await recordsOn(third, profile, { clock, prefix: 'dddd' });
    const [incident] = await up.records.incidents();
    assert.equal(incident.key, 'storage/quota/-');
    assert.equal(incident.occurrences, 1);
  });

  it('S6: dropping sightings in memory keeps one counting event, and real events stay', async () => {
    const profile = trustProfile();
    const clock = manualClock();
    const { records } = await recordsOn(createTrustDatabase({ indexedDB: brokenFactory }), profile, { clock });
    const journal = createDiagnosticJournal({ records, clock });
    journal.event('capture.failed', { surface: 'worker-internal', errorCode: 'quota' });
    await journal.flush();
    for (let n = 0; n < 260; n++) {
      await records.raise({ providerId: 'index', faultCode: 'lagging', subjectId: legacyId(n), severity: 'degraded' });
      clock.advance(1);
    }
    const events = await records.events();
    assert.ok(
      events.some(event => event.code === 'capture.failed'),
      'dropped sightings pushed a real event out',
    );
    assert.equal(records.dropped().events, 0);
    assert.ok(events.filter(event => event.code === 'trust.fallback-dropped').length <= 1);
    assert.ok(records.dropped().incidents > 0);
  });

  it('N1: a connection Chrome closes opens again on the next write', async () => {
    const profile = trustProfile();
    const database = databaseOn(profile);
    opened.push(database);
    const { records } = await recordsOn(database, profile);
    for (const connection of profile.faults.connections) forceCloseDatabase(connection);
    const raised = await records.raise({ providerId: 'index', faultCode: 'lagging', severity: 'degraded' });
    assert.equal(raised.held, false, 'the records stayed in memory after a closed connection');
  });

  it('N2: a sighting the settings copy still holds is not counted as dropped', async () => {
    const profile = trustProfile();
    const clock = manualClock();
    const { records } = await recordsOn(createTrustDatabase({ indexedDB: brokenFactory }), profile, { clock });
    await records.raise({ providerId: 'storage', faultCode: 'quota', severity: 'capture-risk' });
    clock.advance(1);
    for (let n = 0; n < 200; n++) {
      await records.raise({ providerId: 'index', faultCode: 'lagging', subjectId: legacyId(n), severity: 'degraded' });
      clock.advance(1);
    }
    assert.equal(records.dropped().incidents, 0);
    assert.equal(
      (await records.incidents()).filter(incident => incident.key === 'storage/quota/-').length,
      1,
      'the copy still shows the storage incident',
    );
  });

  it("N4: a held sighting older than the stored one adds an occurrence, and leaves the newer one's fields", async () => {
    const profile = trustProfile();
    const clock = manualClock();
    const { store, failNext } = flakyDatabase(profile);
    const a = await recordsOn(store, profile, { clock, prefix: 'aaaa' });
    await a.records.raise({ providerId: 'index', faultCode: 'lagging', severity: 'degraded', evidence: { lag: 1 } });
    clock.advance(10);
    failNext(1);
    await a.records.raise({ providerId: 'index', faultCode: 'lagging', severity: 'degraded', evidence: { lag: 2 } });
    clock.advance(10);
    const other = databaseOn(profile);
    opened.push(other);
    const b = await recordsOn(other, profile, { clock, prefix: 'bbbb' });
    await b.records.raise({
      providerId: 'index',
      faultCode: 'lagging',
      severity: 'degraded',
      affected: ['search'],
      evidence: { lag: 3 },
    });
    clock.advance(10);
    await a.records.append({ at: clock.now(), code: 'trust.reconciled', fields: { count: 0 } });
    const [incident] = await a.records.incidents();
    assert.equal(incident.occurrences, 3);
    assert.deepEqual(incident.evidence, { lag: 3 });
    assert.deepEqual(incident.affected, ['search']);
    assert.equal(incident.lastSeenAt, clock.now() - 10);
  });
});
