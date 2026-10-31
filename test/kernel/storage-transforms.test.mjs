// #17 PR 3a's data transforms (transforms.js) and logical 2: under Web Lock storage.migrate held
// exclusive, after the worker's run, each note gets its placement, kind, and lifecycle by #1's
// rules and an updatedAt an index can hold, in strict batches of at most 100 notes or 2 MB that
// read what they write, with nothing else changed; a commit between two batches stands; cut off
// anywhere, the next run ends where an uncut one does; the run reuses the run's verified point
// while the notes are as it holds them, and takes one more after the space check otherwise;
// short of space nothing runs, and the stop stands for half an hour; and with nothing to fill
// there's no point at all.

import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { createIndexedDbAdapter } from '../../js/kernel/adapters/indexeddb/adapter.js';
import { exportPoint } from '../../js/kernel/adapters/indexeddb/legacy-export.js';
import {
  DEFAULT_LIMITS,
  POINTS_LOCK,
  RECOVERY_DB_NAME,
  committed,
  copyPoint,
  keepVerified,
  listPoints,
  openRecovery,
  startPoint,
  storesToCopy,
  verifyPoint,
} from '../../js/kernel/adapters/indexeddb/recovery-points.js';
import { DB_NAME } from '../../js/kernel/adapters/indexeddb/schema.js';
import { openWithoutUpgrade } from '../../js/kernel/adapters/indexeddb/shapes.js';
import {
  TRANSFORM_KEY,
  TRANSFORM_RETRY_AFTER_MS,
  TRANSFORM_STOP_KEY,
} from '../../js/kernel/adapters/indexeddb/transforms.js';
import { createKernel } from '../../js/kernel/core/application/kernel.js';
import { withoutPlacement } from '../../js/kernel/core/domain/placement.js';
import { createBaselinePolicy } from '../../js/kernel/core/ports/policy.js';
import {
  KeyRange,
  dump,
  killAt,
  legacyEnv,
  newProfile,
  profileWith,
  recordsIn,
  run,
  synthesized,
  transform,
} from './migration-support.mjs';
import { CALLERS, NOW } from './support.mjs';
import { webcrypto } from 'node:crypto';

/** @typedef {import('./migration-support.mjs').Profile} Profile */
/** @typedef {import('../../js/kernel/adapters/indexeddb/recovery-points.js').Point} Point */
/** @typedef {import('../../js/kernel/adapters/indexeddb/transforms.js').TransformOutcome} TransformOutcome */

const crypto = /** @type {any} */ (webcrypto);
const BASIC = /** @type {any} */ (synthesized().get('v8.basic'));
const FOLDER = recordsIn(BASIC, 'CanvasTabDB', 'folders')[0].value.id;
/** The transform's clock: after the run's, so a filled time shows which it came from */
const RUN_START = NOW + 7000;
const later = { now: () => RUN_START };
const io = { keyRange: KeyRange, crypto, limits: DEFAULT_LIMITS };
/** A disk with no room for a point */
const SHORT = async () => ({ quota: 1024, usage: 0 });
/** The stores logical 2 never writes */
const UNTOUCHED = ['elements', 'folders', 'links', 'media', 'search_index', 'snapshots', 'themes', 'vectors'];

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
 * A 1.4.x note as v8.basic holds one, at the root, with `fields` over it, and `drop` taken off
 * @param {string} id
 * @param {Record<string, unknown>} fields
 * @param {string[]} [drop]
 * @returns {Record<string, unknown>}
 */
function legacyNote(id, fields, drop = []) {
  const base = recordsIn(BASIC, 'CanvasTabDB', 'canvases')[1].value;
  const note = { ...base, id, ...fields };
  for (const field of drop) delete note[field];
  return note;
}

