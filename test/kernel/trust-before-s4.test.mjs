// #20's "Before slice 4's first view" follow-ups, part 1: a success at a failure site resolves
// the site's incident, the trust store's own held failures reconcile when the store opens, and
// a database that stays broken journals one storage.open-failed while its incident is open.
// Each test fails on #84's head (72be363).

import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { createTrustDatabase } from '../../js/kernel/adapters/indexeddb/trust.js';
import { createFailureEvents } from '../../js/kernel/composition/trust.js';
import { lazyFailureEvents } from '../../js/kernel/composition/lazy-failure-events.js';
import { EVENT_CODES } from '../../js/trust/core/event-codes.js';
import { createDiagnosticJournal } from '../../js/trust/core/journal.js';
import { SETTINGS_KEYS } from '../../js/trust/core/ports.js';
import { createTrustRecords } from '../../js/trust/core/trust-records.js';
import { brokenFactory, databaseOn, fakeKeyRange, hexIds, manualClock, trustProfile } from './trust-support.mjs';

/** @typedef {import('../../js/trust/core/ports.js').TrustStore} TrustStore */
/** @typedef {ReturnType<typeof trustProfile>} Profile */
/** @typedef {ReturnType<typeof createTrustRecords>} Records */

/** @type {TrustStore[]} */
const opened = [];
after(() => opened.forEach(store => store.close()));

const SITES = /** @type {const} */ ([
  ['indexer.start-failed', 'indexer.started', 'index/indexer-start-failed/-'],
  ['backup.auto-failed', 'backup.auto-succeeded', 'backup/auto-backup-failed/-'],
  ['capture.failed', 'capture.committed', 'capture/capture-failed/-'],
]);

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
 * @param {string} key
 */
const at = async (records, key) => (await records.incidents()).find(incident => incident.key === key);

/** @param {Records} records */
const codes = async records => (await records.events()).map(event => event.code);

describe('a success at a failure site resolves its incident (journal.js, event-codes.js)', () => {
  for (const [failure, success, key] of SITES) {
    it(`${success} resolves ${key}, sighted in any context before it, and journals only when it did`, async () => {
      assert.ok(EVENT_CODES[success], `${success} isn't registered`);
      const profile = trustProfile();
      const clock = manualClock();
      const database = databaseFor(profile);
      const a = await recordsOn(database, profile, { clock, prefix: 'aaaa' });
      const b = await recordsOn(databaseFor(profile), profile, { clock, prefix: 'bbbb' });
      const ja = createDiagnosticJournal({ records: a.records, clock, strict: true });
      const jb = createDiagnosticJournal({ records: b.records, clock, strict: true });
      // Nothing open: the success journals nothing
      jb.event(success, {});
      await jb.flush();
      assert.deepEqual(await codes(b.records), []);
      ja.event(failure, {});
      await ja.flush();
      assert.equal((await at(b.records, key))?.state, 'open');
      clock.advance(1000);
      // Another context's success is evidence: same package, same profile
      jb.event(success, {});
      await jb.flush();
      assert.equal((await at(b.records, key))?.state, 'resolved');
      assert.deepEqual((await codes(b.records)).slice(-1), [success]);
    });
  }

  it('a success leaves open a sighting that came after its snapshot', async () => {
    const profile = trustProfile();
    const clock = manualClock();
    const database = databaseFor(profile);
    const a = await recordsOn(database, profile, { clock, prefix: 'aaaa' });
    const b = await recordsOn(databaseFor(profile), profile, { clock, prefix: 'bbbb' });
    const ja = createDiagnosticJournal({ records: a.records, clock, strict: true });
    ja.event('indexer.start-failed', {});
    await ja.flush();
    clock.advance(1000);
    // A sighting lands between the success's snapshot and its resolve
    const racing = /** @type {Records} */ (
      Object.freeze({
        ...b.records,
        /** @type {Records['resolve']} */
        resolve: async (provider, still, options) => {
          ja.event('indexer.start-failed', {});
          await ja.flush();
          return b.records.resolve(provider, still, options);
        },
      })
    );
    const jb = createDiagnosticJournal({ records: racing, clock, strict: true });
    jb.event('indexer.started', {});
    await jb.flush();
    const incident = await at(b.records, 'index/indexer-start-failed/-');
    assert.deepEqual([incident?.state, incident?.occurrences], ['open', 2]);
  });

  it("a success never resolves another site's incident, or the records' own", async () => {
    const profile = trustProfile();
    const clock = manualClock();
    const { records } = await recordsOn(databaseFor(profile), profile, { clock });
    const journal = createDiagnosticJournal({ records, clock, strict: true });
    journal.event('backup.auto-failed', {});
    journal.event('embeddings.load-failed', {});
    await journal.flush();
    clock.advance(1000);
    journal.event('indexer.started', {});
    journal.event('capture.committed', {});
    await journal.flush();
    assert.equal((await at(records, 'backup/auto-backup-failed/-'))?.state, 'open');
    assert.equal((await at(records, 'local-inference/load-failed/-'))?.state, 'open');
  });
});

