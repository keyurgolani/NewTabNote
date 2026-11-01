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
} from '../../js/kernel/composition/background.js';
import { createIndexedDbAdapter } from '../../js/kernel/adapters/indexeddb/adapter.js';
import { createKernel } from '../../js/kernel/core/application/kernel.js';
import { createBaselinePolicy } from '../../js/kernel/core/ports/policy.js';
import { SWEPT_KEY } from '../../js/kernel/adapters/indexeddb/ledger.js';
import { exportPoint } from '../../js/kernel/adapters/indexeddb/legacy-export.js';
import {
  DEFAULT_LIMITS,
  discardPoint,
  listPoints,
  openRecovery,
} from '../../js/kernel/adapters/indexeddb/recovery-points.js';
import { LEGACY_STORE_NAMES } from '../../js/kernel/adapters/indexeddb/registry.js';
import { DB_VERSION } from '../../js/kernel/adapters/indexeddb/schema.js';
import { detectShape, inspect } from '../../js/kernel/adapters/indexeddb/shapes.js';
import { legacyEnv, profileWith, synthesized } from './migration-support.mjs';
import { recordsOf } from './storage-fixture.mjs';
import { CALLERS } from './support.mjs';

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
    // v10.basic's ledger rows are from 2025, past the 30 days a row is kept
    const of = await profileWith(/** @type {any} */ (FIXTURES.get('v10.basic')));
    assert.equal((await recordsOf(of, 'operations')).length, 3);
    const swept = async () => (await recordsOf(of, 'meta')).find(record => record.key === SWEPT_KEY);
    const worker = createWorkerClient(hostOf(of));
    assert.equal(await worker.whenReady(), null);
    assert.equal((await worker.migration.done).status, 'current');
    // The sweep runs behind the kernel, so the test waits on it in real time
    const deadline = Date.now() + 10_000;
    while (!(await swept()) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
    const record = await swept();
    assert.equal(typeof record?.sweptAt, 'number');
    assert.deepEqual(await recordsOf(of, 'operations'), []);
    // A capture keeps its row, and the next start, within the day, sweeps nothing
    assert.equal((await capture(worker, 'kept')).kind, 'committed');
    const again = createWorkerClient(hostOf(of));
    assert.equal(await again.whenReady(), null);
    await new Promise(resolve => setTimeout(resolve, 50));
    assert.deepEqual(await swept(), record);
    assert.equal((await recordsOf(of, 'operations')).length, 1);
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
    const events = {
      event: (/** @type {string} */ code, /** @type {unknown} */ fields, /** @type {any} */ failure) =>
        void journaled.push([code, fields, failure ? failure.code : null]),
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
