// The trust store suite (#20 slice 1, AC2): every bound the scope sets, and a repeat that
// updates one incident, through the production records layer (trust-records.js) on a trust
// store. trust-store.test.mjs runs it on the memory store and on NewTabNoteTrust over
// fake-indexeddb, and conformance-inventory.mjs binds both to it.

import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { BOUNDS } from '../../js/trust/core/records.js';
import { openRecords, trustProfile } from './trust-support.mjs';

/** @typedef {import('./trust-support.mjs').TrustProfile} TrustProfile */
/** @typedef {import('../../js/trust/core/ports.js').TrustStore} TrustStore */
/** @typedef {import('../../js/trust/core/records.js').RemediationRun} RemediationRun */

const DAY = 24 * 60 * 60 * 1000;

/**
 * A record id in the shape Utils.generateId makes, numbered
 * @param {number} n
 * @param {string} [tag]
 */
const legacyId = (n, tag = 'a') => `${1730000000000 + n}-${(tag + n.toString(36)).padStart(9, '0').slice(-9)}`;

/** @type {TrustStore[]} */
const opened = [];
after(() => opened.forEach(store => store.close()));

/**
 * @param {(profile: TrustProfile) => TrustStore} make
 */
async function fresh(make) {
  const profile = trustProfile();
  const store = make(profile);
  opened.push(store);
  return { profile, store, ...(await openRecords(store, profile)) };
}

/**
 * A receipt input for `providerId` with `status`, verified at `at`
 * @param {string} providerId
 * @param {import('../../js/trust/core/vocabulary.js').ReceiptStatus} status
 * @param {number} at
 */
const receipt = (providerId, status, at) => ({
  providerId,
  status,
  verifiedAt: at,
  durationMs: 3,
  freshnessMs: DAY,
  operation: 'storage.probe-readwrite',
  evidence: { durationMs: 3 },
  consequenceKey: null,
  preserved: [],
  nextAction: null,
});

/**
 * @param {string} id
 * @param {RemediationRun['state']} state
 * @param {number} at
 * @returns {RemediationRun}
 */
const run = (id, state, at) => ({
  id,
  commandId: 'retry-open',
  incidentId: null,
  state,
  outcome: state === 'succeeded' ? 'verified' : null,
  startedAt: at,
  updatedAt: at,
});

/**
 * Runs the suite on the trust store `make` opens in a fresh profile
 * @param {string} name
 * @param {{make: (profile: TrustProfile) => TrustStore}} options
 */
