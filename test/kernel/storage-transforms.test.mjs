// #17 PR 3a's data transforms (transforms.js) and logical 2, and PR 3b's logical 3, each Daily
// Note's local key, with the daily index: under Web Lock storage.migrate held
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
import { createLegacyAdapter } from '../../js/kernel/adapters/legacy/adapter.js';
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
  TRANSFORM_DAILY_KEY,
  TRANSFORM_KEY,
  TRANSFORM_RETRY_AFTER_MS,
  TRANSFORM_STOP_KEY,
} from '../../js/kernel/adapters/indexeddb/transforms.js';
import { createKernel } from '../../js/kernel/core/application/kernel.js';
import { PLACEMENT_FIELDS, withoutPlacement } from '../../js/kernel/core/domain/placement.js';
import { createBaselinePolicy } from '../../js/kernel/core/ports/policy.js';
import { placementOf } from '../../js/product/placement.js';
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

/** The commands withCommands has sent in this file */
let commandCount = 0;

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
    // Logical 3's key (#17 PR 3b): made during its UTC date, so it keeps it
    daily: { dailyKey: '2025-10-09', dailyTimeZone: null, dailyDuplicateOf: null },
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
 * v8.basic with CASES' notes, BLOCKS, and `extra` at version 8, migrated to 10 by the run,
 * which made its pinned point of them
 * @param {Array<Record<string, unknown>>} [extra]
 * @returns {Promise<Profile>}
 */
