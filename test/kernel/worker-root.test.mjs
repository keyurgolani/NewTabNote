// The service worker's composition root since #17 PR 1b (js/kernel/composition/background.js):
// it runs #17's migration run at worker start and records its outcome; a run short of space
// leaves the database as it was, captures keep working on it, and the next worker start within
// RETRY_AFTER_MS doesn't try again; a blocked upgrade answers blocked-upgrade at once instead
// of leaving a capture waiting, and once the blocker goes the run finishes and captures commit.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { webcrypto } from 'node:crypto';

import { KEEPALIVE_MS, RETRY_AFTER_MS, UPGRADE_RECORD_KEY, createWorkerClient } from '../../js/kernel/composition/background.js';
import { exportPoint } from '../../js/kernel/adapters/indexeddb/legacy-export.js';
import { listPoints, openRecovery } from '../../js/kernel/adapters/indexeddb/recovery-points.js';
import { LEGACY_STORE_NAMES } from '../../js/kernel/adapters/indexeddb/registry.js';
import { detectShape, inspect } from '../../js/kernel/adapters/indexeddb/shapes.js';
import { legacyEnv, profileWith, synthesized } from './migration-support.mjs';

/** @typedef {import('./migration-support.mjs').Profile} Profile */

/** @type {{IDBKeyRange: typeof globalThis.IDBKeyRange}} */
const { IDBKeyRange: KeyRange } = createRequire(import.meta.url)('fake-indexeddb');
const FIXTURES = synthesized();

/** A disk with 1 MB free */
const CRAMPED = async () => ({ quota: 100 * 1024 ** 2, usage: 99 * 1024 ** 2 });

/**
 * The worker's host over `of`
 * @param {Profile} of
 * @param {{estimate?: any}} [options]
 */
const hostOf = (of, { estimate = null } = {}) => ({
  indexedDB: of.real,
  keyRange: KeyRange,
  settings: of.chrome.api.storage.local,
  locks: legacyEnv.createLockManager(),
  estimate,
  crypto: /** @type {any} */ (webcrypto),
});

/** @param {any} worker @param {string} id */
const capture = (worker, id) =>
  worker.execute({
    type: 'captureToDailyNote',
    commandId: `c-${id}`,
    noteId: `d-${id}`,
    blockId: `b-${id}`,
    capture: { type: 'text', content: id },
  });

/** @param {Profile} of */
const recoveryExists = async of =>
  (await of.real.databases()).some((/** @type {IDBDatabaseInfo} */ db) => db.name === 'NewTabNoteRecovery');

