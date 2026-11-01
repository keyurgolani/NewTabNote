/**
 * #17's `operations` ledger (#17, "Identity and feed"; ports/idempotency-ledger.js): a row for
 * each command that committed or kept its conflict, under its commandId, which #17 calls its
 * opId, written in the transaction that commits the command (adapter.js). A row is `{opId,
 * digest, outcome, at}`: the SHA-256 of the command's canonical JSON (memory/fingerprint.js),
 * never the command, the outcome, which holds codes and ids only, and when it was written.
 * A resend of the same command gets the row's outcome back from commit, with nothing run
 * again, and another command under the same key is `idempotency-key-reuse`.
 *
 * Settings commands and startup maintenance keep no row: their writes go to
 * chrome.storage.local, outside any IndexedDB transaction, so a resend of one writes the same
 * values again. A database below version 10 has no `operations` store, so nothing there keeps
 * one either.
 *
 * Retention (sweepLedger): the worker drops rows older than LEDGER_MAX_AGE_MS, and the oldest
 * past LEDGER_MAX_ROWS, at most once every LEDGER_SWEEP_EVERY_MS. A resend older than that
 * reads as `absent` and runs again: a create is refused as `note-exists`, a capture lands its
 * block again under the same id, a placement command applies again, and from #17 PR 4 a save
 * carries its expected revision, so it conflicts and its text is kept.
 */

import { isId } from '../../core/contracts/checks.js';
import { clone } from '../../core/contracts/clone.js';
import { UnavailableError, rejected } from '../../core/contracts/outcomes.js';
import { digestOf } from '../../core/memory/fingerprint.js';
import { failureOf } from './failures.js';
import { META_STORE, OPERATIONS_STORE } from './registry.js';
import { committed, endOf, result } from './requests.js';

/** @typedef {import('../../core/contracts/outcomes.js').Committed} Committed */
/** @typedef {import('../../core/contracts/outcomes.js').Conflict} Conflict */
/** @typedef {import('../../core/contracts/outcomes.js').Outcome} Outcome */
/** @typedef {import('../../core/ports/idempotency-ledger.js').IdempotencyLedger} IdempotencyLedger */
/** @typedef {import('../../core/ports/idempotency-ledger.js').KeyedCommand} KeyedCommand */
/** @typedef {import('../../core/ports/idempotency-ledger.js').LedgerRead} LedgerRead */