/** The notes added to v8.basic, each a case of logical 2, and what it gives each */
const CASES = Object.freeze({
  'x-inbox': {
    note: legacyNote('x-inbox', { name: 'Untitled' }),
    group: { placement: { kind: 'inbox' }, kind: 'note', lifecycle: 'active' },
  },
  'x-stale': {
    note: legacyNote('x-stale', { name: 'Filed', folderId: 'folder-gone' }),
    group: { placement: { kind: 'collection', folderId: null }, kind: 'note', lifecycle: 'active' },
  },
  'x-daily': {
    note: legacyNote('x-daily', { name: 'Daily Note - Oct 9, 2025', isDaily: true, dateStr: '2025-10-09' }),
    group: { placement: { kind: 'daily', dateKey: '2025-10-09' }, kind: 'note', lifecycle: 'active' },
  },
  'x-undated': {
    note: legacyNote('x-undated', { name: 'Daily', isDaily: true, dateStr: null }),
    group: { placement: { kind: 'collection', folderId: null }, kind: 'note', lifecycle: 'active' },
  },
  'x-both': {
    note: legacyNote('x-both', {
      name: 'Both',
      trashed: true,
      trashedAt: NOW - 100,
      archived: true,
      archivedAt: NOW - 200,
    }),
    group: { placement: { kind: 'collection', folderId: null }, kind: 'note', lifecycle: 'trashed' },
  },
  'x-template': {
    note: legacyNote('x-template', { name: 'Filed template', isTemplate: true, folderId: FOLDER }),
    group: { placement: { kind: 'collection', folderId: FOLDER }, kind: 'template', lifecycle: 'active' },
  },
  'x-created': {
    note: legacyNote('x-created', { createdAt: NOW - 5000 }, ['updatedAt']),
    group: { placement: { kind: 'collection', folderId: null }, kind: 'note', lifecycle: 'active' },
    updatedAt: NOW - 5000,
  },
  'x-blocks': {
    note: legacyNote('x-blocks', {}, ['updatedAt', 'createdAt']),
    group: { placement: { kind: 'collection', folderId: null }, kind: 'note', lifecycle: 'active' },
    updatedAt: NOW - 3000,
  },
  'x-none': {
    note: legacyNote('x-none', { updatedAt: NaN }, ['createdAt']),
    group: { placement: { kind: 'collection', folderId: null }, kind: 'note', lifecycle: 'active' },
    updatedAt: RUN_START,
  },
});

/** The blocks of x-blocks, whose newest time its updatedAt takes */
const BLOCKS = [
  {
    id: 'xb1',
    canvasId: 'x-blocks',
    type: 'text',
    content: 'One',
    order: 0,
    createdAt: NOW - 4000,
    updatedAt: NOW - 3000,
  },
  { id: 'xb2', canvasId: 'x-blocks', type: 'text', content: 'Two', order: 1, createdAt: NOW - 3500 },
];

/** What logical 2 gives v8.basic's own notes, by name */
const BASIC_GROUPS = Object.freeze({
  Groceries: { placement: { kind: 'collection', folderId: FOLDER }, kind: 'note', lifecycle: 'active' },
  'Reading list': { placement: { kind: 'collection', folderId: null }, kind: 'note', lifecycle: 'active' },
  'Old plans': { placement: { kind: 'collection', folderId: null }, kind: 'note', lifecycle: 'archived' },
  'Thrown away': { placement: { kind: 'collection', folderId: null }, kind: 'note', lifecycle: 'trashed' },
  'Meeting template': { placement: { kind: 'collection', folderId: null }, kind: 'template', lifecycle: 'active' },
});

/**
 * v8.basic with CASES' notes and BLOCKS at version 8, migrated to 10 by the run, which made its
 * pinned point of them
 * @returns {Promise<Profile>}
 */
async function upgraded() {
  const of = await profileWith(BASIC);
  const db = await done(of.real.open('CanvasTabDB'));
  const tx = db.transaction(['canvases', 'elements'], 'readwrite');
  for (const { note } of Object.values(CASES)) tx.objectStore('canvases').put(note);
  for (const block of BLOCKS) tx.objectStore('elements').put(block);
  await committed(tx);
  db.close();
  assert.equal((await run(of)).status, 'migrated');
  return of;
}

/**
 * The profile's notes by id
 * @param {Profile} of
 * @returns {Promise<Record<string, any>>}
 */
async function notesIn(of) {
  return Object.fromEntries(recordsIn(await dump(of), 'CanvasTabDB', 'canvases').map(({ value }) => [value.id, value]));
}

/**
 * The profile's `meta` records by key
 * @param {Profile} of
 * @returns {Promise<Record<string, any>>}
 */
async function metaIn(of) {
  return Object.fromEntries(recordsIn(await dump(of), 'CanvasTabDB', 'meta').map(({ value }) => [value.key, value]));
}

