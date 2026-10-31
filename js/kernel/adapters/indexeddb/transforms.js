/**
 * #17's data transforms (#17 PR 3a; registry.js's TRANSFORM_STEPS): logical versions that fill
 * fields on records in place, outside any upgrade. Only the service worker runs them, once its
 * migration run is in, under Web Lock `storage.migrate` held exclusive, as the runner and the
 * purge are. The worker's kernel never waits for them, and they hold no page up: a capture or a
 * page's commit goes in between two batches.
 *
 * A run:
 * 1. Reads `meta.schema`. Nothing pending: nothing to do.
 * 2. Reads the notes, readonly, until one lacks what a pending step fills. None does (a new
 *    profile, or every note made by a kernel command): each step's receipt goes in at once,
 *    with no recovery point, since a run would change nothing a point could give back.
 * 3. Takes its recovery point (#17, "Steps" 1): the one a cut-off run named, or the newest
 *    verified pre-migration point while it still holds the stores the transforms rewrite (Q9),
 *    or else a new one, after the space check. Short of space, nothing runs, and reads derive
 *    what the transforms would fill.
 * 4. Fills each pending step's fields batch by batch: one strict readwrite transaction of at
 *    most 100 records or 2 MB, which reads what it rewrites, so a commit between two batches is
 *    never undone, and records in `meta` where it got to (TRANSFORM_KEY). It yields a macrotask
 *    between batches.
 * 5. Writes the step's receipt and raises `meta.schema.logicalVersion` to it, in one
 *    transaction.
 * Cut off anywhere, the next run picks up where `meta` says, and each fill looks at what's there
 * first, so a batch run twice changes nothing. A fill takes only what's absent, but for one
 * field, a trashed note's `trashedAt` when 1.4.x never listed the note (filledByLogical2), and
 * never overwrites a field a command wrote.
 *
 * A run that read every store and then stopped, short of space or on a point that didn't
 * verify, records the stop in `meta` (TRANSFORM_STOP_KEY), and the worker's starts in the next
 * TRANSFORM_RETRY_AFTER_MS don't read them all again, as the runner's starts don't (review R79).
 * Each outcome holds the stop the run found recorded (`previous`), so the worker journals a
 * stop once per code (composition/background.js, #20); a completed step takes the stop with it.
 *
 * Logical 2 gives each note without a placement its placement, kind, and lifecycle from its
 * flags, by #1's rules (domain/placement.js). It also gives a note whose `updatedAt` no index
 * can hold one (domain/note.js, filledUpdatedAt), so Storage's lists and its export list it too
 * (KD-011), and a trashed note its time in the trash, which retention counts from. It writes no
 * change entry and moves no version: it adds what the flags already say. Its receipt counts the
 * notes it read and filled, and #1's findings (placementFindingsOf), never content.
 *
 * Logical 3 (#17 PR 3b) gives each Daily Note its local key, by #17's rules (domain/daily.js,
 * assignDailyKeys), and fills step 11's daily index. The rules weigh every Daily Note at once,
 * so the run reads them all first, in bounded readonly batches, and keeps the answer in `meta`
 * (TRANSFORM_DAILY_KEY) until the step's receipt, so a cut-off run picks up with the same answer
 * whatever its batches wrote. A batch claims each key in the index as it writes the note that
 * holds it, so an entry a command wrote since the run read the notes, for a Daily Note it made,
 * goes to the earlier made of the two. Its receipt counts the notes it read and filled, the
 * ones it moved to their local date, and the ones it marked as duplicates, never content.
 */

import { assignDailyKeys, canHoldKey, holdsKey, madeBefore, withAssignedKey } from '../../core/domain/daily.js';
import { filledUpdatedAt, hasIndexedTime, hasTrashTime } from '../../core/domain/note.js';
import { hasPlacementGroup, isDateKey, placementFindingsOf, placementGroupOf } from '../../core/domain/placement.js';
import { zoneOf } from '../../core/ports/runtime.js';
import { failureOf } from './failures.js';
import { approximateBytes } from './records.js';
import {
  DEFAULT_LIMITS,
  POINTS_LOCK,
  committed,
  copyPoint,
  discardPoint,
  isQuota,
  keepVerified,
  listPoints,
  matchesSource,
  measureStores,
  openRecovery,
  readBatch,
  readProgress,
  startPoint,
  storesToCopy,
  verifyPoint,
} from './recovery-points.js';
import {
  DAILY_INDEX_STORE,
  LATEST_LOGICAL,
  META_STORE,
  MIGRATIONS_STORE,
  SCHEMA_KEY,
  pendingTransforms,
} from './registry.js';
import { result } from './requests.js';
import { DB_NAME } from './schema.js';
import { openWithoutUpgrade } from './shapes.js';
import { checkSpace } from './space.js';