export function describeTrustStore(name, { make }) {
  describe(`trust records on ${name} (#20 slice 1, AC2)`, () => {
    it('a repeat of one provider, fault, and subject updates one incident', async () => {
      const { records, clock } = await fresh(make);
      const first = await records.raise({ providerId: 'storage', faultCode: 'open-failed', severity: 'degraded' });
      assert.equal(first.created, true);
      assert.equal(first.held, false);
      await records.dismiss(first.incident.id, true);
      clock.advance(1000);
      const second = await records.raise({ providerId: 'storage', faultCode: 'open-failed', severity: 'data-risk' });
      assert.equal(second.created, false);
      assert.equal(second.incident.id, first.incident.id);
      const all = await records.incidents();
      assert.equal(all.length, 1);
      const [incident] = all;
      assert.equal(incident.occurrences, 2);
      assert.equal(incident.firstSeenAt + 1000, incident.lastSeenAt);
      // The worse severity, and the next failure clears dismissal
      assert.equal(incident.severity, 'data-risk');
      assert.equal(incident.dismissed, false);
      assert.equal(incident.key, 'storage/open-failed/-');
      assert.equal(incident.ref, incident.id.slice(0, 6).toUpperCase());
      // Another subject is another incident
      await records.raise({
        providerId: 'storage',
        faultCode: 'open-failed',
        subjectId: 'canvases',
        severity: 'degraded',
      });
      assert.equal((await records.incidents()).length, 2);
    });

    it('a resolved incident that comes back reopens the same record', async () => {
      const { records, clock } = await fresh(make);
      const { incident } = await records.raise({ providerId: 'index', faultCode: 'lagging', severity: 'degraded' });
      clock.advance(10);
      const [resolved] = await records.resolve('index', []);
      assert.equal(resolved.state, 'resolved');
      assert.equal(resolved.resolvedAt, clock.now());
      clock.advance(10);
      const again = await records.raise({ providerId: 'index', faultCode: 'lagging', severity: 'degraded' });
      assert.equal(again.incident.id, incident.id);
      assert.equal(again.incident.state, 'open');
      assert.equal(again.incident.resolvedAt, null);
      assert.equal(again.incident.occurrences, 2);
    });

    it('resolving keeps the faults a check still reports, and leaves other providers alone', async () => {
      const { records } = await fresh(make);
      await records.raise({ providerId: 'index', faultCode: 'lagging', severity: 'degraded' });
      await records.raise({ providerId: 'index', faultCode: 'stalled', severity: 'degraded' });
      await records.raise({ providerId: 'storage', faultCode: 'open-failed', severity: 'degraded' });
      const done = await records.resolve('index', ['index/stalled/-']);
      assert.deepEqual(
        done.map(incident => incident.key),
        ['index/lagging/-'],
      );
      const states = Object.fromEntries((await records.incidents()).map(incident => [incident.key, incident.state]));
      assert.deepEqual(states, {
        'index/lagging/-': 'resolved',
        'index/stalled/-': 'open',
        'storage/open-failed/-': 'open',
      });
    });

    it('open incidents, dismissed included, always stay; resolved ones keep 200 at most', async () => {
      const { records, clock } = await fresh(make);
      for (let n = 0; n < BOUNDS.resolvedIncidents + 5; n++) {
        await records.raise({
          providerId: 'index',
          faultCode: 'lagging',
          subjectId: legacyId(n, 'r'),
          severity: 'degraded',
        });
        clock.advance(1);
        await records.resolve('index', []);
      }
      for (let n = 0; n < 3; n++) {
        const { incident } = await records.raise({
          providerId: 'sync',
          faultCode: 'conflict',
          subjectId: legacyId(n, 'o'),
          severity: 'data-risk',
        });
        if (n === 0) await records.dismiss(incident.id, true);
      }
      const all = await records.incidents();
      const resolved = all.filter(incident => incident.state === 'resolved');
      assert.equal(resolved.length, BOUNDS.resolvedIncidents);
      // The newest resolved ones stay
      assert.ok(
        !resolved.some(incident =>
          [0, 1, 2, 3, 4].map(n => legacyId(n, 'r')).includes(/** @type {string} */ (incident.subjectId)),
        ),
      );
      const open = all.filter(incident => incident.state === 'open');
      assert.equal(open.length, 3);
      assert.equal(open.filter(incident => incident.dismissed).length, 1);
    });

    it('resolved incidents older than 90 days go, and open ones of any age stay', async () => {
      const { records, clock } = await fresh(make);
      await records.raise({ providerId: 'sync', faultCode: 'conflict', severity: 'data-risk' });
      await records.raise({ providerId: 'index', faultCode: 'lagging', severity: 'degraded' });
      await records.resolve('index', []);
      clock.advance(BOUNDS.resolvedIncidentAgeMs + 1);
      // Any write to incidents applies the bound
      await records.raise({ providerId: 'backup', faultCode: 'stale-backup', severity: 'data-risk' });
      const keys = (await records.incidents()).map(incident => incident.key).sort();
      assert.deepEqual(keys, ['backup/stale-backup/-', 'sync/conflict/-']);
    });

    it('receipts keep the latest per provider and its 20 newest transitions', async () => {
      const { records, clock } = await fresh(make);
      // 30 changes of status, each followed by a repeat of it, then 5 repeats of the last
      const statuses = /** @type {const} */ (['verified', 'degraded']);
      for (let n = 0; n < 30; n++) {
        const status = statuses[n % 2];
        await records.record(receipt('storage', status, clock.now()));
        clock.advance(1);
        await records.record(receipt('storage', status, clock.now()));
        clock.advance(1);
      }
      for (let n = 0; n < 5; n++) {
        await records.record(receipt('storage', 'degraded', clock.now()));
        clock.advance(1);
      }
      await records.record(receipt('index', 'unverified', clock.now()));
      const stored = await records.receipts();
      const storage = stored.filter(item => item.providerId === 'storage');
      const transitions = storage.filter(item => item.transition);
      assert.equal(transitions.length, BOUNDS.receiptTransitions);
      assert.equal(storage.length, BOUNDS.receiptTransitions + 1);
      // The latest is the last repeat, and every transition alternates
      const latest = storage[storage.length - 1];
      assert.equal(latest.transition, false);
      assert.equal(latest.verifiedAt, clock.now() - 1);
      assert.ok(transitions.every((item, index) => index === 0 || item.status !== transitions[index - 1].status));
      assert.deepEqual((await records.latestReceipts()).map(item => [item.providerId, item.status]).sort(), [
        ['index', 'unverified'],
        ['storage', 'degraded'],
      ]);
      assert.ok(stored.every(item => item.installId === stored[0].installId));
    });

    it('runs keep the newest 200, and any still running', async () => {
      const RUNNING = legacyId(9999, 'running');
      const { records, clock } = await fresh(make);
      await records.putRun(run(RUNNING, 'running', clock.now()));
      clock.advance(1);
      for (let n = 0; n < BOUNDS.runs + 9; n++) {
        await records.putRun(run(legacyId(n, 'run'), n % 2 ? 'succeeded' : 'failed', clock.now()));
        clock.advance(1);
      }
      const runs = await records.runs();
      assert.equal(runs.length, BOUNDS.runs);
      assert.ok(runs.some(item => item.id === RUNNING));
      assert.ok(!runs.some(item => item.id === legacyId(9, 'run')));
      assert.ok(runs.some(item => item.id === legacyId(10, 'run')));
      // A run's next state replaces it
      await records.putRun({ ...run(RUNNING, 'succeeded', clock.now()), startedAt: runs[0].startedAt });
      assert.equal((await records.runs()).find(item => item.id === RUNNING)?.state, 'succeeded');
    });

    it('the journal keeps 2,000 events, none older than 14 days', async () => {
      const { records, clock } = await fresh(make);
      await records.append({ at: clock.now(), code: 'trust.reconciled', fields: { count: 0 } });
      clock.advance(BOUNDS.journalAgeMs + 1);
      await records.append({ at: clock.now(), code: 'trust.reconciled', fields: { count: 1 } });
      let events = await records.events();
      assert.deepEqual(
        events.map(event => event.fields.count),
        [1],
      );
      for (let n = 2; n < BOUNDS.journalEvents + 6; n++) {
        await records.append({ at: clock.now(), code: 'trust.reconciled', fields: { count: n } });
      }
      events = await records.events();
      assert.equal(events.length, BOUNDS.journalEvents);
      assert.equal(events[0].fields.count, 6);
      assert.equal(events[events.length - 1].fields.count, BOUNDS.journalEvents + 5);
      assert.ok(events.every((event, index) => index === 0 || event.seq > events[index - 1].seq));
    });

    it('refuses a record outside its schema, and stores nothing of it', async () => {
      const { records } = await fresh(make);
      await assert.rejects(
        records.raise({
          providerId: 'storage',
          faultCode: 'open-failed',
          severity: 'degraded',
          evidence: { message: 'a sentence' },
        }),
        TypeError,
      );
      await assert.rejects(records.append({ at: 1, code: 'Not A Code', fields: {} }));
      await assert.rejects(records.record({ ...receipt('storage', 'verified', 1), evidence: { url: 'x' } }));
      assert.deepEqual(await records.incidents(), []);
      assert.deepEqual(await records.events(), []);
      assert.deepEqual(await records.receipts(), []);
    });
  });
}
