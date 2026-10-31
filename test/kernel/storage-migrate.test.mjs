// #17 PR 1a, the migration runner (migrate.js) and the registry's step 9 (registry.js): every
// synthesized fixture runs to 9 and equals its independently derived expected file, recovery
// point included; a second run writes nothing; a run stopped at every step or batch and run
// again ends the same; short of space, blocked, or failing, nothing runs past what failed and
// the outcome says so; a database outside the matrix stays as it was, with a point; and step 9
// makes only synchronous createObjectStore, createIndex, and put calls, keeping all ten legacy
// stores.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { webcrypto } from 'node:crypto';

import { exportPoint, exportablePoint } from '../../js/kernel/adapters/indexeddb/legacy-export.js';
import { committed, openRecovery } from '../../js/kernel/adapters/indexeddb/recovery-points.js';
import { LEGACY_STORE_NAMES, STEPS, legacySchema } from '../../js/kernel/adapters/indexeddb/registry.js';
import { detectShape, inspect, openWithoutUpgrade } from '../../js/kernel/adapters/indexeddb/shapes.js';
import { fillCanaries, loadFixture } from '../fixtures/storage/load-fixture.mjs';
import {
  KeyRange,
  Killed,
  legacyEnv,
  asDumped,
  dump,
  expectedFor,
  newProfile,
  profileWith,
  recordsIn,
  run,
  start,
  synthesized,
} from './migration-support.mjs';
import { NOW } from './support.mjs';

/** @typedef {import('./migration-support.mjs').Profile} Profile */

const FIXTURES = synthesized();

/** What each fixture's run answers */
const OUTCOMES = {
  'none.basic': 'migrated',
  'none.empty-v1': 'migrated',
  'v9.basic': 'current',
  'v8.missing-core': 'refused',
  'v8.extra-store': 'refused',
  'v9.newer': 'refused',
};
/** @param {string} id */
const outcomeOf = id => /** @type {Record<string, string>} */ (OUTCOMES)[id] || 'migrated';

/** A small batch bound, so the copy takes many batches */
const SMALL = Object.freeze({ records: 2, bytes: 2 * 1024 * 1024 });

describe('every fixture through the registry to 9', () => {
  for (const [id, fixture] of FIXTURES) {
    it(`${id}: ${outcomeOf(id)}, and the profile equals expected/${id}.v9.json`, async () => {
      const of = await profileWith(fixture);
      const outcome = await run(of);
      assert.equal(outcome.status, outcomeOf(id), JSON.stringify(outcome));
      const expected = expectedFor(id);
      assert.deepStrictEqual(await dump(of, expected.header), asDumped(expected));
    });
  }

  for (const [id, fixture] of FIXTURES) {
    it(`${id}: a second run changes nothing and adds no receipt`, async () => {
      const of = await profileWith(fixture);
      await run(of);
      const once = await dump(of);
      const again = await run(of);
      assert.ok(['current', 'refused'].includes(again.status), JSON.stringify(again));
      assert.deepStrictEqual(again.steps, []);
      assert.deepStrictEqual(await dump(of), once);
      // Nothing written: no readwrite transaction, and no upgrade
      const before = of.faults.transactions.length;
      await run(of);
      assert.deepStrictEqual(
        of.faults.transactions.slice(before).filter(tx => tx.mode !== 'readonly'),
        [],
      );
    });
  }
});

describe('a run stopped anywhere and run again', () => {
  const STOPPED = [
    'v8.basic',
    'v2-idb-settings.basic',
    'v8.missing-themes',
    'none.basic',
    'v8.missing-core',
    'v9.newer',
  ];
  for (const id of STOPPED) {
    it(`${id}: stopped at each step and batch in turn, the next run ends at the expected file`, async () => {
      const expected = asDumped(expectedFor(id));
      let stops = 0;
      for (let at = 1; ; at++) {
        const of = await profileWith(/** @type {any} */ (FIXTURES.get(id)));
        /** @type {string[]} */
        const labels = [];
        let killed = false;
        const first = await run(of, {
          limits: SMALL,
          hooks: {
            between: label => {
              labels.push(label);
              if (labels.length === at) {
                killed = true;
                throw new Killed();
              }
            },
          },
        });
        if (!killed) {
          stops = labels.length;
          assert.equal(first.status, outcomeOf(id));
          break;
        }
        assert.equal(first.status, 'failed');
        // A new worker: its own locks, and nothing held over but what's on disk
        const second = await run(of, { limits: SMALL });
        // Stopped after its last write, the run had finished: the next finds nothing to do
        const finished = labels[labels.length - 1] === 'receipts';
        assert.equal(
          second.status,
          finished ? 'current' : outcomeOf(id),
          `stopped at ${labels.join(' > ')}: ${JSON.stringify(second)}`,
        );
        assert.deepStrictEqual(await dump(of, expected.header), expected, `stopped at ${labels.join(' > ')}`);
        const third = await run(of, { limits: SMALL });
        assert.ok(['current', 'refused'].includes(third.status));
      }
      assert.ok(stops >= 3, `only ${stops} places to stop`);
    });
  }
});