/**
 * A ledger row
 * @typedef {{opId: string, digest: string, outcome: Committed | Conflict, at: number}} LedgerRow
 */

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * How long a row is kept. A resend comes within seconds of the send it repeats until the
 * capture journal (#2, #35) replays captures for up to 90 days: that change has to raise this
 * to cover its window.
 */
export const LEDGER_MAX_AGE_MS = 30 * DAY_MS;

/** The most rows kept, at about 250 bytes a row about 12 MB at worst; the oldest go first */
export const LEDGER_MAX_ROWS = 50000;

/** The worker sweeps at its start, and no more often than this */
export const LEDGER_SWEEP_EVERY_MS = DAY_MS;

/** How many rows one sweep transaction deletes */
export const LEDGER_SWEEP_BATCH = 100;

/** `meta`'s record of the last sweep: `{key: 'operations', sweptAt}` */
export const SWEPT_KEY = 'operations';

/** @type {IDBTransactionOptions} */
const STRICT = Object.freeze({ durability: 'strict' });

/**
 * The row a command's outcome is kept as
 * @param {KeyedCommand} command
 * @param {Committed | Conflict} outcome
 * @param {number} at
 * @returns {LedgerRow}
 */
export function ledgerRow(command, outcome, at) {
  return { opId: command.commandId, digest: digestOf(command), outcome: clone(outcome), at };
}

/**
 * What a row answers a command sent again under its key: the row's outcome when it's the same
 * command, by its digest, and `idempotency-key-reuse` when it's another
 * @param {LedgerRow} row
 * @param {KeyedCommand} command
 * @returns {{outcome: Outcome, replayed: boolean}}
 */
export function replayFrom(row, command) {
  if (row.digest !== digestOf(command))
    return { outcome: rejected('validation', 'idempotency-key-reuse'), replayed: false };
  return { outcome: clone(row.outcome), replayed: true };
}

/**
 * @param {LedgerRow | undefined} row
 * @param {KeyedCommand} command
 * @returns {LedgerRead}
 */
function readFrom(row, command) {
  if (!row) return { status: 'absent' };
  if (row.digest !== digestOf(command)) return { status: 'key-reuse' };
  const outcome = clone(row.outcome);
  return outcome.kind === 'committed' ? { status: 'committed', outcome } : { status: 'conflict', outcome };
}

/**
 * What a failed read or sweep answers: the adapter's says reload-required on a connection
 * that's gone or going (adapter.js), and failures.js's says what the failure means
 * @typedef {(error: unknown) => UnavailableError} FailureOf
 */

/**
 * The ledger's read port over a connection's database (ports/idempotency-ledger.js). A read
 * writes nothing, and a database without `operations` has no record of anything.
 * @param {{database: () => IDBDatabase, failure?: FailureOf}} options
 * @returns {IdempotencyLedger}
 */
export function createIndexedDbLedger({ database, failure = failureOf }) {
  return Object.freeze({
    async read(command) {
      const commandId = /** @type {unknown} */ (command?.commandId);
      if (!isId(commandId)) throw new UnavailableError('adapter', 'invalid-key', false);
      try {
        const db = database();
        if (!db.objectStoreNames.contains(OPERATIONS_STORE)) return { status: 'absent' };
        const store = db.transaction(OPERATIONS_STORE, 'readonly').objectStore(OPERATIONS_STORE);
        return readFrom(/** @type {LedgerRow | undefined} */ (await result(store.get(commandId))), command);
      } catch (error) {
        throw failure(error);
      }
    },
  });
}

/**
 * One sweep transaction: deletes, oldest first by `at`, up to `batch` rows that are older than
 * `cutoff` or past `maxRows`, and answers how many it deleted
 * @param {IDBDatabase} db
 * @param {{cutoff: number, maxRows: number, batch: number}} bounds
 * @returns {Promise<number>}
 */
function sweepBatch(db, { cutoff, maxRows, batch }) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction([OPERATIONS_STORE], 'readwrite', STRICT);
    const store = tx.objectStore(OPERATIONS_STORE);
    let deleted = 0;
    const counted = store.count();
    counted.onsuccess = () => {
      let left = counted.result;
      const walk = store.index('at').openCursor();
      walk.onsuccess = () => {
        const cursor = walk.result;
        if (!cursor || deleted >= batch) return;
        const { at } = /** @type {LedgerRow} */ (cursor.value);
        // Rows come oldest first, so the first one that's in bounds ends the batch
        if (!(at < cutoff) && left <= maxRows) return;
        cursor.delete();
        deleted += 1;
        left -= 1;
        cursor.continue();
      };
    };
    endOf(tx).then(end =>
      end.committed ? resolve(deleted) : reject(end.error || new DOMException('The transaction was aborted', 'AbortError')),
    );
  });
}

/**
 * The ledger's retention (#17 PR 2a): drops every row older than `maxAgeMs`, and the oldest
 * past `maxRows`, in strict transactions of `batch` rows, then records when it swept in `meta`.
 * It does nothing within `everyMs` of the last sweep, or on a database below version 10. Cut
 * off, the next sweep finishes it, since the record is written only at the end.
 * @param {{database: () => IDBDatabase, now: number, maxAgeMs?: number, maxRows?: number, everyMs?: number, batch?: number, failure?: FailureOf}} options
 * @returns {Promise<{swept: boolean, deleted: number}>}
 */
export async function sweepLedger({
  database,
  now,
  maxAgeMs = LEDGER_MAX_AGE_MS,
  maxRows = LEDGER_MAX_ROWS,
  everyMs = LEDGER_SWEEP_EVERY_MS,
  batch = LEDGER_SWEEP_BATCH,
  failure = failureOf,
}) {
  try {
    const db = database();
    if (!db.objectStoreNames.contains(OPERATIONS_STORE) || !db.objectStoreNames.contains(META_STORE)) {
      return { swept: false, deleted: 0 };
    }
    const meta = db.transaction(META_STORE, 'readonly').objectStore(META_STORE);
    const last = /** @type {{sweptAt?: unknown} | undefined} */ (await result(meta.get(SWEPT_KEY)));
    const sweptAt = last && typeof last.sweptAt === 'number' ? last.sweptAt : null;
    if (sweptAt !== null && now - sweptAt >= 0 && now - sweptAt < everyMs) return { swept: false, deleted: 0 };
    let deleted = 0;
    for (;;) {
      const count = await sweepBatch(db, { cutoff: now - maxAgeMs, maxRows, batch });
      deleted += count;
      if (count < batch) break;
    }
    const done = db.transaction(META_STORE, 'readwrite', STRICT);
    done.objectStore(META_STORE).put({ key: SWEPT_KEY, sweptAt: now });
    await committed(done);
    return { swept: true, deleted };
  } catch (error) {
    throw failure(error);
  }
}
