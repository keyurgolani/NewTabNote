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
    // The mark keeps the incident's id with its count
    const marked = /** @type {any} */ (profile.settings.items.get(SETTINGS_KEYS.openSites));
    assert.deepEqual(Object.keys(marked), ['indexer.start-failed']);
    const sighted = marked['indexer.start-failed']['index/indexer-start-failed/-'];
    assert.deepEqual(Object.keys(sighted).sort(), ['id', 'occurrences']);
    assert.equal(sighted.occurrences, 1);
    // Another tab's indexer starts
    const other = createFailureEvents({ surface: 'newtab', host });
    other.event('indexer.started', {});
    await other.flush();
    assert.deepEqual(profile.settings.items.get(SETTINGS_KEYS.openSites), {});
    const store = databaseFor(profile);
    const { records } = await recordsOn(store, profile, { prefix: 'cccc' });
    const resolved = await at(records, 'index/indexer-start-failed/-');
    assert.deepEqual([resolved?.state, resolved?.id], ['resolved', sighted.id]);
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
      [
        SETTINGS_KEYS.openSites,
        { 'indexer.start-failed': { 'index/indexer-start-failed/-': { id: 'i1', occurrences: 1 } } },
      ],
      [SETTINGS_KEYS.lastStorageIncident, { entries: [{}] }],
    ]);
    const page = lazyOver(items);
    page.events.event('backup.auto-succeeded', {});
    page.events.event('indexer.started', {});
    await page.events.reconcile();
    await page.events.flush();
    assert.equal(page.loads(), 1);
    // The reconcile runs beside the page's queue, so its order against the event isn't fixed
    assert.deepEqual([...page.heard].sort(), ['indexer.started', 'reconcile']);
  });

  it("names the same success codes and settings keys as the trust code, which it can't import", async () => {
    const lazy = await import('../../js/kernel/composition/lazy-failure-events.js');
    const { SUCCESS_SITES, OPEN_SITES_KEY, COPY_KEY } = lazy;
    assert.equal(OPEN_SITES_KEY, SETTINGS_KEYS.openSites);
    assert.equal(COPY_KEY, SETTINGS_KEYS.lastStorageIncident);
    const records = await import('../../js/trust/core/trust-records.js');
    assert.equal(lazy.OPEN_FAILED_KEY, records.OPEN_FAILED_KEY);
    assert.equal(lazy.RETRY_OPEN_MS, records.RETRY_OPEN_MS);
    assert.equal(lazy.READ_WITHIN_MS, records.COPY_READ_MS);
    const registered = Object.fromEntries(
      Object.entries(EVENT_CODES)
        .filter(([, entry]) => /** @type {any} */ (entry).resolves)
        .map(([code, entry]) => [code, /** @type {any} */ (entry).resolves]),
    );
    assert.deepEqual({ ...SUCCESS_SITES }, registered);
  });
});

