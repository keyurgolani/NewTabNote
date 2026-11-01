/**
 * #17's change log (#17, "Identity and feed"; ports/commit-log.js): a row for each note and
 * folder a commit wrote, `{seq, entityType, entityId, revision, opId, ops, position}`, keyed by
 * `[seq, entityType, entityId]` and indexed by entity, with the log's `head` and `floor` in
 * `meta`'s `changes` record. The adapter appends a commit's rows in the commit's transaction
 * (adapter.js), at the seq after the head, so seqs run from 1 with no gaps, and a commit that
 * wrote no note or folder appends none. `ops` stays empty until #17 PR 4 defines each op (the
 * lead's Q4: metadata only), and `position` keeps the order the commit wrote them in. Rows
 * hold ids, types, revisions, and the commandId, never content.
 *
 * Nothing prunes it before #19 sets the floor; pruneChanges is that retention's step.
 */

import { UnavailableError } from '../../core/contracts/outcomes.js';
import { failureOf } from './failures.js';
import { CHANGES_KEY, CHANGES_STORE, META_STORE } from './registry.js';
import { committed, result } from './requests.js';

/** @typedef {import('../../core/ports/commit-log.js').Change} Change */
/** @typedef {import('../../core/ports/commit-log.js').ChangeEntry} ChangeEntry */
/** @typedef {import('../../core/ports/commit-log.js').CommitLog} CommitLog */

/**
 * `meta`'s record of the log: the last seq, and the last one retention dropped
 * @typedef {{key: 'changes', head: number, floor: number}} LogHead
 */

/**
 * A change log row
 * @typedef {Change & {seq: number, opId: string, ops: unknown[], position: number}} ChangeRow
 */

/** @type {IDBTransactionOptions} */
const STRICT = Object.freeze({ durability: 'strict' });

/**
 * @param {unknown} value
 * @param {number} from
 */
const isCount = (value, from) => Number.isSafeInteger(value) && /** @type {number} */ (value) >= from;

/**
 * The head record as stored, or an empty log's
 * @param {unknown} record
 * @returns {LogHead}
 */
export function logHead(record) {
  const { head, floor } = /** @type {{head?: unknown, floor?: unknown}} */ (record || {});
  return { key: CHANGES_KEY, head: isCount(head, 0) ? Number(head) : 0, floor: isCount(floor, 0) ? Number(floor) : 0 };
}

/**
 * Puts one commit's rows and the new head in `tx`, which spans `changes` and `meta`, and
 * answers the commit's seq. `head` is the log's head as this transaction read it.
 * @param {IDBTransaction} tx
 * @param {LogHead} head
 * @param {readonly Change[]} changes - one or more
 * @param {string} opId
 * @returns {number}
 */
export function writeChanges(tx, head, changes, opId) {
  const seq = head.head + 1;
  const rows = tx.objectStore(CHANGES_STORE);
  changes.forEach(({ entityType, entityId, revision }, position) => {
    /** @type {ChangeRow} */
    const row = { seq, entityType, entityId, revision, opId, ops: [], position };
    rows.put(row);
  });
  tx.objectStore(META_STORE).put({ ...head, head: seq });
  return seq;
}

/** How an append or a prune ends, Chrome's close of the connection included (requests.js) */
const completion = committed;

/**
 * Appends one commit's changes in a transaction of its own, as the adapter does in a commit's,
 * and answers its seq. For #13's port suite and for repairs, never for a command's writes.
 * @param {IDBDatabase} db
 * @param {readonly Change[]} changes
 * @param {string} opId
 * @returns {Promise<number>}
 */
export async function appendChanges(db, changes, opId) {
  const tx = db.transaction([CHANGES_STORE, META_STORE], 'readwrite', STRICT);
  const done = completion(tx);
  const head = logHead(await result(tx.objectStore(META_STORE).get(CHANGES_KEY)));
  const seq = writeChanges(tx, head, changes, opId);
  await done;
  return seq;
}

/**
 * Drops every commit up to `through`, which becomes the floor, as #19's retention will
 * @param {IDBDatabase} db
 * @param {typeof IDBKeyRange} keyRange
 * @param {number} through
 * @returns {Promise<void>}
 */
export async function pruneChanges(db, keyRange, through) {
  if (!isCount(through, 0)) throw new TypeError('prune takes a seq');
  const tx = db.transaction([CHANGES_STORE, META_STORE], 'readwrite', STRICT);
  const done = completion(tx);
  const head = logHead(await result(tx.objectStore(META_STORE).get(CHANGES_KEY)));
  const floor = Math.max(head.floor, Math.min(through, head.head));
  // Every key below [floor + 1] is a row of a commit up to the floor
  tx.objectStore(CHANGES_STORE).delete(keyRange.upperBound([floor + 1], true));
  tx.objectStore(META_STORE).put({ ...head, floor });
  await done;
}

/**
 * The change log's cursor read over a connection's database (ports/commit-log.js). A
 * database without `changes` has an empty log. `failure` says what a failed read answers: the
 * adapter's says reload-required on a connection that's gone or going (adapter.js).
 * @param {{database: () => IDBDatabase, keyRange: typeof IDBKeyRange, failure?: (error: unknown) => UnavailableError}} options
 * @returns {CommitLog}
 */
export function createIndexedDbCommitLog({ database, keyRange, failure = failureOf }) {
  /**
   * The log's head record, and the rows of the commits after `cursor` up to `last`, in one
   * readonly transaction, so the rows and the head agree
   * @param {(head: LogHead) => [number, number] | null} range - the seqs to read, given the head
   * @returns {Promise<{head: LogHead, rows: ChangeRow[]}>}
   */
  const readLog = async range => {
    try {
      const db = database();
      if (!db.objectStoreNames.contains(CHANGES_STORE) || !db.objectStoreNames.contains(META_STORE)) {
        return { head: logHead(undefined), rows: [] };
      }
      const tx = db.transaction([CHANGES_STORE, META_STORE], 'readonly');
      const head = logHead(await result(tx.objectStore(META_STORE).get(CHANGES_KEY)));
      const seqs = range(head);
      if (!seqs) return { head, rows: [] };
      const [first, last] = seqs;
      const bound = keyRange.bound([first], [last + 1], false, true);
      const rows = /** @type {ChangeRow[]} */ (await result(tx.objectStore(CHANGES_STORE).getAll(bound)));
      return { head, rows };
    } catch (error) {
      throw failure(error);
    }
  };

  return Object.freeze({
    async readChangesSince(cursor, limit) {
      if (!isCount(cursor, 0)) throw new UnavailableError('adapter', 'invalid-cursor', false);
      if (!isCount(limit, 1)) throw new UnavailableError('adapter', 'invalid-limit', false);
      const { head, rows } = await readLog(log =>
        cursor < log.floor || cursor >= log.head ? null : [cursor + 1, Math.min(cursor + limit, log.head)],
      );
      if (cursor < head.floor || cursor > head.head)
        return { kind: 'resync-required', floor: head.floor, head: head.head };
      const last = Math.min(cursor + limit, head.head);
      /** @type {ChangeEntry[]} */
      const entries = rows
        .slice()
        .sort((a, b) => a.seq - b.seq || (a.position ?? 0) - (b.position ?? 0))
        .map(({ seq, entityType, entityId, revision }) => ({ commitSeq: seq, entityType, entityId, revision }));
      return { kind: 'changes', entries, cursor: Math.max(cursor, last), more: last < head.head };
    },
    async head() {
      return (await readLog(() => null)).head.head;
    },
  });
}
