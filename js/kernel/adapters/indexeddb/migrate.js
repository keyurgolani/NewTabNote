/**
 * The migration runner (#17, "Hosting" and "Steps"). #17 PR 1b has the service worker's
 * composition root call it at worker start, before maintenance; no shipped file does yet.
 * Under Web Lock `storage.migrate` (exclusive), so one runner at a time:
 * 1. Open CanvasTabDB without upgrading it and read its shape (shapes.js).
 * 2. Make the `pre-migration` recovery point (recovery-points.js), or reuse the verified one
 *    an interrupted run made, after the space check (space.js). Short of space: no point, no
 *    step, and the build keeps running on the shape it found.
 * 3. Open at the newest version the steps reach, running every pending structural step in the
 *    one `versionchange` (registry.js), synchronously.
 * 4. In a second transaction, read the stores, indexes, and `meta` back, and write a receipt
 *    per step: `{id, from, to, status, startedAt, completedAt, recoveryPointId, failure}`,
 *    with ids, versions, times, and a code, never content.
 * A `newer`, `missing-core`, or `unknown` database gets a point and no step (Q13): it's left as
 * it is, and #33's refusal stays the answer.
 *
 * Every run can be cut off anywhere and run again. A point resumes from its progress record,
 * a verified one is reused, and a database whose `versionchange` committed but whose receipt
 * didn't reads as `current` and gets the receipt, since the second transaction's check is the
 * same read. A run that finds nothing to do writes nothing, receipts included.
 *
 * When another connection blocks the upgrade, the run waits, and `answer` resolves with
 * `blocked-upgrade` within `openWithinMs` (5 seconds, connection.js's OPEN_WITHIN_MS) while
 * `done` keeps waiting for the upgrade.
 *
 * Outcomes and log lines hold shape kinds, versions, step and point ids, and codes only.
 */

import { OPEN_WITHIN_MS } from './connection.js';
import { failureOf } from './failures.js';
import {
  DEFAULT_LIMITS,
  committed,
  copyPoint,
  discardPoint,
  isQuota,
  keepVerified,
  listPoints,
  measureStores,
  openRecovery,
  readProgress,
  startPoint,
  storesToCopy,
  verifyPoint,
} from './recovery-points.js';
import { MIGRATIONS_STORE, pendingStructural } from './registry.js';
import { DB_NAME } from './schema.js';
import { detectShape, inspect, openWithoutUpgrade, readSchema } from './shapes.js';
import { checkSpace } from './space.js';

/** @typedef {import('./registry.js').StructuralStep} StructuralStep */
/** @typedef {import('./shapes.js').Shape} Shape */
/** @typedef {import('./shapes.js').Inspection} Inspection */
/** @typedef {import('./shapes.js').Receipt} Receipt */
/** @typedef {import('./recovery-points.js').Point} Point */
/** @typedef {import('./recovery-points.js').Hooks} Hooks */
/** @typedef {import('./recovery-points.js').Io} Io */
/** @typedef {import('./recovery-points.js').Limits} Limits */
/** @typedef {import('./records.js').Digester} Digester */
/** @typedef {import('./space.js').Estimate} Estimate */
/** @typedef {import('../../core/ports/runtime.js').Clock} Clock */
/** @typedef {import('../../core/ports/runtime.js').Logger} Logger */

/** The Web Lock every runner takes (#17, "Hosting") */
export const MIGRATE_LOCK = 'storage.migrate';

/**
 * Web Locks, or anything with its request(name, options, callback)
 * @typedef {{request: (name: string, options: {mode: 'exclusive'}, callback: () => Promise<any>) => Promise<any>}} MigrateLocks
 */

/**
 * @typedef {object} MigrationOptions
 * @property {IDBFactory} indexedDB
 * @property {typeof IDBKeyRange} keyRange - from the same IndexedDB as `indexedDB`
 * @property {MigrateLocks} locks
 * @property {Estimate | null} [estimate] - navigator.storage.estimate, bound
 * @property {Digester} crypto
 * @property {Clock} clock
 * @property {Logger} logger
 * @property {number} [openWithinMs]
 * @property {() => void} [onBlocked] - called when another connection blocks the upgrade
 * @property {Hooks} [hooks]
 * @property {Limits} [limits]
 */