/** @typedef {import('./registry.js').TransformStep} TransformStep */
/** @typedef {import('./recovery-points.js').Point} Point */
/** @typedef {import('./recovery-points.js').Io} Io */
/** @typedef {import('./recovery-points.js').Limits} Limits */
/** @typedef {import('./records.js').Digester} Digester */
/** @typedef {import('./space.js').Estimate} Estimate */
/** @typedef {import('./shapes.js').Receipt} Receipt */
/** @typedef {import('../../core/domain/note.js').NoteRecord} NoteRecord */
/** @typedef {import('../../core/domain/daily.js').DailyAssignment} DailyAssignment */
/** @typedef {import('../../core/ports/runtime.js').Clock} Clock */
/** @typedef {import('../../core/ports/runtime.js').Logger} Logger */

/** `meta`'s record of a run in progress: the step, the last note it read, its point, and its counts */
export const TRANSFORM_KEY = 'transform';

/** `meta`'s record of a run that read every store and then stopped (see the top of this file) */
export const TRANSFORM_STOP_KEY = 'transform-stop';

/** `meta`'s record of logical 3's answer while its batches run (see the top of this file) */
export const TRANSFORM_DAILY_KEY = 'transform-daily';

/** How long such a stop stands, as the worker's RETRY_AFTER_MS for the runner */
export const TRANSFORM_RETRY_AFTER_MS = 30 * 60 * 1000;

/**
 * What a receipt counts (COUNTED): the notes read and filled, and for logical 2 #1's findings
 * among those read, for logical 3 the notes moved to their local date and those marked as
 * duplicates
 * @typedef {Record<string, number>} TransformCounts
 */

/**
 * Logical 3's answer, as `meta` keeps it: each Daily Note's id, key, holder when another holds
 * it, and whether it moves to its local date, and the zone the run took local dates in
 * @typedef {{key: typeof TRANSFORM_DAILY_KEY, zone: string, assignments: Array<[string, string, string | null, boolean]>}} TransformDaily
 */

/**
 * Where a cut-off run got to
 * @typedef {{key: typeof TRANSFORM_KEY, id: string, after: IDBValidKey | null, recoveryPointId: string | null, startedAt: number, counts: TransformCounts}} TransformProgress
 */

/**
 * @typedef {{key: typeof TRANSFORM_STOP_KEY, status: 'space-blocked' | 'failed', code: string, at: number, target: number}} TransformStop
 */

/**
 * The stores the transforms rewrite that a reused point must still hold as they are. Logical 3
 * also writes the daily index, which is derived from the notes, so a point that holds them as
 * they were holds what it needs.
 */
const REWRITTEN = Object.freeze(['canvases']);

/** What each step's receipt counts */
const COUNTED = Object.freeze({
  'logical-2': Object.freeze(['read', 'filled', 'staleFolder', 'dailyWithoutDate']),
  'logical-3': Object.freeze(['read', 'filled', 'rekeyed', 'duplicates']),
});

/** @type {IDBTransactionOptions} */
const STRICT = Object.freeze({ durability: 'strict' });

/**
 * Web Locks, or anything with its request(name, options, callback)
 * @typedef {{request: (name: string, options: {mode: 'exclusive'}, callback: () => Promise<any>) => Promise<any>}} TransformLocks
 */

/**
 * @typedef {object} TransformOptions
 * @property {IDBFactory} indexedDB
 * @property {typeof IDBKeyRange} keyRange - from the same IndexedDB as `indexedDB`
 * @property {TransformLocks} locks
 * @property {Estimate | null} [estimate]
 * @property {Digester} crypto
 * @property {Clock} clock
 * @property {Logger} logger
 * @property {{between?: (label: string) => void | Promise<void>}} [hooks]
 * @property {Limits} [limits]
 * @property {() => Promise<void>} [yieldBetween] - what it waits on between batches, a macrotask unless a test passes one
 * @property {number} [retryAfterMs] - TRANSFORM_RETRY_AFTER_MS unless a test passes another
 */

/**
 * - `transformed`: every pending step filled what it fills, with its receipt
 * - `current`: nothing was pending, and nothing was written
 * - `space-blocked`: no room for its point, so nothing ran
 * - `failed`: IndexedDB, the point, or the lock failed; a later run picks up where this one got to
 * @typedef {'transformed' | 'current' | 'space-blocked' | 'failed'} TransformStatus
 */

/**
 * @typedef {object} TransformOutcome
 * @property {TransformStatus} status
 * @property {string[]} steps - the step ids it recorded completions for
 * @property {number} filled - the notes it filled
 * @property {string | null} recoveryPointId
 * @property {{code: string} | null} failure
 * @property {boolean} backedOff - it found a standing stop, and read nothing
 * @property {{status: TransformStop['status'], code: string} | null} previous - the stop an
 *   earlier run recorded, as this one found it in `meta`, standing or not, which the worker
 *   journals a stop against, once per code (#20)
 */

