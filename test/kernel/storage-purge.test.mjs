// #17 PR 2b's recovery-point purge (purge.js), with the lead's rules: it runs under Web Lock
// storage.migrate held exclusive, driven only by tombstones; each batch is at most 100 rows,
// records the purged keys and nothing else, and leaves the point verifying, which it checks
// after each; a point that doesn't verify, before a batch or after one, stops the purge and
// is left as it was; cut off anywhere, the next sweep finishes; and a reader of points that
// takes the lock shared never sees one between two batches.

import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';

import { createIndexedDbAdapter } from '../../js/kernel/adapters/indexeddb/adapter.js';
import { createRecoveryReader } from '../../js/kernel/adapters/indexeddb/health.js';
import { exportPoint } from '../../js/kernel/adapters/indexeddb/legacy-export.js';
import { MIGRATE_LOCK } from '../../js/kernel/adapters/indexeddb/migrate.js';
import { OWNERS, purgeRecoveryPoints } from '../../js/kernel/adapters/indexeddb/purge.js';
import {
  DEFAULT_LIMITS,
  POINTS_LOCK,
  ROWS_STORE,
  committed,
  copyPoint,
  discardPoint,
  keepVerified,
  listPoints,
  openRecovery,
  startPoint,
  storesToCopy,
  verifyPoint,
} from '../../js/kernel/adapters/indexeddb/recovery-points.js';
import { openWithoutUpgrade } from '../../js/kernel/adapters/indexeddb/shapes.js';
import { createKernel } from '../../js/kernel/core/application/kernel.js';
import { createBaselinePolicy } from '../../js/kernel/core/ports/policy.js';
import {
  DELETED_AT,
  KeyRange,
  dump,
  killAt,
  legacyEnv,
  newProfile,
  profileWith,
  recordsIn,
  run,
  synthesized,
} from './migration-support.mjs';
import { CALLERS, NOW } from './support.mjs';

/** @typedef {import('./migration-support.mjs').Profile} Profile */
/** @typedef {import('../../js/kernel/adapters/indexeddb/recovery-points.js').Point} Point */
/** @typedef {import('../../js/kernel/adapters/indexeddb/purge.js').PurgeOptions} PurgeOptions */

const crypto = /** @type {any} */ (webcrypto);
const FIXTURES = synthesized();
const clock = { now: () => NOW };
/** A minute after the run's point: when the notes here are deleted, and the sweeps run */
const later = { now: () => DELETED_AT };
const io = { keyRange: KeyRange, crypto, limits: DEFAULT_LIMITS };
const DOOMED = 'doomed-note';

/** @type {Array<{close(): void}>} */
const open = [];
afterEach(() => {
  for (const one of open.splice(0)) one.close();
});

/**
 * @template T
 * @param {IDBRequest<T>} request
 * @returns {Promise<T>}
 */
const done = request =>
  new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });

/**
 * v8.basic with a doomed note of `blocks` blocks at version 8, migrated, so the pinned point
 * holds it, and then the note deleted for good through #17's adapter
 * @param {{blocks?: number, deleteIt?: boolean}} [options]
 * @returns {Promise<{of: Profile, notes: any[]}>}
 */
async function deletedProfile({ blocks = 3, deleteIt = true } = {}) {
  const fixture = /** @type {any} */ (FIXTURES.get('v8.basic'));
  const of = await profileWith(fixture);
  const notes = recordsIn(fixture, 'CanvasTabDB', 'canvases').map(record => record.value);
  const db = await done(of.real.open('CanvasTabDB'));
  const tx = db.transaction(['canvases', 'elements', 'search_index'], 'readwrite');
  tx.objectStore('canvases').put({ ...notes[0], id: DOOMED, name: 'Doomed' });
  for (let order = 0; order < blocks; order++) {
    tx.objectStore('elements').put({
      id: `doomed-b${order}`,
      canvasId: DOOMED,
      type: 'text',
      content: `Line ${order}`,
      order,
    });
  }
  tx.objectStore('search_index').put({ noteId: DOOMED, name: 'Doomed', content: '', updatedAt: NOW });
  await committed(tx);
  db.close();
  assert.equal((await run(of)).status, 'migrated');
  if (deleteIt) await deleteNote(of, DOOMED);
  return { of, notes };
}

