// The service worker's composition root since #17 PR 1b (js/kernel/composition/background.js):
// it runs #17's migration run at worker start and records its outcome; a run short of space
// leaves the database as it was, captures keep working on it, and the next worker start within
// RETRY_AFTER_MS doesn't try again; a blocked upgrade answers blocked-upgrade at once instead
// of leaving a capture waiting, and once the blocker goes the run finishes and captures commit.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { webcrypto } from 'node:crypto';

import {
  KEEPALIVE_MS,
  PURGE_RECOVERY_POINTS,
  RETRY_AFTER_MS,
  UPGRADE_RECORD_KEY,
  createWorkerClient,
  journalPurge,
  journalTransforms,
} from '../../js/kernel/composition/background.js';
import { createFailureEvents } from '../../js/kernel/composition/trust.js';
import { createIndexedDbAdapter } from '../../js/kernel/adapters/indexeddb/adapter.js';
import { MISSING_STORES_COPY_KEY, RECOVERY_COPY_LOCK } from '../../js/kernel/adapters/indexeddb/recovery-copies.js';
import { COMMANDS } from '../../js/kernel/core/contracts/commands.js';
import { COMMAND_SAMPLES } from './command-samples.mjs';
import { createKernel } from './test-kernel.mjs';
import { createBaselinePolicy } from '../../js/kernel/core/ports/policy.js';
import { SWEPT_KEY } from '../../js/kernel/adapters/indexeddb/ledger-sweep.js';
import { exportPoint } from '../../js/kernel/adapters/indexeddb/legacy-export.js';
import {
  DEFAULT_LIMITS,
  discardPoint,
  listPoints,
  openRecovery,
} from '../../js/kernel/adapters/indexeddb/recovery-points.js';
import { LEGACY_STORE_NAMES, pendingStructural } from '../../js/kernel/adapters/indexeddb/registry.js';
import { DB_NAME, DB_VERSION } from '../../js/kernel/adapters/indexeddb/schema.js';
import { detectShape, inspect } from '../../js/kernel/adapters/indexeddb/shapes.js';
import { TRANSFORM_RETRY_AFTER_MS, TRANSFORM_STOP_KEY } from '../../js/kernel/adapters/indexeddb/transforms.js';
import { withoutPlacement } from '../../js/kernel/core/domain/placement.js';
import { ROOMY, legacyEnv, newProfile, profileWith, synthesized, transform } from './migration-support.mjs';
import { recordsOf } from './storage-fixture.mjs';
import { CALLERS } from './support.mjs';
import { databaseOn, fakeKeyRange, openRecords, trustProfile } from './trust-support.mjs';

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

/**
 * How long a test waits for a run to reach a blocked upgrade, in real time: it measures,
 * copies and hashes (webcrypto, on the thread pool) first, which takes longer on a slower
 * machine than any count of event-loop turns allows
 */
const RUN_BLOCKS = Object.freeze({ withinMs: 10_000, message: "the run's upgrade to be blocked" });

