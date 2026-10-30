/**
 * The CommitLog port (#13, "Idempotency and catch-up"): the cursor read over #17's change
 * log, which the refined body calls `CommitFeed`. It's named apart from #12's in-process
 * `CommitFeed` (application/feed.js), the `{aggregate, ids}` publisher that tells one
 * context's projections what its own commands changed, which stays.
 *
 * Each commit that changes an entity has one commitSeq, from 1, and one entry per entity it
 * changed, carrying what a hint carries and nothing more: `{commitSeq, entityType, entityId,
 * revision}`, no content, no URL. A page catches up from its cursor, the last commitSeq its
 * projection covers (messaging/catch-up.js):
 *
 * - `readChangesSince(cursor, limit)` answers the entries of up to `limit` commits after the
 *   cursor, in commitSeq order, never part of a commit, the cursor to read from next, and
 *   whether more follow.
 * - A cursor below the log's floor, the last commitSeq its retention dropped (#19 defines
 *   it), or past its head, as when the log was replaced under the page, can't be served: the
 *   read answers `resync-required`, and the page reads its projection again.
 * - `head()` is the last commitSeq, 0 before any, which a projection read reports as its
 *   `asOfCommitSeq` when it reads it no later than the records it covers.
 *
 * Reads are async, since #17's log is in IndexedDB, and a read that fails rejects with an
 * UnavailableError. Appending is the adapter's, in the commit's transaction, so the port has
 * no write. test/kernel/commit-log-suite.mjs is the suite #17's durable log runs.
 */

/** @typedef {import('../contracts/fields.js').EntityType} EntityType */

/**
 * One entity a commit changed
 * @typedef {{entityType: EntityType, entityId: string, revision: number}} Change
 */

/** @typedef {Change & {commitSeq: number}} ChangeEntry */

/**
 * @typedef {{kind: 'changes', entries: ChangeEntry[], cursor: number, more: boolean}
 *   | {kind: 'resync-required', floor: number, head: number}} ChangesSince
 */

/**
 * @typedef {object} CommitLog
 * @property {(cursor: number, limit: number) => Promise<ChangesSince>} readChangesSince
 *   `cursor` is a count from 0 and `limit` one from 1. Anything else rejects with an
 *   UnavailableError, cause `adapter`, code `invalid-cursor` or `invalid-limit`.
 * @property {() => Promise<number>} head
 */

/** The most commits a page asks for at a time */
export const CHANGES_PAGE = 100;