/**
 * @param {Partial<TransformOutcome> & {status: TransformStatus}} fields
 * @returns {TransformOutcome}
 */
const outcome = fields => ({
  steps: [],
  filled: 0,
  recoveryPointId: null,
  failure: null,
  backedOff: false,
  previous: null,
  ...fields,
});

/**
 * @param {TransformStep} step
 * @returns {TransformCounts}
 */
const noCounts = step =>
  Object.fromEntries((COUNTED[/** @type {keyof typeof COUNTED} */ (step.id)] || ['read', 'filled']).map(name => [name, 0]));

/**
 * Whether logical 2 has something to fill on `note`. A note without its placement gets the
 * group whatever its placement version: a command on it before the transform reached it (a pin
 * between the run and the transform, say) moved that version and wrote no group, since a command
 * keeps only a group that's there in step (domain/placement.js), and the batch reads its flags
 * as that command left them.
 * @param {NoteRecord} note
 */
export const needsLogical2 = note =>
  !hasPlacementGroup(note) || !hasIndexedTime(note) || (Boolean(note.trashed) && !hasTrashTime(note));

/**
 * Whether logical 3 has something to fill on `note`: a Daily Note with a valid `dateStr` and no
 * key yet. A Daily Note without a valid `dateStr` gets none, as #1's `daily-without-date`.
 * @param {NoteRecord} note
 */
export const needsLogical3 = note => Boolean(note.isDaily) && isDateKey(note.dateStr) && !isDateKey(note.dailyKey);

/** What each step has to fill */
const NEEDS = Object.freeze({ 'logical-2': needsLogical2, 'logical-3': needsLogical3 });

/**
 * Whether a pending step has something to fill on `note`
 * @param {readonly TransformStep[]} steps
 * @param {NoteRecord} note
 */
const needsAny = (steps, note) =>
  steps.some(step => {
    const needs = NEEDS[/** @type {keyof typeof NEEDS} */ (step.id)];
    return needs !== undefined && needs(note);
  });

/**
 * A note with what logical 2 fills, or null when it has it all:
 * - its placement, kind, and lifecycle, unless it has a placement;
 * - for a trashed note, its time in the trash: the run's start when it has none, and also when
 *   it had no updatedAt an index held, since 1.4.x never listed it, so it shows in Trash for a
 *   whole retention window before retention can take it. That second case writes over an old
 *   `trashedAt`, the one field logical 2 writes over (#17 PR 3a, the lead's call). Every other
 *   trashed note keeps its own;
 * - an `updatedAt` an index can hold, when it has none.
 * @param {NoteRecord} note
 * @param {{liveFolderIds: ReadonlySet<string>, blocks: readonly any[], runStart: number}} context
 * @returns {NoteRecord | null}
 */
export function filledByLogical2(note, { liveFolderIds, blocks, runStart }) {
  /** @type {NoteRecord} */
  let next = note;
  if (!hasPlacementGroup(note)) next = { ...next, ...placementGroupOf(note, liveFolderIds) };
  if (note.trashed && (!hasIndexedTime(note) || !hasTrashTime(note))) next = { ...next, trashedAt: runStart };
  if (!hasIndexedTime(note)) next = { ...next, updatedAt: filledUpdatedAt(note, blocks, runStart) };
  return next === note ? null : next;
}

/**
 * Adds one note read to `counts`: it, and for logical 2 #1's findings on it
 * @param {TransformCounts} counts
 * @param {NoteRecord} note
 * @param {ReadonlySet<string>} liveFolderIds
 */
function tally(counts, note, liveFolderIds) {
  counts.read += 1;
  if (!('staleFolder' in counts)) return;
  for (const finding of placementFindingsOf(note, liveFolderIds)) {
    if (finding === 'stale-folder') counts.staleFolder += 1;
    else counts.dailyWithoutDate += 1;
  }
}

/**
 * The folder ids a request answers with, as a set
 * @param {IDBRequest<IDBValidKey[]>} request
 * @returns {Promise<Set<string>>}
 */
async function folderIdsOf(request) {
  const keys = await result(request);
  return new Set(/** @type {string[]} */ (keys.filter(key => typeof key === 'string')));
}

/**
 * `meta`'s schema record, the progress of a cut-off run, a recorded stop, and logical 3's answer
 * @param {IDBDatabase} db
 * @returns {Promise<{schema: Record<string, unknown> | undefined, progress: TransformProgress | undefined, stop: TransformStop | undefined, daily: TransformDaily | undefined}>}
 */
