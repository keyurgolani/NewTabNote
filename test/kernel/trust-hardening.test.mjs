// #68's review round (#20 slice 1a): each finding as the probe that showed it, so each fails
// on the PR head it was found on (9eb6705) and passes once fixed. The numbers are the review's.

import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { createTrustDatabase } from '../../js/kernel/adapters/indexeddb/trust.js';
import { createRegistryRoot } from '../../js/kernel/registry/root.js';
import { createRuntime } from '../../js/kernel/registry/runtime.js';
import { exceptionOf } from '../../js/trust/core/checks.js';
import { checkEvidence } from '../../js/trust/core/evidence.js';
import { health } from '../../js/trust/core/families.js';
import { createDiagnosticJournal } from '../../js/trust/core/journal.js';
import { createMemoryTrustStore } from '../../js/trust/core/memory-store.js';
import { BOUNDS } from '../../js/trust/core/records.js';
import { createTrustRecords } from '../../js/trust/core/trust-records.js';
import { createTrustUseCases } from '../../js/trust/core/use-cases.js';
import {
  brokenFactory,
  databaseOn,
  flakyStore,
  hexIds,
  lockManager,
  manualClock,
  realTimers,
  settingsArea,
  trustProfile,
} from './trust-support.mjs';

/** @typedef {import('../../js/trust/core/ports.js').TrustStore} TrustStore */

/** @type {TrustStore[]} */
const opened = [];
after(() => opened.forEach(store => store.close()));

const KEY = 'trust.lastStorageIncident';
const VERSIONS = Object.freeze({ extension: '1.4.1', browser: null, canvasSchema: 8, trustSchema: 1 });
const SUBJECT = '1730000000000-k3j2h1g0f';

/**
 * Records over `store`, sharing `profile`'s settings and locks
 * @param {TrustStore} store
 * @param {ReturnType<typeof trustProfile>} profile
 * @param {{clock?: ReturnType<typeof manualClock>, prefix?: string, locks?: boolean}} [options]
 */
async function recordsOn(store, profile, { clock = manualClock(), prefix = 'a1b2', locks = true } = {}) {
  const records = createTrustRecords({
    store,
    settings: profile.settings,
    clock,
    ids: hexIds(prefix),
    locks: locks ? profile.locks : null,
  });
  const result = await records.open();
  return { records, clock, result };
}

/**
 * @param {ReturnType<typeof createTrustRecords>} records
 * @param {ReturnType<typeof manualClock>} clock
 * @param {{strict?: boolean}} [options]
 */
function useCases(records, clock, { strict = true } = {}) {
  const journal = createDiagnosticJournal({ records, clock, strict });
  const root = createRegistryRoot({ host: 'workspace' });
  root.register(health, []);
  const resolution = root.resolve();
  return {
    journal,
    trust: createTrustUseCases({
      records,
      journal,
      clock,
      timers: realTimers,
      registry: { resolution, runtime: createRuntime(resolution) },
      versions: VERSIONS,
    }),
  };
}

