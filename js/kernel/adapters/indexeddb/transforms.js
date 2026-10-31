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
 * first, so a batch run twice changes nothing. A fill takes only what's absent, and never
 * overwrites a field a command wrote.
 *
 * A run that read every store and then stopped, short of space or on a point that didn't
 * verify, records the stop in `meta` (TRANSFORM_STOP_KEY), and the worker's starts in the next
 * TRANSFORM_RETRY_AFTER_MS don't read them all again, as the runner's starts don't (review R79).
 *
 * Logical 2 gives each note without a placement its placement, kind, and lifecycle from its
 * flags, by #1's rules (domain/placement.js). It also gives a note whose `updatedAt` no index
 * can hold one (domain/note.js, filledUpdatedAt), so Storage's lists and its export list it too
 * (KD-011). It writes no change entry and moves no version: it adds what the flags already say.
 * Its receipt counts the notes it read and filled, and #1's findings (placementFindingsOf),
 * never content.
 */

import { filledUpdatedAt, hasIndexedTime } from '../../core/domain/note.js';
import { hasPlacementGroup, placementFindingsOf, placementGroupOf } from '../../core/domain/placement.js';
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
import { LATEST_LOGICAL, META_STORE, MIGRATIONS_STORE, SCHEMA_KEY, pendingTransforms } from './registry.js';
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
/** @typedef {import('../../core/ports/runtime.js').Clock} Clock */
/** @typedef {import('../../core/ports/runtime.js').Logger} Logger */

/** `meta`'s record of a run in progress: the step, the last note it read, its point, and its counts */
export const TRANSFORM_KEY = 'transform';

/** `meta`'s record of a run that read every store and then stopped (see the top of this file) */
export const TRANSFORM_STOP_KEY = 'transform-stop';

/** How long such a stop stands, as the worker's RETRY_AFTER_MS for the runner */
export const TRANSFORM_RETRY_AFTER_MS = 30 * 60 * 1000;

/**
 * What a receipt counts: the notes read and filled, and #1's findings among those read
 * @typedef {{read: number, filled: number, staleFolder: number, dailyWithoutDate: number}} TransformCounts
 */

/**
 * Where a cut-off run got to
 * @typedef {{key: typeof TRANSFORM_KEY, id: string, after: IDBValidKey | null, recoveryPointId: string | null, startedAt: number, counts: TransformCounts}} TransformProgress
 */

/**
 * @typedef {{key: typeof TRANSFORM_STOP_KEY, status: 'space-blocked' | 'failed', code: string, at: number, target: number}} TransformStop
 */

/** The stores logical 2 rewrites, which a reused point must still hold as they are */
const REWRITTEN = Object.freeze(['canvases']);

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
 */

/**
 * @param {Partial<TransformOutcome> & {status: TransformStatus}} fields
 * @returns {TransformOutcome}
 */
const outcome = fields => ({ steps: [], filled: 0, recoveryPointId: null, failure: null, backedOff: false, ...fields });

/** @returns {TransformCounts} */
const noCounts = () => ({ read: 0, filled: 0, staleFolder: 0, dailyWithoutDate: 0 });

/**
 * Whether logical 2 has something to fill on `note`. A note without its placement gets the
 * group whatever its placement version: a command on it before the transform reached it (a pin
 * between the run and the transform, say) moved that version and wrote no group, since a command
 * keeps only a group that's there in step (domain/placement.js), and the batch reads its flags
 * as that command left them.
 * @param {NoteRecord} note
 */
export const needsLogical2 = note => !hasPlacementGroup(note) || !hasIndexedTime(note);

/**
 * A note with what logical 2 fills: its placement, kind, and lifecycle unless it has them, and
 * an `updatedAt` an index can hold, or null when it has both
 * @param {NoteRecord} note
 * @param {{liveFolderIds: ReadonlySet<string>, blocks: readonly any[], runStart: number}} context
 * @returns {NoteRecord | null}
 */
export function filledByLogical2(note, { liveFolderIds, blocks, runStart }) {
  /** @type {NoteRecord} */
  let next = note;
  if (!hasPlacementGroup(note)) next = { ...next, ...placementGroupOf(note, liveFolderIds) };
  if (!hasIndexedTime(note)) next = { ...next, updatedAt: filledUpdatedAt(note, blocks, runStart) };
  return next === note ? null : next;
}

/**
 * Adds one note read to `counts`: it, and #1's findings on it
 * @param {TransformCounts} counts
 * @param {NoteRecord} note
 * @param {ReadonlySet<string>} liveFolderIds
 */