/**
 * - `migrated`: every pending step ran and has its receipt
 * - `current`: nothing to do, and nothing was written
 * - `refused`: a `newer`, `missing-core`, or `unknown` database, left as it is with a point
 * - `space-blocked`: not enough room for the point, so nothing ran
 * - `failed`: the point didn't verify, or IndexedDB failed; nothing ran past what failed
 * @typedef {'migrated' | 'current' | 'refused' | 'space-blocked' | 'failed'} MigrationStatus
 */

/**
 * @typedef {object} MigrationOutcome
 * @property {MigrationStatus} status
 * @property {Shape['kind'] | null} shape - what the run found, null when it couldn't read it
 * @property {number | null} to - the structural version it left, when it ran steps
 * @property {string[]} steps - the step ids it recorded completions for
 * @property {string | null} recoveryPointId
 * @property {{code: string} | null} failure
 */

/**
 * What `answer` gives before the run finishes: the upgrade is blocked, or still going
 * @typedef {{status: 'blocked-upgrade' | 'migrating', retryable: true}} MigrationPending
 */

/**
 * @typedef {object} MigrationRun
 * @property {Promise<MigrationOutcome | MigrationPending>} answer - within `openWithinMs`
 * @property {Promise<MigrationOutcome>} done
 * @property {() => 'running' | 'blocked-upgrade' | 'done'} state
 */

/** The code a database that stays as it is answers with */
const REFUSALS = Object.freeze({
  'missing-core': 'missing-core-stores',
  newer: 'version-too-new',
  unknown: 'unknown-shape',
});

/**
 * @param {Partial<MigrationOutcome> & {status: MigrationStatus}} fields
 * @returns {MigrationOutcome}
 */
const outcome = fields => ({ shape: null, to: null, steps: [], recoveryPointId: null, failure: null, ...fields });

/**
 * Two lists of store names, sorted, that hold the same names
 * @param {readonly string[]} a
 * @param {readonly string[]} b
 */
const sameNames = (a, b) => a.length === b.length && a.every((name, i) => name === b[i]);

/**
 * Where a structural step starts from: the step before it, or 8 (every legacy shape, and no
 * database) for the first
 * @param {StructuralStep} step
 */
const fromOf = step => {
  const earlier = pendingStructural(0).filter(other => other.to < step.to);
  return earlier.length > 0 ? earlier[earlier.length - 1].to : 8;
};

/**
 * Writes receipts in one strict transaction
 * @param {IDBDatabase} db
 * @param {Receipt[]} receipts
 */
async function writeReceipts(db, receipts) {
  const tx = db.transaction(MIGRATIONS_STORE, 'readwrite', { durability: 'strict' });
  const done = committed(tx);
  const store = tx.objectStore(MIGRATIONS_STORE);
  for (const receipt of receipts) store.put(receipt);
  await done;
}

/**
 * Opens CanvasTabDB at `version`, running `steps` in its `versionchange`. Only the steps'
 * synchronous calls happen there: an exception in one aborts the upgrade.
 * @param {{indexedDB: IDBFactory, version: number, steps: StructuralStep[], logicalVersion: number | null, onBlocked: () => void}} options
 * @returns {Promise<IDBDatabase>}
 */
function upgrade({ indexedDB, version, steps, logicalVersion, onBlocked }) {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, version);
    request.onupgradeneeded = () => {
      const db = request.result;
      const tx = /** @type {IDBTransaction} */ (request.transaction);
      try {
        for (const step of steps) step.apply(db, tx, { logicalVersion });
      } catch (error) {
        try {
          tx.abort();
        } catch {
          // Already aborted
        }
        throw error;
      }
    };
    request.onblocked = () => onBlocked();
    request.onsuccess = () => {
      const db = request.result;
      db.onversionchange = () => db.close();
      resolve(db);
    };
    request.onerror = () => reject(request.error);
  });
}

/**
 * The verified pre-migration point made before structural version `target`, if any, without
 * making the recovery database
 * @param {IDBFactory} indexedDB
 * @param {number} target
 * @returns {Promise<Point | null>}
 */