describe('space', () => {
  it('short of space: no point, no step, the database as it was, and a logged outcome', async () => {
    const fixture = /** @type {any} */ (FIXTURES.get('v8.basic'));
    const of = await profileWith(fixture);
    const before = await dump(of);
    const outcome = await run(of, { estimate: async () => ({ quota: 100 * 1024 ** 2, usage: 50 * 1024 ** 2 }) });
    assert.equal(outcome.status, 'space-blocked');
    assert.deepStrictEqual(outcome.failure, { code: 'space-short' });
    assert.deepStrictEqual(await dump(of), before);
    assert.deepStrictEqual(
      of.logs.map(line => line.event),
      ['storage-migration'],
    );
    assert.equal(of.logs[0].detail.status, 'space-blocked');
  });

  it('enough is twice the copy plus 64 MB: just under that blocks, just over runs', async () => {
    const fixture = /** @type {any} */ (FIXTURES.get('v8.data-urls'));
    const { measureStores, storesToCopy, DEFAULT_LIMITS } =
      await import('../../js/kernel/adapters/indexeddb/recovery-points.js');
    const { openWithoutUpgrade } = await import('../../js/kernel/adapters/indexeddb/shapes.js');
    const { KeyRange } = await import('./migration-support.mjs');
    const measuring = await profileWith(fixture);
    const db = /** @type {IDBDatabase} */ (await openWithoutUpgrade(measuring.real, 'CanvasTabDB'));
    const bytes = await measureStores(db, storesToCopy(db), { keyRange: KeyRange, limits: DEFAULT_LIMITS });
    db.close();
    const need = 2 * bytes + 64 * 1024 * 1024;
    const short = await profileWith(fixture);
    assert.equal((await run(short, { estimate: async () => ({ quota: need - 1, usage: 0 }) })).status, 'space-blocked');
    const enough = await profileWith(fixture);
    assert.equal((await run(enough, { estimate: async () => ({ quota: need, usage: 0 }) })).status, 'migrated');
  });

  it("an estimate that can't be read is not short: the run goes ahead and says so", async () => {
    const of = await profileWith(/** @type {any} */ (FIXTURES.get('v8.basic')));
    const outcome = await run(of, {
      estimate: async () => {
        throw new Error('no estimate');
      },
    });
    assert.equal(outcome.status, 'migrated');
    assert.ok(of.logs.some(line => line.event === 'storage-migration-space-unknown'));
  });
});