/**
 * The profile's receipts
 * @param {Profile} of
 * @returns {Promise<any[]>}
 */
async function receiptsIn(of) {
  return recordsIn(await dump(of), 'CanvasTabDB', 'migrations').map(({ value }) => value);
}

/**
 * The profile's recovery points, oldest first, each with whether it reads back verified now
 * @param {Profile} of
 * @returns {Promise<Array<Point & {verifies: boolean}>>}
 */
async function pointsIn(of) {
  const recovery = await openRecovery(of.real, { create: false });
  if (!recovery) return [];
  try {
    const points = await listPoints(recovery);
    /** @type {Array<Point & {verifies: boolean}>} */
    const read = [];
    for (const point of points) read.push({ ...point, verifies: (await verifyPoint({ recovery, point, io })).ok });
    return read;
  } finally {
    recovery.close();
  }
}

/**
 * Runs `body` with commands on #17's adapter over `of`, as a page sends them
 * @template T
 * @param {Profile} of
 * @param {(send: (fields: Record<string, unknown>) => Promise<void>) => Promise<T>} body
 * @returns {Promise<T>}
 */
async function withCommands(of, body) {
  const adapter = createIndexedDbAdapter({
    indexedDB: of.faults.factory,
    settings: of.chrome.api.storage.local,
    keyRange: KeyRange,
    clock: later,
  });
  await adapter.open();
  try {
    let count = 0;
    const ids = { next: () => `t-${(count += 1)}` };
    const kernel = createKernel({ adapter, policy: createBaselinePolicy(), caller: CALLERS.newtab, ids, clock: later });
    return await body(async fields => {
      const outcome = await kernel.execute(/** @type {any} */ ({ commandId: ids.next(), ...fields }));
      assert.equal(outcome.kind, 'committed', JSON.stringify(outcome));
    });
  } finally {
    adapter.close();
  }
}

/**
 * The note as logical 2 leaves it: its group, and its filled updatedAt, over what it was
 * @param {Record<string, any>} before
 * @returns {Record<string, any>}
 */
function filledNote(before) {
  const one = Object.values(CASES).find(({ note }) => note.id === before.id);
  if (one) {
    return { ...before, ...one.group, ...('updatedAt' in one ? { updatedAt: one.updatedAt } : {}) };
  }
  return { ...before, .../** @type {Record<string, any>} */ (BASIC_GROUPS)[before.name] };
}