async function pointBefore(indexedDB, target) {
  const recovery = await openRecovery(indexedDB, { create: false });
  if (!recovery) return null;
  try {
    const points = await listPoints(recovery);
    return points.filter(point => point.status === 'verified' && point.target === target).pop() || null;
  } finally {
    recovery.close();
  }
}

/**
 * Makes the pre-migration point, or reuses the verified one an earlier run made for the same
 * database and target, or resumes the one it cut off
 * @param {MigrationOptions & {io: Io, inspection: Inspection, shape: Shape, target: number | null, structuralVersion: number | null, logicalVersion: number | null}} options
 * @returns {Promise<{status: 'ready', point: Point | null} | {status: 'space-blocked' | 'failed', code: string}>}
 */
async function ensurePoint(options) {
  const { indexedDB, io, inspection, shape, target, clock, logger, estimate, hooks = {} } = options;
  const between = async (/** @type {string} */ label) => {
    if (hooks.between) await hooks.between(label);
  };
  const source = await openWithoutUpgrade(indexedDB, DB_NAME);
  if (!source) return { status: 'ready', point: null };
  try {
    const stores = storesToCopy(source);
    // Nothing a point would hold
    if (stores.length === 0) return { status: 'ready', point: null };
    // Read first, so a run that reuses a point or stops short of space makes no recovery database
    let recovery = await openRecovery(indexedDB, { create: false });
    try {
      const points = recovery ? await listPoints(recovery) : [];
      /** @param {Point} point */
      const matches = point =>
        point.kind === 'pre-migration' &&
        point.target === target &&
        point.sourceShape === shape.kind &&
        point.sourceVersion === inspection.version &&
        sameNames(point.stores, stores);
      const reusable = points.filter(point => point.status === 'verified' && matches(point)).pop();
      if (reusable) return { status: 'ready', point: reusable };

      // A point that never verified is resumed when it's this one, and dropped otherwise
      /** @type {Point | null} */
      let resume = null;
      for (const point of points) {
        if (point.status === 'verified') continue;
        if (!resume && point.status === 'copying' && matches(point)) resume = point;
        else await discardPoint(/** @type {IDBDatabase} */ (recovery), point.id, io);
      }

      const bytes = await measureStores(source, stores, io);
      await between('measured');
      const space = await checkSpace({ estimate, bytes });
      if (space.status === 'short') {
        // A partial point holds room capture may need, and never verified (Q7)
        if (resume && recovery) await discardPoint(recovery, resume.id, io);
        return { status: 'space-blocked', code: 'space-short' };
      }
      if (space.status === 'unknown') logger.warn('storage-migration-space-unknown', { shape: shape.kind });
      if (!recovery) recovery = /** @type {IDBDatabase} */ (await openRecovery(indexedDB, { create: true }));

      /** @type {Point} */
      let point;
      /** @type {import('./recovery-points.js').Progress} */
      let progress;
      if (resume) {
        point = resume;
        progress = await readProgress(recovery, resume.id);
      } else {
        const createdAt = clock.now();
        const taken = new Set(points.map(other => other.id));
        let id = `pre-migration-${createdAt}`;
        for (let n = 2; taken.has(id); n++) id = `pre-migration-${createdAt}-${n}`;
        ({ point, progress } = await startPoint(recovery, {
          id,
          kind: 'pre-migration',
          sourceShape: shape.kind,
          sourceVersion: inspection.version,
          structuralVersion: options.structuralVersion,
          logicalVersion: options.logicalVersion,
          target,
          stores,
          createdAt,
        }));
      }
      await between('point-started');

      try {
        await copyPoint({ source, recovery, point, progress, io, hooks });
      } catch (error) {
        if (!isQuota(error)) throw error;
        // Dropped, so it never holds the room (Q7)
        await discardPoint(recovery, point.id, io).catch(() => {});
        return { status: 'space-blocked', code: 'quota' };
      }
      await between('copied');

      const verdict = await verifyPoint({ recovery, point, io });
      if (!verdict.ok) {
        logger.warn('storage-recovery-point-unverified', { pointId: point.id, code: verdict.code });
        await discardPoint(recovery, point.id, io);
        return { status: 'failed', code: 'recovery-point-unverified' };
      }
      const verified = await keepVerified({ recovery, point, clock, io });
      await between('verified');
      return { status: 'ready', point: verified };
    } finally {
      if (recovery) recovery.close();
    }
  } finally {
    source.close();
  }
}