describe("the worker's composition root", () => {
  it('short of space: records it, opens the database as it is, and captures still commit on 8', async () => {
    const of = await profileWith(/** @type {any} */ (FIXTURES.get('v8.basic')));
    const worker = createWorkerClient(hostOf(of, { estimate: CRAMPED }));
    assert.equal(await worker.whenReady(), null);
    const outcome = await worker.migration.done;
    assert.deepStrictEqual([outcome.status, outcome.failure], ['space-blocked', { code: 'space-short' }]);
    const record = /** @type {any} */ (of.chrome.local[UPGRADE_RECORD_KEY]);
    assert.deepStrictEqual([record.status, record.code, typeof record.at], ['space-blocked', 'space-short', 'number']);
    assert.equal(detectShape(await inspect(of.real)).kind, 'legacy');
    assert.equal(await recoveryExists(of), false, 'no point, no recovery database');
    assert.equal((await capture(worker, 'on-8')).kind, 'committed');
    assert.equal((await inspect(of.real)).version, 8);
  });

  it('a worker start within RETRY_AFTER_MS of a run short of space tries nothing, and one after it tries again', async () => {
    const of = await profileWith(/** @type {any} */ (FIXTURES.get('v8.basic')));
    await createWorkerClient(hostOf(of, { estimate: CRAMPED })).migration.done;
    const recorded = /** @type {any} */ (of.chrome.local[UPGRADE_RECORD_KEY]);
    // Room now, but the last try stands: nothing is measured or copied, and the record keeps its time
    const soon = createWorkerClient(hostOf(of, { estimate: async () => ({ quota: 10 * 1024 ** 3, usage: 0 }) }));
    assert.equal((await soon.migration.done).status, 'space-blocked');
    assert.equal(await soon.whenReady(), null);
    assert.equal((await capture(soon, 'still-8')).kind, 'committed');
    assert.deepStrictEqual(of.chrome.local[UPGRADE_RECORD_KEY], recorded);
    assert.equal((await inspect(of.real)).version, 8);
    // Once it's older than RETRY_AFTER_MS the next start runs, and migrates
    of.chrome.local[UPGRADE_RECORD_KEY] = { ...recorded, at: recorded.at - RETRY_AFTER_MS - 1 };
    const later = createWorkerClient(hostOf(of));
    assert.equal((await later.migration.done).status, 'migrated');
    assert.equal(/** @type {any} */ (of.chrome.local[UPGRADE_RECORD_KEY]).status, 'migrated');
    assert.equal((await inspect(of.real)).version, 9);
    assert.equal((await capture(later, 'on-9')).kind, 'committed');
  });

  it('a blocked upgrade answers blocked-upgrade at once, and once the blocker closes the run finishes and captures commit', async () => {
    const of = await profileWith(/** @type {any} */ (FIXTURES.get('v8.basic')));
    // An older build's page that never closes on versionchange, as 1.4.1's new tab holds its own
    const blocker = /** @type {IDBDatabase} */ (await legacyEnv.requestToPromise(of.real.open('CanvasTabDB')));
    const worker = createWorkerClient(hostOf(of));
    try {
      const refused = await legacyEnv.waitFor(async () => {
        const answer = await worker.whenReady();
        return answer && answer.code === 'blocked-upgrade' ? answer : null;
      });
      assert.deepStrictEqual([refused.cause, refused.code, refused.retryable], ['storage', 'blocked-upgrade', true]);
      assert.equal(worker.migration.blocked(), true);
      const held = await capture(worker, 'while-blocked');
      assert.deepStrictEqual(held.kind === 'unavailable' && [held.cause, held.code], ['storage', 'blocked-upgrade']);
    } finally {
      blocker.close();
    }
    assert.equal((await worker.migration.done).status, 'migrated');
    assert.equal(await worker.whenReady(), null);
    assert.equal((await capture(worker, 'after')).kind, 'committed');
  });

  it('a profile with a newer database is refused, recorded, and captures answer newer-schema', async () => {
    const of = await profileWith(/** @type {any} */ (FIXTURES.get('v9.newer')));
    const worker = createWorkerClient(hostOf(of));
    const failure = await worker.whenReady();
    assert.deepStrictEqual(failure && [failure.cause, failure.code], ['newer-schema', 'version-too-new']);
    assert.equal(/** @type {any} */ (of.chrome.local[UPGRADE_RECORD_KEY]).status, 'refused');
  });
});

describe('a run that stands is one this build ran', () => {
  it('an update tries at once, past a run of the build before that stopped short of space', async () => {
    const of = await profileWith(/** @type {any} */ (FIXTURES.get('v8.basic')));
    await createWorkerClient({ ...hostOf(of, { estimate: CRAMPED }), version: '1.5.0' }).migration.done;
    assert.equal(/** @type {any} */ (of.chrome.local[UPGRADE_RECORD_KEY]).version, '1.5.0');
    // The same build again, minutes later: it stands
    const same = createWorkerClient({ ...hostOf(of), version: '1.5.0' });
    assert.equal((await same.migration.done).status, 'space-blocked');
    assert.equal((await inspect(of.real)).version, 8);
    // An update: it runs now
    const updated = createWorkerClient({ ...hostOf(of), version: '1.5.1' });
    assert.equal((await updated.migration.done).status, 'migrated');
    assert.deepStrictEqual(
      [
        /** @type {any} */ (of.chrome.local[UPGRADE_RECORD_KEY]).status,
        /** @type {any} */ (of.chrome.local[UPGRADE_RECORD_KEY]).version,
      ],
      ['migrated', '1.5.1'],
    );
  });
});

/**
 * Fake interval timers: `fire()` runs every live interval once
 */