describe('a blocked upgrade', () => {
  it('answers blocked-upgrade within openWithinMs, keeps waiting, and migrates once the connection closes', async () => {
    const fixture = /** @type {any} */ (FIXTURES.get('v8.basic'));
    const of = await profileWith(fixture);
    // A 1.3.0-era page: open, with no versionchange handler
    const old = await new Promise((resolve, reject) => {
      const request = of.real.open('CanvasTabDB');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    let blocked = 0;
    // Long enough for the point to be made on a loaded machine first, so the answer is the block
    const within = 3000;
    const began = Date.now();
    const started = start(of, { openWithinMs: within, onBlocked: () => (blocked += 1) });
    try {
      const answer = await started.answer;
      assert.deepStrictEqual(answer, { status: 'blocked-upgrade', retryable: true });
      assert.ok(Date.now() - began < within + 1000, 'answered late');
      assert.equal(started.state(), 'blocked-upgrade');
      assert.equal(blocked, 1);
      // Nothing structural ran (any other open now would queue behind the upgrade)
      assert.equal(/** @type {IDBDatabase} */ (old).version, 8);
    } finally {
      // Even when an assertion fails, so the run ends and the file can exit
      /** @type {IDBDatabase} */ (old).close();
    }
    const outcome = await started.done;
    assert.equal(outcome.status, 'migrated');
    const expected = expectedFor('v8.basic');
    assert.deepStrictEqual(await dump(of, expected.header), asDumped(expected));
    assert.ok(of.logs.some(line => line.event === 'storage-migration-blocked'));
  });

  it('answers with the outcome itself when the run finishes first', async () => {
    const of = await profileWith(/** @type {any} */ (FIXTURES.get('v8.basic')));
    const started = start(of, { openWithinMs: 5000 });
    assert.equal(/** @type {any} */ (await started.answer).status, 'migrated');
  });

  it('two runs at once run one after the other under storage.migrate, and the second finds nothing to do', async () => {
    const of = await profileWith(/** @type {any} */ (FIXTURES.get('v8.basic')));
    const locks = legacyEnv.createLockManager();
    const [a, b] = await Promise.all([run(of, { locks }), run(of, { locks })]);
    assert.deepStrictEqual([a.status, b.status], ['migrated', 'current']);
    const expected = expectedFor('v8.basic');
    assert.deepStrictEqual(await dump(of, expected.header), asDumped(expected));
  });

  it('without Web Locks it runs nothing', async () => {
    const of = await profileWith(/** @type {any} */ (FIXTURES.get('v8.basic')));
    const before = await dump(of);
    const outcome = await run(of, { locks: /** @type {any} */ (null) });
    assert.deepStrictEqual([outcome.status, outcome.failure], ['failed', { code: 'locks-unavailable' }]);
    assert.deepStrictEqual(await dump(of), before);
  });
});

describe('faults on both databases', () => {
  /**
   * A v8.basic profile, a fault set up on it, a run, and then a clean run that must end at the
   * expected file
   * @param {(of: Profile) => void} fault
   * @param {string} status - what the faulted run answers
   * @param {string} code
   */
  async function faulted(fault, status, code) {
    const of = await profileWith(/** @type {any} */ (FIXTURES.get('v8.basic')));
    fault(of);
    const outcome = await run(of, { limits: SMALL });
    assert.deepStrictEqual([outcome.status, outcome.failure && outcome.failure.code], [status, code]);
    const again = await run(of, { limits: SMALL });
    assert.equal(again.status, 'migrated', JSON.stringify(again));
    const expected = expectedFor('v8.basic');
    assert.deepStrictEqual(await dump(of, expected.header), asDumped(expected));
    return { of, outcome };
  }

  it('CanvasTabDB open: a VersionError at the upgrade leaves it at 8, keeps the verified point, and the next run reuses it', async () => {
    const of = await profileWith(/** @type {any} */ (FIXTURES.get('v8.basic')));
    const outcome = await run(of, {
      hooks: {
        between: label => (label === 'verified' ? of.faults.failNextOpen('CanvasTabDB', 'VersionError') : undefined),
      },
    });
    assert.deepStrictEqual([outcome.status, outcome.failure], ['failed', { code: 'version-too-new' }]);
    assert.equal((await inspect(of.real)).version, 8);
    const point = recordsIn(await dump(of), 'NewTabNoteRecovery', 'points');
    assert.equal(point.length, 1);
    const again = await run(of);
    assert.equal(again.status, 'migrated');
    assert.equal(again.recoveryPointId, point[0].key);
    const expected = expectedFor('v8.basic');
    assert.deepStrictEqual(await dump(of, expected.header), asDumped(expected));
  });

  it('NewTabNoteRecovery open: a VersionError runs nothing', async () => {
    const of = await profileWith(/** @type {any} */ (FIXTURES.get('v8.basic')));
    const before = await dump(of);
    of.faults.failNextOpen('NewTabNoteRecovery', 'VersionError');
    const outcome = await run(of);
    assert.deepStrictEqual([outcome.status, outcome.failure], ['failed', { code: 'version-too-new' }]);
    assert.deepStrictEqual(await dump(of), before);
  });

  it('NewTabNoteRecovery at a version this build does not know: refused, left as it is, nothing runs', async () => {
    const of = await profileWith(/** @type {any} */ (FIXTURES.get('v8.basic')));
    await new Promise((resolve, reject) => {
      const request = of.real.open('NewTabNoteRecovery', 2);
      request.onupgradeneeded = () => request.result.createObjectStore('points', { keyPath: 'id' });
      request.onsuccess = () => {
        request.result.close();
        resolve(undefined);
      };
      request.onerror = () => reject(request.error);
    });
    const before = await dump(of);
    const outcome = await run(of);
    assert.deepStrictEqual([outcome.status, outcome.failure], ['failed', { code: 'recovery-unavailable' }]);
    assert.deepStrictEqual(await dump(of), before);
  });

  it('request: a read of CanvasTabDB that fails mid-copy leaves a resumable point, and nothing structural', async () => {
    const of = await profileWith(/** @type {any} */ (FIXTURES.get('v8.basic')));
    const outcome = await run(of, {
      limits: SMALL,
      hooks: {
        between: label =>
          label === 'point-started' ? of.faults.failNextRead('elements', 'NotReadableError') : undefined,
      },
    });
    assert.deepStrictEqual([outcome.status, outcome.shape, outcome.recoveryPointId], ['failed', 'legacy', null]);
    const partial = await dump(of);
    assert.equal(recordsIn(partial, 'NewTabNoteRecovery', 'points')[0].value.status, 'copying');
    assert.equal(recordsIn(partial, 'NewTabNoteRecovery', 'progress').length, 1);
    assert.equal(partial.databases.find(db => db.name === 'CanvasTabDB')?.version, 8);
    assert.equal((await run(of, { limits: SMALL })).status, 'migrated');
    const expected = expectedFor('v8.basic');
    assert.deepStrictEqual(await dump(of, expected.header), asDumped(expected));
  });

  it('commit: a copy batch that aborts after its writes succeeded (UnknownError) resumes on the next run', async () => {
    await faulted(of => of.faults.abortAfterNextWrite('rows', 'UnknownError'), 'failed', 'transaction-failed');
  });

  it('commit: QuotaExceededError on a copy batch drops the partial point (Q7) and runs nothing', async () => {
    const of = await profileWith(/** @type {any} */ (FIXTURES.get('v8.basic')));
    const canvas = recordsIn(await dump(of), 'CanvasTabDB', 'canvases');
    of.faults.abortAfterNextWrite('rows', 'QuotaExceededError');
    const outcome = await run(of, { limits: SMALL });
    assert.deepStrictEqual([outcome.status, outcome.failure], ['space-blocked', { code: 'quota' }]);
    const after = await dump(of);
    assert.deepStrictEqual(recordsIn(after, 'NewTabNoteRecovery', 'points'), []);
    assert.deepStrictEqual(recordsIn(after, 'NewTabNoteRecovery', 'rows'), []);
    assert.deepStrictEqual(recordsIn(after, 'NewTabNoteRecovery', 'progress'), []);
    assert.equal(after.databases.find(db => db.name === 'CanvasTabDB')?.version, 8);
    assert.deepStrictEqual(recordsIn(after, 'CanvasTabDB', 'canvases'), canvas);
  });

  it('versionchange: QuotaExceededError on its meta put aborts the upgrade, CanvasTabDB stays at 8, and the next run migrates', async () => {
    const { of } = await faulted(
      of => of.faults.abortAfterNextWrite('meta', 'QuotaExceededError'),
      'failed',
      'transaction-failed',
    );
    assert.equal(recordsIn(await dump(of), 'NewTabNoteRecovery', 'points').length, 1);
  });

  it('commit: the receipts transaction aborting after success leaves 9 without a receipt, which the next run writes', async () => {
    await faulted(of => of.faults.abortAfterNextWrite('migrations', 'AbortError'), 'failed', 'transaction-failed');
  });
});

describe('shapes outside the matrix stay as they are (Q13)', () => {
  for (const id of ['v8.missing-core', 'v8.extra-store', 'v9.newer']) {
    it(`${id}: refused, CanvasTabDB untouched, one verified point`, async () => {
      const fixture = /** @type {any} */ (FIXTURES.get(id));
      const of = await profileWith(fixture);
      const before = (await dump(of)).databases;
      const outcome = await run(of);
      assert.equal(outcome.status, 'refused');
      const after = await dump(of);
      assert.deepStrictEqual(
        after.databases.filter(db => db.name === 'CanvasTabDB'),
        before,
      );
      const points = recordsIn(after, 'NewTabNoteRecovery', 'points');
      assert.equal(points.length, 1);
      assert.equal(points[0].value.status, 'verified');
      assert.equal(points[0].value.target, null);
      assert.equal(outcome.recoveryPointId, points[0].value.id);
    });
  }
});

describe('shape detection reads stores, indexes, and meta', () => {
  const KINDS = {
    'none.basic': 'none',
    'none.empty-v1': 'none',
    'v8.missing-core': 'missing-core',
    'v8.extra-store': 'unknown',
    'v9.basic': 'current',
    'v9.newer': 'newer',
  };
  for (const [id, fixture] of FIXTURES) {
    const kind = /** @type {Record<string, string>} */ (KINDS)[id] || 'legacy';
    it(`${id} reads as ${kind}`, async () => {
      const of = await profileWith(fixture);
      assert.equal(detectShape(await inspect(of.real)).kind, kind);
    });
  }

  /**
   * The shape of a database made from `spec` (legacy-env's createDatabase)
   * @param {object} spec
   */
  async function shapeOf(spec) {
    const of = newProfile();
    await legacyEnv.createDatabase(of.real, spec);
    return detectShape(await inspect(of.real));
  }

  it('the version alone decides nothing: legacy stores at 9 without meta are unknown, and meta naming 9 at version 8 is too', async () => {
    assert.deepStrictEqual(await shapeOf({ version: 9 }), { kind: 'unknown', reason: 'version-mismatch' });
    assert.deepStrictEqual(
      await shapeOf({
        version: 8,
        extraStores: { meta: { keyPath: 'key' }, migrations: { keyPath: ['id', 'status'] } },
        records: { meta: [{ key: 'schema', structuralVersion: 9, logicalVersion: 1 }] },
      }),
      { kind: 'unknown', reason: 'version-mismatch' },
    );
    assert.deepStrictEqual(await shapeOf({ version: 7, omit: ['snapshots'] }), {
      kind: 'legacy',
      missing: ['snapshots'],
    });
    // A version-8 store with an index no release made
    const of = newProfile();
    await new Promise((resolve, reject) => {
      const request = of.real.open('CanvasTabDB', 8);
      request.onupgradeneeded = () => {
        for (const [name, shape] of Object.entries(legacySchema())) {
          const store = request.result.createObjectStore(name, { keyPath: shape.keyPath });
          for (const index of shape.indexes) store.createIndex(index.name, index.keyPath);
          if (name === 'canvases') store.createIndex('extra', 'extra');
        }
      };
      request.onsuccess = () => {
        request.result.close();
        resolve(undefined);
      };
      request.onerror = () => reject(request.error);
    });
    assert.deepStrictEqual(detectShape(await inspect(of.real)), { kind: 'unknown', reason: 'store-mismatch' });
  });

  it('meta without a schema record is unknown, and one naming a later version is newer', async () => {
    const v9 = { meta: { keyPath: 'key' }, migrations: { keyPath: ['id', 'status'] } };
    assert.deepStrictEqual(await shapeOf({ version: 9, extraStores: v9 }), {
      kind: 'unknown',
      reason: 'meta-unreadable',
    });
    assert.deepStrictEqual(
      await shapeOf({
        version: 9,
        extraStores: v9,
        records: { meta: [{ key: 'schema', structuralVersion: 11, logicalVersion: 3 }] },
      }),
      { kind: 'newer', structuralVersion: 11 },
    );
  });

  it('inspecting no database makes none', async () => {
    const of = newProfile();
    assert.equal((await inspect(of.real)).exists, false);
    assert.deepStrictEqual(await of.real.databases(), []);
  });
});

describe('step 9 inside its versionchange', () => {
  /**
   * Runs step 9 on a database made from `fixture`'s CanvasTabDB stores, with the upgrade's
   * database and transaction wrapped so every call is recorded
   * @param {any} fixture
   */
  async function recorded(fixture) {
    const of = newProfile();
    await loadFixture(fixture, { factory: of.real });
    /** @type {string[]} */
    const calls = [];
    let returned = false;
    /** @type {string[]} */
    const late = [];
    /**
     * @template {object} T
     * @param {T} target
     * @param {string} label
     * @returns {T}
     */
    const record = (target, label) =>
      new Proxy(target, {
        get(object, property) {
          const value = Reflect.get(object, property, object);
          if (typeof value !== 'function') {
            if (property === 'objectStoreNames') return record(/** @type {any} */ (value), 'objectStoreNames');
            return value;
          }
          return (/** @type {unknown[]} */ ...args) => {
            const call = `${label}.${String(property)}`;
            (returned ? late : calls).push(call);
            const out = value.apply(object, args);
            return out && typeof out === 'object' && 'createIndex' in out ? record(out, 'store') : out;
          };
        },
      });
    let result;
    await new Promise((resolve, reject) => {
      const request = of.real.open('CanvasTabDB', 9);
      request.onupgradeneeded = () => {
        const db = record(request.result, 'db');
        const tx = record(/** @type {IDBTransaction} */ (request.transaction), 'tx');
        result = STEPS[0].apply(db, tx, { logicalVersion: null });
        returned = true;
      };
      request.onsuccess = () => {
        request.result.close();
        resolve(undefined);
      };
      request.onerror = () => reject(request.error);
    });
    await new Promise(resolve => setTimeout(resolve, 10));
    return { of, calls, late, result };
  }

  const ALLOWED = new Set([
    'db.createObjectStore',
    'store.createIndex',
    'store.put',
    'tx.objectStore',
    'objectStoreNames.contains',
  ]);

  for (const [id, fixture] of FIXTURES) {
    const kind = fixture.header.shape;
    if (
      kind === 'none' ||
      id === 'v9.basic' ||
      id === 'v9.newer' ||
      id === 'v8.extra-store' ||
      id === 'v8.missing-core'
    )
      continue;
    it(`${id}: only createObjectStore, createIndex, and put, synchronously, and all ten legacy stores kept`, async () => {
      const { of, calls, late, result } = await recorded(fixture);
      assert.equal(result, undefined, 'returned something, so it could have awaited');
      assert.deepStrictEqual(late, [], 'called after it returned');
      assert.deepStrictEqual(
        calls.filter(call => !ALLOWED.has(call)),
        [],
      );
      assert.equal(calls.filter(call => call === 'store.put').length, 1);
      const dumped = await dump({ ...of, chrome: { api: { storage: { local: { get: async () => ({}) } } } } });
      const db = /** @type {any} */ (dumped.databases.find(candidate => candidate.name === 'CanvasTabDB'));
      for (const name of LEGACY_STORE_NAMES) {
        const store = db.stores.find((/** @type {any} */ candidate) => candidate.name === name);
        assert.ok(store, `${name} missing`);
        assert.deepStrictEqual(
          store.indexes.map((/** @type {any} */ index) => index.name),
          legacySchema()[name].indexes.map(index => index.name),
        );
      }
      // Every record and field as it was
      for (const store of fillCanaries(fixture).databases[0].stores) {
        assert.deepStrictEqual(recordsIn(dumped, 'CanvasTabDB', store.name), store.records);
      }
    });
  }
});

describe('a verified point reused only while it matches the live data (review R61, Q3)', () => {
  it('a note written on 8 after the point was verified makes the next run remake it, and the pin moves', async () => {
    const of = await profileWith(/** @type {any} */ (FIXTURES.get('v8.basic')));
    const first = await run(of, {
      hooks: {
        between: label => {
          if (label === 'verified') throw new Killed();
        },
      },
    });
    assert.equal(first.status, 'failed');
    // The user keeps writing on 8 before the worker runs again
    const db = /** @type {IDBDatabase} */ (await openWithoutUpgrade(of.real, 'CanvasTabDB'));
    const tx = db.transaction('canvases', 'readwrite');
    const done = committed(tx);
    tx.objectStore('canvases').put({ ...legacyEnv.note('written-after-point'), name: 'Later' });
    await done;
    db.close();

    const second = await run(of);
    assert.equal(second.status, 'migrated');
    assert.equal(second.recoveryPointId, `pre-migration-${NOW}-2`);
    assert.ok(of.logs.some(line => line.event === 'storage-recovery-point-stale'));
    const points = recordsIn(await dump(of), 'NewTabNoteRecovery', 'points').map(record => record.value);
    assert.deepStrictEqual(
      points.map(point => [point.id, point.pinned]),
      [[`pre-migration-${NOW}-2`, true]],
    );
    const exported = await exportPoint({
      indexedDB: of.real,
      keyRange: KeyRange,
      crypto: /** @type {any} */ (webcrypto),
      clock: { now: () => NOW },
      pointId: /** @type {string} */ (await exportablePoint({ indexedDB: of.real })),
    });
    assert.ok(exported.canvases.some(note => /** @type {any} */ (note).id === 'written-after-point'));
  });

  it("verification reads the point's record from disk, not the copy the run kept in memory (probe E)", async () => {
    const of = await profileWith(/** @type {any} */ (FIXTURES.get('v8.basic')));
    const outcome = await run(of, {
      hooks: {
        between: async label => {
          if (label !== 'copied') return;
          // The stored manifest no longer says what the copy read
          const db = /** @type {IDBDatabase} */ (await openRecovery(of.real, { create: false }));
          const tx = db.transaction('points', 'readwrite');
          const done = committed(tx);
          const request = tx.objectStore('points').get(`pre-migration-${NOW}`);
          request.onsuccess = () => {
            const point = request.result;
            point.manifest.canvases.count += 1;
            tx.objectStore('points').put(point);
          };
          await done;
          db.close();
        },
      },
    });
    assert.deepStrictEqual([outcome.status, outcome.failure], ['failed', { code: 'recovery-point-unverified' }]);
    assert.equal((await inspect(of.real)).version, 8);
  });

  it('a point that still matches is reused as it is, with nothing copied again', async () => {
    const of = await profileWith(/** @type {any} */ (FIXTURES.get('v8.basic')));
    await run(of, {
      hooks: {
        between: label => {
          if (label === 'verified') throw new Killed();
        },
      },
    });
    const before = of.faults.transactions.length;
    const second = await run(of);
    assert.equal(second.recoveryPointId, `pre-migration-${NOW}`);
    const copies = of.faults.transactions
      .slice(before)
      .filter(tx => tx.names.includes('rows') && tx.mode === 'readwrite');
    assert.deepStrictEqual(copies, []);
  });
});

describe('an empty CanvasTabDB, and a database with any store, are never deleted', () => {
  /**
   * A profile whose CanvasTabDB is at `version`, with `stores` (name to key path)
   * @param {number} version
   * @param {Record<string, string>} [stores]
   */
  async function made(version, stores = {}) {
    const of = newProfile();
    await new Promise((resolve, reject) => {
      const request = of.real.open('CanvasTabDB', version);
      request.onupgradeneeded = () => {
        for (const [name, keyPath] of Object.entries(stores)) {
          request.result.createObjectStore(name, { keyPath }).put({ [keyPath]: 'kept', text: 'still here' });
        }
      };
      request.onsuccess = () => {
        request.result.close();
        resolve(undefined);
      };
      request.onerror = () => reject(request.error);
    });
    return of;
  }

  for (const version of [9, 12]) {
    it(`at version ${version}: unknown, left exactly as it is, and nothing deleted (#33's AC6)`, async () => {
      const of = await made(version);
      const before = await dump(of);
      const outcome = await run(of);
      assert.deepStrictEqual(
        [outcome.status, outcome.shape, outcome.failure],
        ['refused', 'unknown', { code: 'unknown-shape' }],
      );
      assert.deepStrictEqual(detectShape(await inspect(of.real)), { kind: 'unknown', reason: 'empty-at-target' });
      assert.deepStrictEqual(of.faults.deletes, []);
      assert.deepStrictEqual(await dump(of), before);
      assert.equal((await run(of)).status, 'refused');
    });
  }

  // The lead's condition: a database with even one store is never deleted, at any version
  for (const version of [1, 2, 7, 8, 9, 10, 12, 40]) {
    for (const stores of /** @type {Record<string, string>[]} */ ([
      { canvases: 'id' },
      { mystery: 'id' },
      { meta: 'key' },
    ])) {
      it(`at version ${version} with only ${Object.keys(stores)[0]}: never deleted, and its record kept`, async () => {
        const of = await made(version, stores);
        await run(of);
        await run(of);
        assert.deepStrictEqual(of.faults.deletes, []);
        const [name] = Object.keys(stores);
        const kept = recordsIn(await dump(of), 'CanvasTabDB', name);
        assert.deepStrictEqual(
          kept.map(record => record.value.text),
          ['still here'],
        );
      });
    }
  }

  it('an empty database below 9 upgrades in place, and nothing is deleted', async () => {
    const of = await made(1);
    assert.equal((await run(of)).status, 'migrated');
    assert.deepStrictEqual(of.faults.deletes, []);
  });
});

describe("#61's carry-overs (#17 PR 1b)", () => {
  it('a run that reuses a point drops an older copy a cut-off run left pinned, so one pinned point stays (carry-over 1)', async () => {
    const of = await profileWith(/** @type {any} */ (FIXTURES.get('v8.basic')));
    const killedAtVerified = {
      hooks: {
        between: (/** @type {string} */ label) => {
          if (label === 'verified') throw new Killed();
        },
      },
    };
    assert.equal((await run(of, killedAtVerified)).status, 'failed');
    /** @returns {Promise<any[]>} */
    const points = async () => recordsIn(await dump(of), 'NewTabNoteRecovery', 'points').map(record => record.value);
    const [older] = await points();
    // The user writes on 8, so the next run remakes the point, and is cut off once the newer one
    // is saved and before the older one goes: put the older record back, as that cut leaves it
    const db = /** @type {IDBDatabase} */ (await openWithoutUpgrade(of.real, 'CanvasTabDB'));
    const tx = db.transaction('canvases', 'readwrite');
    const done = committed(tx);
    tx.objectStore('canvases').put({ ...legacyEnv.note('written-after-point'), name: 'Later' });
    await done;
    db.close();
    assert.equal((await run(of, killedAtVerified)).status, 'failed');
    const recovery = /** @type {IDBDatabase} */ (await openRecovery(of.real, { create: false }));
    const put = recovery.transaction('points', 'readwrite');
    const putDone = committed(put);
    put.objectStore('points').put(older);
    await putDone;
    recovery.close();
    assert.deepStrictEqual(
      (await points()).map(point => [point.id, point.pinned]),
      [
        [`pre-migration-${NOW}`, true],
        [`pre-migration-${NOW}-2`, true],
      ],
    );

    // The next run reuses the newer point and drops the older one, as keepVerified would have
    const outcome = await run(of);
    assert.equal(outcome.status, 'migrated');
    assert.equal(outcome.recoveryPointId, `pre-migration-${NOW}-2`);
    assert.deepStrictEqual(
      (await points()).map(point => [point.id, point.pinned]),
      [[`pre-migration-${NOW}-2`, true]],
    );
  });

  for (const id of ['v8.missing-core', 'v9.newer']) {
    it(`${id}: a run on a refused profile reuses its point without reading every store again (carry-over 3)`, async () => {
      const of = await profileWith(/** @type {any} */ (FIXTURES.get(id)));
      const first = await run(of);
      assert.equal(first.status, 'refused');
      const before = of.faults.transactions.length;
      const second = await run(of);
      assert.deepStrictEqual([second.status, second.recoveryPointId], ['refused', first.recoveryPointId]);
      // matchesSource reads each store in its own transaction; the schema read takes them all at once
      const storeReads = of.faults.transactions
        .slice(before)
        .filter(
          opened =>
            opened.mode === 'readonly' && opened.names.length === 1 && LEGACY_STORE_NAMES.includes(opened.names[0]),
        );
      assert.deepStrictEqual(
        storeReads.map(opened => opened.names),
        [],
      );
    });
  }

  it('an unknown shape, which the new tab still writes to, is checked against its point on each run', async () => {
    const of = await profileWith(/** @type {any} */ (FIXTURES.get('v8.extra-store')));
    assert.equal((await run(of)).status, 'refused');
    const before = of.faults.transactions.length;
    assert.equal((await run(of)).status, 'refused');
    const storeReads = of.faults.transactions
      .slice(before)
      .filter(
        opened =>
          opened.mode === 'readonly' && opened.names.length === 1 && LEGACY_STORE_NAMES.includes(opened.names[0]),
      );
    assert.ok(storeReads.length > 0);
  });
});