async function readState(db) {
  const tx = db.transaction(META_STORE, 'readonly');
  const meta = tx.objectStore(META_STORE);
  const [schema, progress, stop, daily] = await Promise.all([
    result(meta.get(SCHEMA_KEY)),
    result(meta.get(TRANSFORM_KEY)),
    result(meta.get(TRANSFORM_STOP_KEY)),
    result(meta.get(TRANSFORM_DAILY_KEY)),
  ]);
  return { schema, progress, stop, daily };
}

/**
 * Reads the notes in bounded readonly batches until one needs a pending step, counting those
 * before it for each step. Writes nothing.
 * @param {IDBDatabase} db
 * @param {Io} io
 * @param {readonly TransformStep[]} steps
 * @returns {Promise<{needed: boolean, counts: TransformCounts[]}>}
 */
async function scanNotes(db, io, steps) {
  const liveFolderIds = db.objectStoreNames.contains('folders')
    ? await folderIdsOf(db.transaction('folders', 'readonly').objectStore('folders').getAllKeys())
    : new Set();
  const counts = steps.map(noCounts);
  /** @type {IDBValidKey | null} */
  let after = null;
  for (;;) {
    const batch = await readBatch(db, 'canvases', after, null, io);
    for (const { value } of batch.entries) {
      if (needsAny(steps, value)) return { needed: true, counts };
      for (const each of counts) tally(each, value, liveFolderIds);
    }
    if (batch.entries.length > 0) after = batch.entries[batch.entries.length - 1].key;
    if (batch.end || batch.entries.length === 0) return { needed: false, counts };
  }
}

/**
 * Logical 3's answer for the notes as they are now: the fields assignDailyKeys weighs of every
 * Daily Note, read in bounded readonly batches, then each one's key
 * @param {IDBDatabase} db
 * @param {Io} io
 * @param {string} zone
 * @returns {Promise<Map<string, DailyAssignment>>}
 */
async function assignedNow(db, io, zone) {
  /** @type {Array<Record<string, unknown> & {id: string}>} */
  const daily = [];
  /** @type {IDBValidKey | null} */
  let after = null;
  for (;;) {
    const batch = await readBatch(db, 'canvases', after, null, io);
    for (const { value } of batch.entries) {
      if (!value || !value.isDaily) continue;
      const { id, isDaily, dateStr, dailyKey, createdAt, name, trashed, isTemplate } = value;
      daily.push({ id, isDaily, dateStr, dailyKey, createdAt, name, trashed, isTemplate });
    }
    if (batch.entries.length > 0) after = batch.entries[batch.entries.length - 1].key;
    if (batch.end || batch.entries.length === 0) return assignDailyKeys(daily, zone);
  }
}

/**
 * Logical 3's answer for this run: the one `meta` kept for a cut-off run of it, else the notes'
 * now, which `meta` then keeps until the step's receipt
 * @param {IDBDatabase} db
 * @param {Io} io
 * @param {{zone: string, kept: TransformDaily | null}} options
 * @returns {Promise<Map<string, DailyAssignment>>}
 */
async function dailyAnswer(db, io, { zone, kept }) {
  if (kept && Array.isArray(kept.assignments)) {
    return new Map(
      kept.assignments.map(([id, dailyKey, duplicateOf, rekeyed]) => [id, { dailyKey, duplicateOf, rekeyed }]),
    );
  }
  const assigned = await assignedNow(db, io, zone);
  const tx = db.transaction(META_STORE, 'readwrite', STRICT);
  const done = committed(tx);
  /** @type {TransformDaily} */
  const record = {
    key: TRANSFORM_DAILY_KEY,
    zone,
    assignments: [...assigned].map(([id, { dailyKey, duplicateOf, rekeyed }]) => [id, dailyKey, duplicateOf, rekeyed]),
  };
  tx.objectStore(META_STORE).put(record);
  await done;
  return assigned;
}

/**
 * The run's recovery point (see the top of this file). `read` says whether it read every store
 * before it stopped, for the stop record.
 * @param {TransformOptions & {db: IDBDatabase, io: Io, schema: Record<string, unknown>, progress: TransformProgress | undefined}} options
 * @returns {Promise<{status: 'ready', point: Point} | {status: 'space-blocked' | 'failed', code: string, read: boolean}>}
 */