describe("#87's review: a success counts only what was sighted at its own moment", () => {
  /** Lets queued promise callbacks run */
  const tick = async (rounds = 20) => {
    for (let n = 0; n < rounds; n++) await new Promise(resolve => setImmediate(resolve));
  };

  /**
   * A host whose `trust.openSites` reads a test can hold
   * @param {Profile} profile
   */
  const gatedHost = profile => {
    /** @type {{armed: number, waiting: (() => void)[]}} */
    const gate = { armed: 0, waiting: [] };
    const settings = {
      /** @param {string[]} keys */
      get: async keys => {
        if (gate.armed > 0 && keys.includes(SETTINGS_KEYS.openSites)) {
          gate.armed--;
          await new Promise(resolve => gate.waiting.push(() => resolve(undefined)));
        }
        return profile.settings.get(keys);
      },
      /** @param {Record<string, unknown>} items */
      set: items => profile.settings.set(items),
    };
    const host = () => ({
      indexedDB: profile.real,
      keyRange: fakeKeyRange,
      settings,
      locks: profile.locks,
      clock: { now: () => Date.now() },
      ids: { next: () => crypto.randomUUID() },
    });
    return { host, gate, release: () => gate.waiting.splice(0).forEach(go => go()) };
  };

  /**
   * The incident under `key`, read in a fresh context
   * @param {Profile} profile
   * @param {string} key
   */
  const incidentIn = async (profile, key) => {
    const { records } = await recordsOn(databaseFor(profile), profile, { prefix: 'ffff' });
    return at(records, key);
  };

  it('P1: in one context, a failure after a success waits for it, so the success never counts it', async () => {
    const profile = trustProfile();
    const gated = gatedHost(profile);
    const events = createFailureEvents({ surface: 'worker-internal', host: gated.host });
    events.event('capture.failed', {}, new DOMException('m', 'QuotaExceededError'));
    await events.flush();
    gated.gate.armed = 1;
    events.event('capture.committed', { commandId: '1730000000001-abc' });
    await tick();
    assert.equal(gated.gate.waiting.length, 1, 'the success is held at its mark read');
    events.event('capture.failed', {}, new DOMException('m', 'QuotaExceededError'));
    await tick();
    gated.release();
    await events.flush();
    const incident = await incidentIn(profile, 'capture/capture-failed/-');
    assert.deepEqual(
      [incident?.state, incident?.occurrences],
      ['open', 2],
      'the last capture failed, and it reads resolved',
    );
  });

  it("P2: a tab's success resolves only the count it read, not another context's failure while it loaded", async () => {
    const profile = trustProfile();
    const b = createFailureEvents({ surface: 'newtab', host: gatedHost(profile).host });
    b.event('backup.auto-failed', {}, new DOMException('m', 'QuotaExceededError'));
    await b.flush();
    /** @type {() => void} */
    let releaseLoad = () => {};
    const loaded = new Promise(resolve => {
      releaseLoad = () => resolve(undefined);
    });
    const ha = gatedHost(profile);
    const a = lazyFailureEvents({
      surface: 'newtab',
      read: keys => profile.settings.get(keys),
      load: async () => {
        await loaded;
        return {
          createFailureEvents: (/** @type {any} */ options) => createFailureEvents({ ...options, host: ha.host }),
        };
      },
    });
    a.event('backup.auto-succeeded', {});
    await tick();
    b.event('backup.auto-failed', {}, new DOMException('m', 'QuotaExceededError'));
    await b.flush();
    releaseLoad();
    await a.flush();
    const incident = await incidentIn(profile, 'backup/auto-backup-failed/-');
    assert.deepEqual([incident?.state, incident?.occurrences], ['open', 2], "B's newer failure read resolved");
  });

  it('a success that read the count before resolves, in another context, once nothing came since', async () => {
    const profile = trustProfile();
    const b = createFailureEvents({ surface: 'newtab', host: gatedHost(profile).host });
    b.event('backup.auto-failed', {}, new DOMException('m', 'QuotaExceededError'));
    await b.flush();
    const marked = /** @type {any} */ (profile.settings.items.get(SETTINGS_KEYS.openSites));
    assert.equal(marked['backup.auto-failed']['backup/auto-backup-failed/-'].occurrences, 1);
    const a = lazyFailureEvents({
      surface: 'newtab',
      read: keys => profile.settings.get(keys),
      load: async () => ({
        createFailureEvents: (/** @type {any} */ options) =>
          createFailureEvents({ ...options, host: gatedHost(profile).host }),
      }),
    });
    a.event('backup.auto-succeeded', {});
    await a.flush();
    assert.equal((await incidentIn(profile, 'backup/auto-backup-failed/-'))?.state, 'resolved');
    assert.deepEqual(profile.settings.items.get(SETTINGS_KEYS.openSites), {});
  });

  it('P4: a storage.open-failed with a new cause while open is journaled again', async () => {
    const profile = trustProfile();
    const clock = manualClock();
    const { records } = await recordsOn(databaseFor(profile), profile, { clock });
    const journal = createDiagnosticJournal({ records, clock, strict: true });
    for (const errorCode of ['version-too-new', 'version-too-new', 'quota', 'quota']) {
      journal.event('storage.open-failed', { subjectId: 'CanvasTabDB', errorCode });
      await journal.flush();
      clock.advance(1000);
    }
    const journaled = (await records.events()).map(event => event.fields.errorCode);
    assert.deepEqual(journaled, ['version-too-new', 'quota']);
    assert.equal((await at(records, 'storage/open-failed/CanvasTabDB'))?.occurrences, 4);
  });

  it("nit 3: a reconcile within the retry window of a context's failed open tries nothing", async () => {
    const profile = trustProfile();
    const down = await recordsOn(createTrustDatabase({ indexedDB: brokenFactory }), profile, {
      clock: manualClock(Date.now()),
      prefix: 'aaaa',
    });
    assert.ok(down.records);
    const fresh = hostOf(profile);
    await createFailureEvents({ surface: 'worker-internal', host: fresh.host }).reconcile();
    assert.equal(fresh.counted.opens, 0, 'tried to open while another context just failed to');
    // The lazy page skips it too, loading nothing
    let loads = 0;
    const page = lazyFailureEvents({
      surface: 'newtab',
      read: keys => profile.settings.get(keys),
      load: async () => {
        loads++;
        return {
          createFailureEvents: (/** @type {any} */ options) => createFailureEvents({ ...options, host: fresh.host }),
        };
      },
    });
    await page.reconcile();
    assert.equal(loads, 0);
  });

  it("Q1: a tab's success queued behind a slow load reads the mark when it happened, so another tab's failure meanwhile stays open", async () => {
    const profile = trustProfile();
    const b = createFailureEvents({ surface: 'newtab', host: gatedHost(profile).host });
    b.event('backup.auto-failed', {}, new DOMException('m', 'QuotaExceededError'));
    await b.flush();
    /** @type {() => void} */
    let releaseLoad = () => {};
    const loaded = new Promise(resolve => {
      releaseLoad = () => resolve(undefined);
    });
    const ha = gatedHost(profile);
    const a = lazyFailureEvents({
      surface: 'newtab',
      read: keys => profile.settings.get(keys),
      load: async () => {
        await loaded;
        return {
          createFailureEvents: (/** @type {any} */ options) => createFailureEvents({ ...options, host: ha.host }),
        };
      },
    });
    // The tab's first event, at another site, loads the trust code, slowly
    a.event('embeddings.load-failed', {}, new DOMException('m', 'QuotaExceededError'));
    await tick();
    // The auto-backup succeeds now, queued behind it
    a.event('backup.auto-succeeded', {});
    await tick();
    // Another tab's backup fails again meanwhile
    b.event('backup.auto-failed', {}, new DOMException('m', 'QuotaExceededError'));
    await b.flush();
    releaseLoad();
    await a.flush();
    const incident = await incidentIn(profile, 'backup/auto-backup-failed/-');
    assert.deepEqual([incident?.state, incident?.occurrences], ['open', 2], "B's newer failure read resolved");
  });

  it('Q1, in the worker: a success queued behind a slow event reads the mark when it happened', async () => {
    const profile = trustProfile();
    const b = createFailureEvents({ surface: 'newtab', host: gatedHost(profile).host });
    b.event('backup.auto-failed', {}, new DOMException('m', 'QuotaExceededError'));
    await b.flush();
    const gated = gatedHost(profile);
    const a = createFailureEvents({ surface: 'worker-internal', host: gated.host });
    // A's capture failure is held at its mark write, so A's queue waits behind it
    gated.gate.armed = 1;
    a.event('capture.failed', {}, new DOMException('m', 'QuotaExceededError'));
    await tick();
    assert.equal(gated.gate.waiting.length, 1, 'the failure is held at its mark write');
    a.event('backup.auto-succeeded', {});
    await tick();
    b.event('backup.auto-failed', {}, new DOMException('m', 'QuotaExceededError'));
    await b.flush();
    gated.release();
    await a.flush();
    const incident = await incidentIn(profile, 'backup/auto-backup-failed/-');
    assert.deepEqual([incident?.state, incident?.occurrences], ['open', 2], "B's newer failure read resolved");
  });

  for (const [shape, stale] of /** @type {const} */ ([
    ["today's count alone", 1],
    ["an incident id that's gone", { id: 'an-incident-that-is-gone', occurrences: 1 }],
  ])) {
    it(`Q3: a mark left by an incident that's gone (${shape}) never matches a new one`, async () => {
      const profile = trustProfile();
      profile.settings.items.set(SETTINGS_KEYS.openSites, {
        'backup.auto-failed': { 'backup/auto-backup-failed/-': stale },
      });
      /** @type {() => void} */
      let releaseLoad = () => {};
      const loaded = new Promise(resolve => {
        releaseLoad = () => resolve(undefined);
      });
      const ha = gatedHost(profile);
      const a = lazyFailureEvents({
        surface: 'newtab',
        read: keys => profile.settings.get(keys),
        load: async () => {
          await loaded;
          return {
            createFailureEvents: (/** @type {any} */ options) => createFailureEvents({ ...options, host: ha.host }),
          };
        },
      });
      a.event('backup.auto-succeeded', {});
      await tick();
      // A new incident, made after the success, with the same count
      const b = createFailureEvents({ surface: 'newtab', host: gatedHost(profile).host });
      b.event('backup.auto-failed', {}, new DOMException('m', 'QuotaExceededError'));
      await b.flush();
      releaseLoad();
      await a.flush();
      const incident = await incidentIn(profile, 'backup/auto-backup-failed/-');
      assert.deepEqual([incident?.state, incident?.occurrences], ['open', 1], 'a stale mark resolved a new incident');
    });
  }
});