describe('logical 2 (#17 PR 3a)', () => {
  it("gives every 1.4.x note its placement, kind, and lifecycle by #1's rules, and an updatedAt to a note without one an index holds, and changes nothing else", async () => {
    const of = await upgraded();
    const before = await dump(of);
    const notes = await notesIn(of);
    const outcome = await transform(of, { clock: later });
    assert.deepEqual(
      [outcome.status, outcome.steps, outcome.filled, outcome.failure],
      ['transformed', ['logical-2'], 14, null],
    );
    const after = await notesIn(of);
    assert.deepEqual(Object.keys(after).sort(), Object.keys(notes).sort());
    for (const [id, note] of Object.entries(notes)) assert.deepEqual(after[id], filledNote(note), id);
    // No other store moves, blocks included, and no change entry or version
    const dumped = await dump(of);
    for (const store of [...UNTOUCHED, 'changes', 'operations', 'conflicts', 'tombstones']) {
      assert.deepEqual(recordsIn(dumped, 'CanvasTabDB', store), recordsIn(before, 'CanvasTabDB', store), store);
    }
  });

  it('writes its receipt and the logical version together, with its counts and its point, and a second run finds nothing to do', async () => {
    const of = await upgraded();
    const [point] = await pointsIn(of);
    const outcome = await transform(of, { clock: later });
    assert.equal(outcome.recoveryPointId, point.id, 'the run reused the run’s point');
    const meta = await metaIn(of);
    assert.deepEqual(meta.schema, { key: 'schema', structuralVersion: 10, logicalVersion: 2 });
    assert.equal(TRANSFORM_KEY in meta, false, 'no progress');
    const receipt = (await receiptsIn(of)).find(found => found.id === 'logical-2');
    assert.deepEqual(receipt, {
      id: 'logical-2',
      from: 1,
      to: 2,
      status: 'completed',
      startedAt: RUN_START,
      completedAt: RUN_START,
      recoveryPointId: point.id,
      failure: null,
      counts: { read: 14, filled: 14, staleFolder: 1, dailyWithoutDate: 1 },
    });
    const settled = await dump(of);
    const again = await transform(of, { clock: later });
    assert.deepEqual([again.status, again.steps, again.filled], ['current', [], 0]);
    assert.deepEqual(await dump(of), settled, 'nothing written');
  });

  it("fills only what's absent: a group a note has stays, and so does an updatedAt an index holds, and a note a placement command moved before the transform got to it gets its group from its flags as they are", async () => {
    const fixture = /** @type {any} */ (synthesized().get('v10.basic'));
    const of = await profileWith(fixture);
    const folder = recordsIn(fixture, 'CanvasTabDB', 'folders')[0].value.id;
    const placed = { placement: { kind: 'inbox' }, kind: 'template', lifecycle: 'archived' };
    const db = await done(of.real.open('CanvasTabDB'));
    const tx = db.transaction(['canvases'], 'readwrite');
    tx.objectStore('canvases').put(legacyNote('x-placed', { name: 'Has its group', ...placed }));
    tx.objectStore('canvases').put(legacyNote('x-moved', { name: 'Moved at 10', placementVersion: 2 }, ['updatedAt']));
    await committed(tx);
    db.close();
    assert.equal((await run(of)).status, 'current');
    const notes = await notesIn(of);
    const outcome = await transform(of, { clock: later });
    assert.equal(outcome.status, 'transformed');
    const after = await notesIn(of);
    // As it was, even where its flags would say otherwise
    assert.deepEqual(after['x-placed'], notes['x-placed']);
    // v10.basic's Groceries, and this one, moved on #17's adapter at 10, which wrote no group
    const groceries = Object.values(notes).find(note => note.name === 'Groceries');
    assert.equal(groceries.placementVersion, 1);
    assert.deepEqual(after[groceries.id], {
      ...groceries,
      placement: { kind: 'collection', folderId: folder },
      kind: 'note',
      lifecycle: 'active',
    });
    assert.deepEqual(after['x-moved'], {
      ...notes['x-moved'],
      ...BASIC_GROUPS['Reading list'],
      updatedAt: notes['x-moved'].createdAt,
    });
    const reading = Object.values(notes).find(note => note.name === 'Reading list');
    assert.deepEqual(after[reading.id], { ...reading, ...BASIC_GROUPS['Reading list'] });
  });
});