describe('a database that stays broken journals one storage.open-failed while its incident is open', () => {
  it('counts every sighting, and journals again once the incident resolved', async () => {
    const profile = trustProfile();
    const clock = manualClock();
    const { records } = await recordsOn(databaseFor(profile), profile, { clock });
    const journal = createDiagnosticJournal({ records, clock, strict: true });
    for (let n = 0; n < 3; n++) {
      journal.event('storage.open-failed', { subjectId: 'CanvasTabDB', errorCode: 'version-too-new' });
      await journal.flush();
      clock.advance(1000);
    }
    assert.deepEqual(await codes(records), ['storage.open-failed']);
    assert.equal((await at(records, 'storage/open-failed/CanvasTabDB'))?.occurrences, 3);
    await records.resolve('storage', []);
    clock.advance(1000);
    journal.event('storage.open-failed', { subjectId: 'CanvasTabDB', errorCode: 'version-too-new' });
    await journal.flush();
    assert.deepEqual(await codes(records), ['storage.open-failed', 'storage.open-failed']);
  });
});

/** A page's or the worker's trust host over `profile`, counting the IndexedDB opens it makes */
function hostOf(/** @type {Profile} */ profile, /** @type {IDBFactory} */ indexedDB = profile.real) {
  const counted = { opens: 0 };
  const factory = /** @type {IDBFactory} */ (
    /** @type {unknown} */ ({
      open: (/** @type {string} */ name, /** @type {number} */ version) => {
        counted.opens++;
        return indexedDB.open(name, version);
      },
    })
  );
  const host = () => ({
    indexedDB: factory,
    keyRange: fakeKeyRange,
    settings: profile.settings,
    locks: profile.locks,
    clock: { now: () => Date.now() },
    ids: { next: () => crypto.randomUUID() },
  });
  return { host, counted };
}