/**
 * One run, under the lock
 * @param {MigrationOptions} options
 * @param {{phase: 'running' | 'blocked-upgrade' | 'done'}} status
 * @returns {Promise<MigrationOutcome>}
 */
async function migrate(options, status) {
  const { indexedDB, clock, logger, hooks = {} } = options;
  /** @type {Io} */
  const io = { keyRange: options.keyRange, crypto: options.crypto, limits: options.limits || DEFAULT_LIMITS };
  const between = async (/** @type {string} */ label) => {
    if (hooks.between) await hooks.between(label);
  };

  const inspection = await inspect(indexedDB);
  const shape = detectShape(inspection);
  await between('inspected');

  /** @type {StructuralStep[]} */
  let steps = [];
  /** @type {number | null} */
  let structuralVersion = null;
  /** @type {number | null} */
  let logicalVersion = null;
  if (shape.kind === 'none' || shape.kind === 'legacy') steps = pendingStructural(8);
  else if (shape.kind === 'current') {
    structuralVersion = shape.structuralVersion;
    logicalVersion = shape.logicalVersion;
    steps = pendingStructural(shape.structuralVersion);
  }

  if (shape.kind === 'current' && steps.length === 0) {
    // Steps whose versionchange committed but whose receipt didn't
    const recorded = new Set(
      inspection.receipts.filter(receipt => receipt.status === 'completed').map(receipt => receipt.id),
    );
    const unrecorded = pendingStructural(8, shape.structuralVersion).filter(step => !recorded.has(step.id));
    if (unrecorded.length === 0) return outcome({ status: 'current', shape: shape.kind });
    const db = await openWithoutUpgrade(indexedDB, DB_NAME);
    if (!db) return outcome({ status: 'failed', shape: shape.kind, failure: { code: 'no-database' } });
    try {
      // The same read that found it current, in its own transaction
      const check = detectShape({ exists: true, ...(await readSchema(db)) });
      if (check.kind !== 'current' || check.structuralVersion !== shape.structuralVersion) {
        return outcome({ status: 'failed', shape: shape.kind, failure: { code: 'schema-mismatch' } });
      }
      const now = clock.now();
      /** @type {Receipt[]} */
      const receipts = [];
      for (const step of unrecorded) {
        const point = await pointBefore(indexedDB, step.to);
        receipts.push({
          id: step.id,
          from: fromOf(step),
          to: step.to,
          status: 'completed',
          startedAt: now,
          completedAt: now,
          recoveryPointId: point ? point.id : null,
          failure: null,
        });
      }
      await writeReceipts(db, receipts);
      return outcome({
        status: 'migrated',
        shape: shape.kind,
        to: shape.structuralVersion,
        steps: receipts.map(receipt => receipt.id),
        recoveryPointId: receipts[receipts.length - 1].recoveryPointId,
      });
    } finally {
      db.close();
    }
  }

  const refusal = Object.hasOwn(REFUSALS, shape.kind) ? REFUSALS[/** @type {keyof typeof REFUSALS} */ (shape.kind)] : null;
  const target = steps.length > 0 ? steps[steps.length - 1].to : null;

  // No point for no database: there's nothing it would hold
  /** @type {Point | null} */
  let point = null;
  if (shape.kind !== 'none') {
    const made = await ensurePoint({ ...options, io, inspection, shape, target, structuralVersion, logicalVersion });
    if (made.status !== 'ready') {
      // Where `migrations` exists, the step that couldn't run gets a receipt for it
      if (shape.kind === 'current' && steps.length > 0) {
        const db = await openWithoutUpgrade(indexedDB, DB_NAME);
        if (db) {
          try {
            const now = clock.now();
            await writeReceipts(db, [
              {
                id: steps[0].id,
                from: fromOf(steps[0]),
                to: steps[0].to,
                status: made.status,
                startedAt: now,
                completedAt: now,
                recoveryPointId: null,
                failure: { code: made.code },
              },
            ]);
          } finally {
            db.close();
          }
        }
      }
      return outcome({ status: made.status, shape: shape.kind, failure: { code: made.code } });
    }
    point = made.point;
  }
  const recoveryPointId = point ? point.id : null;

  if (refusal || target === null) {
    return outcome({ status: 'refused', shape: shape.kind, recoveryPointId, failure: { code: refusal || 'unknown-shape' } });
  }

  const startedAt = clock.now();
  const db = await upgrade({
    indexedDB,
    version: target,
    steps,
    logicalVersion,
    onBlocked: () => {
      status.phase = 'blocked-upgrade';
      logger.warn('storage-migration-blocked', { shape: shape.kind, to: target });
      if (options.onBlocked) options.onBlocked();
    },
  });
  status.phase = 'running';
  try {
    await between('upgraded');
    const check = detectShape({ exists: true, ...(await readSchema(db)) });
    if (check.kind !== 'current' || check.structuralVersion !== target) {
      const now = clock.now();
      if (db.objectStoreNames.contains(MIGRATIONS_STORE)) {
        await writeReceipts(
          db,
          steps.map(step => ({
            id: step.id,
            from: fromOf(step),
            to: step.to,
            status: /** @type {const} */ ('failed'),
            startedAt,
            completedAt: now,
            recoveryPointId,
            failure: { code: 'schema-mismatch' },
          })),
        );
      }
      return outcome({ status: 'failed', shape: shape.kind, recoveryPointId, failure: { code: 'schema-mismatch' } });
    }
    const completedAt = clock.now();
    await writeReceipts(
      db,
      steps.map(step => ({
        id: step.id,
        from: fromOf(step),
        to: step.to,
        status: /** @type {const} */ ('completed'),
        startedAt,
        completedAt,
        recoveryPointId,
        failure: null,
      })),
    );
    await between('receipts');
    return outcome({
      status: 'migrated',
      shape: shape.kind,
      to: target,
      steps: steps.map(step => step.id),
      recoveryPointId,
    });
  } finally {
    db.close();
  }
}