describe('batches, yields, and the commits between them', () => {
  it('reads and writes at most limits.records notes per strict batch, yields between batches, and records where it got to after each', async () => {
    const of = await upgraded();
    let yields = 0;
    /** @type {any[]} */
    const progress = [];
    const outcome = await transform(of, {
      clock: later,
      limits: { records: 3, bytes: DEFAULT_LIMITS.bytes },
      yieldBetween: async () => {
        yields += 1;
      },
      hooks: {
        between: async label => {
          if (label === 'batch') progress.push((await metaIn(of))[TRANSFORM_KEY]);
        },
      },
    });
    assert.equal(outcome.status, 'transformed');
    // 14 notes, 3 at a time: five batches, and a yield between each two
    assert.equal(progress.length, 5);
    assert.equal(yields, 4);
    const ids = Object.keys(await notesIn(of)).sort();
    assert.deepEqual(
      progress.map(record => [record.after, record.counts.read]),
      [
        [ids[2], 3],
        [ids[5], 6],
        [ids[8], 9],
        [ids[11], 12],
        [ids[13], 14],
      ],
    );
    assert.deepEqual(
      progress.map(record => [record.id, record.recoveryPointId, record.startedAt]),
      progress.map(() => ['logical-2', outcome.recoveryPointId, RUN_START]),
    );
    const batches = of.faults.transactions.filter(
      opened => opened.mode === 'readwrite' && opened.names.includes('canvases') && opened.names.includes('meta'),
    );
    assert.equal(batches.length, 5);
    for (const batch of batches) assert.equal(batch.durability, 'strict');
  });

  it('takes no more than limits.bytes of notes in a batch, unless one note is bigger', async () => {
    const of = await upgraded();
    let batches = 0;
    const outcome = await transform(of, {
      clock: later,
      limits: { records: 100, bytes: 1 },
      hooks: {
        between: label => {
          if (label === 'batch') batches += 1;
        },
      },
    });
    assert.equal(outcome.status, 'transformed');
    assert.equal(batches, 14, 'one note a batch');
    for (const note of Object.values(await notesIn(of))) assert.ok(note.placement, note.id);
  });

  it('a commit between two batches stands, whether its note was filled already or is filled after', async () => {
    const of = await upgraded();
    const notes = await notesIn(of);
    const reading = /** @type {any} */ (Object.values(notes).find(note => note.name === 'Reading list'));
    let first = true;
    const outcome = await transform(of, {
      clock: later,
      limits: { records: 2, bytes: DEFAULT_LIMITS.bytes },
      hooks: {
        between: async label => {
          if (label !== 'batch' || !first) return;
          first = false;
          await withCommands(of, async send => {
            // Reading list was in the first batch, x-stale comes in a later one
            await send({ type: 'renameNote', noteId: reading.id, name: 'Renamed' });
            await send({ type: 'archiveNote', noteId: reading.id });
            await send({ type: 'trashNote', noteId: 'x-stale' });
          });
        },
      },
    });
    assert.equal(outcome.status, 'transformed');
    const after = await notesIn(of);
    assert.deepEqual(
      [after[reading.id].name, after[reading.id].archived, after[reading.id].lifecycle, after[reading.id].placement],
      ['Renamed', true, 'archived', { kind: 'collection', folderId: null }],
    );
    assert.deepEqual(
      [after['x-stale'].trashed, after['x-stale'].lifecycle, after['x-stale'].placement],
      [true, 'trashed', { kind: 'collection', folderId: null }],
    );
    // The commits' versions stand too, and the transform moved none
    assert.deepEqual(
      [after[reading.id].revision, after[reading.id].placementVersion, after['x-stale'].placementVersion],
      [1, 1, 1],
    );
  });

  it('runs only while it holds the points lock, exclusive, so the purge and the pre-update export wait for it', async () => {
    const of = await upgraded();
    const locks = legacyEnv.createLockManager();
    /** @type {() => void} */
    let release = () => {};
    const held = new Promise(resolve => {
      release = /** @type {() => void} */ (resolve);
    });
    const reading = locks.request(POINTS_LOCK, { mode: 'shared' }, () => held);
    const running = transform(of, { clock: later, locks });
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal((await metaIn(of)).schema.logicalVersion, 1, 'nothing ran while a reader held the lock');
    release();
    await reading;
    assert.equal((await running).status, 'transformed');
    assert.equal((await metaIn(of)).schema.logicalVersion, 2);
  });
});

describe('cut off, and run again', () => {
  it('cut off at any stop, a second run ends where an uncut run does, with one verified point for it', async () => {
    /**
     * v8.basic upgraded, then a note renamed at 10, so the run's point no longer holds the notes
     * and the transform takes its own
     */
    const edited = async () => {
      const of = await upgraded();
      await withCommands(of, send => send({ type: 'renameNote', noteId: 'x-inbox', name: 'Untitled 2' }));
      return of;
    };
    const limits = { records: 4, bytes: DEFAULT_LIMITS.bytes };
    const reference = await edited();
    const uncut = await transform(reference, { clock: later, limits });
    assert.equal(uncut.status, 'transformed');
    const expected = await notesIn(reference);
    /** @param {Profile} of */
    const ended = async of => {
      const meta = await metaIn(of);
      const receipts = (await receiptsIn(of)).map(({ startedAt, completedAt, recoveryPointId, ...receipt }) => receipt);
      return { notes: await notesIn(of), schema: meta.schema, progress: TRANSFORM_KEY in meta, receipts };
    };
    const target = await ended(reference);
    let stops = 0;
    for (let at = 1; ; at++) {
      const of = await edited();
      const cut = killAt(at);
      const first = await transform(of, { clock: later, limits, hooks: cut.hooks });
      if (cut.reached.count < at) {
        // Every stop was reached without a cut: the run went through
        assert.equal(first.status, 'transformed');
        stops = at - 1;
        break;
      }
      assert.equal(first.status, 'failed', `${at}: ${cut.reached.labels.at(-1)}`);
      const second = await transform(of, { clock: later, limits });
      const label = `cut at ${at} (${cut.reached.labels.at(-1)})`;
      // Cut after the step's receipt went in, there's nothing left to do
      assert.equal(second.status, cut.reached.labels.at(-1) === 'step-done' ? 'current' : 'transformed', label);
      assert.deepEqual(await ended(of), target, label);
      const points = await pointsIn(of);
      assert.ok(
        points.every(point => point.status === 'verified' && point.verifies),
        label,
      );
      const own = points.filter(point => point.logicalTarget === 2);
      assert.equal(own.length, 1, label);
      const receipt = (await receiptsIn(of)).find(found => found.id === 'logical-2');
      assert.equal(receipt.recoveryPointId, own[0].id, label);
      // The point holds the notes as the transform found them: the renamed one, without a group
      const file = await exportPoint({
        indexedDB: of.real,
        keyRange: KeyRange,
        crypto,
        clock: later,
        pointId: own[0].id,
      });
      const held = /** @type {any[]} */ (file.canvases);
      assert.equal(held.find(note => note.id === 'x-inbox')?.name, 'Untitled 2', label);
    }
    assert.ok(stops > 10, `${stops} stops`);
    assert.deepEqual(expected, target.notes);
  });
});

