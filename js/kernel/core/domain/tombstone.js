/**
 * Tombstones (#17, "Identity and feed" and Q16): what's left of a note or a folder deleted for
 * good, so nothing that deletes it leaves it anywhere it can be read. A tombstone holds ids,
 * a reason, and times, never content: `{entityType, id, deletedAt, reason, purge}`, and
 * `lastRevision` and `seq` on an adapter with revisions, which fills them in the delete's own
 * transaction (#17 PR 2b). `purge` is `pending` until the worker has purged the entity from
 * every recovery point (adapters/indexeddb/purge.js), and then goes, so only pending ones are
 * in the store's `purge` index.
 */

/** @typedef {'note' | 'folder'} TombstoneEntity */

/**
 * Why a note was deleted for good: a permanent delete (one note or a bulk one), Empty trash,
 * trash retention, or a trash of an untitled note with nothing in it. A folder is only ever
 * `deleted`.
 * @typedef {'deleted' | 'trash-emptied' | 'trash-expired' | 'empty-note'} TombstoneReason
 */

/** A tombstone whose entity the recovery points may still hold */
export const PURGE_PENDING = 'pending';

/**
 * @typedef {object} TombstoneRecord
 * @property {TombstoneEntity} entityType
 * @property {string} id
 * @property {number} deletedAt
 * @property {TombstoneReason} reason
 * @property {typeof PURGE_PENDING} [purge] - absent once the purge is done
 * @property {number} [purgedAt]
 * @property {number} [lastRevision] - the note's content revision when it went
 * @property {number | null} [seq] - the change-log seq of the commit that deleted it
 */

/**
 * The tombstone a delete puts, in the same transaction as the delete, waiting for the purge
 * @param {TombstoneEntity} entityType
 * @param {string} id
 * @param {TombstoneReason} reason
 * @param {number} now
 * @returns {TombstoneRecord}
 */
export function newTombstone(entityType, id, reason, now) {
  return { entityType, id, deletedAt: now, reason, purge: PURGE_PENDING };
}
