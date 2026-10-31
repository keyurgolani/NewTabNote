// #20 slice 1's fallback (AC2): with IndexedDB down, the latest storage incident goes to
// memory and chrome.storage.local's `trust.lastStorageIncident` through the injected settings
// port, every failed write counts in `storage/write-failed`, and the next open reconciles them
// into NewTabNoteTrust once, whichever context opens it. Any context can raise one, the
// service worker's included, since the records take only ports. And `trust.installId` is
// written once.

import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { createTrustDatabase } from '../../js/kernel/adapters/indexeddb/trust.js';
import { createMemoryTrustStore } from '../../js/trust/core/memory-store.js';
import { HELD_KEYS, OPEN_FAILED_KEY, WRITE_FAILED_KEY, createTrustRecords } from '../../js/trust/core/trust-records.js';
import { UnavailableError } from '../../js/kernel/core/contracts/outcomes.js';
import {
  brokenFactory,
  databaseOn,
  hexIds,
  legacyId,
  manualClock,
  openRecords,
  trustProfile,
} from './trust-support.mjs';

/** @typedef {import('../../js/trust/core/ports.js').TrustStore} TrustStore */
/** @typedef {import('../../js/trust/core/records.js').Incident} Incident */

/** @type {TrustStore[]} */
const opened = [];
after(() => opened.forEach(store => store.close()));

const KEY = 'trust.lastStorageIncident';

/**
 * @param {Incident[]} incidents
 * @param {string} key
 */
const at = (incidents, key) => incidents.find(incident => incident.key === key);

describe('the trust records fallback (#20 slice 1, AC2)', () => {
  it('holds the storage incidents in memory and the settings area while IndexedDB is down, and counts every failed write', async () => {
    const profile = trustProfile();
    const down = createTrustDatabase({ indexedDB: brokenFactory });
    const { records, clock, opened: result } = await openRecords(down, profile);
    assert.deepEqual(result, { ok: false, code: 'open-failed' });
    assert.equal(records.state(), 'fallback');

    const first = await records.raise({ providerId: 'storage', faultCode: 'open-failed', severity: 'capture-risk' });
    assert.deepEqual([first.recorded, first.held], [false, true]);
    clock.advance(5);
    await records.raise({ providerId: 'storage', faultCode: 'open-failed', severity: 'capture-risk' });
    clock.advance(5);
    await records.raise({ providerId: 'capture', faultCode: 'capture-failed', severity: 'capture-risk' });
    // Not a storage incident: not held, answered as not recorded, and counted
    const other = await records.raise({ providerId: 'index', faultCode: 'lagging', severity: 'degraded' });
    assert.deepEqual([other.recorded, other.held, other.incident], [false, false, null]);

    const copy = /** @type {any} */ (profile.settings.items.get(KEY));
    // The failed open() holds NewTabNoteTrust's own open-failed incident (round 4)
    assert.deepEqual(copy.entries.map((/** @type {any} */ entry) => [entry.key, entry.count]).sort(), [
      ['capture/capture-failed/-', 1],
      ['storage/open-failed/-', 2],
      [OPEN_FAILED_KEY, 1],
      [WRITE_FAILED_KEY, 4],
    ]);
    assert.ok(
      profile.settings.sets.every(set => Object.keys(set).every(key => key === KEY || key === 'trust.installId')),
    );
    const shown = await records.incidents();
    assert.deepEqual(shown.map(incident => [incident.key, incident.occurrences]).sort(), [
      ['capture/capture-failed/-', 1],
      ['storage/open-failed/-', 2],
      [OPEN_FAILED_KEY, 1],
      [WRITE_FAILED_KEY, 4],
    ]);
    assert.deepEqual(await records.events(), []);
  });

  it('a later context reads the held incidents back while IndexedDB stays down', async () => {
    const profile = trustProfile();
    const first = await openRecords(createTrustDatabase({ indexedDB: brokenFactory }), profile);
    await first.records.raise({ providerId: 'storage', faultCode: 'open-failed', severity: 'capture-risk' });
    // The service worker, say, starting later in the same profile
    const second = await openRecords(
      createMemoryTrustStore({ openError: new UnavailableError('storage', 'open-failed', true) }),
      profile,
    );
    assert.deepEqual((await second.records.incidents()).map(incident => incident.key).sort(), [
      'storage/open-failed/-',
      OPEN_FAILED_KEY,
      WRITE_FAILED_KEY,
    ]);
  });

  it("the next open replays the held incidents into NewTabNoteTrust once, even when it can't trim the copy after", async () => {
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
    const { incident: shown } = await down.raise({
      providerId: 'storage',
      faultCode: 'open-failed',
      severity: 'capture-risk',
      evidence: { exception: 'UnknownError' },
    });
    clock.advance(10);
    await down.raise({ providerId: 'storage', faultCode: 'open-failed', severity: 'capture-risk' });

    // The first open replays them, but can't trim the copy, which keeps them
    profile.settings.failSets = 1;
    const store = databaseOn(profile);
    opened.push(store);
    const first = await openRecords(store, profile, { clock });
    assert.equal(first.opened.ok, true);
    const replayed = at(await first.records.incidents(), 'storage/open-failed/-');
    assert.equal(replayed?.occurrences, 2);
    assert.equal(replayed?.id, shown?.id, 'the held incident keeps the id it was shown with');
    assert.equal(at(await first.records.incidents(), WRITE_FAILED_KEY)?.occurrences, 2);
    assert.equal(/** @type {any} */ (profile.settings.items.get(KEY)).entries.length, 3);
    assert.deepEqual(
      (await first.records.events()).map(event => event.code),
      ['trust.reconciled'],
    );

    // The next open replays them again, which adds nothing, and trims the copy
    const store2 = databaseOn(profile);
    opened.push(store2);
    const up = await openRecords(store2, profile, { clock });
    assert.equal(at(await up.records.incidents(), 'storage/open-failed/-')?.occurrences, 2);
    assert.equal(profile.settings.items.get(KEY), null);
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
    const merged = at(await up.records.incidents(), 'storage/open-failed/-');
    assert.equal(merged?.occurrences, 2);
    assert.equal(merged?.severity, 'capture-risk');
    assert.equal(merged?.lastSeenAt, clock.now() - 100);
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
    assert.deepEqual((await next.records.incidents()).map(incident => incident.key).sort(), [
      'capture/capture-failed/-',
      WRITE_FAILED_KEY,
    ]);
  });

  it('memory holds a bounded set of storage keys, and the write-failed incident counts the rest', async () => {
    const profile = trustProfile();
    const { records } = await openRecords(createTrustDatabase({ indexedDB: brokenFactory }), profile);
    for (let n = 0; n < 20; n++) {
      await records.raise({
        providerId: 'capture',
        faultCode: 'capture-failed',
        subjectId: legacyId(n),
        severity: 'capture-risk',
      });
    }
    const shown = await records.incidents();
    assert.equal(shown.filter(incident => incident.providerId === 'capture').length, HELD_KEYS);
    assert.equal(at(shown, WRITE_FAILED_KEY)?.occurrences, 20);
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
    const stored = await b.records.record({
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
    assert.equal(stored.recorded && stored.receipt.installId, first);
  });
});