describe("#68's review round", () => {
  it('1 (blocking): one failed write leaves every read on the store, with the failure shown', async () => {
    const profile = trustProfile();
    const database = databaseOn(profile);
    opened.push(database);
    const flaky = flakyStore(database);
    const { records, clock } = await recordsOn(flaky.store, profile);
    await records.raise({ providerId: 'storage', faultCode: 'scan-findings', severity: 'data-risk' });
    flaky.failNext(1, 'retries-exhausted');
    await records.append({ at: clock.now(), code: 'trust.reconciled', fields: { count: 0 } });
    assert.equal(records.state(), 'fallback');
    const incidents = await records.incidents();
    assert.deepEqual(
      incidents.map(incident => incident.key).sort(),
      ['storage/scan-findings/-', 'storage/write-failed/-'],
      'the open incident in NewTabNoteTrust disappeared from reads',
    );
    const { trust } = useCases(records, clock);
    const summary = /** @type {any} */ (await trust.summary()).data;
    assert.equal(summary.actionRequired, 2);
    // The event that failed isn't held, and the next write that succeeds stores the failure
    assert.deepEqual(await records.events(), []);
    await records.raise({ providerId: 'index', faultCode: 'lagging', severity: 'degraded' });
    assert.equal(records.state(), 'open');
    const stored = await database.run(['incidents'], 'readonly', tx => tx.getAll('incidents'));
    assert.ok(
      stored.some(incident => incident.key === 'storage/write-failed/-'),
      'the failed write was never counted',
    );
  });

  it('2: credentials, titles, and hosts fit no evidence field, and no exception name is copied unless it is a known one', () => {
    for (const fields of [
      { subjectId: 'sk-CaNaRy-9xQ2Lp7Zt' },
      { subjectId: 'canary.example.test' },
      { exception: 'AKIAIOSFODNN7EXAMPLE' },
      { exception: 'CaNaRyError' },
      { errorCode: 'my-divorce-plans' },
      { faultCode: 'my-divorce-plans' },
      { reason: 'my-divorce-plans' },
    ]) {
      assert.equal(checkEvidence(fields).ok, false, JSON.stringify(fields));
    }
    assert.equal(exceptionOf({ name: 'AKIAIOSFODNN7EXAMPLE' }), null);
    assert.equal(exceptionOf({ name: 'QuotaExceededError' }), 'QuotaExceededError');
    assert.equal(checkEvidence({ subjectId: SUBJECT, exception: 'TypeError', errorCode: 'quota' }).ok, true);
  });

  it("3: reconciling clears the settings copy only if it's still the one it reconciled", async () => {
    const profile = trustProfile();
    const clock = manualClock();
    const a = await recordsOn(createTrustDatabase({ indexedDB: brokenFactory }), profile, { clock, prefix: 'aaaa' });
    await a.records.raise({ providerId: 'storage', faultCode: 'open-failed', severity: 'capture-risk' });
    clock.advance(10);
    // While B reads the copy to reconcile it, A raises a newer storage incident
    /** @type {Promise<unknown> | null} */
    let raisedMeanwhile = null;
    const get = profile.settings.get;
    profile.settings.get = async keys => {
      const found = await get(keys);
      if (keys.includes(KEY) && !raisedMeanwhile) {
        raisedMeanwhile = a.records.raise({
          providerId: 'capture',
          faultCode: 'capture-failed',
          severity: 'capture-risk',
        });
      }
      return found;
    };
    const database = databaseOn(profile);
    opened.push(database);
    await recordsOn(database, profile, { clock, prefix: 'bbbb' });
    await raisedMeanwhile;
    profile.settings.get = get;
    const database2 = databaseOn(profile);
    opened.push(database2);
    const c = await recordsOn(database2, profile, { clock, prefix: 'cccc' });
    assert.deepEqual((await c.records.incidents()).map(incident => incident.key).sort(), [
      'capture/capture-failed/-',
      'storage/open-failed/-',
      // A's failed open() holds NewTabNoteTrust's own incident (round 4)
      'storage/open-failed/NewTabNoteTrust',
      'storage/write-failed/-',
    ]);
  });

  it('4: memory holds only storage incidents, so nothing else can be dropped from it: other failed writes are counted', async () => {
    const profile = trustProfile();
    const { records } = await recordsOn(createTrustDatabase({ indexedDB: brokenFactory }), profile);
    const runIds = hexIds('ffff');
    for (let n = 0; n < 60; n++) {
      const answer = await records.putRun({
        id: runIds.next(),
        commandId: 'retry-open',
        incidentId: null,
        state: 'failed',
        outcome: 'retries-exhausted',
        startedAt: n + 1,
        updatedAt: n + 1,
      });
      assert.equal(answer.recorded, false);
    }
    assert.deepEqual(await records.runs(), []);
    assert.deepEqual(
      (await records.incidents()).map(incident => [incident.key, incident.occurrences]),
      [
        ['storage/open-failed/NewTabNoteTrust', 1],
        ['storage/write-failed/-', 60],
      ],
    );
  });

  it('5: refused events are counted in memory, and never crowd real events out of the journal', async () => {
    const profile = trustProfile();
    const database = databaseOn(profile);
    opened.push(database);
    const { records, clock } = await recordsOn(database, profile);
    const journal = createDiagnosticJournal({ records, clock });
    journal.event('capture.failed', { surface: 'worker-internal', errorCode: 'quota' });
    for (let n = 0; n < BOUNDS.journalEvents + 5; n++) journal.event('note.saved', {});
    await journal.flush();
    const events = await records.events();
    assert.ok(
      events.some(event => event.code === 'capture.failed'),
      'refusals evicted a real event',
    );
    assert.ok(events.filter(event => event.code === 'diagnostics.rejected').length <= 2);
    assert.equal(journal.rejected()['unregistered-code'], BOUNDS.journalEvents + 5);
  });

  it('6: a held copy updated after another context reconciled it counts each occurrence once', async () => {
    const profile = trustProfile();
    const clock = manualClock();
    const a = await recordsOn(createTrustDatabase({ indexedDB: brokenFactory }), profile, { clock, prefix: 'aaaa' });
    await a.records.raise({ providerId: 'storage', faultCode: 'open-failed', severity: 'capture-risk' });
    clock.advance(10);
    const b = databaseOn(profile);
    opened.push(b);
    await recordsOn(b, profile, { clock, prefix: 'bbbb' });
    clock.advance(10);
    await a.records.raise({ providerId: 'storage', faultCode: 'open-failed', severity: 'capture-risk' });
    clock.advance(10);
    const c = databaseOn(profile);
    opened.push(c);
    const { records } = await recordsOn(c, profile, { clock, prefix: 'cccc' });
    const incident = (await records.incidents()).find(item => item.key === 'storage/open-failed/-');
    assert.equal(incident?.occurrences, 2);
  });

  it('7: any provider, fault, and subject the records accept make a valid incident key', async () => {
    const profile = trustProfile();
    const { records } = await recordsOn(createMemoryTrustStore(), profile);
    for (const providerId of [`p${'x'.repeat(63)}`, `p${'x'.repeat(127)}`]) {
      for (const subjectId of ['00000000-0000-4000-8000-000000000000', `s${'x'.repeat(127)}`]) {
        await records.raise({ providerId, faultCode: 'scan-findings', subjectId, severity: 'degraded' }).then(
          ({ incident }) => assert.equal(incident?.providerId, providerId),
          error => {
            // Refused for an input it names, never for the key the inputs made
            assert.ok(error instanceof TypeError);
            assert.match(String(error.message), /providerId|subjectId/);
          },
        );
      }
    }
  });

  it('8: events past 14 days and resolved incidents past 90 days go after a quiet spell, with no write first', async () => {
    const profile = trustProfile();
    const { records, clock } = await recordsOn(createMemoryTrustStore(), profile);
    await records.append({ at: clock.now(), code: 'trust.reconciled', fields: { count: 0 } });
    await records.raise({ providerId: 'index', faultCode: 'lagging', severity: 'degraded' });
    await records.resolve('index', []);
    // The resolution is ordered after the sighting it follows, a millisecond on
    clock.advance(BOUNDS.resolvedIncidentAgeMs + 2);
    assert.deepEqual(await records.events(), []);
    assert.deepEqual(await records.incidents(), []);
  });

  it('9: a reconcile that runs twice after a transient abort counts once, and leaves a remediating incident remediating', async () => {
    const profile = trustProfile();
    const clock = manualClock();
    const down = await recordsOn(createTrustDatabase({ indexedDB: brokenFactory }), profile, { clock, prefix: 'aaaa' });
    await down.records.raise({ providerId: 'storage', faultCode: 'open-failed', severity: 'capture-risk' });
    const database = databaseOn(profile);
    opened.push(database);
    const aborted = profile.faults.abortAfterNextWrite('incidents', 'UnknownError');
    const up = await recordsOn(database, profile, { clock, prefix: 'bbbb' });
    await aborted;
    const reconciled = (await up.records.events()).filter(event => event.code === 'trust.reconciled');
    // The held open-failed incident, the failed write, and the failed open() (round 4), once each
    assert.deepEqual(
      reconciled.map(event => event.fields.count),
      [3],
    );
    // An incident a remediation is working on stays remediating when a held copy reconciles
    const incident = /** @type {import('../../js/trust/core/records.js').Incident} */ (
      (await up.records.incidents()).find(item => item.key === 'storage/open-failed/-')
    );
    await database.run(['incidents'], 'readwrite', async tx =>
      tx.put('incidents', { ...incident, state: 'remediating' }),
    );
    clock.advance(10);
    await down.records.raise({ providerId: 'storage', faultCode: 'open-failed', severity: 'capture-risk' });
    const database2 = databaseOn(profile);
    opened.push(database2);
    const again = await recordsOn(database2, profile, { clock, prefix: 'cccc' });
    const remediated = (await again.records.incidents()).find(item => item.key === 'storage/open-failed/-');
    assert.equal(remediated?.state, 'remediating');
  });

  it('10: an open that answered open-pending opens once the connection does', async () => {
    const profile = trustProfile();
    const slow = /** @type {IDBFactory} */ (
      /** @type {unknown} */ ({
        open: (/** @type {string} */ name, /** @type {number} */ version) => {
          const request = profile.real.open(name, version);
          return new Proxy(request, {
            set(target, property, value) {
              if (property === 'onsuccess') {
                target.onsuccess = event => setTimeout(() => value.call(target, event), 30);
                return true;
              }
              return Reflect.set(target, property, value);
            },
            get(target, property) {
              const value = Reflect.get(target, property, target);
              return typeof value === 'function' ? value.bind(target) : value;
            },
          });
        },
      })
    );
    const store = createTrustDatabase({ indexedDB: slow, openWithinMs: 5 });
    opened.push(store);
    await assert.rejects(store.open(), { code: 'open-pending' });
    await new Promise(resolve => setTimeout(resolve, 60));
    await store.open();
    assert.equal(await store.run(['incidents'], 'readonly', tx => tx.count('incidents')), 0);
  });

  it('11: recovery.raise says when an incident is only held in memory', async () => {
    const profile = trustProfile();
    const { records, clock } = await recordsOn(createTrustDatabase({ indexedDB: brokenFactory }), profile);
    const { trust } = useCases(records, clock);
    const outcome = await trust.raise({
      type: 'recovery.raise',
      commandId: 'c1',
      providerId: 'storage',
      faultCode: 'open-failed',
      severity: 'capture-risk',
    });
    // Round 4: a held raise answers its own kind, never committed
    assert.equal(outcome.kind, 'held');
    assert.equal(/** @type {any} */ (outcome).code, 'incident-held');
  });

  it('12: the report exports without an install id when chrome.storage.local fails, and says the id is stable', async () => {
    const profile = trustProfile();
    const { records, clock } = await recordsOn(createMemoryTrustStore(), profile);
    const { trust } = useCases(records, clock);
    const exported = /** @type {any} */ (await trust.exportDiagnostics());
    assert.equal(exported.kind, 'diagnostics');
    assert.ok(exported.notices.includes('install-id-stable'));
    const failing = settingsArea();
    failing.failGets = 99;
    const without = createTrustRecords({
      store: createMemoryTrustStore(),
      settings: failing,
      clock,
      ids: hexIds(),
      locks: lockManager(),
    });
    await without.open();
    const exportedWithout = /** @type {any} */ (await useCases(without, clock).trust.exportDiagnostics());
    assert.equal(exportedWithout.kind, 'diagnostics');
    assert.equal(JSON.parse(exportedWithout.serialized).installId, null);
    assert.ok(exportedWithout.notices.includes('install-id-missing'));
  });
});
