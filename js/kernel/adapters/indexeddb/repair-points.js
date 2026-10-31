/**
 * The `pre-repair` recovery point a reversible remediation takes before it changes anything
 * (#20, "Remediation pipeline": reversible needs "a verified #17 recovery point", `pre-repair`
 * for repair, orphan, and quarantine actions). It's #17's point, made the way migrate.js makes
 * a `pre-migration` one (recovery-points.js): every CanvasTabDB store but `settings`, copied
 * in bounded batches into NewTabNoteRecovery, then read back and matched on counts, ID sets,
 * and every row's SHA-256 before it counts as verified.
 *
 * - It runs under Web Lock `storage.migrate`, exclusive, the lock migrate.js holds, so a point
 *   still has one writer at a time and a repair never runs beside a migration.
 * - The space check comes first (space.js). Short of room, no point and no repair: the
 *   remediation answers `space-short` and changes nothing.
 * - Verified also means it holds what the repair is about to change: every key `holds` names,
 *   in its store, so a block typed in between the copy and the check can't go unprotected.
 *   A point that misses one is dropped, never handed out.
 * - #17's rule for which points stay holds (keepVerified): the newest verified `pre-repair`
 *   point stays, and the pinned `pre-migration` point is never touched.
 *
 * Nothing shipped calls it: the remediation pipeline does, in-process, once slice 4's views
 * start a run.
 */

import { failureOf } from './failures.js';
import { MIGRATE_LOCK } from './migrate.js';
import {
  DEFAULT_LIMITS,
  copyPoint,
  discardPoint,
  isQuota,
  keepVerified,
  listPoints,
  measureStores,
  openRecovery,
  readPointStore,
  startPoint,
  storesToCopy,
  verifyPoint,
} from './recovery-points.js';
import { DB_NAME } from './schema.js';
import { detectShape, openWithoutUpgrade, readSchema } from './shapes.js';
import { checkSpace } from './space.js';

/** @typedef {import('./records.js').Digester} Digester */
/** @typedef {import('./recovery-points.js').Point} Point */
/** @typedef {import('./recovery-points.js').Hooks} Hooks */
/** @typedef {import('./space.js').Estimate} Estimate */
/** @typedef {import('./migrate.js').MigrateLocks} MigrateLocks */
/** @typedef {import('../../core/ports/runtime.js').Clock} Clock */

/**
 * @typedef {{ok: true, pointId: string, verifiedAt: number} | {ok: false, code: string}} MadePoint
 */

/**
 * @param {{
 *   indexedDB: IDBFactory,
 *   keyRange: typeof IDBKeyRange,
 *   crypto: Digester,
 *   clock: Clock,
 *   locks: MigrateLocks,
 *   estimate?: Estimate | null,
 *   hooks?: Hooks,
 * }} options
 */
export function createRepairPoints({ indexedDB, keyRange, crypto, clock, locks, estimate = null, hooks = {} }) {
  const io = { keyRange, crypto, limits: DEFAULT_LIMITS };

  /**
   * Whether `point` holds every key `holds` names, in its store
   * @param {IDBDatabase} recovery
   * @param {Point} point
   * @param {Readonly<Record<string, readonly string[]>>} holds
   */
  const holdsAll = async (recovery, point, holds) => {
    for (const [store, keys] of Object.entries(holds)) {
      if (keys.length === 0) continue;
      if (!point.stores.includes(store)) return false;
      const held = new Set((await readPointStore(recovery, point, store, io)).map(row => row.key));
      if (keys.some(key => !held.has(key))) return false;
    }
    return true;
  };

  /**
   * @param {Readonly<Record<string, readonly string[]>>} holds
   * @returns {Promise<MadePoint>}
   */
  const make = async holds => {
    const source = await openWithoutUpgrade(indexedDB, DB_NAME);
    if (!source) return { ok: false, code: 'no-database' };
    try {
      const shape = detectShape({ exists: true, ...(await readSchema(source)) });
      const stores = storesToCopy(source);
      const bytes = await measureStores(source, stores, io);
      const space = await checkSpace({ estimate, bytes });
      if (space.status === 'short') return { ok: false, code: 'space-short' };
      const recovery = /** @type {IDBDatabase} */ (await openRecovery(indexedDB, { create: true }));
      try {
        const createdAt = clock.now();
        const taken = new Set((await listPoints(recovery)).map(point => point.id));
        let id = `pre-repair-${createdAt}`;
        for (let n = 2; taken.has(id); n++) id = `pre-repair-${createdAt}-${n}`;
        const started = await startPoint(recovery, {
          id,
          kind: 'pre-repair',
          sourceShape: shape.kind,
          sourceVersion: source.version,
          structuralVersion: shape.kind === 'current' ? shape.structuralVersion : null,
          logicalVersion: shape.kind === 'current' ? shape.logicalVersion : null,
          target: null,
          stores,
          createdAt,
        });
        try {
          await copyPoint({ source, recovery, point: started.point, progress: started.progress, io, hooks });
        } catch (error) {
          await discardPoint(recovery, id, io).catch(() => {});
          return { ok: false, code: isQuota(error) ? 'quota' : failureOf(error).code };
        }
        // What's on disk is what's verified, not the record kept in memory
        const stored = (await listPoints(recovery)).find(point => point.id === id);
        const verdict = stored ? await verifyPoint({ recovery, point: stored, io }) : { ok: false };
        if (!stored || !verdict.ok || !(await holdsAll(recovery, stored, holds))) {
          await discardPoint(recovery, id, io).catch(() => {});
          return { ok: false, code: 'recovery-point-unverified' };
        }
        const verified = await keepVerified({ recovery, point: stored, clock, io });
        return { ok: true, pointId: verified.id, verifiedAt: /** @type {number} */ (verified.verifiedAt) };
      } finally {
        recovery.close();
      }
    } finally {
      source.close();
    }
  };

  return Object.freeze({
    /**
     * Makes and verifies a `pre-repair` point that holds every key `holds` names. Never
     * rejects: what failed answers its code.
     * @param {{holds?: Readonly<Record<string, readonly string[]>>}} [options]
     * @returns {Promise<MadePoint>}
     */
    async make({ holds = {} } = {}) {
      try {
        return await locks.request(MIGRATE_LOCK, { mode: 'exclusive' }, () => make(holds));
      } catch (error) {
        return { ok: false, code: failureOf(error).code };
      }
    },

    /**
     * Whether point `pointId` is there and reads back verified now
     * @param {string} pointId
     * @returns {Promise<boolean>}
     */
    async verify(pointId) {
      try {
        const recovery = await openRecovery(indexedDB, { create: false });
        if (!recovery) return false;
        try {
          const point = (await listPoints(recovery)).find(candidate => candidate.id === pointId);
          return Boolean(point && point.status === 'verified' && (await verifyPoint({ recovery, point, io })).ok);
        } finally {
          recovery.close();
        }
      } catch {
        return false;
      }
    },
  });
}

/** @typedef {ReturnType<typeof createRepairPoints>} RepairPoints */