async function pointForRun(options) {
  const { indexedDB, db, io, clock, logger, estimate = null, progress, schema, hooks = {} } = options;
  let recovery = await openRecovery(indexedDB, { create: false });
  try {
    const points = recovery ? await listPoints(recovery) : [];
    const verified = points.filter(point => point.kind === 'pre-migration' && point.status === 'verified');
    if (progress && progress.recoveryPointId) {
      const named = verified.find(point => point.id === progress.recoveryPointId);
      if (named) return { status: 'ready', point: named };
    }
    // Before a batch has filled anything, the newest point may hold the notes as the run finds them
    const newest = verified[verified.length - 1];
    if (!progress && newest && (await matchesSource({ source: db, point: newest, io, stores: REWRITTEN }))) {
      return { status: 'ready', point: newest };
    }

    // A transform point that never verified is resumed when it's for this build's target, and
    // dropped otherwise, as the runner drops its own (migrate.js); the runner's are left to it
    /** @type {Point | undefined} */
    let resume;
    for (const point of points) {
      if (point.status === 'verified' || point.target !== null || typeof point.logicalTarget !== 'number') continue;
      if (!resume && point.status === 'copying' && point.logicalTarget === LATEST_LOGICAL) resume = point;
      else if (recovery) await discardPoint(recovery, point.id, io);
    }

    const stores = storesToCopy(db);
    const space = await checkSpace({ estimate, bytes: await measureStores(db, stores, io) });
    if (space.status === 'short') {
      // A partial point holds room capture may need, and never verified (#17, Q7)
      if (resume && recovery) await discardPoint(recovery, resume.id, io);
      return { status: 'space-blocked', code: 'space-short', read: true };
    }
    if (space.status === 'unknown') logger.warn('storage-transform-space-unknown', {});
    if (!recovery) recovery = /** @type {IDBDatabase} */ (await openRecovery(indexedDB, { create: true }));

    /** @type {Point} */
    let point;
    /** @type {import('./recovery-points.js').Progress} */
    let copied;
    if (resume) {
      point = resume;
      copied = await readProgress(recovery, resume.id);
    } else {
      const createdAt = clock.now();
      const taken = new Set(points.map(other => other.id));
      let id = `pre-migration-${createdAt}`;
      for (let n = 2; taken.has(id); n++) id = `pre-migration-${createdAt}-${n}`;
      ({ point, progress: copied } = await startPoint(recovery, {
        id,
        kind: 'pre-migration',
        sourceShape: 'current',
        sourceVersion: db.version,
        structuralVersion: typeof schema.structuralVersion === 'number' ? schema.structuralVersion : null,
        logicalVersion: typeof schema.logicalVersion === 'number' ? schema.logicalVersion : null,
        target: null,
        logicalTarget: LATEST_LOGICAL,
        stores,
        createdAt,
      }));
    }
    try {
      await copyPoint({ source: db, recovery, point, progress: copied, io, hooks });
    } catch (error) {
      if (!isQuota(error)) throw error;
      // Dropped, so it never holds the room (Q7)
      await discardPoint(recovery, point.id, io).catch(() => {});
      return { status: 'space-blocked', code: 'quota', read: true };
    }
    // What's on disk is what's verified, not the record this run kept in memory
    const stored = (await listPoints(recovery)).find(candidate => candidate.id === point.id);
    const verdict = stored
      ? await verifyPoint({ recovery, point: stored, io })
      : { ok: /** @type {const} */ (false), code: 'point-missing' };
    if (!verdict.ok) {
      logger.warn('storage-recovery-point-unverified', { pointId: point.id, code: verdict.code });
      await discardPoint(recovery, point.id, io);
      return { status: 'failed', code: 'recovery-point-unverified', read: true };
    }
    return {
      status: 'ready',
      point: await keepVerified({ recovery, point: /** @type {Point} */ (stored), clock, io }),
    };
  } finally {
    if (recovery) recovery.close();
  }
}

/**
 * One batch of logical 2 after `after`: at most `limits.records` notes, and no more than
 * `limits.bytes` of them and the blocks it read, unless one is bigger, in one strict transaction
 * that reads them and writes what it filled, with the run's progress
 * @param {{db: IDBDatabase, step: TransformStep, after: IDBValidKey | null, keyRange: typeof IDBKeyRange, limits: Limits, runStart: number, progress: Omit<TransformProgress, 'after'>}} options
 * @returns {Promise<{after: IDBValidKey | null, end: boolean, counts: TransformCounts}>}
 */