describe('failure events at a success (js/kernel/composition/trust.js)', () => {
  it('opens nothing for a success while no failure at its site is marked open', async () => {
    const profile = trustProfile();
    const { host, counted } = hostOf(profile);
    const events = createFailureEvents({ surface: 'newtab', host });
    events.event('indexer.started', {});
    await events.flush();
    assert.equal(counted.opens, 0);
  });

  it('marks a failure at a site, and a success there resolves it and clears the mark', async () => {
    const profile = trustProfile();
    const { host } = hostOf(profile);
    const failing = createFailureEvents({ surface: 'newtab', host });
    failing.event('indexer.start-failed', {}, new DOMException('m', 'SecurityError'));
    await failing.flush();
    assert.deepEqual(profile.settings.items.get(SETTINGS_KEYS.openSites), ['indexer.start-failed']);
    // Another tab's indexer starts
    const other = createFailureEvents({ surface: 'newtab', host });
    other.event('indexer.started', {});
    await other.flush();
    assert.deepEqual(profile.settings.items.get(SETTINGS_KEYS.openSites), []);
    const store = databaseFor(profile);
    const { records } = await recordsOn(store, profile, { prefix: 'cccc' });
    assert.equal((await at(records, 'index/indexer-start-failed/-'))?.state, 'resolved');
  });

  it("reconciles the trust store's held failures when the copy holds any, and opens nothing when it doesn't", async () => {
    const profile = trustProfile();
    const clean = hostOf(profile);
    const idle = createFailureEvents({ surface: 'worker-internal', host: clean.host });
    await idle.reconcile();
    assert.equal(clean.counted.opens, 0);
    // A context whose NewTabNoteTrust wouldn't open held its own incidents in the copy
    const clock = manualClock(Date.now() - 60_000);
    const down = await recordsOn(createTrustDatabase({ indexedDB: brokenFactory }), profile, { clock, prefix: 'aaaa' });
    await down.records.append({ at: 0, code: 'trust.reconciled', fields: { count: 0 } });
    assert.ok(profile.settings.items.get(SETTINGS_KEYS.lastStorageIncident));
    // A later worker start, with the store working, reconciles them without any failure
    const { host, counted } = hostOf(profile);
    const worker = createFailureEvents({ surface: 'worker-internal', host });
    await worker.reconcile();
    assert.ok(counted.opens >= 1);
    assert.equal(profile.settings.items.get(SETTINGS_KEYS.lastStorageIncident), null);
    const { records } = await recordsOn(databaseFor(profile), profile, { prefix: 'cccc' });
    // NewTabNoteTrust opened, so its open-failed resolves; the dead context's write-failed stays
    assert.equal((await at(records, 'storage/open-failed/NewTabNoteTrust'))?.state, 'resolved');
    assert.equal((await at(records, 'storage/write-failed/-'))?.state, 'open');
  });
});

describe('the new tab at a success (js/kernel/composition/lazy-failure-events.js)', () => {
  /**
   * @param {Map<string, unknown>} items
   */
  const lazyOver = items => {
    let loads = 0;
    /** @type {string[]} */
    const heard = [];
    const events = lazyFailureEvents({
      surface: 'newtab',
      read: async keys => Object.fromEntries(keys.filter(key => items.has(key)).map(key => [key, items.get(key)])),
      load: async () => {
        loads++;
        return {
          createFailureEvents: () => ({
            event: (/** @type {string} */ code) => {
              heard.push(code);
            },
            flush: async () => {},
            reconcile: async () => {
              heard.push('reconcile');
            },
            rejected: async () => null,
          }),
        };
      },
    });
    return { events, heard, loads: () => loads };
  };

  it("loads no trust code for a success while its site isn't marked, or a reconcile with an empty copy", async () => {
    const page = lazyOver(new Map());
    page.events.event('indexer.started', {});
    page.events.event('backup.auto-succeeded', {});
    await page.events.reconcile();
    await page.events.flush();
    assert.equal(page.loads(), 0);
    assert.deepEqual(page.heard, []);
  });

  it('loads it for a success at a marked site, and for a reconcile when the copy holds entries', async () => {
    const items = new Map([
      [SETTINGS_KEYS.openSites, ['indexer.start-failed']],
      [SETTINGS_KEYS.lastStorageIncident, { entries: [{}] }],
    ]);
    const page = lazyOver(items);
    page.events.event('backup.auto-succeeded', {});
    page.events.event('indexer.started', {});
    await page.events.reconcile();
    await page.events.flush();
    assert.equal(page.loads(), 1);
    assert.deepEqual(page.heard, ['indexer.started', 'reconcile']);
  });

  it("names the same success codes and settings keys as the trust code, which it can't import", async () => {
    const { SUCCESS_SITES, OPEN_SITES_KEY, COPY_KEY } =
      await import('../../js/kernel/composition/lazy-failure-events.js');
    assert.equal(OPEN_SITES_KEY, SETTINGS_KEYS.openSites);
    assert.equal(COPY_KEY, SETTINGS_KEYS.lastStorageIncident);
    const registered = Object.fromEntries(
      Object.entries(EVENT_CODES)
        .filter(([, entry]) => /** @type {any} */ (entry).resolves)
        .map(([code, entry]) => [code, /** @type {any} */ (entry).resolves]),
    );
    assert.deepEqual({ ...SUCCESS_SITES }, registered);
  });
});