describe('its recovery point (Q9)', () => {
  it("reuses the run's verified point while the notes are as it holds them", async () => {
    const of = await upgraded();
    const before = await pointsIn(of);
    assert.equal(before.length, 1);
    const outcome = await transform(of, { clock: later });
    assert.equal(outcome.recoveryPointId, before[0].id);
    assert.deepEqual(
      (await pointsIn(of)).map(point => point.id),
      [before[0].id],
    );
  });

  it("takes one more, verified, after the space check, once a note changed since the run's point, and keeps the pinned one", async () => {
    const of = await upgraded();
    const [pinned] = await pointsIn(of);
    await withCommands(of, send => send({ type: 'setPinned', noteId: 'x-daily', pinned: true }));
    const outcome = await transform(of, { clock: later });
    assert.equal(outcome.status, 'transformed');
    const points = await pointsIn(of);
    assert.deepEqual(
      points.map(point => [
        point.id,
        point.pinned,
        point.target,
        point.logicalTarget ?? null,
        point.status,
        point.verifies,
      ]),
      [
        [pinned.id, true, 10, null, 'verified', true],
        [outcome.recoveryPointId, false, null, 2, 'verified', true],
      ],
    );
    // It holds the notes before the transform: the pin, and no group
    const file = await exportPoint({
      indexedDB: of.real,
      keyRange: KeyRange,
      crypto,
      clock: later,
      pointId: /** @type {string} */ (outcome.recoveryPointId),
    });
    const daily = file.canvases.find(note => /** @type {any} */ (note).id === 'x-daily');
    assert.equal(/** @type {any} */ (daily).pinned, true);
  });

  it('short of space, it fills nothing and records the stop, which stands for half an hour; then it runs', async () => {
    const of = await upgraded();
    await withCommands(of, send => send({ type: 'setPinned', noteId: 'x-daily', pinned: true }));
    const notes = await notesIn(of);
    const blocked = await transform(of, { clock: later, estimate: SHORT });
    assert.deepEqual(
      [blocked.status, blocked.failure, blocked.backedOff],
      ['space-blocked', { code: 'space-short' }, false],
    );
    assert.deepEqual(await notesIn(of), notes, 'nothing filled');
    assert.equal((await pointsIn(of)).length, 1, 'no point');
    const meta = await metaIn(of);
    assert.deepEqual(meta[TRANSFORM_STOP_KEY], {
      key: TRANSFORM_STOP_KEY,
      status: 'space-blocked',
      code: 'space-short',
      at: RUN_START,
      target: 2,
    });
    assert.equal(meta.schema.logicalVersion, 1);
    assert.deepEqual(
      of.logs.filter(line => line.event === 'storage-transform').map(line => line.detail),
      [{ status: 'space-blocked', code: 'space-short' }],
    );

    // A start in the next half hour reads nothing but meta, and logs nothing more
    const reads = of.faults.transactions.length;
    const soon = await transform(of, { clock: { now: () => RUN_START + TRANSFORM_RETRY_AFTER_MS - 1 } });
    assert.deepEqual([soon.status, soon.failure, soon.backedOff], ['space-blocked', { code: 'space-short' }, true]);
    const since = of.faults.transactions.slice(reads);
    assert.deepEqual(
      since.map(opened => opened.names),
      [['meta']],
    );
    assert.equal(of.logs.filter(line => line.event === 'storage-transform').length, 1);

    // After it, with room, it runs, and the stop goes with its receipt
    const ran = await transform(of, { clock: { now: () => RUN_START + TRANSFORM_RETRY_AFTER_MS } });
    assert.equal(ran.status, 'transformed');
    assert.equal(TRANSFORM_STOP_KEY in (await metaIn(of)), false);
    assert.equal((await metaIn(of)).schema.logicalVersion, 2);
  });

  it('a disk that fills during the copy drops the partial point, and the run stops as short of space', async () => {
    const of = await upgraded();
    await withCommands(of, send => send({ type: 'setPinned', noteId: 'x-daily', pinned: true }));
    const aborted = of.faults.abortAfterNextWrite('rows', 'QuotaExceededError');
    const outcome = await transform(of, { clock: later });
    await aborted;
    assert.deepEqual([outcome.status, outcome.failure], ['space-blocked', { code: 'quota' }]);
    assert.deepEqual(
      (await pointsIn(of)).map(point => point.target),
      [10],
      'only the run’s point',
    );
    assert.equal((await metaIn(of))[TRANSFORM_STOP_KEY]?.code, 'quota');
  });

  it('with nothing to fill, it writes its receipt without a point, and makes no recovery database', async () => {
    const of = newProfile();
    assert.equal((await run(of)).status, 'migrated');
    // Notes the kernel made carry their group already
    await withCommands(of, async send => {
      await send({ type: 'createNote', noteId: 'n1', name: 'Plan' });
      await send({ type: 'ensureDailyNote', noteId: 'd1' });
    });
    const outcome = await transform(of, { clock: later });
    assert.deepEqual(
      [outcome.status, outcome.steps, outcome.filled, outcome.recoveryPointId],
      ['transformed', ['logical-2'], 0, null],
    );
    const receipt = (await receiptsIn(of)).find(found => found.id === 'logical-2');
    assert.deepEqual(
      [receipt.recoveryPointId, receipt.counts],
      [null, { read: 2, filled: 0, staleFolder: 0, dailyWithoutDate: 0 }],
    );
    assert.equal((await metaIn(of)).schema.logicalVersion, 2);
    const names = (await dump(of)).databases.map(db => db.name);
    assert.equal(names.includes(RECOVERY_DB_NAME), false);
  });
});