async function fillBatch({ db, step, after, keyRange, limits, runStart, progress }) {
  const tx = db.transaction(['canvases', 'elements', 'folders', META_STORE], 'readwrite', STRICT);
  const done = committed(tx);
  const notes = tx.objectStore('canvases');
  const liveFolderIds = await folderIdsOf(tx.objectStore('folders').getAllKeys());
  const found = /** @type {NoteRecord[]} */ (
    await result(notes.getAll(after === null ? null : keyRange.lowerBound(after, true), limits.records))
  );
  const counts = noCounts(step);
  let last = after;
  let bytes = 0;
  for (const note of found) {
    let size = approximateBytes(note);
    if (counts.read > 0 && bytes + size > limits.bytes) break;
    // Only a note with neither time needs its blocks', the newest of which it takes
    /** @type {any[]} */
    let blocks = [];
    if (!hasIndexedTime(note) && typeof note.createdAt !== 'number') {
      blocks = await result(tx.objectStore('elements').index('canvasId').getAll(note.id));
      size += approximateBytes(blocks);
    }
    bytes += size;
    last = note.id;
    tally(counts, note, liveFolderIds);
    const next = step.id === 'logical-2' ? filledByLogical2(note, { liveFolderIds, blocks, runStart }) : null;
    if (next) {
      notes.put(next);
      counts.filled += 1;
    }
  }
  /** @type {TransformProgress} */
  const record = { ...progress, key: TRANSFORM_KEY, id: step.id, after: last, counts: added(progress.counts, counts) };
  tx.objectStore(META_STORE).put(record);
  await done;
  return { after: last, end: counts.read === found.length && found.length < limits.records, counts };
}

/**
 * `a`'s counts, each with `b`'s added
 * @param {TransformCounts} a
 * @param {TransformCounts} b
 * @returns {TransformCounts}
 */
const added = (a, b) => Object.fromEntries(Object.entries(a).map(([name, count]) => [name, count + (b[name] || 0)]));

/**
 * Puts `note`'s entry for `key` in the daily index, and answers `note` as it then is. An entry
 * for another note that still holds the key, which a command made or keyed since the run read
 * the notes, stays when that note was made first, and `note` becomes its duplicate. Otherwise
 * `note` takes the key, and the other note becomes its duplicate, in the same transaction.
 * @param {IDBObjectStore} notes
 * @param {IDBObjectStore} index
 * @param {NoteRecord} note
 * @param {string} key
 * @returns {Promise<{note: NoteRecord, displaced: NoteRecord | null}>}
 */
async function claimKey(notes, index, note, key) {
  const entry = /** @type {{noteId?: unknown} | undefined} */ (await result(index.get(key)));
  if (entry && entry.noteId === note.id) return { note, displaced: null };
  /** @type {NoteRecord | null} */
  let displaced = null;
  if (entry && typeof entry.noteId === 'string') {
    const holder = /** @type {NoteRecord | undefined} */ (await result(notes.get(entry.noteId)));
    if (holder && holdsKey(holder, key)) {
      if (!madeBefore(note, holder)) return { note: { ...note, dailyDuplicateOf: holder.id }, displaced: null };
      if (holder.dailyDuplicateOf !== note.id) displaced = { ...holder, dailyDuplicateOf: note.id };
    }
  }
  index.put({ dailyKey: key, noteId: note.id });
  return { note, displaced };
}

/**
 * One batch of logical 3 after `after`, as fillBatch has one of logical 2: at most
 * `limits.records` notes, and no more than `limits.bytes` of them unless one is bigger, in one
 * strict transaction over the notes, the daily index, and `meta`. Each Daily Note `assigned`
 * names gets its key (withAssignedKey), unless a command keyed it otherwise since, and the
 * index its entry when it holds the key (claimKey).
 * @param {{db: IDBDatabase, step: TransformStep, after: IDBValidKey | null, keyRange: typeof IDBKeyRange, limits: Limits, assigned: ReadonlyMap<string, DailyAssignment>, progress: Omit<TransformProgress, 'after'>}} options
 * @returns {Promise<{after: IDBValidKey | null, end: boolean, counts: TransformCounts}>}
 */
async function fillDailyBatch({ db, step, after, keyRange, limits, assigned, progress }) {
  const tx = db.transaction(['canvases', DAILY_INDEX_STORE, META_STORE], 'readwrite', STRICT);
  const done = committed(tx);
  const notes = tx.objectStore('canvases');
  const index = tx.objectStore(DAILY_INDEX_STORE);
  const found = /** @type {NoteRecord[]} */ (
    await result(notes.getAll(after === null ? null : keyRange.lowerBound(after, true), limits.records))
  );
  const counts = noCounts(step);
  /** @type {Map<string, NoteRecord>} */
  const displaced = new Map();
  let last = after;
  let bytes = 0;
  for (const read of found) {
    const size = approximateBytes(read);
    if (counts.read > 0 && bytes + size > limits.bytes) break;
    bytes += size;
    last = read.id;
    counts.read += 1;
    // As an earlier note's claim in this batch may have left it
    const note = displaced.get(read.id) || read;
    const assignment = assigned.get(note.id);
    if (!assignment || !note.isDaily) continue;
    // A Daily Note a command keyed otherwise since the run read the notes keeps its key
    if (isDateKey(note.dailyKey) && note.dailyKey !== assignment.dailyKey) continue;
    let next = withAssignedKey(note, assignment);
    if (assignment.duplicateOf === null && canHoldKey(next)) {
      const claimed = await claimKey(notes, index, next, assignment.dailyKey);
      next = claimed.note;
      if (claimed.displaced) {
        notes.put(claimed.displaced);
        displaced.set(claimed.displaced.id, claimed.displaced);
        counts.filled += 1;
        counts.duplicates += 1;
      }
    }
    if (next === note) continue;
    notes.put(next);
    counts.filled += 1;
    if (next.dateStr !== note.dateStr) counts.rekeyed += 1;
    if (typeof next.dailyDuplicateOf === 'string' && next.dailyDuplicateOf !== note.dailyDuplicateOf) {
      counts.duplicates += 1;
    }
  }
  /** @type {TransformProgress} */
  const record = { ...progress, key: TRANSFORM_KEY, id: step.id, after: last, counts: added(progress.counts, counts) };
  tx.objectStore(META_STORE).put(record);
  await done;
  return { after: last, end: counts.read === found.length && found.length < limits.records, counts };
}

