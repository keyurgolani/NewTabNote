/**
 * The ledger's retention (#17 PR 2a; ledger.js): the service worker drops rows older than
 * LEDGER_MAX_AGE_MS, and the oldest past LEDGER_MAX_ROWS, at most once every
 * LEDGER_SWEEP_EVERY_MS, at its start (composition/background.js). Only the worker runs it, so
 * only its adapter has it (worker-tasks.js), and no page's start holds it (#35 slice 3c).
 */

import { failureOf } from './failures.js';
import { META_STORE, OPERATIONS_STORE } from './registry.js';
import { committed, endOf, result } from './requests.js';

/** @typedef {import('./ledger.js').LedgerRow} LedgerRow */
/** @typedef {import('./ledger.js').FailureOf} FailureOf */

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * How long a row is kept: 90 days since #35's journal (slice 3), whose drain replays an entry
 * under its opId for as long as it stays, so a command that committed answers its row rather
 * than running again across that window (#17, "Identity and feed")
 */
export const LEDGER_MAX_AGE_MS = 90 * DAY_MS;

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
