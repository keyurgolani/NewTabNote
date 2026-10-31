/**
 * Tombstones in CanvasTabDB's `tombstones` store (#17 PR 2b; domain/tombstone.js). Core's
 * deletion puts one in the delete's own unit, for each note deleted for good and each folder
 * deleted, so nothing deletes an entity without leaving one. Here:
 * - #17's adapter fills in what only it knows, in the same transaction: a note's last content
 *   revision, so one made again under its id carries on past it (versions.js), and the
 *   change-log seq of the commit that deleted it.
 * - The worker's purge (purge.js) reads the pending ones, and once every recovery point is
 *   purged of them, drops their `purge` field, so the store's sparse `purge` index lists only
 *   the ones still to do.
 * A tombstone holds ids, a reason, revisions, and times, never content.
 */

import { PURGE_PENDING } from '../../core/domain/tombstone.js';
import { TOMBSTONES_STORE } from './registry.js';
import { result } from './requests.js';

/** @typedef {import('../../core/domain/tombstone.js').TombstoneRecord} TombstoneRecord */

/** The index that lists the tombstones still to purge */
export const PURGE_INDEX = 'purge';

/** @type {IDBTransactionOptions} */
const STRICT = Object.freeze({ durability: 'strict' });

/**
 * Resolves when `tx` commits, and rejects with its error when it aborts
 * @param {IDBTransaction} tx
 * @returns {Promise<void>}
 */
const committed = tx =>
  new Promise((resolve, reject) => {
    tx.addEventListener('complete', () => resolve());
    tx.addEventListener('abort', () => reject(tx.error || new DOMException('The transaction aborted', 'AbortError')));
  });

/**
 * Puts the tombstones a commit's units put again, with the deleted note's last content
 * revision and the commit's change-log seq, in the commit's transaction
 * @param {IDBObjectStore} store - `tombstones`, in that transaction
 * @param {readonly TombstoneRecord[]} tombstones - as the units put them
 * @param {{deleted: ReadonlyArray<{id: string, lastRevision: number}>, seq: number | null}} commit
 */
export function finishTombstones(store, tombstones, { deleted, seq }) {
  const lastRevisions = new Map(deleted.map(({ id, lastRevision }) => [id, lastRevision]));
  for (const tombstone of tombstones) {
    /** @type {TombstoneRecord} */
    const finished = { ...tombstone, seq };
    if (tombstone.entityType === 'note') finished.lastRevision = lastRevisions.get(tombstone.id) ?? 0;
    store.put(finished);
  }
}

/**
 * Every tombstone whose purge is still to do, oldest first. None on a database without the
 * store, below version 10.
 * @param {IDBDatabase} db
 * @returns {Promise<TombstoneRecord[]>}
 */
export async function pendingTombstones(db) {
  if (!db.objectStoreNames.contains(TOMBSTONES_STORE)) return [];
  const tx = db.transaction(TOMBSTONES_STORE, 'readonly');
  const found = /** @type {TombstoneRecord[]} */ (
    await result(tx.objectStore(TOMBSTONES_STORE).index(PURGE_INDEX).getAll(PURGE_PENDING))
  );
  return found.sort((a, b) => a.deletedAt - b.deletedAt);
}

/**
 * Marks `tombstones` purged, in one strict transaction: each loses its `purge` field and
 * gains `purgedAt`, as it's stored now, so a tombstone a later delete put again under the same
 * key keeps whatever it has besides
 * @param {IDBDatabase} db
 * @param {readonly TombstoneRecord[]} tombstones
 * @param {number} now
 */
export async function markPurged(db, tombstones, now) {
  if (tombstones.length === 0) return;
  const tx = db.transaction(TOMBSTONES_STORE, 'readwrite', STRICT);
  const done = committed(tx);
  const store = tx.objectStore(TOMBSTONES_STORE);
  for (const { entityType, id } of tombstones) {
    const request = store.get([entityType, id]);
    request.onsuccess = () => {
      const stored = /** @type {TombstoneRecord | undefined} */ (request.result);
      if (!stored || stored.purge !== PURGE_PENDING) return;
      /** @type {TombstoneRecord} */
      const purged = { ...stored, purgedAt: now };
      delete purged.purge;
      store.put(purged);
    };
  }
  await done;
}