describe("the worker's composition root", () => {
  it("sweeps the adapter's ledger once its kernel is ready, and not again within a day (#17 PR 2a)", async () => {
    // v10.basic's ledger rows are from 2025, past the 30 days a row is kept; its run takes it to 11
    const of = await profileWith(/** @type {any} */ (FIXTURES.get('v10.basic')));
    assert.equal((await recordsOf(of, 'operations')).length, 3);
    const swept = async () => (await recordsOf(of, 'meta')).find(record => record.key === SWEPT_KEY);
    // The rows but the records' catch-up's, which runs beside the sweep (records-catch-up.test.mjs)
    const rows = async () =>
      (await recordsOf(of, 'operations')).filter(row => !String(row.outcome?.code).startsWith('records-caught-up'));
    const worker = createWorkerClient(hostOf(of));
    assert.equal(await worker.whenReady(), null);
    assert.equal((await worker.migration.done).status, 'migrated');
    // The sweep runs behind the kernel, so the test waits on it in real time
    const deadline = Date.now() + 10_000;
    while (!(await swept()) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
    const record = await swept();
    assert.equal(typeof record?.sweptAt, 'number');
    assert.deepEqual(await rows(), []);
    // A capture keeps its row, and the next start, within the day, sweeps nothing
    assert.equal((await capture(worker, 'kept')).kind, 'committed');
    const again = createWorkerClient(hostOf(of));
    assert.equal(await again.whenReady(), null);
    await new Promise(resolve => setTimeout(resolve, 50));
    assert.deepEqual(await swept(), record);
    assert.equal((await rows()).length, 1);
  });

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
    assert.equal((await inspect(of.real)).version, DB_VERSION);
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
      }, RUN_BLOCKS);
      assert.deepStrictEqual([refused.cause, refused.code, refused.retryable], ['storage', 'blocked-upgrade', true]);
      assert.equal(worker.migration.blocked(), true);
      // Blocked or not, it's upgrading the database that was there (#35 slice 2)
      assert.equal(worker.migration.upgrading(), true);
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

describe('what the coordinator reads while the run upgrades (#35 slice 2)', () => {
  /**
   * A space estimate the test lets answer: the run asks it right after it measures the stores
   * for its point, and waits there until `release`
   */
  const heldEstimate = () => {
    /** @type {() => void} */
    let release = () => {};
    const gate = new Promise(resolve => {
      release = () => resolve(undefined);
    });
    const asked = { count: 0 };
    return {
      estimate: async () => {
        asked.count++;
        await gate;
        return ROOMY();
      },
      asked,
      release: () => release(),
    };
  };

  /**
   * `real`, with the first versioned open of CanvasTabDB held until `release`: the run makes or
   * upgrades the database in that open, so the test reads the run while it's there. Every
   * other open goes straight through.
   * @param {any} real
   */
  const heldUpgrade = real => {
    /** @type {() => void} */
    let release = () => {};
    const gate = new Promise(resolve => {
      release = () => resolve(undefined);
    });
    const asked = { count: 0 };
    const indexedDB = new Proxy(real, {
      get(target, key) {
        if (key !== 'open') {
          const value = Reflect.get(target, key);
          return typeof value === 'function' ? value.bind(target) : value;
        }
        return (/** @type {string} */ name, /** @type {number | undefined} */ version) => {
          if (version === undefined) return target.open(name);
          if (name !== DB_NAME || asked.count > 0) return target.open(name, version);
          asked.count++;
          // A request whose handlers the run sets now, wired to the real one once the gate opens
          /** @type {any} */
          const request = { result: undefined, transaction: undefined, error: null };
          gate.then(() => {
            const inner = target.open(name, version);
            inner.onupgradeneeded = (/** @type {Event} */ event) => {
              request.result = inner.result;
              request.transaction = inner.transaction;
              if (request.onupgradeneeded) request.onupgradeneeded(event);
            };
            inner.onblocked = (/** @type {Event} */ event) => {
              if (request.onblocked) request.onblocked(event);
            };
            inner.onsuccess = (/** @type {Event} */ event) => {
              request.result = inner.result;
              if (request.onsuccess) request.onsuccess(event);
            };
            inner.onerror = (/** @type {Event} */ event) => {
              request.error = inner.error;
              if (request.onerror) request.onerror(event);
            };
          });
          return request;
        };
      },
    });
    return { indexedDB, asked, release: () => release() };
  };

  it('migration.upgrading() is true while the run upgrades a 1.4.x database, and false once the attempt is in', async () => {
    const of = await profileWith(/** @type {any} */ (FIXTURES.get('v8.basic')));
    const held = heldEstimate();
    const worker = createWorkerClient(hostOf(of, { estimate: held.estimate }));
    await legacyEnv.waitFor(() => held.asked.count > 0, { withinMs: 10_000, message: 'the space check' });
    assert.equal(worker.migration.upgrading(), true);
    assert.equal(worker.migration.blocked(), false);
    held.release();
    assert.equal((await worker.migration.done).status, 'migrated');
    assert.equal(worker.migration.upgrading(), false);
    assert.equal(await worker.whenReady(), null);
  });

  it("is false for a database at this build's version, and for a newer one the run refuses while it makes its point", async () => {
    const of = await profileWith(/** @type {any} */ (FIXTURES.get('v8.basic')));
    await createWorkerClient(hostOf(of)).migration.done;
    const current = createWorkerClient(hostOf(of));
    /** @type {Set<boolean>} */
    const seen = new Set([current.migration.upgrading()]);
    const sample = setInterval(() => seen.add(current.migration.upgrading()), 1);
    try {
      assert.equal((await current.migration.done).status, 'current');
    } finally {
      clearInterval(sample);
    }
    seen.add(current.migration.upgrading());
    assert.deepEqual([...seen], [false]);

    const newer = await profileWith(/** @type {any} */ (FIXTURES.get('v9.newer')));
    const held = heldEstimate();
    const refused = createWorkerClient(hostOf(newer, { estimate: held.estimate }));
    await legacyEnv.waitFor(() => held.asked.count > 0, { withinMs: 10_000, message: "the newer database's point" });
    assert.equal(refused.migration.upgrading(), false);
    held.release();
    assert.equal((await refused.migration.done).status, 'refused');
  });

  it('is false while the run makes a database where there was none, and after', async () => {
    const of = newProfile();
    const held = heldUpgrade(of.real);
    const worker = createWorkerClient({ ...hostOf(of), indexedDB: held.indexedDB });
    await legacyEnv.waitFor(() => held.asked.count > 0, { withinMs: 10_000, message: "the run's versioned open" });
    assert.equal(worker.migration.upgrading(), false);
    held.release();
    const ended = await worker.migration.done;
    assert.deepEqual([ended.status, ended.shape], ['migrated', 'none']);
    assert.equal(worker.migration.upgrading(), false);
    assert.equal(await worker.whenReady(), null);
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
    assert.equal((await inspect(of.real)).version, DB_VERSION);
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
    assert.equal((await inspect(of.real)).version, DB_VERSION);
    // Its kernel follows: a capture now lands on this build's version
    assert.equal((await capture(worker, 'on-9')).kind, 'committed');
  });

  it('storage.migrate during a blocked run answers with that run, and starts no other', async () => {
    const of = await profileWith(/** @type {any} */ (FIXTURES.get('v8.basic')));
    const blocker = /** @type {IDBDatabase} */ (await legacyEnv.requestToPromise(of.real.open('CanvasTabDB')));
    const worker = createWorkerClient(hostOf(of));
    try {
      await legacyEnv.waitFor(() => worker.migration.blocked(), RUN_BLOCKS);
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
    assert.equal((await inspect(of.real)).version, DB_VERSION);
    // R79's probe: another context deletes it and makes it again at 8, with a note
    await legacyEnv.requestToPromise(of.real.deleteDatabase('CanvasTabDB'));
    await legacyEnv.createDatabase(of.real, {
      records: { canvases: [legacyEnv.note('recreated', { name: 'Recreated' })] },
    });
    assert.equal((await capture(worker, 'second')).kind, 'committed');
    assert.equal((await inspect(of.real)).version, DB_VERSION);
    // The step ran only after a verified point of the recreated database
    const recovery = /** @type {IDBDatabase} */ (await openRecovery(of.real, { create: false }));
    const points = await listPoints(recovery);
    recovery.close();
    const latest = points.filter(point => point.kind === 'pre-migration' && point.status === 'verified').pop();
    assert.ok(
      latest && latest.sourceVersion === 8 && latest.target === DB_VERSION,
      JSON.stringify(points.map(p => p.id)),
    );
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
      await legacyEnv.waitFor(() => worker.migration.blocked(), RUN_BLOCKS);
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
    // The run is followed by the start's purge sweep (#17 PR 2b), which the keepalive spans too
    assert.equal(await worker.whenReady(), null);
    await worker.purge.done;
    await legacyEnv.waitFor(() => timers.live.size === 0, { withinMs: 5000, message: 'the keepalive to stop' });
    assert.equal(worker.migration.running(), false);
    const before = calls;
    timers.fire();
    assert.equal(calls, before, 'none once the run and the sweep ended');
    assert.equal(KEEPALIVE_MS, 20 * 1000);
  });
});

/** The CanvasTabDB connections `of`'s wrapped factory opened that are still open */
const openConnections = (/** @type {any} */ of) =>
  of.faults.connections.filter((/** @type {any} */ db) => db.name === 'CanvasTabDB' && !db._closePending).length;

/** Moves the stored record back past the window, as if RETRY_AFTER_MS had gone by */
const pastTheWindow = (/** @type {any} */ of) => {
  const recorded = /** @type {any} */ (of.chrome.local[UPGRADE_RECORD_KEY]);
  of.chrome.local[UPGRADE_RECORD_KEY] = { ...recorded, at: recorded.at - RETRY_AFTER_MS - 1 };
};

describe("review R79's delta: shared retries, one connection, what counts as costly, no call left waiting", () => {
  it('requests that arrive together after the window share one attempt, which measures once', async () => {
    const of = await profileWith(/** @type {any} */ (FIXTURES.get('v8.basic')));
    const worker = createWorkerClient({
      ...hostOf(of, { estimate: CRAMPED }),
      indexedDB: of.faults.factory,
      version: '1.5.0',
    });
    const one = storeReadsSince(of, 0);
    assert.equal(one, 0, 'nothing read before the first attempt starts');
    assert.equal((await worker.migration.done).status, 'space-blocked');
    const measure = storeReadsSince(of, 0);
    assert.ok(measure > 0, 'the first attempt measured');
    pastTheWindow(of);
    const before = of.faults.transactions.length;
    const answers = await Promise.all([
      worker.migration.request(),
      worker.migration.request(),
      worker.migration.request(),
    ]);
    assert.equal(storeReadsSince(of, before), measure, 'one measure for the three');
    assert.equal(answers[0], answers[1]);
    assert.equal(answers[1], answers[2]);
    assert.equal(answers[0].status, 'space-blocked');
  });

  it('requests on a space-blocked profile leave the worker one CanvasTabDB connection, inside the window or past it', async () => {
    const of = await profileWith(/** @type {any} */ (FIXTURES.get('v8.basic')));
    const worker = createWorkerClient({
      ...hostOf(of, { estimate: CRAMPED }),
      indexedDB: of.faults.factory,
      version: '1.5.0',
    });
    assert.equal((await worker.migration.done).status, 'space-blocked');
    assert.equal((await capture(worker, 'first')).kind, 'committed');
    for (let i = 0; i < 10; i++) assert.equal((await worker.migration.request()).status, 'space-blocked');
    assert.equal((await capture(worker, 'inside')).kind, 'committed');
    assert.equal(openConnections(of), 1, 'inside the window');
    for (let i = 0; i < 3; i++) {
      pastTheWindow(of);
      assert.equal((await worker.migration.request()).status, 'space-blocked');
    }
    assert.equal((await capture(worker, 'past')).kind, 'committed');
    assert.equal(openConnections(of), 1, 'past the window, each run replacing the last connection');
  });

  it('a run that fails after reading the shape but before reading any store backs nothing off', async () => {
    const of = await profileWith(/** @type {any} */ (FIXTURES.get('v8.basic')));
    // A recovery database without its stores, which the run refuses before it lists points,
    // measures, or copies
    const empty = of.real.open('NewTabNoteRecovery', 1);
    /** @type {IDBDatabase} */ (await legacyEnv.requestToPromise(empty)).close();
    let recoveryOpens = 0;
    const factory = {
      open: (/** @type {string} */ name, /** @type {number} */ version) => {
        if (name === 'NewTabNoteRecovery') recoveryOpens++;
        return version === undefined ? of.real.open(name) : of.real.open(name, version);
      },
      deleteDatabase: (/** @type {string} */ name) => of.real.deleteDatabase(name),
      databases: () => of.real.databases(),
      cmp: (/** @type {unknown} */ a, /** @type {unknown} */ b) => of.real.cmp(a, b),
    };
    const worker = createWorkerClient({ ...hostOf(of), indexedDB: /** @type {any} */ (factory), version: '1.5.0' });
    const failed = await worker.migration.done;
    assert.deepStrictEqual(
      [failed.status, failed.shape, failed.failure && failed.failure.code],
      ['failed', 'legacy', 'recovery-unavailable'],
    );
    assert.equal(/** @type {any} */ (of.chrome.local[UPGRADE_RECORD_KEY]).costly, false);
    const opens = recoveryOpens;
    // So the next request runs again at once
    assert.equal((await worker.migration.request()).status, 'failed');
    assert.ok(recoveryOpens > opens, 'it ran again');
  });

  it('a lock manager that throws as it is called is a failed run, and a capture still answers', async () => {
    const of = await profileWith(/** @type {any} */ (FIXTURES.get('v8.basic')));
    const locks = {
      request: () => {
        throw new DOMException('lock manager unavailable', 'InvalidStateError');
      },
    };
    const worker = createWorkerClient({ ...hostOf(of), locks: /** @type {any} */ (locks), version: '1.5.0' });
    const failed = await worker.migration.done;
    assert.deepStrictEqual([failed.status, failed.shape], ['failed', null]);
    assert.equal(/** @type {any} */ (of.chrome.local[UPGRADE_RECORD_KEY]).costly, false);
    // On the database as it was
    assert.equal((await capture(worker, 'on-8')).kind, 'committed');
    assert.equal((await inspect(of.real)).version, 8);
  });

  it("a kernel that can't be built answers open-failed to a capture and to whenReady, never a call left waiting", async () => {
    const of = await profileWith(/** @type {any} */ (FIXTURES.get('v8.basic')));
    // A run of this build that stands, so the attempt keeps it without touching IndexedDB
    of.chrome.local[UPGRADE_RECORD_KEY] = {
      status: 'space-blocked',
      code: 'space-short',
      at: Date.now(),
      version: '1.5.0',
      costly: true,
    };
    const host = {
      ...hostOf(of),
      version: '1.5.0',
      get indexedDB() {
        throw new Error('no IndexedDB here');
      },
    };
    const worker = createWorkerClient(/** @type {any} */ (host));
    assert.equal((await worker.migration.done).status, 'space-blocked');
    const outcome = await capture(worker, 'unbuilt');
    assert.deepStrictEqual(outcome.kind === 'unavailable' && [outcome.cause, outcome.code, outcome.retryable], [
      'storage',
      'open-failed',
      true,
    ]);
    const ready = await worker.whenReady();
    assert.deepStrictEqual(ready && [ready.cause, ready.code], ['storage', 'open-failed']);
  });
});

/** @param {Profile} of - every database the profile holds, as name@version */
const databasesOf = async of =>
  (await of.real.databases()).map((/** @type {IDBDatabaseInfo} */ db) => `${db.name}@${db.version}`).sort();

/**
 * Runs `body` with console.warn and console.info recorded, and what they said
 * @template T
 * @param {() => Promise<T>} body
 * @returns {Promise<{value: T, said: Array<[string, string]>}>}
 */
async function recording(body) {
  /** @type {Array<[string, string]>} */
  const said = [];
  const { warn, info } = console;
  console.warn = (/** @type {unknown[]} */ ...args) => said.push(['warn', String(args[0])]);
  console.info = (/** @type {unknown[]} */ ...args) => said.push(['info', String(args[0])]);
  try {
    return { value: await body(), said };
  } finally {
    console.warn = warn;
    console.info = info;
  }
}

/** A worker client whose run took a v8 profile to this build's version, with that attempt's end and its record */
async function migratedWorker() {
  const of = await profileWith(/** @type {any} */ (FIXTURES.get('v8.basic')));
  const worker = createWorkerClient(hostOf(of));
  assert.equal(await worker.whenReady(), null);
  const first = worker.migration.done;
  assert.equal((await first).status, 'migrated');
  return { of, worker, first, record: structuredClone(of.chrome.local[UPGRADE_RECORD_KEY]) };
}

// R88's probe of 9bd44a23, at the worker client, where the retry lives (#35 slice 1, the
// rebase onto next): the e2e fixture host deletes the install's database under the worker
describe("the worker's integrity check once another context deleted the database", () => {
  it('warns and commits, as Storage.runIntegrityCheck does: no retry, no other attempt, and no database made', async () => {
    const { of, worker, first, record } = await migratedWorker();
    assert.ok((await databasesOf(of)).includes(`CanvasTabDB@${DB_VERSION}`));
    await legacyEnv.requestToPromise(of.real.deleteDatabase('CanvasTabDB'));
    assert.ok(!(await databasesOf(of)).some(name => name.startsWith('CanvasTabDB@')), 'deleted');

    const { value: checked, said } = await recording(async () => {
      const outcome = await worker.execute({ type: 'runIntegrityCheck', commandId: 'check-1' });
      for (let i = 0; i < 20; i++) await new Promise(resolve => setImmediate(resolve));
      return outcome;
    });
    // Every property at once, so a failure shows each one that broke
    assert.deepEqual(
      {
        answer: checked.kind === 'committed' && checked.code,
        said: said.filter(([, message]) => message.startsWith('Integrity check')),
        sameAttempt: worker.migration.done === first,
        running: worker.migration.running(),
        recordUnchanged: JSON.stringify(of.chrome.local[UPGRADE_RECORD_KEY]) === JSON.stringify(record),
        notesDatabases: (await databasesOf(of)).filter(name => name.startsWith('CanvasTabDB@')),
      },
      {
        answer: 'integrity-checked',
        said: [['warn', 'Integrity check encountered an error:']],
        sameAttempt: true,
        running: false,
        recordUnchanged: true,
        notesDatabases: [],
      },
    );
  });

  it('control: a capture after the same delete starts an attempt, which makes the database again', async () => {
    const { of, worker, first } = await migratedWorker();
    await legacyEnv.requestToPromise(of.real.deleteDatabase('CanvasTabDB'));
    const outcome = await capture(worker, 'after');
    assert.equal(outcome.kind, 'committed', JSON.stringify(outcome));
    assert.notEqual(worker.migration.done, first, 'a new attempt');
    assert.ok((await databasesOf(of)).includes(`CanvasTabDB@${DB_VERSION}`), `made again: ${await databasesOf(of)}`);
  });
});

describe('the worker purges what was deleted for good from the recovery points (#17 PR 2b)', () => {
  /**
   * Trashes one of the profile's notes and deletes it for good, as a page would, on #17's
   * adapter over the profile; answers its id
   * @param {Profile} of
   * @param {number} [index] - which of the stored notes, by id
   * @returns {Promise<string>}
   */
  const deleteForGood = async (of, index = 0) => {
    const noteId = (await recordsOf(of, 'canvases')).map(note => note.id).sort()[index];
    const adapter = createIndexedDbAdapter({
      steps: pendingStructural,
      indexedDB: of.real,
      settings: of.chrome.api.storage.local,
      keyRange: KeyRange,
    });
    await adapter.open();
    try {
      let count = 0;
      const ids = { next: () => `delete-${noteId}-${(count += 1)}` };
      const clock = { now: () => Date.now() };
      const page = createKernel({ adapter, policy: createBaselinePolicy(), caller: CALLERS.newtab, ids, clock });
      const trashed = await page.execute(/** @type {any} */ ({ type: 'trashNote', commandId: ids.next(), noteId }));
      assert.equal(trashed.kind, 'committed', JSON.stringify(trashed));
      const deleted = await page.execute(
        /** @type {any} */ ({ type: 'deleteNotePermanently', commandId: ids.next(), noteId }),
      );
      assert.equal(deleted.kind, 'committed', JSON.stringify(deleted));
      return noteId;
    } finally {
      adapter.close();
    }
  };

  /**
   * The ids of the notes the pinned point's export holds
   * @param {Profile} of
   */
  const inPoint = async of => {
    const recovery = /** @type {IDBDatabase} */ (await openRecovery(of.real, { create: false }));
    let pointId;
    try {
      pointId = (await listPoints(recovery)).filter(point => point.pinned)[0].id;
    } finally {
      recovery.close();
    }
    const file = await exportPoint({
      indexedDB: of.real,
      keyRange: KeyRange,
      crypto: /** @type {any} */ (webcrypto),
      clock: { now: () => Date.now() },
      pointId,
    });
    return [...file.canvases, ...file.trashedCanvases].map((/** @type {any} */ note) => note.id);
  };

  /** @param {Profile} of */
  const pending = async of =>
    (await recordsOf(of, 'tombstones'))
      .filter(tombstone => tombstone.purge === 'pending')
      .map(tombstone => tombstone.id);

  it('at every start, once its run is in, purges what a delete it never heard of left pending', async () => {
    const of = await profileWith(/** @type {any} */ (FIXTURES.get('v8.basic')));
    const first = createWorkerClient(hostOf(of));
    assert.equal((await first.migration.done).status, 'migrated');
    assert.equal(await first.whenReady(), null);
    assert.equal((await first.purge.done)?.status, 'nothing');
    const noteId = await deleteForGood(of);
    assert.ok((await inPoint(of)).includes(noteId));
    assert.deepEqual(await pending(of), [noteId]);
    const next = createWorkerClient(hostOf(of));
    assert.equal(await next.whenReady(), null);
    assert.equal((await next.purge.done)?.status, 'purged');
    assert.equal((await inPoint(of)).includes(noteId), false);
    assert.deepEqual(await pending(of), []);
  });

  it("a page's storage.purge after a delete purges it, and two at once both see it done", async () => {
    const of = await profileWith(/** @type {any} */ (FIXTURES.get('v8.basic')));
    const worker = createWorkerClient(hostOf(of));
    assert.equal(await worker.whenReady(), null);
    // The start's sweep first, which would otherwise purge these deletes itself
    assert.equal((await worker.purge.done)?.status, 'nothing');
    const one = await deleteForGood(of, 0);
    const two = await deleteForGood(of, 0);
    const [a, b] = await Promise.all([worker.purge.request(), worker.purge.request()]);
    assert.deepEqual([a?.status, b?.status], ['purged', 'purged']);
    const held = await inPoint(of);
    assert.deepEqual([held.includes(one), held.includes(two)], [false, false]);
    assert.deepEqual(await pending(of), []);
    assert.equal((await worker.purge.request())?.status, 'nothing');
  });

  it('with PURGE_RECOVERY_POINTS off it never purges, and the tombstone stays pending for when it is on', async () => {
    assert.equal(PURGE_RECOVERY_POINTS, true);
    const of = await profileWith(/** @type {any} */ (FIXTURES.get('v8.basic')));
    const off = createWorkerClient({ ...hostOf(of), purgeRecoveryPoints: false });
    assert.equal(await off.whenReady(), null);
    const noteId = await deleteForGood(of);
    assert.equal(await off.purge.request(), null);
    assert.equal(await off.purge.done, null);
    assert.ok((await inPoint(of)).includes(noteId));
    assert.deepEqual(await pending(of), [noteId]);
    const on = createWorkerClient(hostOf(of));
    assert.equal(await on.whenReady(), null);
    assert.equal((await on.purge.done)?.status, 'purged');
    assert.equal((await inPoint(of)).includes(noteId), false);
  });

  it('journals each point a sweep left, but one it backed off, and the end of each stop it cleared (per-point stop)', () => {
    /** @type {Array<[string, unknown, unknown]>} */
    const journaled = [];
    const events = {
      event: (/** @type {string} */ code, /** @type {unknown} */ fields, /** @type {any} */ failure) =>
        void journaled.push([code, fields, failure ? failure.code : null]),
    };
    journalPurge(events, {
      status: 'stopped',
      tombstones: 1,
      rows: 5,
      failure: { code: 'record-mismatch', pointId: 'pre-migration-1760000000001' },
      stops: [
        { pointId: 'pre-migration-1760000000001', code: 'record-mismatch', backedOff: false },
        { pointId: 'pre-migration-1760000000002', code: 'record-mismatch', backedOff: true },
      ],
      backedOff: false,
      cleared: ['pre-migration-1760000000003'],
    });
    assert.deepEqual(journaled, [
      ['storage.purge-completed', { subjectId: 'pre-migration-1760000000003' }, null],
      ['storage.purge-stopped', { subjectId: 'pre-migration-1760000000001' }, 'record-mismatch'],
    ]);
  });

  it('journals a stopped purge once, not the wakes it backs off on, and its end once the point goes (review R93)', async () => {
    const of = await profileWith(/** @type {any} */ (FIXTURES.get('v8.basic')));
    /** @type {Array<[string, unknown, unknown]>} */
    const journaled = [];
    // The purge's, without the transforms' end, which the same events hear first (#20)
    const events = {
      event: (/** @type {string} */ code, /** @type {unknown} */ fields, /** @type {any} */ failure) => {
        if (code.startsWith('storage.purge-')) journaled.push([code, fields, failure ? failure.code : null]);
      },
    };
    const worker = createWorkerClient({ ...hostOf(of), events });
    assert.equal(await worker.whenReady(), null);
    assert.equal((await worker.purge.done)?.status, 'nothing');
    await deleteForGood(of);
    // The pinned point no longer reads back as it was copied: a row of a note that stays changed
    const recovery = /** @type {IDBDatabase} */ (await openRecovery(of.real, { create: false }));
    let pointId;
    try {
      pointId = (await listPoints(recovery))[0].id;
      const tx = recovery.transaction('rows', 'readwrite');
      const rows = tx.objectStore('rows');
      const range = KeyRange.bound([pointId, 'folders'], [pointId, 'folders\u0000'], false, true);
      const [row] = await new Promise((resolve, reject) => {
        const request = rows.getAll(range);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      rows.put({ ...row, value: { ...row.value, name: 'Bit rot' } });
      await new Promise((resolve, reject) => {
        tx.oncomplete = resolve;
        tx.onabort = () => reject(tx.error);
      });
    } finally {
      recovery.close();
    }

    assert.equal((await worker.purge.request())?.status, 'stopped');
    assert.equal((await worker.purge.request())?.status, 'stopped');
    assert.deepEqual(journaled, [['storage.purge-stopped', { subjectId: pointId }, 'record-mismatch']]);

    const store = /** @type {IDBDatabase} */ (await openRecovery(of.real, { create: false }));
    try {
      await discardPoint(store, pointId, { keyRange: KeyRange, limits: DEFAULT_LIMITS });
    } finally {
      store.close();
    }
    assert.equal((await worker.purge.request())?.status, 'purged');
    assert.deepEqual(journaled.slice(1), [['storage.purge-completed', { subjectId: pointId }, null]]);
    assert.deepEqual(await pending(of), []);
  });

  it('on a database the run left below 10 it never purges', async () => {
    const of = await profileWith(/** @type {any} */ (FIXTURES.get('v8.basic')));
    const worker = createWorkerClient(hostOf(of, { estimate: CRAMPED }));
    assert.equal((await worker.migration.done).status, 'space-blocked');
    assert.equal(await worker.purge.request(), null);
    assert.equal(await recoveryExists(of), false);
  });
});

describe("the worker's data transforms (#17 PR 3a)", () => {
  /**
   * The profile's `meta.schema` and whether every note has its group
   * @param {Profile} of
   */
  const state = async of => {
    const [schema] = (await recordsOf(of, 'meta')).filter(record => record.key === 'schema');
    const notes = await recordsOf(of, 'canvases');
    return { logicalVersion: schema.logicalVersion, grouped: notes.every(note => note.placement && note.lifecycle) };
  };

  it('at every start, once its run is in, runs the transforms the database still needs, then the purge, without holding the kernel up', async () => {
    const of = await profileWith(/** @type {any} */ (FIXTURES.get('v8.basic')));
    // The logical version as each holder of the points lock lets it go: the run, then the
    // transforms, then the records' catch-up (#33), then the purge, each after the one before
    const manager = legacyEnv.createLockManager();
    /** @type {number[]} */
    const released = [];
    const locks = {
      request: (/** @type {string} */ name, /** @type {any} */ options, /** @type {() => Promise<any>} */ callback) =>
        manager.request(name, options, async () => {
          try {
            return await callback();
          } finally {
            released.push((await state(of)).logicalVersion);
          }
        }),
    };
    const base = fakeTimers();
    let kept = 0;
    const timers = {
      ...base,
      setInterval: (/** @type {() => void} */ fn) => {
        kept += 1;
        return base.setInterval(fn);
      },
    };
    const worker = createWorkerClient({ ...hostOf(of), locks, timers, keepAlive: async () => {} });
    assert.equal(await worker.whenReady(), null);
    // Which ends first, since the versions alone read the same either way: the purge waits for
    // the catch-up (w11)
    /** @type {string[]} */
    const ended = [];
    const endings = Promise.all([
      worker.recordsCatchUp.done.then(() => ended.push('catch-up')),
      Promise.resolve(worker.purge.done).then(() => ended.push('purge')),
    ]);
    assert.equal((await worker.transforms.done)?.status, 'transformed');
    assert.equal((await worker.recordsCatchUp.done)?.status, 'done');
    assert.equal((await worker.purge.done)?.status, 'nothing');
    await endings;
    assert.deepEqual(ended, ['catch-up', 'purge']);
    // The transforms take it through logical 2 and 3 (#17 PR 3b) in one run
    assert.deepEqual(released, [1, 3, 3, 3]);
    assert.deepEqual(await state(of), { logicalVersion: 3, grouped: true });
    // The keepalive spans each: the run, the transforms, the catch-up, and the sweep
    assert.equal(kept, 4);
    await legacyEnv.waitFor(() => base.live.size === 0, { withinMs: 5000, message: 'the keepalive to stop' });
    // The next start finds nothing to do
    const next = createWorkerClient(hostOf(of));
    assert.equal(await next.whenReady(), null);
    assert.equal((await next.transforms.done)?.status, 'current');
  });

  it('on a database the run left below 11 it runs none, and reads nothing for them', async () => {
    const of = await profileWith(/** @type {any} */ (FIXTURES.get('v8.basic')));
    const worker = createWorkerClient(hostOf(of, { estimate: CRAMPED }));
    assert.equal((await worker.migration.done).status, 'space-blocked');
    assert.equal(await worker.whenReady(), null);
    assert.equal(await worker.transforms.done, null);
  });
});

/**
 * @template T
 * @param {IDBRequest<T>} request
 * @returns {Promise<T>}
 */
const answer = request =>
  new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });

/**
 * Runs `change` on CanvasTabDB's `names` in one readwrite transaction of the test's own
 * @param {Profile} of
 * @param {string[]} names
 * @param {(stores: Record<string, IDBObjectStore>) => Promise<void>} change
 */
async function edit(of, names, change) {
  const db = /** @type {IDBDatabase} */ (await answer(of.real.open(DB_NAME)));
  try {
    const tx = db.transaction(names, 'readwrite');
    const ended = new Promise((resolve, reject) => {
      tx.oncomplete = resolve;
      tx.onabort = () => reject(tx.error);
    });
    await change(Object.fromEntries(names.map(name => [name, tx.objectStore(name)])));
    await ended;
  } finally {
    db.close();
  }
}

/** @param {Profile} of - the transforms' recorded stop, if there is one */
const stopOf = async of => (await recordsOf(of, 'meta')).find(record => record.key === TRANSFORM_STOP_KEY);

/**
 * Moves the recorded stop back by TRANSFORM_RETRY_AFTER_MS, as half an hour passing would
 * @param {Profile} of
 */
const ageStop = of =>
  edit(of, ['meta'], async ({ meta }) => {
    const stop = await answer(meta.get(TRANSFORM_STOP_KEY));
    meta.put({ ...stop, at: stop.at - TRANSFORM_RETRY_AFTER_MS });
  });

// #20's journal pair for the transforms (#17 PR 3a, the lead's call): a stop is journaled once
// per code, from the stop record the run found, and the end once the transforms reach this
// build's logical version. Neither raises an incident in R1 (event-codes.js).
describe("the worker journals the data transforms' stops, once per code, and their end (#17 PR 3a, #20)", () => {
  /**
   * The synthesized profile at this build's structural version, its logical version set back to
   * 1 so every transform is still to run, and its notes without their group, whose first worker
   * start's transforms stop short of space. `start` starts another worker on it and answers its
   * transforms' outcome; every worker journals what the transforms do to `journaled`, as the
   * code, the fields, and the failure's code.
   */
  const stoppedOnce = async () => {
    const of = await profileWith(/** @type {any} */ (FIXTURES.get(`v${DB_VERSION}.basic`)));
    await edit(of, ['meta'], async ({ meta }) => {
      meta.put({ ...(await answer(meta.get('schema'))), logicalVersion: 1 });
    });
    /** @type {Array<[string, unknown, string | null]>} */
    const journaled = [];
    const events = {
      event: (/** @type {string} */ code, /** @type {unknown} */ fields, /** @type {any} */ failure) => {
        if (code.startsWith('storage.transforms-')) journaled.push([code, fields, failure ? failure.code : null]);
      },
    };
    /** @param {any} [estimate] */
    const start = async (estimate = CRAMPED) => {
      const worker = createWorkerClient({ ...hostOf(of, { estimate }), indexedDB: of.faults.factory, events });
      assert.equal(await worker.whenReady(), null);
      return worker.transforms.done;
    };
    const first = await start();
    assert.deepEqual(
      [first?.status, first?.failure, first?.backedOff],
      ['space-blocked', { code: 'space-short' }, false],
    );
    return { of, journaled, start };
  };

  it('journals a stop once, and not at the starts in the next half hour, which back off on it', async () => {
    const { journaled, start } = await stoppedOnce();
    const soon = await start();
    assert.deepEqual(journaled, [['storage.transforms-stopped', {}, 'space-short']]);
    assert.deepEqual([soon?.status, soon?.backedOff], ['space-blocked', true]);
  });

  it("doesn't journal the same code at a retry half an hour on: the stop the run found recorded has it, so a start before journaled it", async () => {
    const { of, journaled, start } = await stoppedOnce();
    const stopped = await stopOf(of);
    await ageStop(of);
    const retried = await start();
    assert.deepEqual(journaled, [['storage.transforms-stopped', {}, 'space-short']]);
    assert.deepEqual(
      [retried?.status, retried?.failure, retried?.backedOff, retried?.previous],
      ['space-blocked', { code: 'space-short' }, false, { status: 'space-blocked', code: 'space-short' }],
    );
    assert.ok((await stopOf(of))?.at >= stopped.at, 'the retry read the stores and recorded its own stop');
  });

  it('journals a stop with a new code', async () => {
    const { of, journaled, start } = await stoppedOnce();
    await ageStop(of);
    // Room for the point, until the disk refuses its copy
    const aborted = of.faults.abortAfterNextWrite('rows', 'QuotaExceededError');
    const refused = await start(ROOMY);
    await aborted;
    assert.deepEqual(journaled, [
      ['storage.transforms-stopped', {}, 'space-short'],
      ['storage.transforms-stopped', {}, 'quota'],
    ]);
    assert.deepEqual(
      [refused?.status, refused?.failure, refused?.previous],
      ['space-blocked', { code: 'quota' }, { status: 'space-blocked', code: 'space-short' }],
    );
  });

  it("journals the end once the transforms reach this build's logical version, and nothing at the starts after it", async () => {
    const { of, journaled, start } = await stoppedOnce();
    await ageStop(of);
    assert.equal((await start(ROOMY))?.status, 'transformed');
    assert.equal((await start(ROOMY))?.status, 'current');
    assert.deepEqual(journaled, [
      ['storage.transforms-stopped', {}, 'space-short'],
      ['storage.transforms-completed', {}, null],
    ]);
  });

  it("journals no end on a database the run only made, where they had nothing to change, as the run's own end isn't journaled there", async () => {
    const of = newProfile();
    /** @type {string[]} */
    const journaled = [];
    const events = { event: (/** @type {string} */ code) => void journaled.push(code) };
    const worker = createWorkerClient({ ...hostOf(of), events });
    assert.equal(await worker.whenReady(), null);
    assert.deepEqual([(await worker.migration.done).status, (await worker.migration.done).shape], ['migrated', 'none']);
    assert.equal((await worker.transforms.done)?.status, 'transformed');
    assert.equal((await worker.purge.done)?.status, 'nothing');
    assert.deepEqual(journaled, []);
  });

  it('journals a stop after the end again, since the end takes the stop record with it', async () => {
    const { of, journaled, start } = await stoppedOnce();
    await ageStop(of);
    assert.equal((await start(ROOMY))?.status, 'transformed');
    assert.equal(await stopOf(of), undefined);
    // As a later build's step would be: pending, with a note to fill, and no room for its point
    await edit(of, ['meta', 'canvases'], async ({ meta, canvases }) => {
      const schema = await answer(meta.get('schema'));
      meta.put({ ...schema, logicalVersion: 1 });
      const [note] = await answer(canvases.getAll());
      canvases.put(withoutPlacement(note));
    });
    const again = await start();
    assert.deepEqual(journaled, [
      ['storage.transforms-stopped', {}, 'space-short'],
      ['storage.transforms-completed', {}, null],
      ['storage.transforms-stopped', {}, 'space-short'],
    ]);
    assert.deepEqual(
      [again?.status, again?.failure, again?.backedOff, again?.previous],
      ['space-blocked', { code: 'space-short' }, false, null],
    );
  });

  it("journals the stop at a meta.schema they can't read with its code, which the registry lists (meta-unreadable)", async () => {
    // A schema record without its logical version, which the run's own check refuses, so the
    // transforms meet one only when it changed after the run
    const of = await profileWith(/** @type {any} */ (FIXTURES.get(`v${DB_VERSION}.basic`)));
    await edit(of, ['meta'], async ({ meta }) => {
      const schema = await answer(meta.get('schema'));
      delete schema.logicalVersion;
      meta.put(schema);
    });
    const ended = await transform(of);
    assert.deepEqual([ended.status, ended.failure, ended.previous], ['failed', { code: 'meta-unreadable' }, null]);
    // The worker's failure events, which keep a failure's code only when it's a registered one
    const trust = trustProfile();
    const events = createFailureEvents({
      surface: 'worker-internal',
      host: () => ({
        indexedDB: trust.faults.factory,
        keyRange: fakeKeyRange,
        settings: trust.settings,
        locks: trust.locks,
        clock: { now: () => Date.now() },
        ids: { next: () => webcrypto.randomUUID() },
      }),
    });
    journalTransforms(events, ended);
    await events.flush();
    const store = databaseOn(trust);
    try {
      const { records } = await openRecords(store, trust);
      assert.deepEqual(
        (await records.events())
          .filter(event => event.code.startsWith('storage.'))
          .map(event => [event.code, event.fields]),
        [['storage.transforms-stopped', { surface: 'worker-internal', errorCode: 'meta-unreadable' }]],
      );
    } finally {
      store.close();
    }
  });
});

/**
 * A close-time draft of a note this profile doesn't hold, which the apply answers close-draft-gone:
 * a commit that writes nothing, so it shows the command ran on a kernel that may run it
 * @param {string} id
 */
const goneDraft = id => ({
  v: 1,
  id,
  noteId: 'n-gone',
  base: { revision: null, updatedAt: Date.now() - 1000, issued: [] },
  at: Date.now(),
  blocks: [legacyEnv.block('b-gone', 'n-gone', 0, 'Edited as the page closed', { updatedAt: Date.now() - 500 })],
  deletedBlockIds: [],
  preview: 'Edited as the page closed',
  todoProgress: null,
  linkedNames: [],
});

/**
 * A note's quick-note command, as Popup sends it
 * @param {string} id
 */
const quickNote = id => ({
  type: 'createNote',
  commandId: `c-${id}`,
  noteId: id,
  name: 'Quick',
  blocks: [{ id: `b-${id}`, type: 'text', content: 'A quick note' }],
});

describe("a page's command on the worker, on a kernel of its surface (#35 slice 4b-2)", () => {
  it("runs Popup's commands on a Popup kernel on the worker's adapter, refuses what the shared catalog doesn't grant Popup, and gives Side Panel a kernel of its own (#35 slice 4b-2, rule 5)", async () => {
    const of = newProfile();
    const worker = /** @type {any} */ (createWorkerClient(hostOf(of)));
    const popup = { surface: 'popup' };
    // Popup's apply commits, which the worker's own kernel isn't granted
    const applied = await worker.execute(
      { type: 'applyCloseDraft', commandId: 'c-apply', draft: goneDraft('1762444800000-popup') },
      popup,
    );
    assert.deepEqual(
      [applied.kind, applied.code],
      ['committed', 'close-draft-gone'],
      `Popup's apply runs on a Popup kernel: ${JSON.stringify(applied)}`,
    );
    // Its quick note commits, and an append the worker's own kernel runs is refused, with nothing written
    assert.equal((await worker.execute(quickNote('n-popup'), popup)).kind, 'committed');
    const appended = await worker.execute(
      {
        type: 'insertBlocks',
        commandId: 'c-append',
        noteId: 'n-popup',
        blocks: [{ id: 'b-append', type: 'text', content: "Not Popup's to add" }],
      },
      popup,
    );
    assert.deepEqual(
      [appended.kind, appended.reason, appended.code],
      ['rejected', 'policy', 'not-on-surface'],
      `Popup's append is refused on Popup's kernel: ${JSON.stringify(appended)}`,
    );
    assert.deepEqual(
      (await recordsOf(of, 'elements')).filter(block => block.id === 'b-append'),
      [],
    );
    // Side Panel's commands run on a kernel of its own: its apply commits, and its createNote, which
    // Popup's kernel would take, is refused
    const side = { surface: 'sidepanel' };
    const sideApplied = await worker.execute(
      { type: 'applyCloseDraft', commandId: 'c-side-apply', draft: goneDraft('1762444800000-side') },
      side,
    );
    assert.equal(sideApplied.kind, 'committed', JSON.stringify(sideApplied));
    const sideMade = await worker.execute(quickNote('n-side'), side);
    assert.deepEqual(
      [sideMade.kind, sideMade.reason, sideMade.code],
      ['rejected', 'policy', 'not-on-surface'],
      `Side Panel's createNote runs on Side Panel's kernel, not Popup's: ${JSON.stringify(sideMade)}`,
    );
    assert.deepEqual(
      (await recordsOf(of, 'canvases')).filter(note => note.id === 'n-side'),
      [],
    );
    // And with no surface, the worker's own capture runs on its own kernel, as before
    assert.equal((await capture(worker, 'own')).kind, 'committed');
  });
});

/**
 * The commands the new tab sends the worker over the port (#35 slice 4d, rule 10): every one the
 * shared catalog grants the new tab but the two that stay off the worker's new tab kernel, its
 * session's write, which the page commits itself, and startup maintenance, which the worker's own
 * start runs. The catalog's, not the worker's tables', so a table that drops one is caught.
 */
const STAY_OFF = Object.freeze(['saveWorkspaceSession', 'runStartupMaintenance']);
const NEWTAB_SENDS = Object.freeze(
  Object.keys(COMMANDS).filter(
    type =>
      COMMANDS[/** @type {keyof typeof COMMANDS} */ (type)].surfaces.includes('newtab') && !STAY_OFF.includes(type),
  ),
);

/** @param {number} [count] */
const rounds = async (count = 50) => {
  for (let round = 0; round < count; round++) await new Promise(resolve => setImmediate(resolve));
};

/**
 * `local`, chrome.storage.local, as a store whose set of the sidebar width `held` waits until the
 * case lets it go, as a slow write would, with each set's sidebar width in `landed`, by when it
 * reached the store
 * @param {any} local
 * @param {number} held
 */
const holdingSets = (local, held) => {
  /** @type {number[]} */
  const landed = [];
  /** @type {() => void} */
  let release = () => {};
  const released = new Promise(resolve => {
    release = () => resolve(undefined);
  });
  /** @type {() => void} */
  let reach = () => {};
  const reached = new Promise(resolve => {
    reach = () => resolve(undefined);
  });
  const store = {
    get: (/** @type {any} */ keys) => local.get(keys),
    remove: (/** @type {any} */ keys) => local.remove(keys),
    set: async (/** @type {Record<string, unknown>} */ items) => {
      const width = items.setting_sidebarWidth;
      if (width === held) {
        reach();
        await released;
      }
      // The case's own, past the first-run setting the worker's start writes
      if (typeof width === 'number' && width >= held) landed.push(width);
      return local.set(items);
    },
  };
  return { store, landed, reached, release };
};

/** @param {string} id @param {number} sidebarWidth */
const widthSet = (id, sidebarWidth) => ({ type: 'setPreferences', commandId: `c-${id}`, values: { sidebarWidth } });

describe("the new tab's commands on the worker, on a kernel of its surface (#35 slice 4d)", () => {
  it("runs every command the new tab sends on a new tab kernel, its backup tasks among them, leaves its session's write and startup maintenance to the page and the worker's start, and refuses what only the worker runs (#35 slice 4d, rule 10)", async () => {
    assert.equal(NEWTAB_SENDS.length, 46);
    const of = newProfile();
    const worker = /** @type {any} */ (createWorkerClient(hostOf(of)));
    const newtab = { surface: 'newtab' };
    /** @type {Array<[string, string, unknown, unknown]>} */
    const answers = [];
    /** @type {any} */
    let imported = null;
    for (const [type, fields] of Object.entries(COMMAND_SAMPLES)) {
      if (!NEWTAB_SENDS.includes(type)) continue;
      const outcome = await worker.execute({ ...fields, type, commandId: `c-${type}` }, newtab);
      answers.push([type, outcome.kind, outcome.reason, outcome.code]);
      if (type === 'importBackup') imported = outcome;
    }
    assert.equal(answers.length, 46);
    assert.deepEqual(
      answers.filter(([, kind, reason]) => kind === 'rejected' && reason === 'policy'),
      [],
      "none is refused as not registered or not the new tab's",
    );
    // The backup tasks run here now, on the adapter's backups: the import's note lands, and the
    // automatic backup is in chrome.storage.local
    assert.deepEqual(
      answers
        .filter(([type]) => type === 'createAutoBackup' || type === 'importBackup')
        .map(([type, kind]) => [type, kind]),
      [
        ['createAutoBackup', 'committed'],
        ['importBackup', 'committed'],
      ],
    );
    assert.ok(
      Object.keys(legacyEnv.plain(of.chrome.local)).some(key => key.startsWith('auto_backup_')),
      'an automatic backup',
    );
    // The import gives the note it adds an id of its own, the first its outcome names
    const [importedId] = imported?.changedIds ?? [];
    assert.equal(
      (await recordsOf(of, 'canvases')).filter(note => note.id === importedId && note.name === 'Plan').length,
      1,
      `the import's note: ${JSON.stringify(imported)}`,
    );
    // The two that stay off it are refused, with nothing written, and so is the worker's own capture
    for (const type of STAY_OFF) {
      const fields = COMMAND_SAMPLES[/** @type {keyof typeof COMMAND_SAMPLES} */ (type)];
      const outcome = await worker.execute({ ...fields, type, commandId: `c-again-${type}` }, newtab);
      assert.deepEqual([outcome.kind, outcome.reason, outcome.code], ['rejected', 'policy', 'not-registered'], type);
    }
    const captured = await worker.execute(
      {
        type: 'captureToDailyNote',
        commandId: 'c-newtab-capture',
        noteId: 'd-newtab',
        blockId: 'b-newtab',
        capture: { type: 'text', content: 'Not the new tab to capture' },
      },
      newtab,
    );
    assert.deepEqual([captured.kind, captured.reason], ['rejected', 'policy'], JSON.stringify(captured));
    assert.deepEqual(
      (await recordsOf(of, 'canvases')).filter(note => note.id === 'd-newtab'),
      [],
    );
  });

  it("writes the new tab's settings one after another, each checked against its turn's live right before it goes: a cut turn's held set lands before the next turn's, and one cut while it waits never goes (#35 slice 4d, rule 11)", async () => {
    const of = newProfile();
    const held = holdingSets(of.chrome.api.storage.local, 301);
    const worker = /** @type {any} */ (createWorkerClient({ ...hostOf(of), settings: held.store }));
    assert.equal(await worker.whenReady(), null);
    let cutA = false;
    let cutC = false;
    // Turn A's set reaches the store and is held there, and the queue cuts A
    const a = worker.execute(widthSet('a', 301), { surface: 'newtab', live: () => !cutA });
    const first = await Promise.race([held.reached.then(() => 'held'), a]);
    assert.equal(first, 'held', `A's set reached the store first: ${JSON.stringify(first)}`);
    cutA = true;
    // B and C come after it, each live as its kernel checks it; C is cut while it waits
    const b = worker.execute(widthSet('b', 302), { surface: 'newtab', live: () => true });
    const c = worker.execute(widthSet('c', 303), { surface: 'newtab', live: () => !cutC });
    await rounds();
    cutC = true;
    held.release();
    const [doneA, doneB, doneC] = await Promise.all([a, b, c]);
    assert.deepEqual(held.landed, [301, 302], 'A, then B, and C never');
    assert.deepEqual(
      [doneA.kind, doneB.kind, doneC.kind, doneC.code],
      ['committed', 'committed', 'unavailable', 'turn-exceeded'],
    );
    assert.equal(of.chrome.local.setting_sidebarWidth, 302);
  });

  it("makes #33's recovery copy as it opens a database at 8 that lacks a store, as it is, under the copy's lock, and once with the new tab's copy on too (#35 slice 4d, rule 9)", async () => {
    const WITHOUT_THEMES = {
      omit: ['themes'],
      records: {
        canvases: [legacyEnv.note('n1', { name: 'Kept' })],
        elements: [legacyEnv.block('b1', 'n1', 0, 'Kept text')],
      },
    };
    /** @param {Profile} of */
    const copiesIn = of =>
      Object.entries(legacyEnv.plain(of.chrome.local)).filter(
        ([key, copy]) => key.startsWith('recovery_backup_') && /** @type {any} */ (copy).reason === 'missing-stores',
      );
    // The worker alone, whose run is short of space, so it opens the database as it is
    const of = newProfile();
    await legacyEnv.createDatabase(of.real, WITHOUT_THEMES);
    const host = hostOf(of, { estimate: CRAMPED });
    /** @type {string[]} */
    const named = [];
    const request = host.locks.request.bind(host.locks);
    host.locks.request = (/** @type {string} */ name, /** @type {any[]} */ ...rest) => {
      named.push(name);
      return /** @type {any} */ (request)(name, ...rest);
    };
    const worker = createWorkerClient(host);
    assert.equal(await worker.whenReady(), null);
    assert.equal((await worker.migration.done).status, 'space-blocked');
    assert.equal(copiesIn(of).length, 1);
    assert.deepEqual(legacyEnv.plain(of.chrome.local)[MISSING_STORES_COPY_KEY].missingStores, ['themes']);
    assert.ok(named.includes(RECOVERY_COPY_LOCK), `the copy's lock: ${named.join(', ')}`);
    assert.equal((await inspect(of.real)).version, 8, 'the database as it was');
    // With the new tab's adapter opening beside it on the same locks, as the new tab still copies
    // until the page move, one copy between them
    const both = newProfile();
    await legacyEnv.createDatabase(both.real, WITHOUT_THEMES);
    const shared = hostOf(both, { estimate: CRAMPED });
    const tab = createIndexedDbAdapter({
      indexedDB: both.real,
      settings: both.chrome.api.storage.local,
      locks: shared.locks,
      mode: 'existing',
      requireCore: true,
      maintains: true,
      copiesMissingStores: true,
      backups: true,
    });
    await Promise.all([createWorkerClient(shared).whenReady(), tab.open()]);
    assert.equal(copiesIn(both).length, 1);
    tab.close();
  });

  it("commits no unit of a Replace all import whose turn the queue cut after the kernel's check, on #247's check inside its commit, and commits one whose turn it didn't cut (#35 slice 4d, rule 11)", async () => {
    const of = newProfile();
    const local = of.chrome.api.storage.local;
    // Replace all saves its recovery copy before its unit commits, so a cut there comes between
    let atCopy = () => {};
    const settings = {
      get: (/** @type {any} */ keys) => local.get(keys),
      remove: (/** @type {any} */ keys) => local.remove(keys),
      set: (/** @type {Record<string, unknown>} */ items) => {
        if (Object.keys(items).some(key => key.startsWith('recovery_backup_'))) atCopy();
        return local.set(items);
      },
    };
    const worker = /** @type {any} */ (createWorkerClient({ ...hostOf(of), settings }));
    assert.equal(await worker.whenReady(), null);
    // An import gives the note it adds an id of its own, so each is found by its name
    /** @param {string} id */
    const replacing = id => ({
      type: 'importBackup',
      commandId: `c-${id}`,
      mode: 'replace',
      backup: { version: 1, exportedAt: 1, canvases: [{ id, name: `Imported ${id}` }], elements: [] },
    });
    /** @param {string} id */
    const named = async id => (await recordsOf(of, 'canvases')).filter(note => note.name === `Imported ${id}`);
    let cut = false;
    atCopy = () => {
      cut = true;
    };
    const cutOne = await worker.execute(replacing('n-cut'), { surface: 'newtab', live: () => !cut });
    assert.deepEqual(
      [cutOne.kind, cutOne.cause, cutOne.code],
      ['unavailable', 'coordinator', 'turn-exceeded'],
      JSON.stringify(cutOne),
    );
    assert.equal(cut, true, 'cut as its recovery copy was saved');
    assert.deepEqual(await named('n-cut'), []);
    atCopy = () => {};
    const kept = await worker.execute(replacing('n-kept'), { surface: 'newtab', live: () => true });
    assert.equal(kept.kind, 'committed', JSON.stringify(kept));
    assert.equal((await named('n-kept')).length, 1);
  });

  it("lets a capture's open of a database at 8 that lacks a store go on when #33's copy can't be written: the capture commits, with no copy or marker left (#35 slice 4d, rule 9)", async () => {
    const of = newProfile();
    await legacyEnv.createDatabase(of.real, {
      omit: ['themes'],
      records: {
        canvases: [legacyEnv.note('n1', { name: 'Kept' })],
        elements: [legacyEnv.block('b1', 'n1', 0, 'Kept text')],
      },
    });
    const local = of.chrome.api.storage.local;
    /** @type {string[][]} */
    const thrown = [];
    // The copy's write throws, as a full chrome.storage.local's does, and every other write goes on
    const settings = {
      get: (/** @type {any} */ keys) => local.get(keys),
      remove: (/** @type {any} */ keys) => local.remove(keys),
      set: (/** @type {Record<string, unknown>} */ items) => {
        if (Object.keys(items).some(key => key.startsWith('recovery_backup_'))) {
          thrown.push(Object.keys(items));
          throw new Error('QUOTA_BYTES quota exceeded');
        }
        return local.set(items);
      },
    };
    // Short of space, so its run leaves the database as it is, and the capture waits on the open
    const worker = /** @type {any} */ (createWorkerClient({ ...hostOf(of, { estimate: CRAMPED }), settings }));
    const captured = await capture(worker, 'copy-failed');
    assert.equal(captured.kind, 'committed', JSON.stringify(captured));
    assert.deepEqual(
      thrown.map(keys => keys.slice(1)),
      [[MISSING_STORES_COPY_KEY]],
      'the copy was tried once, with its marker in the same write',
    );
    const stored = legacyEnv.plain(of.chrome.local);
    assert.equal(stored[MISSING_STORES_COPY_KEY], undefined);
    assert.deepEqual(
      Object.keys(stored).filter(key => key.startsWith('recovery_backup_')),
      [],
    );
    assert.equal((await worker.migration.done).status, 'space-blocked');
    assert.equal((await recordsOf(of, 'elements')).filter(block => block.id === 'b-copy-failed').length, 1);
    assert.equal((await inspect(of.real)).version, 8, 'the database as it was');
  });
});