/**
 * Starts a run. `done` resolves with its outcome, never rejects, and logs any outcome other
 * than `migrated` and `current`.
 * @param {MigrationOptions} options
 * @returns {MigrationRun}
 */
export function startMigrations(options) {
  const { logger, openWithinMs = OPEN_WITHIN_MS } = options;
  /** @type {{phase: 'running' | 'blocked-upgrade' | 'done'}} */
  const status = { phase: 'running' };
  /** @type {Promise<MigrationOutcome>} */
  const run =
    options.locks && typeof options.locks.request === 'function'
      ? options.locks.request(MIGRATE_LOCK, { mode: 'exclusive' }, () => migrate(options, status))
      : Promise.resolve(outcome({ status: 'failed', failure: { code: 'locks-unavailable' } }));
  const done = run
    .catch(error => outcome({ status: 'failed', failure: { code: failureOf(error).code } }))
    .then(result => {
      status.phase = 'done';
      if (result.status !== 'migrated' && result.status !== 'current') {
        logger.warn('storage-migration', {
          status: result.status,
          shape: result.shape,
          code: result.failure ? result.failure.code : null,
          recoveryPointId: result.recoveryPointId,
        });
      }
      return result;
    });
  /** @type {Promise<MigrationOutcome | MigrationPending>} */
  const answer = new Promise(resolve => {
    const timer = setTimeout(
      () =>
        resolve({
          status: status.phase === 'blocked-upgrade' ? 'blocked-upgrade' : 'migrating',
          retryable: true,
        }),
      openWithinMs,
    );
    done.then(result => {
      clearTimeout(timer);
      resolve(result);
    });
  });
  return { answer, done, state: () => status.phase };
}

/**
 * Runs the migrations and resolves with the outcome once the run has finished
 * @param {MigrationOptions} options
 * @returns {Promise<MigrationOutcome>}
 */
export function runMigrations(options) {
  return startMigrations(options).done;
}