function fakeTimers() {
  /** @type {Map<number, () => void>} */
  const live = new Map();
  let next = 1;
  return {
    live,
    setInterval: (/** @type {() => void} */ fn) => {
      live.set(next, fn);
      return next++;
    },
    clearInterval: (/** @type {unknown} */ id) => {
      live.delete(/** @type {number} */ (id));
    },
    fire: () => [...live.values()].forEach(fn => fn()),
  };
}

/** Single-store reads of a legacy store since `from`, which only measuring and copying make */
const storeReadsSince = (/** @type {any} */ of, /** @type {number} */ from) =>
  of.faults.transactions
    .slice(from)
    .filter(
      (/** @type {any} */ opened) =>
        opened.mode === 'readonly' && opened.names.length === 1 && LEGACY_STORE_NAMES.includes(opened.names[0]),
    ).length;

describe('the backoff, retries within one worker, and the keepalive (review R79)', () => {
  it('three starts in one window measure once, and a start after the window measures again and starts a new window', async () => {
    const of = await profileWith(/** @type {any} */ (FIXTURES.get('v8.basic')));
    const host = () => ({ ...hostOf(of, { estimate: CRAMPED }), indexedDB: of.faults.factory, version: '1.5.0' });
    const reads = [];
    for (let i = 0; i < 3; i++) {
      const before = of.faults.transactions.length;
      assert.equal((await createWorkerClient(host()).migration.done).status, 'space-blocked');
      reads.push(storeReadsSince(of, before) > 0);
    }
    assert.deepStrictEqual(reads, [true, false, false]);
    const first = /** @type {any} */ (of.chrome.local[UPGRADE_RECORD_KEY]);
    // Past the window: it measures again, and its time starts the next window
    of.chrome.local[UPGRADE_RECORD_KEY] = { ...first, at: first.at - RETRY_AFTER_MS - 1 };
    let before = of.faults.transactions.length;
    await createWorkerClient(host()).migration.done;
    assert.ok(storeReadsSince(of, before) > 0, 'measured again');
    const refreshed = /** @type {any} */ (of.chrome.local[UPGRADE_RECORD_KEY]);
    assert.ok(refreshed.at > first.at - RETRY_AFTER_MS - 1, 'the time moved on');
    before = of.faults.transactions.length;
    await createWorkerClient(host()).migration.done;
    assert.equal(storeReadsSince(of, before), 0, 'and the next start in the new window measures nothing');
  });

  it("a page's storage.migrate after a run that failed before reading anything runs again at once", async () => {
    const of = await profileWith(/** @type {any} */ (FIXTURES.get('v8.basic')));
    const locks = legacyEnv.createLockManager();
    let refusals = 1;
    const flaky = {
      request: (/** @type {any[]} */ ...args) => {
        if (refusals-- > 0) return Promise.reject(new DOMException('lock manager unavailable', 'InvalidStateError'));
        return /** @type {any} */ (locks).request(...args);
      },
    };
    const worker = createWorkerClient({ ...hostOf(of), locks: /** @type {any} */ (flaky), version: '1.5.0' });
    const failed = await worker.migration.done;
    assert.deepStrictEqual([failed.status, failed.shape], ['failed', null]);
    assert.equal(/** @type {any} */ (of.chrome.local[UPGRADE_RECORD_KEY]).costly, false);
    // A reload of the page asks again, and the run goes at once
    assert.equal((await worker.migration.request()).status, 'migrated');
    assert.equal((await inspect(of.real)).version, 9);
    assert.equal((await capture(worker, 'after-retry')).kind, 'committed');
  });

  it("after a run short of space, storage.migrate runs again only past the window, and then migrates when there's room", async () => {
    const of = await profileWith(/** @type {any} */ (FIXTURES.get('v8.basic')));
    let free = 1024 ** 2;
    const estimate = async () => ({ quota: free, usage: 0 });
    const worker = createWorkerClient({ ...hostOf(of, { estimate }), version: '1.5.0' });
    assert.equal((await worker.migration.done).status, 'space-blocked');
    free = 10 * 1024 ** 3;
    // Inside the window the record stands, so nothing is measured again
    assert.equal((await worker.migration.request()).status, 'space-blocked');
    assert.equal((await inspect(of.real)).version, 8);
    const recorded = /** @type {any} */ (of.chrome.local[UPGRADE_RECORD_KEY]);
    of.chrome.local[UPGRADE_RECORD_KEY] = { ...recorded, at: recorded.at - RETRY_AFTER_MS - 1 };
    assert.equal((await worker.migration.request()).status, 'migrated');
    assert.equal((await inspect(of.real)).version, 9);
    // Its kernel follows: a capture now lands on 9
    assert.equal((await capture(worker, 'on-9')).kind, 'committed');
  });

  it('storage.migrate during a blocked run answers with that run, and starts no other', async () => {
    const of = await profileWith(/** @type {any} */ (FIXTURES.get('v8.basic')));
    const blocker = /** @type {IDBDatabase} */ (await legacyEnv.requestToPromise(of.real.open('CanvasTabDB')));
    const worker = createWorkerClient(hostOf(of));
    try {
      await legacyEnv.waitFor(() => worker.migration.blocked());
      const first = worker.migration.done;
      const answer = worker.migration.request();
      assert.equal(worker.migration.done, first, 'no new attempt');
      blocker.close();
      assert.equal((await answer).status, 'migrated');
    } finally {
      blocker.close();
    }
  });

  it('a database replaced at 8 under the worker is migrated by the runner, after a point, before the next capture lands', async () => {
    const of = await profileWith(/** @type {any} */ (FIXTURES.get('v8.basic')));
    const worker = createWorkerClient(hostOf(of));
    assert.equal((await capture(worker, 'first')).kind, 'committed');
    assert.equal((await inspect(of.real)).version, 9);
    // R79's probe: another context deletes it and makes it again at 8, with a note
    await legacyEnv.requestToPromise(of.real.deleteDatabase('CanvasTabDB'));
    await legacyEnv.createDatabase(of.real, { records: { canvases: [legacyEnv.note('recreated', { name: 'Recreated' })] } });
    assert.equal((await capture(worker, 'second')).kind, 'committed');
    assert.equal((await inspect(of.real)).version, 9);
    // The step ran only after a verified point of the recreated database
    const recovery = /** @type {IDBDatabase} */ (await openRecovery(of.real, { create: false }));
    const points = await listPoints(recovery);
    recovery.close();
    const latest = points.filter(point => point.kind === 'pre-migration' && point.status === 'verified').pop();
    assert.ok(latest && latest.sourceVersion === 8 && latest.target === 9, JSON.stringify(points.map(p => p.id)));
    const exported = await exportPoint({
      indexedDB: of.real,
      keyRange: KeyRange,
      crypto: /** @type {any} */ (webcrypto),
      clock: { now: () => Date.now() },
      pointId: /** @type {any} */ (latest).id,
    });
    assert.ok(exported.canvases.some(note => /** @type {any} */ (note).id === 'recreated'));
  });

  it('keeps the worker alive with an extension API call every 20 s while a run is in progress, and stops when it ends', async () => {
    const of = await profileWith(/** @type {any} */ (FIXTURES.get('v8.basic')));
    const blocker = /** @type {IDBDatabase} */ (await legacyEnv.requestToPromise(of.real.open('CanvasTabDB')));
    const timers = fakeTimers();
    let calls = 0;
    const worker = createWorkerClient({
      ...hostOf(of),
      timers,
      keepAlive: async () => {
        calls++;
      },
    });
    try {
      await legacyEnv.waitFor(() => worker.migration.blocked());
      assert.equal(timers.live.size, 1, 'one keepalive while the run waits');
      assert.equal(worker.migration.running(), true);
      timers.fire();
      timers.fire();
      timers.fire();
      assert.equal(calls, 3);
    } finally {
      blocker.close();
    }
    await worker.migration.done;
    await legacyEnv.waitFor(() => timers.live.size === 0, { message: 'the keepalive to stop' });
    assert.equal(worker.migration.running(), false);
    timers.fire();
    assert.equal(calls, 3, 'none once the run ended');
    assert.equal(KEEPALIVE_MS, 20 * 1000);
  });
});