/**
 * Trashes `noteId` and deletes it for good through #17's adapter
 * @param {Profile} of
 * @param {string} noteId
 */
async function deleteNote(of, noteId) {
  const adapter = createIndexedDbAdapter({
    indexedDB: of.faults.factory,
    settings: of.chrome.api.storage.local,
    keyRange: KeyRange,
    clock: later,
  });
  await adapter.open();
  try {
    let count = 0;
    const ids = { next: () => `purge-${noteId}-${(count += 1)}` };
    const kernel = createKernel({ adapter, policy: createBaselinePolicy(), caller: CALLERS.newtab, ids, clock: later });
    assert.equal(
      (await kernel.execute(/** @type {any} */ ({ type: 'trashNote', commandId: ids.next(), noteId }))).kind,
      'committed',
    );
    const deleted = await kernel.execute(
      /** @type {any} */ ({ type: 'deleteNotePermanently', commandId: ids.next(), noteId }),
    );
    assert.deepEqual(deleted.kind === 'committed' && deleted.code, 'note-deleted');
  } finally {
    adapter.close();
  }
}

/**
 * A sweep over `of`
 * @param {Profile} of
 * @param {Partial<PurgeOptions>} [options]
 */
const purge = (of, options = {}) =>
  purgeRecoveryPoints({
    indexedDB: of.faults.factory,
    keyRange: KeyRange,
    locks: legacyEnv.createLockManager(),
    crypto,
    clock: later,
    logger: { warn: (event, detail) => of.logs.push({ event, detail }) },
    ...options,
  });

/**
 * Every point, as stored
 * @param {Profile} of
 * @returns {Promise<Point[]>}
 */
async function points(of) {
  const recovery = /** @type {IDBDatabase} */ (await openRecovery(of.real, { create: false }));
  try {
    return await listPoints(recovery);
  } finally {
    recovery.close();
  }
}

/**
 * Whether every point reads back verified
 * @param {Profile} of
 */
async function allVerify(of) {
  const recovery = /** @type {IDBDatabase} */ (await openRecovery(of.real, { create: false }));
  try {
    const verdicts = [];
    for (const point of await listPoints(recovery)) verdicts.push(await verifyPoint({ recovery, point, io }));
    return verdicts;
  } finally {
    recovery.close();
  }
}

/**
 * The rows the points hold of `noteId`, by point and store
 * @param {Profile} of
 * @param {string} noteId
 */
async function rowsOfNote(of, noteId) {
  const dumped = await dump(of);
  return recordsIn(dumped, 'NewTabNoteRecovery', 'rows')
    .map(record => record.value)
    .filter(row => row.key === noteId || row.value?.canvasId === noteId || row.value?.noteId === noteId)
    .map(row => `${row.pointId} ${row.store} ${row.key}`)
    .sort();
}

/**
 * The tombstones' purge fields, by id
 * @param {Profile} of
 */
async function pendingOf(of) {
  const dumped = await dump(of);
  return Object.fromEntries(
    recordsIn(dumped, 'CanvasTabDB', 'tombstones').map(record => [record.value.id, record.value.purge ?? null]),
  );
}

/**
 * Changes the point's rows through a connection of its own
 * @param {Profile} of
 * @param {(rows: IDBObjectStore) => void} change
 */
async function tamper(of, change) {
  const recovery = /** @type {IDBDatabase} */ (await openRecovery(of.real, { create: false }));
  const tx = recovery.transaction(ROWS_STORE, 'readwrite');
  const finished = committed(tx);
  change(tx.objectStore(ROWS_STORE));
  await finished;
  recovery.close();
}

/**
 * One row of another note's that the point holds, a block of v8.basic's first note
 * @param {Profile} of
 * @param {string} noteId
 */
async function rowOf(of, noteId) {
  const dumped = await dump(of);
  return recordsIn(dumped, 'NewTabNoteRecovery', 'rows')
    .map(record => record.value)
    .find(row => row.store === 'elements' && row.value.canvasId === noteId);
}

/**
 * NewTabNoteRecovery as a dump holds it, but for `skip`, a row the test changed itself
 * @param {Profile} of
 * @param {string} [skip] - `pointId store key`
 */