/**
 * The step's receipt, `meta.schema` at its logical version, and no stop, in one transaction,
 * with the progress at the start of `next`, the run's next step, under the same point, so a run
 * cut off between the two picks up there with it, or no progress when none comes next
 * @param {IDBDatabase} db
 * @param {TransformStep} step
 * @param {{from: number, startedAt: number, completedAt: number, recoveryPointId: string | null, counts: TransformCounts, next?: TransformStep | null}} done
 */
async function finishStep(db, step, { from, startedAt, completedAt, recoveryPointId, counts, next = null }) {
  const tx = db.transaction([META_STORE, MIGRATIONS_STORE], 'readwrite', STRICT);
  const finished = committed(tx);
  const meta = tx.objectStore(META_STORE);
  const schema = /** @type {Record<string, unknown>} */ (await result(meta.get(SCHEMA_KEY)));
  meta.put({ ...schema, logicalVersion: step.to });
  if (next) {
    /** @type {TransformProgress} */
    const progress = { key: TRANSFORM_KEY, id: next.id, after: null, recoveryPointId, startedAt, counts: noCounts(next) };
    meta.put(progress);
  } else {
    meta.delete(TRANSFORM_KEY);
  }
  meta.delete(TRANSFORM_STOP_KEY);
  meta.delete(TRANSFORM_DAILY_KEY);
  /** @type {Receipt} */
  const receipt = {
    id: step.id,
    from,
    to: step.to,
    status: 'completed',
    startedAt,
    completedAt,
    recoveryPointId,
    failure: null,
    counts,
  };
  tx.objectStore(MIGRATIONS_STORE).put(receipt);
  await finished;
}

/**
 * Records a stop, best effort: without it, the next start reads the stores again
 * @param {IDBDatabase} db
 * @param {Omit<TransformStop, 'key' | 'target'>} stop
 * @param {Logger} logger
 */
async function recordStop(db, stop, logger) {
  try {
    const tx = db.transaction(META_STORE, 'readwrite', STRICT);
    const done = committed(tx);
    /** @type {TransformStop} */
    const record = { key: TRANSFORM_STOP_KEY, ...stop, target: LATEST_LOGICAL };
    tx.objectStore(META_STORE).put(record);
    await done;
  } catch (error) {
    logger.warn('storage-transform-stop-unrecorded', { code: failureOf(error).code });
  }
}

/**
 * Whether `stop` stands at `now`: this build's target, recorded less than `retryAfterMs` ago
 * @param {TransformStop | undefined} stop
 * @param {number} now
 * @param {number} retryAfterMs
 * @returns {stop is TransformStop}
 */
function standing(stop, now, retryAfterMs) {
  if (!stop || stop.target !== LATEST_LOGICAL || typeof stop.at !== 'number') return false;
  return (
    (stop.status === 'space-blocked' || stop.status === 'failed') && now >= stop.at && now - stop.at < retryAfterMs
  );
}

/**
 * One run, under the lock
 * @param {TransformOptions} options
 * @returns {Promise<TransformOutcome>}
 */