describe("the point's export after the transform (#17 PR 3a, Q8)", () => {
  it('writes every note as 1.4.1 stores one, without the group, from a point taken after it', async () => {
    const of = await upgraded();
    assert.equal((await transform(of, { clock: later })).status, 'transformed');
    // A point a later run takes, as #17 PR 3b's step 11 will, holds the filled notes
    const source = /** @type {IDBDatabase} */ (await openWithoutUpgrade(of.real, DB_NAME));
    const recovery = /** @type {IDBDatabase} */ (await openRecovery(of.real, { create: false }));
    try {
      const { point, progress } = await startPoint(recovery, {
        id: `pre-migration-${RUN_START + 1}`,
        kind: 'pre-migration',
        sourceShape: 'current',
        sourceVersion: source.version,
        structuralVersion: 10,
        logicalVersion: 2,
        target: 11,
        stores: storesToCopy(source),
        createdAt: RUN_START + 1,
      });
      await copyPoint({ source, recovery, point, progress, io });
      const stored = /** @type {Point} */ ((await listPoints(recovery)).find(found => found.id === point.id));
      assert.equal((await verifyPoint({ recovery, point: stored, io })).ok, true);
      await keepVerified({ recovery, point: stored, clock: later, io });
    } finally {
      source.close();
      recovery.close();
    }
    const held = (await pointsIn(of)).find(found => found.id === `pre-migration-${RUN_START + 1}`);
    assert.ok(held && held.verifies);
    const file = await exportPoint({ indexedDB: of.real, keyRange: KeyRange, crypto, clock: later, pointId: held.id });
    assert.equal(file.canvases.length + file.trashedCanvases.length, 14);
    const notes = await notesIn(of);
    for (const note of /** @type {any[]} */ ([...file.canvases, ...file.trashedCanvases])) {
      assert.deepEqual(note, withoutPlacement(notes[note.id]), note.id);
      assert.ok(notes[note.id].placement, `${note.id} has its group in the database`);
    }
  });
});