async function recoveryOf(of, skip) {
  const dumped = await dump(of);
  const db = dumped.databases.find(candidate => candidate.name === 'NewTabNoteRecovery');
  return JSON.stringify(
    db?.stores.map(store => ({
      ...store,
      records: store.records.filter(
        (/** @type {any} */ record) =>
          !skip || `${record.value.pointId} ${record.value.store} ${record.value.key}` !== skip,
      ),
    })),
  );
}

describe('the recovery-point purge (#17 PR 2b)', () => {
  it('takes the lock every runner takes, exclusive, and owns each store of a deleted note by key or field', () => {
    assert.equal(POINTS_LOCK, MIGRATE_LOCK);
    assert.deepEqual(Object.keys(OWNERS).sort(), [
      'canvases',
      'conflicts',
      'daily_index',
      'elements',
      'folders',
      'links',
      'media',
      'search_index',
      'snapshots',
      'vectors',
    ]);
  });

  it('purges in batches of at most 100 rows, verifying the point after each, and records only the keys', async () => {
    const { of } = await deletedProfile({ blocks: 250 });
    /** @type {string[]} */
    const labels = [];
    /** @type {number[]} */
    const sizes = [];
    let before = (await points(of))[0].manifest.elements.purged.length;
    const purged = await purge(of, {
      hooks: {
        between: async label => {
          labels.push(label);
          if (label !== 'batch-written') return;
          const after = (await points(of))[0].manifest;
          const total = Object.values(after).reduce((sum, store) => sum + store.purged.length, 0);
          sizes.push(total - before);
          before = total;
        },
      },
    });
    assert.deepEqual([purged.status, purged.tombstones, purged.rows], ['purged', 1, 252]);
    // canvases, then elements in three, then search_index
    assert.deepEqual(sizes, [1, 100, 100, 50, 1]);
    assert.equal(labels.filter(label => label === 'batch-verified').length, 5);
    assert.deepEqual(await allVerify(of), [{ ok: true }]);
    const [point] = await points(of);
    assert.deepEqual(point.manifest.canvases.purged, [DOOMED]);
    assert.deepEqual(
      [...point.manifest.elements.purged].sort(),
      Array.from({ length: 250 }, (_, order) => `doomed-b${order}`).sort(),
    );
    assert.deepEqual(await rowsOfNote(of, DOOMED), []);
    assert.deepEqual(await pendingOf(of), { [DOOMED]: null });
  });

  it('cut off at every step, leaves each point verifying, and the next sweep finishes the same', async () => {
    const reference = await deletedProfile();
    const counted = killAt(Number.MAX_SAFE_INTEGER);
    assert.equal(
      (await purge(reference.of, { hooks: counted.hooks, limits: { records: 2, bytes: DEFAULT_LIMITS.bytes } })).status,
      'purged',
    );
    const finished = await recoveryOf(reference.of);
    const steps = counted.reached.count;
    assert.ok(steps >= 8, `${steps} steps`);
    for (let at = 1; at <= steps; at++) {
      const { of } = await deletedProfile();
      const cut = await purge(of, { hooks: killAt(at).hooks, limits: { records: 2, bytes: DEFAULT_LIMITS.bytes } });
      assert.equal(cut.status, 'failed', `cut at ${at}`);
      assert.deepEqual(await allVerify(of), [{ ok: true }], `cut at ${at}`);
      // Pending until every point is purged of it
      if (at < steps) assert.deepEqual(await pendingOf(of), { [DOOMED]: 'pending' }, `cut at ${at}`);
      const again = await purge(of, { limits: { records: 2, bytes: DEFAULT_LIMITS.bytes } });
      assert.equal(again.status, at < steps ? 'purged' : 'nothing', `cut at ${at}`);
      assert.equal(await recoveryOf(of), finished, `cut at ${at}`);
      assert.deepEqual(await pendingOf(of), { [DOOMED]: null }, `cut at ${at}`);
    }
  });

  it("a point that doesn't verify stops the purge, and is left as it was, with the tombstone pending", async () => {
    const { of, notes } = await deletedProfile();
    const row = await rowOf(of, notes[0].id);
    await tamper(of, rows => rows.put({ ...row, value: { ...row.value, content: 'damaged' } }));
    const before = await recoveryOf(of);
    const stopped = await purge(of);
    assert.deepEqual(
      [stopped.status, stopped.rows, stopped.failure],
      ['stopped', 0, { code: 'record-mismatch', pointId: row.pointId }],
    );
    assert.equal(await recoveryOf(of), before);
    assert.deepEqual(await pendingOf(of), { [DOOMED]: 'pending' });
    assert.deepEqual(
      of.logs.filter(line => line.event === 'storage-purge').map(line => line.detail.code),
      ['record-mismatch'],
    );
  });

  it("a batch after which the point doesn't verify is put back, so the point is as it was before it, and the purge stops", async () => {
    const { of, notes } = await deletedProfile();
    const row = await rowOf(of, notes[0].id);
    const skip = `${row.pointId} ${row.store} ${row.key}`;
    const before = await recoveryOf(of, skip);
    const recordBefore = (await points(of))[0];
    let damaged = false;
    const stopped = await purge(of, {
      hooks: {
        between: async label => {
          // Something else changes the point while the first batch is in, so it no longer verifies
          if (label !== 'batch-written' || damaged) return;
          damaged = true;
          await tamper(of, rows => rows.put({ ...row, value: { ...row.value, content: 'damaged' } }));
        },
      },
    });
    assert.deepEqual([stopped.status, stopped.rows, stopped.failure?.code], ['stopped', 0, 'record-mismatch']);
    assert.equal(await recoveryOf(of, skip), before);
    assert.deepEqual((await points(of))[0], recordBefore);
    assert.deepEqual(await pendingOf(of), { [DOOMED]: 'pending' });
    assert.ok((await rowsOfNote(of, DOOMED)).length > 0);
  });

  it('goes by tombstones only: a note gone from CanvasTabDB without one stays in the point', async () => {
    const { of, notes } = await deletedProfile();
    const lost = notes[1].id;
    // Gone from the live database some other way, as lost data would be, with no tombstone
    const db = await done(of.real.open('CanvasTabDB'));
    const tx = db.transaction('canvases', 'readwrite');
    tx.objectStore('canvases').delete(lost);
    await committed(tx);
    db.close();
    const kept = await rowsOfNote(of, lost);
    assert.ok(kept.length > 0);
    assert.equal((await purge(of)).status, 'purged');
    assert.deepEqual(await rowsOfNote(of, lost), kept);
    assert.deepEqual(await rowsOfNote(of, DOOMED), []);
    assert.deepEqual(await allVerify(of), [{ ok: true }]);
  });

  it('purges every point, the pinned one and a later one, and leaves every other row as it was', async () => {
    const { of, notes } = await deletedProfile({ deleteIt: false });
    // A second verified point beside the pinned one, as a later build's update past 11 leaves
    const source = /** @type {IDBDatabase} */ (await openWithoutUpgrade(of.real, 'CanvasTabDB'));
    const recovery = /** @type {IDBDatabase} */ (await openRecovery(of.real, { create: false }));
    try {
      const { point, progress } = await startPoint(recovery, {
        id: 'pre-migration-later',
        kind: 'pre-migration',
        sourceShape: 'current',
        sourceVersion: source.version,
        structuralVersion: 11,
        logicalVersion: 1,
        target: 12,
        stores: storesToCopy(source),
        createdAt: NOW + 1,
      });
      await copyPoint({ source, recovery, point, progress, io });
      const stored = /** @type {Point} */ ((await listPoints(recovery)).find(candidate => candidate.id === point.id));
      assert.deepEqual(await verifyPoint({ recovery, point: stored, io }), { ok: true });
      await keepVerified({ recovery, point: stored, clock, io });
    } finally {
      source.close();
      recovery.close();
    }
    assert.equal((await points(of)).length, 2);
    await deleteNote(of, DOOMED);
    const others = (await dump(of)).databases.find(db => db.name === 'NewTabNoteRecovery');
    const otherRows = JSON.stringify(
      others?.stores
        .find(store => store.name === ROWS_STORE)
        ?.records.filter(
          (/** @type {any} */ record) => !String(record.value.key).startsWith('doomed') && record.value.key !== DOOMED,
        ),
    );
    const purged = await purge(of);
    // Each point's note row, its three blocks, and its search entry
    assert.deepEqual([purged.status, purged.rows], ['purged', 10]);
    assert.deepEqual(await rowsOfNote(of, DOOMED), []);
    assert.deepEqual(await allVerify(of), [{ ok: true }, { ok: true }]);
    const after = (await dump(of)).databases.find(db => db.name === 'NewTabNoteRecovery');
    assert.equal(JSON.stringify(after?.stores.find(store => store.name === ROWS_STORE)?.records), otherRows);
    assert.ok(notes.length > 0);
  });

  it('an export that takes the lock shared during a purge waits for it, and lacks the note', async () => {
    const { of } = await deletedProfile();
    const locks = legacyEnv.createLockManager();
    const [pinned] = await points(of);
    /** @type {string[]} */
    const order = [];
    /** @type {Promise<any> | null} */
    let exporting = null;
    const purged = purge(of, {
      locks,
      hooks: {
        between: label => {
          if (label !== 'batch-written' || exporting) return;
          exporting = exportPoint({
            indexedDB: of.real,
            keyRange: KeyRange,
            crypto,
            clock,
            pointId: pinned.id,
            locks,
          }).then(file => {
            order.push('exported');
            return file;
          });
        },
      },
    }).then(outcome => {
      order.push('purged');
      return outcome;
    });
    assert.equal((await purged).status, 'purged');
    assert.ok(exporting);
    const file = await /** @type {Promise<any>} */ (exporting);
    assert.deepEqual(order, ['purged', 'exported']);
    const ids = [...file.canvases, ...file.trashedCanvases].map((/** @type {any} */ note) => note.id);
    assert.equal(ids.includes(DOOMED), false);
    assert.equal(
      file.elements.concat(file.orphanElements).some((/** @type {any} */ block) => block.canvasId === DOOMED),
      false,
    );
  });

  it("#20's recovery reader verifies under the lock shared too, so a purge never fails its check halfway", async () => {
    const { of } = await deletedProfile();
    const locks = legacyEnv.createLockManager();
    const [pinned] = await points(of);
    const reader = createRecoveryReader({ indexedDB: of.real, keyRange: KeyRange, crypto, locks });
    /** @type {string[]} */
    const order = [];
    /** @type {Promise<unknown> | null} */
    let verifying = null;
    const purged = await purge(of, {
      locks,
      hooks: {
        between: label => {
          if (label !== 'batch-written' || verifying) return;
          verifying = reader.verify(pinned.id).then(verdict => {
            order.push('verified');
            return verdict;
          });
        },
      },
    });
    order.push('purged');
    assert.equal(purged.status, 'purged');
    assert.deepEqual(await verifying, { ok: true });
    assert.deepEqual(order, ['purged', 'verified']);
  });

  it('with nothing pending, or no database, it does nothing, and without Web Locks it purges nothing', async () => {
    const { of } = await deletedProfile({ deleteIt: false });
    const before = await dump(of);
    assert.deepEqual(await purge(of), {
      status: 'nothing',
      tombstones: 0,
      rows: 0,
      failure: null,
      backedOff: false,
      cleared: [],
    });
    assert.deepStrictEqual(await dump(of), before);
    const none = newProfile();
    const nothing = await purgeRecoveryPoints({
      indexedDB: none.real,
      keyRange: KeyRange,
      locks: legacyEnv.createLockManager(),
      crypto,
      clock,
      logger: { warn() {} },
    });
    assert.equal(nothing.status, 'nothing');
    assert.deepEqual(await none.real.databases(), []);
    await deleteNote(of, DOOMED);
    const unlocked = await purge(of, { locks: /** @type {any} */ (null) });
    assert.deepEqual([unlocked.status, unlocked.failure?.code], ['failed', 'locks-unavailable']);
    assert.deepEqual(await pendingOf(of), { [DOOMED]: 'pending' });
    assert.ok((await rowsOfNote(of, DOOMED)).length > 0);
  });

  it('a sweep the worker stops mid-batch never leaves half a batch', async () => {
    const { of } = await deletedProfile({ blocks: 5 });
    // Stopped as the first batch's transaction opens, before it commits
    const first = await purge(of, {
      limits: { records: 2, bytes: DEFAULT_LIMITS.bytes },
      hooks: {
        between: label => {
          if (label === 'point-verified') of.faults.abortAfterNextWrite(ROWS_STORE, 'UnknownError');
        },
      },
    });
    assert.equal(first.status, 'failed');
    assert.deepEqual(await allVerify(of), [{ ok: true }]);
    assert.equal((await points(of))[0].manifest.canvases.purged.length, 0);
    assert.equal((await purge(of)).status, 'purged');
    assert.deepEqual(await rowsOfNote(of, DOOMED), []);
  });
});