function tally(counts, note, liveFolderIds) {
  counts.read += 1;
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
 * `meta`'s schema record, the progress of a cut-off run, and a recorded stop
 * @param {IDBDatabase} db
 * @returns {Promise<{schema: Record<string, unknown> | undefined, progress: TransformProgress | undefined, stop: TransformStop | undefined}>}
 */
async function readState(db) {
  const tx = db.transaction(META_STORE, 'readonly');
  const meta = tx.objectStore(META_STORE);
  const [schema, progress, stop] = await Promise.all([
    result(meta.get(SCHEMA_KEY)),
    result(meta.get(TRANSFORM_KEY)),
    result(meta.get(TRANSFORM_STOP_KEY)),
  ]);
  return { schema, progress, stop };
}

/**
 * Reads the notes in bounded readonly batches until one needs logical 2, counting those before
 * it. Writes nothing.
 * @param {IDBDatabase} db
 * @param {Io} io
 * @returns {Promise<{needed: boolean, counts: TransformCounts}>}
 */
async function scanNotes(db, io) {
  const liveFolderIds = db.objectStoreNames.contains('folders')
    ? await folderIdsOf(db.transaction('folders', 'readonly').objectStore('folders').getAllKeys())
    : new Set();
  const counts = noCounts();
  /** @type {IDBValidKey | null} */
  let after = null;
  for (;;) {
    const batch = await readBatch(db, 'canvases', after, null, io);
    for (const { value } of batch.entries) {
      if (needsLogical2(value)) return { needed: true, counts };
      tally(counts, value, liveFolderIds);
    }
    if (batch.entries.length > 0) after = batch.entries[batch.entries.length - 1].key;
    if (batch.end || batch.entries.length === 0) return { needed: false, counts };
  }
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
    return { status: 'ready', point: await keepVerified({ recovery, point: /** @type {Point} */ (stored), clock, io }) };
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
  const counts = noCounts();
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
 * @param {TransformCounts} a
 * @param {TransformCounts} b
 * @returns {TransformCounts}
 */
const added = (a, b) => ({
  read: a.read + b.read,
  filled: a.filled + b.filled,
  staleFolder: a.staleFolder + b.staleFolder,
  dailyWithoutDate: a.dailyWithoutDate + b.dailyWithoutDate,
});

/**
 * The step's receipt, `meta.schema` at its logical version, and neither progress nor a stop, in
 * one transaction
 * @param {IDBDatabase} db
 * @param {TransformStep} step
 * @param {{from: number, startedAt: number, completedAt: number, recoveryPointId: string | null, counts: TransformCounts}} done
 */
async function finishStep(db, step, { from, startedAt, completedAt, recoveryPointId, counts }) {
  const tx = db.transaction([META_STORE, MIGRATIONS_STORE], 'readwrite', STRICT);
  const finished = committed(tx);
  const meta = tx.objectStore(META_STORE);
  const schema = /** @type {Record<string, unknown>} */ (await result(meta.get(SCHEMA_KEY)));
  meta.put({ ...schema, logicalVersion: step.to });
  meta.delete(TRANSFORM_KEY);
  meta.delete(TRANSFORM_STOP_KEY);
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
  return (stop.status === 'space-blocked' || stop.status === 'failed') && now >= stop.at && now - stop.at < retryAfterMs;
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
    const from = schema && typeof schema.logicalVersion === 'number' ? schema.logicalVersion : null;
    if (!schema || from === null) return outcome({ status: 'failed', failure: { code: 'meta-unreadable' } });
    const steps = pendingTransforms(from);
    if (steps.length === 0) return outcome({ status: 'current' });
    if (standing(stop, clock.now(), retryAfterMs)) {
      return outcome({ status: stop.status, failure: { code: stop.code }, backedOff: true });
    }
    // A cut-off run's progress, unless it names a step this build doesn't run
    const progress = state.progress && steps.some(step => step.id === state.progress?.id) ? state.progress : undefined;
    await between('pending-read');

    const runStart = clock.now();
    const scan = progress ? null : await scanNotes(db, io);
    await between('scanned');
    if (scan && !scan.needed) {
      // Nothing to fill, so no point: each step's receipt, with what the scan counted
      for (const [i, step] of steps.entries()) {
        await finishStep(db, step, {
          from: i === 0 ? from : steps[i - 1].to,
          startedAt: runStart,
          completedAt: clock.now(),
          recoveryPointId: null,
          counts: scan.counts,
        });
      }
      return outcome({ status: 'transformed', steps: steps.map(step => step.id) });
    }

    const made = await pointForRun({ ...options, db, io, schema, progress });
    if (made.status !== 'ready') {
      if (made.read) await recordStop(db, { status: made.status, code: made.code, at: clock.now() }, logger);
      return outcome({ status: made.status, failure: { code: made.code } });
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
      let counts = resumed && resumed.counts ? added(noCounts(), resumed.counts) : noCounts();
      let after = resumed ? resumed.after : null;
      for (;;) {
        const batch = await fillBatch({
          db,
          step,
          after,
          keyRange,
          limits,
          runStart,
          progress: { key: TRANSFORM_KEY, id: step.id, recoveryPointId, startedAt, counts },
        });
        counts = added(counts, batch.counts);
        filled += batch.counts.filled;
        after = batch.after;
        await between('batch');
        if (batch.end) break;
        await yieldBetween();
      }
      await finishStep(db, step, { from: at, startedAt, completedAt: clock.now(), recoveryPointId, counts });
      recorded.push(step.id);
      at = step.to;
      await between('step-done');
    }
    return outcome({ status: 'transformed', steps: recorded, filled, recoveryPointId });
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
