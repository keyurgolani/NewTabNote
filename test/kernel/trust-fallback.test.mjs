// #20 slice 1's fallback (AC2): with IndexedDB down, the latest storage incident goes to
// memory and chrome.storage.local's `trust.lastStorageIncident` through the injected settings
// port, and the next open reconciles it into NewTabNoteTrust once, whichever context opens it.
// Any context can raise one, the service worker's included, since the records take only
// ports. And `trust.installId` is written once.

import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { createTrustDatabase } from '../../js/kernel/adapters/indexeddb/trust.js';
import { createMemoryTrustStore } from '../../js/trust/core/memory-store.js';
import { createTrustRecords } from '../../js/trust/core/trust-records.js';
import { UnavailableError } from '../../js/kernel/core/contracts/outcomes.js';
import { brokenFactory, databaseOn, hexIds, manualClock, openRecords, trustProfile } from './trust-support.mjs';

/** @typedef {import('../../js/trust/core/ports.js').TrustStore} TrustStore */

/** @type {TrustStore[]} */
const opened = [];
after(() => opened.forEach(store => store.close()));

const KEY = 'trust.lastStorageIncident';

describe('the trust records fallback (#20 slice 1, AC2)', () => {
  it('holds the latest storage incident in memory and the settings area while IndexedDB is down', async () => {
    const profile = trustProfile();
    const down = createTrustDatabase({ indexedDB: brokenFactory });
    const { records, clock, opened: result } = await openRecords(down, profile);
    assert.deepEqual(result, { ok: false, code: 'open-failed' });
    assert.equal(records.state(), 'fallback');

    const first = await records.raise({ providerId: 'storage', faultCode: 'open-failed', severity: 'capture-risk' });
    assert.equal(first.held, true);
    clock.advance(5);
    await records.raise({ providerId: 'storage', faultCode: 'open-failed', severity: 'capture-risk' });
    clock.advance(5);
    await records.raise({ providerId: 'capture', faultCode: 'capture-failed', severity: 'capture-risk' });
    // Not a storage incident: memory only
    await records.raise({ providerId: 'index', faultCode: 'lagging', severity: 'degraded' });

    const held = /** @type {any} */ (profile.settings.items.get(KEY));
    assert.deepEqual(
      held.ops.map((/** @type {any} */ op) => op.key),
      ['storage/open-failed/-', 'storage/open-failed/-', 'capture/capture-failed/-'],
      'the copy keeps the storage sightings, in order',
    );
    assert.ok(
      profile.settings.sets.every(set => Object.keys(set).every(key => key === KEY || key === 'trust.installId')),
    );
    const inMemory = await records.incidents();
    assert.deepEqual(inMemory.map(incident => incident.key).sort(), [
      'capture/capture-failed/-',
      'index/lagging/-',
      'storage/open-failed/-',
    ]);
    assert.equal(inMemory.find(incident => incident.providerId === 'storage')?.occurrences, 2);
    // The fallback journals itself, by code
    assert.deepEqual(
      (await records.events()).map(event => [event.code, event.fields]),
      [['trust.storage-fallback', { cause: 'storage', errorCode: 'open-failed' }]],
    );
  });

  it('a later context reads the held incident back while IndexedDB stays down', async () => {
    const profile = trustProfile();
    const first = await openRecords(createTrustDatabase({ indexedDB: brokenFactory }), profile);
    await first.records.raise({ providerId: 'storage', faultCode: 'open-failed', severity: 'capture-risk' });
    // The service worker, say, starting later in the same profile
    const second = await openRecords(
      createMemoryTrustStore({ openError: new UnavailableError('storage', 'open-failed', true) }),
      profile,
    );
    assert.deepEqual(
      (await second.records.incidents()).map(incident => incident.key),
      ['storage/open-failed/-'],
    );
  });

  it("the next open replays the held sightings into NewTabNoteTrust once, even when it can't trim the copy after", async () => {
    const profile = trustProfile();
    const clock = manualClock();
    const down = createTrustRecords({
      store: createTrustDatabase({ indexedDB: brokenFactory }),
      settings: profile.settings,
      clock,
      ids: hexIds('dead'),
      locks: profile.locks,
    });
    await down.open();
    await down.raise({
      providerId: 'storage',
      faultCode: 'open-failed',
      severity: 'capture-risk',
      evidence: { exception: 'UnknownError' },
    });
    clock.advance(10);
    await down.raise({ providerId: 'storage', faultCode: 'open-failed', severity: 'capture-risk' });

    // The first open replays both, but can't trim the copy, which keeps them
    profile.settings.failSets = 1;
    const store = databaseOn(profile);
    opened.push(store);
    const first = await openRecords(store, profile, { clock });
    assert.equal(first.opened.ok, true);
    const [incident] = await first.records.incidents();
    assert.equal(incident.key, 'storage/open-failed/-');
    assert.equal(incident.occurrences, 2);
    assert.equal(incident.id.startsWith('dead'), true, 'the held incident keeps its id and ref');
    assert.equal(/** @type {any} */ (profile.settings.items.get(KEY)).ops.length, 2);
    assert.deepEqual(
      (await first.records.events()).map(event => event.code),
      ['trust.reconciled'],
    );

    // The next open replays them again, which adds nothing, and trims the copy
    const store2 = databaseOn(profile);
    opened.push(store2);
    const up = await openRecords(store2, profile, { clock });
    assert.equal((await up.records.incidents())[0].occurrences, 2);
    assert.equal(profile.settings.items.get(KEY), null);

    // Opening again adds nothing
    const store3 = databaseOn(profile);
    opened.push(store3);
    const again = await openRecords(store3, profile, { clock });
    const after = await again.records.incidents();
    assert.equal(after.length, 1);
    assert.equal(after[0].occurrences, 2);
  });

  it('reconciling merges with an incident the database already had', async () => {
    const profile = trustProfile();
    const clock = manualClock();
    const store = databaseOn(profile);
    opened.push(store);
    const before = await openRecords(store, profile, { clock });
    await before.records.raise({ providerId: 'storage', faultCode: 'open-failed', severity: 'degraded' });
    clock.advance(100);
    const down = await openRecords(createTrustDatabase({ indexedDB: brokenFactory }), profile, { clock });
    await down.records.raise({ providerId: 'storage', faultCode: 'open-failed', severity: 'capture-risk' });
    clock.advance(100);
    const store2 = databaseOn(profile);
    opened.push(store2);
    const up = await openRecords(store2, profile, { clock });
    const all = await up.records.incidents();
    assert.equal(all.length, 1);
    assert.equal(all[0].occurrences, 2);
    assert.equal(all[0].severity, 'capture-risk');
    assert.equal(all[0].lastSeenAt, clock.now() - 100);
  });

  it('a context whose writes start failing falls back, and a later open reconciles', async () => {
    const profile = trustProfile();
    const store = databaseOn(profile);
    opened.push(store);
    const { records } = await openRecords(store, profile);
    store.close();
    const raised = await records.raise({
      providerId: 'capture',
      faultCode: 'capture-failed',
      severity: 'capture-risk',
    });
    assert.equal(raised.held, true);
    assert.equal(records.failureCode(), 'reload-required');
    const store2 = databaseOn(profile);
    opened.push(store2);
    const next = await openRecords(store2, profile);
    assert.deepEqual(
      (await next.records.incidents()).map(incident => incident.key),
      ['capture/capture-failed/-'],
    );
  });

  it('memory keeps a bounded number of incidents and events', async () => {
    const profile = trustProfile();
    const { records, clock } = await openRecords(createTrustDatabase({ indexedDB: brokenFactory }), profile);
    for (let n = 0; n < 250; n++) {
      await records.raise({
        providerId: 'index',
        faultCode: 'lagging',
        subjectId: `${1730000000000 + n}-${n.toString(36).padStart(9, '0')}`,
        severity: 'degraded',
      });
    }
    for (let n = 0; n < 250; n++)
      await records.append({ at: clock.now(), code: 'trust.reconciled', fields: { count: n } });
    assert.equal((await records.incidents()).length, 200);
    assert.equal(records.dropped().incidents, 50);
    assert.equal((await records.events()).length, 200);
  });
});

describe('trust.installId (#20, "Records")', () => {
  it('is written once, and every context of a profile stamps receipts with it', async () => {
    const profile = trustProfile();
    const a = await openRecords(createMemoryTrustStore(), profile, { ids: hexIds('aaaa') });
    const b = await openRecords(createMemoryTrustStore(), profile, { ids: hexIds('bbbb') });
    const [first, second] = await Promise.all([a.records.installId(), b.records.installId()]);
    assert.equal(first, second);
    assert.equal(profile.settings.sets.filter(set => 'trust.installId' in set).length, 1);
    assert.equal(await a.records.installId(), first);
    const receipt = await b.records.record({
      providerId: 'storage',
      status: 'verified',
      verifiedAt: 1,
      durationMs: 1,
      freshnessMs: 1000,
      operation: 'storage.probe-readwrite',
      evidence: {},
      consequenceKey: null,
      preserved: [],
      nextAction: null,
    });
    assert.equal(receipt.installId, first);
  });
});