async function upgraded(extra = []) {
  const of = await profileWith(BASIC);
  const db = await done(of.real.open('CanvasTabDB'));
  const tx = db.transaction(['canvases', 'elements'], 'readwrite');
  for (const { note } of Object.values(CASES)) tx.objectStore('canvases').put(note);
  for (const note of extra) tx.objectStore('canvases').put(note);
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
 * Runs `body` with commands on #17's adapter over `of`, as a page sends them, or `caller`, and
 * the kernel for its queries
 * @template T
 * @param {Profile} of
 * @param {(send: (fields: Record<string, unknown>) => Promise<any>, kernel: import('../../js/kernel/core/application/kernel.js').Kernel) => Promise<T>} body
 * @param {{now: () => number}} [clock]
 * @param {typeof CALLERS.newtab} [caller]
 * @returns {Promise<T>}
 */
async function withCommands(of, body, clock = later, caller = CALLERS.newtab) {
  const adapter = createIndexedDbAdapter({
    indexedDB: of.faults.factory,
    settings: of.chrome.api.storage.local,
    keyRange: KeyRange,
    clock,
  });
  await adapter.open();
  try {
    // Ids no other call's commands took, so the ledger never answers one with an earlier outcome
    const ids = { next: () => `t-${(commandCount += 1)}` };
    const kernel = createKernel({ adapter, policy: createBaselinePolicy(), caller, ids, clock });
    return await body(async fields => {
      const outcome = await kernel.execute(/** @type {any} */ ({ commandId: ids.next(), ...fields }));
      assert.equal(outcome.kind, 'committed', JSON.stringify(outcome));
      return outcome;
    }, kernel);
  } finally {
    adapter.close();
  }
}

/**
 * The note as logical 2 and 3 leave it: its group, its filled updatedAt, and a Daily Note's key,
 * over what it was
 * @param {Record<string, any>} before
 * @returns {Record<string, any>}
 */
function filledNote(before) {
  const one = /** @type {any} */ (Object.values(CASES).find(({ note }) => note.id === before.id));
  if (one) {
    return {
      ...before,
      ...one.group,
      ...('updatedAt' in one ? { updatedAt: one.updatedAt } : {}),
      ...(one.daily || {}),
    };
  }
  return { ...before, .../** @type {Record<string, any>} */ (BASIC_GROUPS)[before.name] };
}

describe('logical 2 (#17 PR 3a)', () => {
  it("gives every 1.4.x note its placement, kind, and lifecycle by #1's rules, and an updatedAt to a note without one an index holds, and changes nothing else", async () => {
    const of = await upgraded();
    const before = await dump(of);
    const notes = await notesIn(of);
    const outcome = await transform(of, { clock: later });
    // Logical 2 fills all 14, and logical 3 keys the one Daily Note with a date
    assert.deepEqual(
      [outcome.status, outcome.steps, outcome.filled, outcome.failure],
      ['transformed', ['logical-2', 'logical-3'], 15, null],
    );
    const after = await notesIn(of);
    assert.deepEqual(Object.keys(after).sort(), Object.keys(notes).sort());
    for (const [id, note] of Object.entries(notes)) assert.deepEqual(after[id], filledNote(note), id);
    assert.deepEqual(
      recordsIn(await dump(of), 'CanvasTabDB', 'daily_index').map(({ value }) => value),
      [{ dailyKey: '2025-10-09', noteId: 'x-daily' }],
    );
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
    assert.deepEqual(meta.schema, { key: 'schema', structuralVersion: 11, logicalVersion: 3 });
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
    assert.deepEqual(
      (await receiptsIn(of)).find(found => found.id === 'logical-3'),
      {
        id: 'logical-3',
        from: 2,
        to: 3,
        status: 'completed',
        startedAt: RUN_START,
        completedAt: RUN_START,
        recoveryPointId: point.id,
        failure: null,
        counts: { read: 14, filled: 1, rekeyed: 0, duplicates: 0 },
      },
    );
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
    // Step 11 takes it from 10 (#17 PR 3b)
    assert.equal((await run(of)).status, 'migrated');
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

describe("logical 3 (#17 PR 3b): each Daily Note's local key, and the daily index", () => {
  const EVENING = /** @type {any} */ (synthesized().get('v8.evening-daily-notes'));
  /** The transform's clock, in Los Angeles, where the fixture's Daily Notes were made */
  const inLA = { now: () => RUN_START, zone: () => 'America/Los_Angeles' };
  /** What logical 3 gives each of the fixture's Daily Notes, by #17's rules (domain/daily.js) */
  const KEYS = /** @type {Record<string, {dailyKey: string, dailyDuplicateOf: string | null}>} */ ({
    // Made in the evening, keyed by the next day's UTC date: each moves to the date its name gives
    'daily-oct-7-evening': { dailyKey: '2025-10-07', dailyDuplicateOf: null },
    'daily-oct-8-evening': { dailyKey: '2025-10-08', dailyDuplicateOf: null },
    // A race's two: the earlier holds the date, and the other names it
    'daily-oct-10-a': { dailyKey: '2025-10-10', dailyDuplicateOf: null },
    'daily-oct-10-b': { dailyKey: '2025-10-10', dailyDuplicateOf: 'daily-oct-10-a' },
    // That evening's: its own date is held, so it stays where 1.4.x showed it
    'daily-oct-10-evening': { dailyKey: '2025-10-11', dailyDuplicateOf: null },
    'daily-oct-12-planned': { dailyKey: '2025-10-12', dailyDuplicateOf: null },
  });
  const INDEX = {
    '2025-10-07': 'daily-oct-7-evening',
    '2025-10-08': 'daily-oct-8-evening',
    '2025-10-10': 'daily-oct-10-a',
    '2025-10-11': 'daily-oct-10-evening',
    '2025-10-12': 'daily-oct-12-planned',
  };

  /** The fixture at 8, migrated to 11 by the run, which made its pinned point */
  const evening = async () => {
    const of = await profileWith(EVENING);
    assert.equal((await run(of)).status, 'migrated');
    return of;
  };

  /**
   * The daily index, by date
   * @param {Profile} of
   */
  const indexIn = async of =>
    Object.fromEntries(
      recordsIn(await dump(of), 'CanvasTabDB', 'daily_index').map(({ value }) => [value.dailyKey, value.noteId]),
    );

  /**
   * Each Daily Note's name and blocks
   * @param {Profile} of
   */
  const writtenIn = async of => {
    const dumped = await dump(of);
    const blocks = recordsIn(dumped, 'CanvasTabDB', 'elements').map(({ value }) => value);
    return Object.fromEntries(
      recordsIn(dumped, 'CanvasTabDB', 'canvases')
        .map(({ value }) => value)
        .filter(note => note.isDaily)
        .map(note => [note.id, { name: note.name, blocks: blocks.filter(block => block.canvasId === note.id) }]),
    );
  };

  /**
   * A 1.4.x Daily Note: its id, the day its name gives, its dateStr, and when it was made
   * @typedef {readonly [string, string, string, number]} Made
   */
  /**
   * Daily opened every morning and evening in 1.4.x: Oct 27's morning note, then each evening's,
   * which 1.4.x filed under the next day's UTC date and opened again the next morning
   * @type {readonly Made[]}
   */
  const CHAIN = Object.freeze([
    ['chain-oct-27', 'Oct 27', '2025-10-27', Date.UTC(2025, 9, 27, 16)],
    ['chain-oct-27-evening', 'Oct 27', '2025-10-28', Date.UTC(2025, 9, 28, 3)],
    ['chain-oct-28-evening', 'Oct 28', '2025-10-29', Date.UTC(2025, 9, 29, 2)],
    ['chain-oct-29-evening', 'Oct 29', '2025-10-30', Date.UTC(2025, 9, 30, 2)],
  ]);
  /** Oct 30 at 6:30 PM in Los Angeles */
  const onOct30 = { now: () => Date.UTC(2025, 9, 31, 1, 30), zone: () => 'America/Los_Angeles' };
  /** One note a batch, so a lookup can land between any two */
  const ONE = { records: 1, bytes: DEFAULT_LIMITS.bytes };

  /**
   * v8.basic with `made`'s Daily Notes as 1.4.x kept them, each with what was written in it and
   * the `fields` it names for it, at 8, migrated to 11 by the run
   * @param {readonly Made[]} made
   * @param {Record<string, Record<string, unknown>>} [fields]
   */
  const withDaily = async (made, fields = {}) => {
    const of = await profileWith(BASIC);
    const db = await done(of.real.open('CanvasTabDB'));
    const tx = db.transaction(['canvases', 'elements'], 'readwrite');
    for (const [id, day, dateStr, createdAt] of made) {
      const name = `Daily Note - ${day}, 2025`;
      const note = legacyNote(id, { name, isDaily: true, dateStr, createdAt, updatedAt: createdAt, ...fields[id] });
      tx.objectStore('canvases').put(note);
      // What its evening wrote, and the next morning, when 1.4.x opened it again
      for (const [order, content] of ['Evening', 'Next morning'].entries()) {
        tx.objectStore('elements').put({ id: `${id}-${order}`, canvasId: id, type: 'text', content, order, createdAt });
      }
    }
    await committed(tx);
    db.close();
    assert.equal((await run(of)).status, 'migrated');
    return of;
  };

  /**
   * A page opening the Daily Note for each of `days` on #17's adapter, as the calendar and
   * today's do: an ensure, which repairs the index on a miss, then the read after it, with
   * `clock` the page's. Each day's note, by date, as `new` for one the ensure made.
   * @param {Profile} of
   * @param {{now: () => number, zone: () => string}} clock
   * @param {Array<{dateStr: string, today?: boolean}>} days - `today` sends the moment, as today's does
   * @returns {Promise<Record<string, string | null>>}
   */
  const openDays = (of, clock, days) =>
    withCommands(
      of,
      async (send, kernel) => {
        /** @type {Record<string, string | null>} */
        const opened = {};
        for (const { dateStr, today } of days) {
          const noteId = `opened-${(commandCount += 1)}`;
          await send({ type: 'ensureDailyNote', noteId, ...(today ? { at: clock.now() } : { dateStr }) });
          const found = await kernel.query({ type: 'findDailyNote', dateStr });
          opened[dateStr] =
            found.kind === 'ready' ? (found.data.note.id === noteId ? 'new' : found.data.note.id) : null;
        }
        return opened;
      },
      clock,
    );

  /**
   * Each Daily Note's key and holder, and the daily index, with any note a page made as `new`
   * @param {Profile} of
   */
  const dailyState = async of => {
    const made = (/** @type {unknown} */ id) => (typeof id === 'string' && id.startsWith('opened-') ? 'new' : id);
    const notes = Object.values(await notesIn(of)).filter(note => note.isDaily);
    return {
      keys: Object.fromEntries(
        notes.map(note => [made(note.id), [note.dailyKey, note.dateStr, made(note.dailyDuplicateOf ?? null)]]),
      ),
      index: Object.fromEntries(Object.entries(await indexIn(of)).map(([key, id]) => [key, made(id)])),
    };
  };

  /**
   * `made` upgraded, and logical 3 run a note a batch, with a page opening `days` after its
   * `at`th batch: what the page opened then, and the profile once the run is done, or null when
   * the run had no `at`th batch
   * @param {readonly Made[]} made
   * @param {number} at
   * @param {{now: () => number, zone: () => string}} clock
   * @param {Array<{dateStr: string, today?: boolean}>} days
   */
  const openedBetween = async (made, at, clock, days) => {
    const of = await withDaily(made);
    const seen = { daily: false, batches: 0, opened: /** @type {Record<string, string | null> | null} */ (null) };
    const outcome = await transform(of, {
      clock: inLA,
      limits: ONE,
      hooks: {
        between: async label => {
          // Logical 3's batches only, from its answer on
          if (label === 'daily-assigned') seen.daily = true;
          if (label !== 'batch' || !seen.daily || (seen.batches += 1) !== at) return;
          seen.opened = await openDays(of, clock, days);
        },
      },
    });
    assert.equal(outcome.status, 'transformed');
    return seen.opened ? { opened: seen.opened, of } : null;
  };

  it('gives each Daily Note its key, moves one made in the evening to the date its name gives when no other holds it, and fills the daily index', async () => {
    const of = await evening();
    const before = await notesIn(of);
    const [point] = await pointsIn(of);
    const outcome = await transform(of, { clock: inLA });
    assert.deepEqual([outcome.status, outcome.steps], ['transformed', ['logical-2', 'logical-3']]);
    const after = await notesIn(of);
    for (const [id, key] of Object.entries(KEYS)) {
      assert.deepEqual(
        [after[id].dailyKey, after[id].dateStr, after[id].dailyTimeZone, after[id].dailyDuplicateOf],
        [key.dailyKey, key.dailyKey, null, key.dailyDuplicateOf],
        id,
      );
      // Its daily placement follows the date it holds
      assert.deepEqual(after[id].placement, { kind: 'daily', dateKey: key.dailyKey }, id);
    }
    // No other note gets a key
    for (const note of Object.values(after)) if (!note.isDaily) assert.equal('dailyKey' in note, false, note.id);
    assert.deepEqual(await indexIn(of), INDEX);
    const receipt = (await receiptsIn(of)).find(found => found.id === 'logical-3');
    assert.deepEqual(
      [receipt.from, receipt.to, receipt.recoveryPointId, receipt.counts],
      [2, 3, point.id, { read: Object.keys(before).length, filled: 6, rekeyed: 2, duplicates: 1 }],
    );
    // Its pinned point holds every note as 1.4.x keyed it
    const file = await exportPoint({ indexedDB: of.real, keyRange: KeyRange, crypto, clock: later, pointId: point.id });
    const held = Object.fromEntries(file.canvases.map(note => [/** @type {any} */ (note).id, note]));
    assert.equal(/** @type {any} */ (held['daily-oct-7-evening']).dateStr, '2025-10-08');
  });

  it("every 1.4.x Daily Note keyed by its UTC date whose local date is free ends on the calendar under the date its name gives (the lead's ask)", async () => {
    const of = await evening();
    const before = Object.values(await notesIn(of)).filter(note => note.isDaily);
    assert.equal((await transform(of, { clock: inLA })).status, 'transformed');
    const after = await notesIn(of);
    // #1's findings name each one 1.4.x keyed by its UTC date, and its local date
    const moved = [];
    for (const note of before) {
      const finding = placementOf(note, new Set()).findings.find(found => found.code === 'daily-utc-key');
      if (!finding || finding.code !== 'daily-utc-key') continue;
      // Free: no Daily Note 1.4.x keyed by its own date holds it
      const held = before.some(
        other =>
          other.id !== note.id &&
          other.dateStr === finding.localKey &&
          !placementOf(other, new Set()).findings.some(found => found.code === 'daily-utc-key'),
      );
      if (held) continue;
      const named = /^Daily Note - (\w+) (\d+), (\d+)$/.exec(note.name);
      assert.ok(named, note.id);
      const calendar = after[note.id].dailyKey || after[note.id].dateStr;
      assert.equal(calendar, finding.localKey, note.id);
      assert.equal(
        new Date(`${calendar}T12:00:00Z`).toLocaleDateString('en-US', {
          month: 'short',
          day: 'numeric',
          year: 'numeric',
          timeZone: 'UTC',
        }),
        `${named[1]} ${named[2]}, ${named[3]}`,
        note.id,
      );
      moved.push(note.id);
    }
    assert.deepEqual(moved.sort(), ['daily-oct-7-evening', 'daily-oct-8-evening']);
  });

  it("changes no Daily Note's name or blocks (the lead's ask)", async () => {
    const of = await evening();
    const before = await writtenIn(of);
    assert.equal((await transform(of, { clock: inLA })).status, 'transformed');
    assert.deepEqual(await writtenIn(of), before);
  });

  it('Daily opened every morning and evening in 1.4.x: each date opens the note named for it, today opens fresh, the first evening note stays under the next day as a duplicate, and nothing is lost', async () => {
    const of = await withDaily(CHAIN);
    const kept = async () => ({
      names: Object.fromEntries(Object.values(await notesIn(of)).map(note => [note.id, note.name])),
      blocks: recordsIn(await dump(of), 'CanvasTabDB', 'elements').map(({ value }) => value),
    });
    const before = await kept();
    assert.equal((await transform(of, { clock: inLA })).status, 'transformed');

    // Nothing is lost: every note is still there with its name, and every block is as it was
    assert.deepEqual(await kept(), before);
    const after = await notesIn(of);
    assert.deepEqual(
      CHAIN.map(([id]) => [id, after[id].dailyKey, after[id].dateStr, after[id].dailyDuplicateOf]),
      [
        ['chain-oct-27', '2025-10-27', '2025-10-27', null],
        // Its own date is held, so it stays under the next day, where 1.4.x showed it, as the
        // duplicate of the note named for that day, which moved there (the one exception to Q7)
        ['chain-oct-27-evening', '2025-10-28', '2025-10-28', 'chain-oct-28-evening'],
        ['chain-oct-28-evening', '2025-10-28', '2025-10-28', null],
        ['chain-oct-29-evening', '2025-10-29', '2025-10-29', null],
      ],
    );

    // Oct 30 at 6:30 PM in Los Angeles
    await withCommands(
      of,
      async (send, kernel) => {
        // Each date opens the note named for it
        for (const [dateStr, id] of [
          ['2025-10-27', 'chain-oct-27'],
          ['2025-10-28', 'chain-oct-28-evening'],
          ['2025-10-29', 'chain-oct-29-evening'],
        ]) {
          const found = await kernel.query({ type: 'findDailyNote', dateStr });
          assert.equal(found.kind === 'ready' && found.data.note.id, id, dateStr);
        }
        // Today's opens fresh: a new note, named for today
        const made = await send({ type: 'ensureDailyNote', noteId: 'chain-today', at: onOct30.now() });
        assert.deepEqual([made.code, made.changedIds], ['daily-note-created', ['chain-today']]);
        const today = await kernel.query({ type: 'findDailyNote', dateStr: '2025-10-30' });
        assert.deepEqual(today.kind === 'ready' && [today.data.note.id, today.data.note.name], [
          'chain-today',
          'Daily Note - Oct 30, 2025',
        ]);
        // And the duplicate stays in the list
        const listed = await kernel.query({ type: 'listNotes', view: 'active' });
        const ids = listed.kind === 'ready' ? listed.data.map(note => note.id) : [];
        for (const [id] of CHAIN) assert.ok(ids.includes(id), id);
      },
      onOct30,
    );
  });

  it("Oct 27's morning, Oct 28's morning and evening, Oct 29's evening, upgraded Oct 30: today's looked up between any two batches opens a new note, and every date keeps the note an uncut run gives it", async () => {
    /** @type {readonly Made[]} */
    const made = [
      ['p-oct-27', 'Oct 27', '2025-10-27', Date.UTC(2025, 9, 27, 15)],
      ['p-oct-28', 'Oct 28', '2025-10-28', Date.UTC(2025, 9, 28, 15)],
      ['p-oct-28-evening', 'Oct 28', '2025-10-29', Date.UTC(2025, 9, 29, 2)],
      ['p-oct-29-evening', 'Oct 29', '2025-10-30', Date.UTC(2025, 9, 30, 2)],
    ];
    // Oct 30 at 10 AM in Los Angeles
    const update = { now: () => Date.UTC(2025, 9, 30, 17), zone: () => 'America/Los_Angeles' };
    const today = [{ dateStr: '2025-10-30', today: true }];
    const reference = await withDaily(made);
    assert.equal((await transform(reference, { clock: inLA, limits: ONE })).status, 'transformed');
    assert.deepEqual(await openDays(reference, update, today), { '2025-10-30': 'new' });
    const expected = await dailyState(reference);
    assert.deepEqual(expected.index, {
      '2025-10-27': 'p-oct-27',
      '2025-10-28': 'p-oct-28',
      '2025-10-29': 'p-oct-29-evening',
      '2025-10-30': 'new',
    });
    let at = 0;
    for (;;) {
      const between = await openedBetween(made, (at += 1), update, today);
      if (!between) break;
      assert.deepEqual(between.opened, { '2025-10-30': 'new' }, `after batch ${at}`);
      assert.deepEqual(await dailyState(between.of), expected, `after batch ${at}`);
    }
    assert.ok(at > 4, `${at - 1} batches`);
  });

  it("upgraded the morning after the chain's last evening note: today's looked up between any two batches opens a new note, and that evening note still ends on its own day", async () => {
    const made = CHAIN.slice(0, 3);
    // Oct 29 at 9 AM in Los Angeles
    const morning = { now: () => Date.UTC(2025, 9, 29, 16), zone: () => 'America/Los_Angeles' };
    let at = 0;
    for (;;) {
      const between = await openedBetween(made, (at += 1), morning, [{ dateStr: '2025-10-29', today: true }]);
      if (!between) break;
      const label = `after batch ${at}`;
      assert.deepEqual(between.opened, { '2025-10-29': 'new' }, label);
      const { keys, index } = await dailyState(between.of);
      assert.deepEqual(keys['chain-oct-28-evening'], ['2025-10-28', '2025-10-28', null], label);
      assert.deepEqual(
        index,
        { '2025-10-27': 'chain-oct-27', '2025-10-28': 'chain-oct-28-evening', '2025-10-29': 'new' },
        label,
      );
    }
    assert.ok(at > 4, `${at - 1} batches`);
  });

  it("a mover's date looked up between any two batches opens the note that moves there, and the run ends where an uncut run does", async () => {
    const days = [{ dateStr: '2025-10-28' }, { dateStr: '2025-10-29' }];
    const reference = await withDaily(CHAIN);
    assert.equal((await transform(reference, { clock: inLA, limits: ONE })).status, 'transformed');
    const expected = await dailyState(reference);
    let at = 0;
    for (;;) {
      const between = await openedBetween(CHAIN, (at += 1), onOct30, days);
      if (!between) break;
      const label = `after batch ${at}`;
      assert.deepEqual(
        between.opened,
        { '2025-10-28': 'chain-oct-28-evening', '2025-10-29': 'chain-oct-29-evening' },
        label,
      );
      assert.deepEqual(await dailyState(between.of), expected, label);
    }
    assert.ok(at > 4, `${at - 1} batches`);
  });

  it('after the run, a date whose index entry is gone opens the note that moved there, not the duplicate made before it', async () => {
    const of = await withDaily(CHAIN);
    assert.equal((await transform(of, { clock: inLA })).status, 'transformed');
    const expected = await dailyState(of);
    const db = await done(of.real.open('CanvasTabDB'));
    const tx = db.transaction(['daily_index'], 'readwrite');
    tx.objectStore('daily_index').delete('2025-10-28');
    await committed(tx);
    db.close();
    assert.deepEqual(await openDays(of, onOct30, [{ dateStr: '2025-10-28' }]), {
      '2025-10-28': 'chain-oct-28-evening',
    });
    // The lookup put the entry back, and left the duplicate as it was
    assert.deepEqual(await dailyState(of), expected);
  });

  it("cut off at any stop, with a page opening each Daily Note and today's while the run is cut, a second run ends where an uncut run does", async () => {
    const days = [
      { dateStr: '2025-10-27' },
      { dateStr: '2025-10-28' },
      { dateStr: '2025-10-29' },
      { dateStr: '2025-10-30', today: true },
    ];
    const reference = await withDaily(CHAIN);
    assert.equal((await transform(reference, { clock: inLA, limits: ONE })).status, 'transformed');
    const opened = await openDays(reference, onOct30, days);
    assert.deepEqual(opened, {
      '2025-10-27': 'chain-oct-27',
      '2025-10-28': 'chain-oct-28-evening',
      '2025-10-29': 'chain-oct-29-evening',
      '2025-10-30': 'new',
    });
    const expected = await dailyState(reference);
    let stops = 0;
    for (let at = 1; ; at++) {
      const of = await withDaily(CHAIN);
      const cut = killAt(at);
      const first = await transform(of, { clock: inLA, limits: ONE, hooks: cut.hooks });
      if (cut.reached.count < at) {
        assert.equal(first.status, 'transformed');
        stops = at - 1;
        break;
      }
      const label = `cut at ${at} (${cut.reached.labels.at(-1)})`;
      assert.equal(first.status, 'failed', label);
      assert.deepEqual(await openDays(of, onOct30, days), opened, label);
      // Cut after its last step's receipt, the run had nothing left to do
      const second = await transform(of, { clock: inLA, limits: ONE });
      assert.ok(['transformed', 'current'].includes(second.status), `${label}: ${second.status}`);
      assert.deepEqual(await dailyState(of), expected, label);
    }
    assert.ok(stops > 12, `${stops} stops`);
  });

  it('takes a date its answer gives a note back from another note the run read, which a command keyed there, even one made first', async () => {
    const of = await withDaily(CHAIN);
    const outcome = await transform(of, {
      clock: inLA,
      limits: ONE,
      hooks: {
        between: async label => {
          if (label !== 'daily-assigned') return;
          // Oct 28's evening note, keyed under Oct 29 with that date's entry, between the run's
          // read and its batches, as a lookup that took 1.4.x's date might have left it
          const db = await done(of.real.open('CanvasTabDB'));
          const tx = db.transaction(['canvases', 'daily_index'], 'readwrite');
          const store = tx.objectStore('canvases');
          const note = await done(store.get('chain-oct-28-evening'));
          store.put({ ...note, dailyKey: '2025-10-29', dailyTimeZone: null, dailyDuplicateOf: null });
          tx.objectStore('daily_index').put({ dailyKey: '2025-10-29', noteId: 'chain-oct-28-evening' });
          await committed(tx);
          db.close();
        },
      },
    });
    assert.equal(outcome.status, 'transformed');
    const { keys, index } = await dailyState(of);
    // The answer gives Oct 29 to the note named for it, and the other keeps its key, as its duplicate
    assert.equal(index['2025-10-29'], 'chain-oct-29-evening');
    assert.deepEqual(keys['chain-oct-29-evening'], ['2025-10-29', '2025-10-29', null]);
    assert.deepEqual(keys['chain-oct-28-evening'], ['2025-10-29', '2025-10-29', 'chain-oct-29-evening']);
  });

  it('a note a lookup opens while the run goes, as one restored from the trash then, keeps what a page saved and a capture added into it, still listed under its name, as a duplicate once the run is done', async () => {
    // Oct 28's own Daily Note, made that morning, in the trash when the run read the notes
    /** @type {Made} */
    const morning = ['chain-oct-28-morning', 'Oct 28', '2025-10-28', Date.UTC(2025, 9, 28, 16)];
    const of = await withDaily([...CHAIN, morning], {
      'chain-oct-28-morning': { trashed: true, trashedAt: Date.UTC(2025, 9, 29, 16) },
    });
    // Oct 28 at 1 PM in Los Angeles, for the page and the worker
    const onOct28 = { now: () => Date.UTC(2025, 9, 28, 20), zone: () => 'America/Los_Angeles' };
    const seen = { opened: /** @type {string | null} */ (null) };
    const outcome = await transform(of, {
      clock: inLA,
      limits: ONE,
      hooks: {
        between: async label => {
          if (label !== 'daily-assigned') return;
          // Restored from the trash after the run weighed the notes, before any of its batches,
          // so Oct 28 opens it for now, where the run's answer gives the date to the evening note
          // named for it (the case #17 PR 4's lookup that follows the answer closes)
          await withCommands(of, send => send({ type: 'restoreNote', noteId: morning[0] }), onOct28);
          seen.opened = (await openDays(of, onOct28, [{ dateStr: '2025-10-28' }]))['2025-10-28'];
          // What a page types into the note that opened
          const blocks = ['Evening', 'Next morning', 'Typed while the run went'].map((content, order) => ({
            id: order < 2 ? `${morning[0]}-${order}` : 'typed-during-run',
            type: 'text',
            content,
            canvasId: morning[0],
            order,
          }));
          await withCommands(of, send => send({ type: 'saveNoteContent', noteId: morning[0], blocks }), onOct28);
          // And what a capture adds to today's
          await withCommands(
            of,
            send =>
              send({
                type: 'captureToDailyNote',
                noteId: 'capture-made-during-run',
                blockId: 'captured-during-run',
                capture: { type: 'text', content: 'Captured while the run went' },
              }),
            onOct28,
            CALLERS['worker-internal'],
          );
        },
      },
    });
    assert.equal(outcome.status, 'transformed');
    assert.equal(seen.opened, morning[0]);
    const kept = (await notesIn(of))[morning[0]];
    assert.deepEqual(
      [Boolean(kept.trashed), Boolean(kept.archived), Boolean(kept.isTemplate), kept.name],
      [false, false, false, 'Daily Note - Oct 28, 2025'],
    );
    const contents = recordsIn(await dump(of), 'CanvasTabDB', 'elements')
      .map(({ value }) => value)
      .filter(block => block.canvasId === morning[0])
      .map(block => block.content)
      .sort();
    assert.deepEqual(contents, ['Captured while the run went', 'Evening', 'Next morning', 'Typed while the run went']);
    // Still listed, and once the run is done, the duplicate of the note the run gives the date
    await withCommands(of, async (_, kernel) => {
      const listed = await kernel.query({ type: 'listNotes', view: 'active' });
      assert.ok(listed.kind === 'ready' && listed.data.some(note => note.id === morning[0]));
    });
    assert.equal((await indexIn(of))['2025-10-28'], 'chain-oct-28-evening');
    assert.equal(kept.dailyDuplicateOf, 'chain-oct-28-evening');
  });

  it('takes a date back from a Daily Note a page made during the run after the one that holds it, whose entry the index had, which becomes its duplicate', async () => {
    const of = await evening();
    // A Daily Note the kernel made for Oct 10 at 11, with its entry, after the race's two and
    // after the run read the notes
    const later = {
      ...legacyNote('kernel-oct-10', { name: 'Daily Note - Oct 10, 2025', isDaily: true, dateStr: '2025-10-10' }),
      createdAt: Date.UTC(2025, 9, 20),
      dailyKey: '2025-10-10',
      dailyTimeZone: 'America/Los_Angeles',
      dailyDuplicateOf: null,
    };
    const hooks = {
      between: async (/** @type {string} */ label) => {
        if (label !== 'daily-assigned') return;
        const db = await done(of.real.open('CanvasTabDB'));
        const tx = db.transaction(['canvases', 'daily_index'], 'readwrite');
        tx.objectStore('canvases').put(later);
        tx.objectStore('daily_index').put({ dailyKey: '2025-10-10', noteId: 'kernel-oct-10' });
        await committed(tx);
        db.close();
      },
    };
    assert.equal((await transform(of, { clock: inLA, hooks })).status, 'transformed');
    const after = await notesIn(of);
    assert.equal((await indexIn(of))['2025-10-10'], 'daily-oct-10-a');
    assert.deepEqual(
      [after['kernel-oct-10'].dailyKey, after['kernel-oct-10'].dailyDuplicateOf, after['kernel-oct-10'].dailyTimeZone],
      ['2025-10-10', 'daily-oct-10-a', 'America/Los_Angeles'],
    );
    assert.equal(after['daily-oct-10-a'].dailyDuplicateOf, null);
  });

  it('leaves a Daily Note a command keyed otherwise once the run read the notes as that command left it', async () => {
    const of = await evening();
    const outcome = await transform(of, {
      clock: inLA,
      hooks: {
        between: async label => {
          if (label !== 'daily-assigned') return;
          // As a lookup in another zone might key it, between the run's read and its batches
          const db = await done(of.real.open('CanvasTabDB'));
          const tx = db.transaction(['canvases'], 'readwrite');
          const store = tx.objectStore('canvases');
          const note = await done(store.get('daily-oct-12-planned'));
          store.put({ ...note, dailyKey: '2025-10-13', dateStr: '2025-10-13' });
          await committed(tx);
          db.close();
        },
      },
    });
    assert.equal(outcome.status, 'transformed');
    const planned = (await notesIn(of))['daily-oct-12-planned'];
    assert.deepEqual([planned.dailyKey, planned.dateStr], ['2025-10-13', '2025-10-13']);
    assert.equal((await indexIn(of))['2025-10-12'], undefined);
  });

  it('cut off at any stop, a second run ends where an uncut run does, with the same keys and index', async () => {
    const limits = { records: 2, bytes: DEFAULT_LIMITS.bytes };
    const reference = await evening();
    assert.equal((await transform(reference, { clock: inLA, limits })).status, 'transformed');
    const expected = { notes: await notesIn(reference), index: await indexIn(reference) };
    let stops = 0;
    for (let at = 1; ; at++) {
      const of = await evening();
      const cut = killAt(at);
      const first = await transform(of, { clock: inLA, limits, hooks: cut.hooks });
      if (cut.reached.count < at) {
        assert.equal(first.status, 'transformed');
        stops = at - 1;
        break;
      }
      const label = `cut at ${at} (${cut.reached.labels.at(-1)})`;
      assert.equal(first.status, 'failed', label);
      await transform(of, { clock: inLA, limits });
      assert.deepEqual({ notes: await notesIn(of), index: await indexIn(of) }, expected, label);
      assert.equal(TRANSFORM_DAILY_KEY in (await metaIn(of)), false, label);
    }
    assert.ok(stops > 12, `${stops} stops`);
  });
});

describe("a trashed note's time in the trash (#17 PR 3a, the lead's rule)", () => {
  const DAY = 24 * 60 * 60 * 1000;
  /** Trashed, and never listed by 1.4.x, since it has no updatedAt */
  const unlistedOld = legacyNote(
    'x-trash-old',
    { name: 'Trashed long ago', trashed: true, trashedAt: NOW - 90 * DAY },
    ['updatedAt'],
  );
  const unlistedUndated = legacyNote('x-trash-none', { name: 'Trashed, no date', trashed: true }, [
    'updatedAt',
    'trashedAt',
  ]);
  /** Trashed, and listed */
  const listedOld = legacyNote('x-trash-listed', { name: 'Listed, old', trashed: true, trashedAt: NOW - 90 * DAY });
  const listedUndated = legacyNote('x-trash-undated', { name: 'Listed, no date', trashed: true, trashedAt: null });

  /**
   * The ids the trash lists, as the new tab reads it
   * @param {import('../../js/kernel/core/application/kernel.js').Kernel} kernel
   */
  const inTrash = async kernel => {
    const state = await kernel.query({ type: 'listNotes', view: 'trashed' });
    return state.kind === 'ready' ? state.data.map(note => note.id) : [];
  };

  for (const [label, note] of /** @type {const} */ ([
    ['an old trashedAt', unlistedOld],
    ['no trashedAt', unlistedUndated],
  ])) {
    it(`a trashed note 1.4.x never listed, with ${label}, survives the startup retention cleanup before and after the transform, lists in Trash, and its window starts at the upgrade`, async () => {
      const of = await upgraded([note]);
      // The new tab's startup cleanup before the transform reached it
      await withCommands(of, async (send, kernel) => {
        await send({ type: 'runTrashCleanup' });
        assert.ok((await inTrash(kernel)).includes(/** @type {string} */ (note.id)), 'in Trash before the transform');
      });
      assert.equal((await transform(of, { clock: later })).status, 'transformed');
      const filled = (await notesIn(of))[/** @type {string} */ (note.id)];
      assert.deepEqual([filled.trashedAt, filled.lifecycle], [RUN_START, 'trashed']);
      // A cleanup inside a window from the upgrade keeps it, and one past it takes it
      await withCommands(
        of,
        async (send, kernel) => {
          await send({ type: 'runTrashCleanup' });
          assert.ok((await inTrash(kernel)).includes(/** @type {string} */ (note.id)), 'in Trash after the transform');
        },
        { now: () => RUN_START + 29 * DAY },
      );
      await withCommands(of, send => send({ type: 'runTrashCleanup' }), { now: () => RUN_START + 31 * DAY });
      assert.equal(/** @type {string} */ (note.id) in (await notesIn(of)), false);
    });
  }

  it("a trashed note 1.4.x listed keeps its trashedAt, and one with no time in the trash gets the run's start", async () => {
    const of = await upgraded([listedOld, listedUndated]);
    assert.equal((await transform(of, { clock: later })).status, 'transformed');
    const notes = await notesIn(of);
    assert.deepEqual(
      [notes['x-trash-listed'].trashedAt, notes['x-trash-undated'].trashedAt],
      [NOW - 90 * DAY, RUN_START],
    );
    // Retention counts each from its own: the old one goes now, the other a window from the upgrade
    await withCommands(of, send => send({ type: 'runTrashCleanup' }), { now: () => RUN_START + DAY });
    const after = await notesIn(of);
    assert.deepEqual(['x-trash-listed' in after, 'x-trash-undated' in after], [false, true]);
  });

  it('Empty trash takes a trashed note 1.4.x never listed, as the user sees it in Trash', async () => {
    const of = await upgraded([unlistedOld]);
    await withCommands(of, send => send({ type: 'emptyTrash' }));
    assert.equal('x-trash-old' in (await notesIn(of)), false);
  });
});

describe("the new tab's startup trash cleanup and the notes 1.4.x never listed (review R88)", () => {
  const DAY = 24 * 60 * 60 * 1000;
  /** The new tab's clock: an hour after the run's, so a time the transform gave is recent */
  const TAB = NOW + 60 * 60 * 1000;
  const HIDDEN = ['hidden-none', 'hidden-null', 'hidden-old', 'hidden-recent'];

  /** v8.basic at 8 with a listed note trashed 40 days ago, four 1.4.x never listed, and an active one */
  const profile = async () => {
    const of = await profileWith(BASIC);
    const base = legacyNote('base', { createdAt: NOW - 90 * DAY }, ['updatedAt']);
    const notes = [
      { ...base, id: 'visible-old', trashed: true, trashedAt: NOW - 40 * DAY, updatedAt: NOW - 50 * DAY },
      { ...base, id: 'hidden-old', trashed: true, trashedAt: NOW - 40 * DAY },
      { ...base, id: 'hidden-null', trashed: true, trashedAt: NOW - 40 * DAY, updatedAt: null },
      { ...base, id: 'hidden-none', trashed: true },
      { ...base, id: 'hidden-recent', trashed: true, trashedAt: NOW - 2 * DAY },
      { ...base, id: 'active-x', updatedAt: NOW - DAY },
    ];
    const db = await done(of.real.open('CanvasTabDB'));
    const tx = db.transaction(['canvases', 'elements'], 'readwrite');
    for (const note of notes) {
      tx.objectStore('canvases').put(note);
      tx.objectStore('elements').put({
        id: `${note.id}-b1`,
        canvasId: note.id,
        type: 'text',
        content: 'Body',
        order: 0,
      });
    }
    await committed(tx);
    db.close();
    return of;
  };

  /**
   * The new tab's kernel on the legacy adapter over `of`, as App runs its startup cleanup
   * @param {Profile} of
   * @param {number} now
   */
  const newTab = async (of, now) => {
    const env = legacyEnv.createLegacyEnv({ context: 'page', indexedDB: of.real, chrome: of.chrome });
    env.load('js/utils.js', 'js/storage.js');
    const storage = env.get('Storage');
    const adapter = createLegacyAdapter({ storage, settings: of.chrome.api.storage.local, mode: 'versioned' });
    await adapter.open();
    const kernel = createKernel({
      adapter,
      policy: createBaselinePolicy(),
      caller: CALLERS.newtab,
      ids: { next: () => `tab-${(commandCount += 1)}` },
      clock: { now: () => now },
    });
    open.push({ close: () => storage.db && storage.db.close() });
    return kernel;
  };

  /**
   * The trash as the kernel lists it, and what a startup cleanup deletes
   * @param {import('../../js/kernel/core/application/kernel.js').Kernel} kernel
   */
  const cleanUp = async kernel => {
    const trash = await kernel.query({ type: 'listNotes', view: 'trashed' });
    const cleaned = await kernel.execute({ type: 'runTrashCleanup', commandId: `clean-${(commandCount += 1)}` });
    assert.equal(cleaned.kind, 'committed', JSON.stringify(cleaned));
    return {
      listed: trash.kind === 'ready' ? trash.data.map(note => note.id) : [],
      deleted: cleaned.kind === 'committed' ? [...cleaned.changedIds].sort() : [],
    };
  };

  /** v8.basic's own trashed note, Thrown away, which 1.4.x listed and trashed long ago */
  const THROWN = recordsIn(BASIC, 'CanvasTabDB', 'canvases')
    .map(({ value }) => value)
    .find(note => note.trashed).id;

  for (const scenario of /** @type {const} */ (['A', 'B', 'C'])) {
    const label = {
      A: 'no run, so the database stays at 8 (short of space, or blocked)',
      B: "the run is in, and the cleanup comes before the worker's transforms",
      C: 'the run and the transforms are in',
    }[scenario];
    it(`${scenario}: ${label}: the hidden notes survive and list in Trash, and a listed expired note is still deleted`, async () => {
      const of = await profile();
      if (scenario !== 'A') assert.equal((await run(of)).status, 'migrated');
      if (scenario === 'C') assert.equal((await transform(of)).status, 'transformed');
      const { listed, deleted } = await cleanUp(await newTab(of, TAB));
      for (const id of HIDDEN) assert.ok(listed.includes(id), `${id} lists in Trash`);
      assert.deepEqual(deleted, [THROWN, 'visible-old'].sort());
      const notes = await notesIn(of);
      for (const id of HIDDEN) assert.ok(notes[id], `${id} is still there`);
      if (scenario === 'C') {
        // Their clock starts at the run: a cleanup inside a window keeps them, one past it takes them
        for (const id of HIDDEN) assert.equal(notes[id].trashedAt, NOW, id);
        assert.deepEqual((await cleanUp(await newTab(of, NOW + 29 * DAY))).deleted, []);
        assert.deepEqual((await cleanUp(await newTab(of, NOW + 31 * DAY))).deleted, HIDDEN);
      }
    });
  }
});

describe('below version 10, where 1.4.1 still opens the database, no command writes the group (review R88, p3)', () => {
  /** @param {Record<string, unknown>} note */
  const groupOf = note =>
    Object.fromEntries(PLACEMENT_FIELDS.filter(field => field in note).map(field => [field, note[field]]));

  /**
   * Frozen 1.4.1 on `of`, which opens version 8 as its own, run as its new tab starts
   * @param {Profile} of
   */
  const release141 = async of => {
    const env = legacyEnv.createLegacyEnv({ context: 'page', indexedDB: of.real, chrome: of.chrome });
    env.load(
      'test/fixtures/storage/releases/v1.4.1/js/utils.js',
      'test/fixtures/storage/releases/v1.4.1/js/storage.js',
    );
    const storage = env.get('Storage');
    await storage.init();
    return storage;
  };

  it("the new tab's kernel on a database the run didn't reach writes none, so the transform takes the flags 1.4.1 left", async () => {
    const of = await profileWith(BASIC);
    // This build's new tab on the database as it is, at 8: the run was short of space, say
    const env = legacyEnv.createLegacyEnv({ context: 'page', indexedDB: of.real, chrome: of.chrome });
    env.load('js/utils.js', 'js/storage.js');
    const storage = env.get('Storage');
    const adapter = createLegacyAdapter({ storage, settings: of.chrome.api.storage.local, mode: 'versioned' });
    await adapter.open();
    const ids = { next: () => `p3-${(commandCount += 1)}` };
    const kernel = createKernel({ adapter, policy: createBaselinePolicy(), caller: CALLERS.newtab, ids, clock: later });
    for (const [noteId, name] of [
      ['made-at-8', 'Made at 8'],
      ['moved-later', 'Moved later'],
    ]) {
      const made = await kernel.execute({ type: 'createNote', commandId: ids.next(), noteId, name });
      assert.equal(made.kind, 'committed', JSON.stringify(made));
    }
    storage.db.close();
    const at8 = await notesIn(of);
    for (const id of ['made-at-8', 'moved-later']) assert.deepEqual(groupOf(at8[id]), {}, id);

    // Back on 1.4.1, which changes only the flags
    const old = await release141(of);
    const folder = await old.createFolder('A folder');
    await old.trashNote('made-at-8');
    await old.moveNoteToFolder('moved-later', folder.id);
    old.db.close();

    assert.equal((await run(of)).status, 'migrated');
    assert.equal((await transform(of)).status, 'transformed');
    const after = await notesIn(of);
    assert.deepEqual(groupOf(after['made-at-8']), {
      placement: { kind: 'collection', folderId: null },
      kind: 'note',
      lifecycle: 'trashed',
    });
    assert.deepEqual(groupOf(after['moved-later']), {
      placement: { kind: 'collection', folderId: folder.id },
      kind: 'note',
      lifecycle: 'active',
    });
  });

  it("the worker's kernel, on #17's adapter opened as the database is, writes none there either", async () => {
    const of = await profileWith(BASIC);
    // The worker's kernel when its run didn't get in (composition/background.js's `existing` open)
    const adapter = createIndexedDbAdapter({
      indexedDB: of.faults.factory,
      settings: of.chrome.api.storage.local,
      keyRange: KeyRange,
      clock: later,
      mode: 'existing',
      requireCore: true,
    });
    await adapter.open();
    const ids = { next: () => `p3-${(commandCount += 1)}` };
    const worker = createKernel({
      adapter,
      policy: createBaselinePolicy(),
      caller: CALLERS['worker-internal'],
      ids,
      clock: later,
    });
    const captured = await worker.execute({
      type: 'captureToDailyNote',
      commandId: ids.next(),
      noteId: 'captured-at-8',
      blockId: 'captured-at-8-b1',
      capture: { type: 'text', content: 'Quote' },
    });
    assert.equal(captured.kind, 'committed', JSON.stringify(captured));
    adapter.close();
    const at8 = await notesIn(of);
    assert.deepEqual(groupOf(at8['captured-at-8']), {});

    const old = await release141(of);
    await old.trashNote('captured-at-8');
    old.db.close();

    assert.equal((await run(of)).status, 'migrated');
    assert.equal((await transform(of)).status, 'transformed');
    const daily = (await notesIn(of))['captured-at-8'];
    assert.deepEqual(groupOf(daily), {
      placement: { kind: 'daily', dateKey: daily.dateStr },
      kind: 'note',
      lifecycle: 'trashed',
    });
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
    // 14 notes, 3 at a time: five batches a step, logical 2's then logical 3's, and a yield
    // between each two of a step
    const steps = progress.map(record => record.id);
    assert.deepEqual(steps, [...Array(5).fill('logical-2'), ...Array(5).fill('logical-3')]);
    assert.equal(yields, 8);
    const ids = Object.keys(await notesIn(of)).sort();
    for (const id of ['logical-2', 'logical-3']) {
      assert.deepEqual(
        progress.filter(record => record.id === id).map(record => [record.after, record.counts.read]),
        [
          [ids[2], 3],
          [ids[5], 6],
          [ids[8], 9],
          [ids[11], 12],
          [ids[13], 14],
        ],
        id,
      );
    }
    assert.deepEqual(
      progress.map(record => [record.recoveryPointId, record.startedAt]),
      progress.map(() => [outcome.recoveryPointId, RUN_START]),
    );
    const batches = of.faults.transactions.filter(
      opened => opened.mode === 'readwrite' && opened.names.includes('canvases') && opened.names.includes('meta'),
    );
    assert.equal(batches.length, 10);
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
    assert.equal(batches, 28, 'one note a batch, for each of the two steps');
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
    assert.equal((await metaIn(of)).schema.logicalVersion, 3);
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
      // Cut after the last step's receipt went in, there's nothing left to do
      const finished = cut.reached.labels.filter(found => found === 'step-done').length === 2;
      assert.equal(second.status, finished ? 'current' : 'transformed', label);
      assert.deepEqual(await ended(of), target, label);
      const points = await pointsIn(of);
      assert.ok(
        points.every(point => point.status === 'verified' && point.verifies),
        label,
      );
      const own = points.filter(point => point.logicalTarget === 3);
      assert.equal(own.length, 1, label);
      // Both steps' receipts name it, a cut between the two included
      for (const id of ['logical-2', 'logical-3']) {
        const receipt = (await receiptsIn(of)).find(found => found.id === id);
        assert.equal(receipt.recoveryPointId, own[0].id, `${label}: ${id}`);
      }
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
        [pinned.id, true, 11, null, 'verified', true],
        [outcome.recoveryPointId, false, null, 3, 'verified', true],
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
      target: 3,
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
    assert.equal((await metaIn(of)).schema.logicalVersion, 3);
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
      [11],
      'only the run’s point',
    );
    assert.equal((await metaIn(of))[TRANSFORM_STOP_KEY]?.code, 'quota');
  });

  it('with nothing to fill, it writes its receipt without a point, and makes no recovery database', async () => {
    const of = newProfile();
    assert.equal((await run(of)).status, 'migrated');
    // Notes the kernel made carry their group already, and a Daily Note its key
    await withCommands(of, async send => {
      await send({ type: 'createNote', noteId: 'n1', name: 'Plan' });
      await send({ type: 'ensureDailyNote', noteId: 'd1' });
    });
    const outcome = await transform(of, { clock: later });
    assert.deepEqual(
      [outcome.status, outcome.steps, outcome.filled, outcome.recoveryPointId],
      ['transformed', ['logical-2', 'logical-3'], 0, null],
    );
    const receipts = await receiptsIn(of);
    assert.deepEqual(
      ['logical-2', 'logical-3'].map(id => {
        const receipt = receipts.find(found => found.id === id);
        return [receipt.recoveryPointId, receipt.counts];
      }),
      [
        [null, { read: 2, filled: 0, staleFolder: 0, dailyWithoutDate: 0 }],
        [null, { read: 2, filled: 0, rekeyed: 0, duplicates: 0 }],
      ],
    );
    assert.equal((await metaIn(of)).schema.logicalVersion, 3);
    const names = (await dump(of)).databases.map(db => db.name);
    assert.equal(names.includes(RECOVERY_DB_NAME), false);
  });
});

describe("the point's export after the transform (#17 PR 3a, Q8)", () => {
  it("writes every note as 1.4.1 stores one, without the group or a Daily Note's key, from a point taken after it", async () => {
    const of = await upgraded();
    assert.equal((await transform(of, { clock: later })).status, 'transformed');
    // A point a later run takes, as a later build's step past 11 will, holds the filled notes
    const source = /** @type {IDBDatabase} */ (await openWithoutUpgrade(of.real, DB_NAME));
    const recovery = /** @type {IDBDatabase} */ (await openRecovery(of.real, { create: false }));
    try {
      const { point, progress } = await startPoint(recovery, {
        id: `pre-migration-${RUN_START + 1}`,
        kind: 'pre-migration',
        sourceShape: 'current',
        sourceVersion: source.version,
        structuralVersion: 11,
        logicalVersion: 3,
        target: 12,
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