describe('which points a sweep reads, and a stop it backs off on (#17 PR 2b, review R93)', () => {
  /**
   * A verified point made at `createdAt` beside the ones there are, as a run after a later
   * update makes one
   * @param {Profile} of
   * @param {number} createdAt
   * @returns {Promise<string>} its id
   */
  async function laterPoint(of, createdAt) {
    const source = /** @type {IDBDatabase} */ (await openWithoutUpgrade(of.real, 'CanvasTabDB'));
    const recovery = /** @type {IDBDatabase} */ (await openRecovery(of.real, { create: false }));
    try {
      const { point, progress } = await startPoint(recovery, {
        id: `pre-migration-${createdAt}`,
        kind: 'pre-migration',
        sourceShape: 'current',
        sourceVersion: source.version,
        structuralVersion: 11,
        logicalVersion: 1,
        target: 12,
        stores: storesToCopy(source),
        createdAt,
      });
      await copyPoint({ source, recovery, point, progress, io });
      const stored = /** @type {Point} */ ((await listPoints(recovery)).find(candidate => candidate.id === point.id));
      assert.deepEqual(await verifyPoint({ recovery, point: stored, io }), { ok: true });
      await keepVerified({ recovery, point: stored, clock: { now: () => createdAt }, io });
      return stored.id;
    } finally {
      source.close();
      recovery.close();
    }
  }

  /**
   * Commands on #17's adapter at `at`, as a page sends them
   * @param {Profile} of
   * @param {number} at
   * @param {Array<Record<string, unknown>>} commands
   */
  async function sendAt(of, at, commands) {
    const adapter = createIndexedDbAdapter({
      indexedDB: of.faults.factory,
      settings: of.chrome.api.storage.local,
      keyRange: KeyRange,
      clock: { now: () => at },
    });
    await adapter.open();
    try {
      let count = 0;
      const ids = { next: () => `sent-${at}-${(count += 1)}` };
      const kernel = createKernel({
        adapter,
        policy: createBaselinePolicy(),
        caller: CALLERS.newtab,
        ids,
        clock: { now: () => at },
      });
      for (const command of commands) {
        const sent = await kernel.execute(/** @type {any} */ ({ commandId: ids.next(), ...command }));
        assert.equal(sent.kind, 'committed', JSON.stringify(sent));
      }
    } finally {
      adapter.close();
    }
  }

  /**
   * The keys of `noteId`'s rows in one point, by store
   * @param {Profile} of
   * @param {string} pointId
   * @param {string} noteId
   */
  const heldBy = async (of, pointId, noteId) =>
    (await rowsOfNote(of, noteId)).filter(row => row.startsWith(`${pointId} `));

  /** The readonly transactions on NewTabNoteRecovery's rows since `from` */
  const rowReads = (/** @type {Profile} */ of, /** @type {number} */ from) =>
    of.faults.transactions.slice(from).filter(tx => tx.names.includes(ROWS_STORE) && tx.mode === 'readonly').length;

  /** The recorded stop in `meta`, or null */
  const recordedStop = async (/** @type {Profile} */ of) => {
    const [stop] = recordsIn(await dump(of), 'CanvasTabDB', 'meta').filter(record => record.key === 'purge-stop');
    return stop ? stop.value : null;
  };

  it('takes from a point only what deletes after it was made took, so a note made again since keeps its rows', async () => {
    // Deleted a minute after the run's point, then made again under its id, as #17's adapter
    // allows, and a point made after that, all before a sweep
    const { of } = await deletedProfile();
    await sendAt(of, DELETED_AT + 1000, [
      {
        type: 'createNote',
        noteId: DOOMED,
        name: 'Made again',
        blocks: [{ id: 'again-b1', type: 'text', content: 'Live again', order: 0 }],
      },
    ]);
    const later = await laterPoint(of, DELETED_AT + 2000);
    const [pinned] = (await points(of)).filter(point => point.pinned);
    const before = await heldBy(of, later, DOOMED);
    assert.deepEqual(before.length > 0 && (await heldBy(of, pinned.id, DOOMED)).length > 0, true);

    const purged = await purge(of);
    assert.equal(purged.status, 'purged');
    // The note, its three blocks, and its search entry, from the point made before the delete
    assert.equal(purged.rows, 5);
    assert.deepEqual(await heldBy(of, pinned.id, DOOMED), []);
    assert.deepEqual(await heldBy(of, later, DOOMED), before);
    assert.deepEqual(await allVerify(of), [{ ok: true }, { ok: true }]);
    assert.deepEqual(await pendingOf(of), { [DOOMED]: null });
  });

  it('reads no point whole for a note no point holds', async () => {
    const { of } = await deletedProfile({ deleteIt: false });
    // A note made after the run's point, then deleted for good
    await sendAt(of, DELETED_AT, [
      {
        type: 'createNote',
        noteId: 'made-after',
        name: 'Made after',
        blocks: [{ id: 'after-b1', type: 'text', content: 'x', order: 0 }],
      },
      { type: 'trashNote', noteId: 'made-after' },
      { type: 'deleteNotePermanently', noteId: 'made-after' },
    ]);
    /** @type {string[]} */
    const labels = [];
    const purged = await purge(of, { hooks: { between: label => void labels.push(label) } });
    assert.deepEqual([purged.status, purged.rows], ['purged', 0]);
    assert.ok(labels.includes('point-matched'));
    assert.equal(labels.includes('point-verified'), false, 'it verified a point that holds nothing to purge');
    assert.deepEqual(await pendingOf(of), { 'made-after': null });
  });

  it("records a point that doesn't verify, backs off reading no row until the points change, and clears it once the point goes", async () => {
    const { of } = await deletedProfile();
    const [pinned] = await points(of);
    // One of the point's rows of a note that stays no longer matches its hash
    const recovery = /** @type {IDBDatabase} */ (await openRecovery(of.real, { create: false }));
    try {
      const tx = recovery.transaction(ROWS_STORE, 'readwrite');
      const rows = tx.objectStore(ROWS_STORE);
      const range = KeyRange.bound([pinned.id, 'canvases'], [pinned.id, 'canvases\u0000'], false, true);
      const all = /** @type {any[]} */ (await done(rows.getAll(range)));
      const kept = /** @type {any} */ (all.find(row => row.key !== DOOMED));
      rows.put({ ...kept, value: { ...kept.value, name: 'Bit rot' } });
      await committed(tx);
    } finally {
      recovery.close();
    }

    const first = await purge(of);
    assert.deepEqual(
      [first.status, first.failure, first.backedOff, first.cleared],
      ['stopped', { code: 'record-mismatch', pointId: pinned.id }, false, []],
    );
    const stop = await recordedStop(of);
    assert.deepEqual(
      [stop?.pointId, stop?.code, stop?.at, stop?.points],
      [pinned.id, 'record-mismatch', DELETED_AT, `${pinned.id}:verified`],
    );

    // Each later sweep, a wake's or a start's, backs off at once
    for (let n = 0; n < 2; n++) {
      const from = of.faults.transactions.length;
      const again = await purge(of);
      assert.deepEqual(
        [again.status, again.failure, again.backedOff],
        ['stopped', { code: 'record-mismatch', pointId: pinned.id }, true],
      );
      assert.equal(rowReads(of, from), 0, 'a sweep that backs off read the point');
    }
    assert.deepEqual(await pendingOf(of), { [DOOMED]: 'pending' });

    // A point made since: the points changed, so the next sweep reads them, and stops again
    const later = await laterPoint(of, DELETED_AT + 1000);
    const from = of.faults.transactions.length;
    const third = await purge(of);
    assert.deepEqual([third.status, third.backedOff, third.cleared], ['stopped', false, []]);
    assert.ok(rowReads(of, from) > 0);
    assert.equal((await recordedStop(of))?.points, [`${later}:verified`, `${pinned.id}:verified`].sort().join(','));

    // The damaged point dropped: the next sweep finishes, and ends the stop it recorded
    const store = /** @type {IDBDatabase} */ (await openRecovery(of.real, { create: false }));
    try {
      await discardPoint(store, pinned.id, io);
    } finally {
      store.close();
    }
    const fourth = await purge(of);
    assert.deepEqual([fourth.status, fourth.backedOff, fourth.cleared], ['purged', false, [pinned.id]]);
    assert.equal(await recordedStop(of), null);
    assert.deepEqual(await pendingOf(of), { [DOOMED]: null });
  });
});