async function transform(options) {
  const { indexedDB, keyRange, clock, logger, hooks = {}, retryAfterMs = TRANSFORM_RETRY_AFTER_MS } = options;
  const limits = options.limits || DEFAULT_LIMITS;
  /** @type {Io} */
  const io = { keyRange, crypto: options.crypto, limits };
  const between = async (/** @type {string} */ label) => {
    if (hooks.between) await hooks.between(label);
  };
  const yieldBetween = options.yieldBetween || (() => new Promise(resolve => setTimeout(resolve, 0)));

  const db = await openWithoutUpgrade(indexedDB, DB_NAME);
  if (!db) return outcome({ status: 'current' });
  try {
    if (!db.objectStoreNames.contains(META_STORE) || !db.objectStoreNames.contains(MIGRATIONS_STORE)) {
      return outcome({ status: 'current' });
    }
    const state = await readState(db);
    const { schema, stop } = state;
    const previous = stop && typeof stop.code === 'string' ? { status: stop.status, code: stop.code } : null;
    const from = schema && typeof schema.logicalVersion === 'number' ? schema.logicalVersion : null;
    if (!schema || from === null) return outcome({ status: 'failed', failure: { code: 'meta-unreadable' }, previous });
    const steps = pendingTransforms(from);
    if (steps.length === 0) return outcome({ status: 'current', previous });
    if (standing(stop, clock.now(), retryAfterMs)) {
      return outcome({ status: stop.status, failure: { code: stop.code }, backedOff: true, previous });
    }
    // A cut-off run's progress, unless it names a step this build doesn't run
    const progress = state.progress && steps.some(step => step.id === state.progress?.id) ? state.progress : undefined;
    await between('pending-read');

    const runStart = clock.now();
    const scan = progress ? null : await scanNotes(db, io, steps);
    await between('scanned');
    if (scan && !scan.needed) {
      // Nothing to fill, so no point: each step's receipt, with what the scan counted
      for (const [i, step] of steps.entries()) {
        await finishStep(db, step, {
          from: i === 0 ? from : steps[i - 1].to,
          startedAt: runStart,
          completedAt: clock.now(),
          recoveryPointId: null,
          counts: scan.counts[i],
        });
      }
      return outcome({ status: 'transformed', steps: steps.map(step => step.id), previous });
    }

    const made = await pointForRun({ ...options, db, io, schema, progress });
    if (made.status !== 'ready') {
      if (made.read) await recordStop(db, { status: made.status, code: made.code, at: clock.now() }, logger);
      return outcome({ status: made.status, failure: { code: made.code }, previous });
    }
    const recoveryPointId = made.point.id;
    await between('point-ready');

    /** @type {string[]} */
    const recorded = [];
    let filled = 0;
    let at = from;
    for (const step of steps) {
      const resumed = progress && progress.id === step.id ? progress : null;
      const startedAt = resumed ? resumed.startedAt : runStart;
      let counts = resumed && resumed.counts ? added(noCounts(step), resumed.counts) : noCounts(step);
      let after = resumed ? resumed.after : null;
      // Logical 3 weighs every Daily Note before its first batch, or picks up the answer it kept
      const assigned =
        step.id === 'logical-3'
          ? await dailyAnswer(db, io, { zone: zoneOf(clock), kept: resumed ? state.daily || null : null })
          : null;
      if (assigned) await between('daily-assigned');
      for (;;) {
        const fields = { db, step, after, keyRange, limits };
        /** @type {Omit<TransformProgress, 'after'>} */
        const batchProgress = { key: TRANSFORM_KEY, id: step.id, recoveryPointId, startedAt, counts };
        const batch = assigned
          ? await fillDailyBatch({ ...fields, assigned, progress: batchProgress })
          : await fillBatch({ ...fields, runStart, progress: batchProgress });
        counts = added(counts, batch.counts);
        filled += batch.counts.filled;
        after = batch.after;
        await between('batch');
        if (batch.end) break;
        await yieldBetween();
      }
      const next = steps[steps.indexOf(step) + 1] || null;
      await finishStep(db, step, { from: at, startedAt, completedAt: clock.now(), recoveryPointId, counts, next });
      recorded.push(step.id);
      at = step.to;
      await between('step-done');
    }
    return outcome({ status: 'transformed', steps: recorded, filled, recoveryPointId, previous });
  } finally {
    db.close();
  }
}

/**
 * Runs the pending transforms under the lock, and resolves with what it did. It never rejects,
 * and logs any outcome but `transformed`, `current`, and a stop it backed off on, with codes only.
 * @param {TransformOptions} options
 * @returns {Promise<TransformOutcome>}
 */
export function runTransforms(options) {
  const { logger } = options;
  /** @type {Promise<TransformOutcome>} */
  const run = Promise.resolve().then(() =>
    options.locks && typeof options.locks.request === 'function'
      ? options.locks.request(POINTS_LOCK, { mode: 'exclusive' }, () => transform(options))
      : outcome({ status: 'failed', failure: { code: 'locks-unavailable' } }),
  );
  return run
    .catch(error => outcome({ status: 'failed', failure: { code: failureOf(error).code } }))
    .then(ended => {
      if (ended.status !== 'transformed' && ended.status !== 'current' && !ended.backedOff) {
        logger.warn('storage-transform', { status: ended.status, code: ended.failure ? ended.failure.code : null });
      }
      return ended;
    });
}
