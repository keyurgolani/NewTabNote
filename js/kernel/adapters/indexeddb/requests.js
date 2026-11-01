/**
 * The IndexedDB request helpers #17's adapter over CanvasTabDB (adapter.js) and its stores'
 * modules use. #12's legacy adapter took these, the store names (schema.js), and the setting
 * keys (settings.js) from here too, so the two couldn't drift apart, until #17 PR 4a deleted it.
 */

import { isId } from '../../core/contracts/checks.js';
import { UnavailableError } from '../../core/contracts/outcomes.js';

/**
 * `value` for an index read, which the port takes only as an id (ports/repository.js, Tx).
 * Anything else is refused, `adapter` `invalid-key`, since IndexedDB reads null and undefined
 * as no range, so such a read would return every record.
 * @param {unknown} value
 * @returns {string}
 */
export function indexValue(value) {
  if (!isId(value)) throw new UnavailableError('adapter', 'invalid-key', false);
  return value;
}

/**
 * A request's result, or its error
 * @template T
 * @param {IDBRequest<T>} request
 * @returns {Promise<T>}
 */
export function result(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

/**
 * How a transaction ended: committed, or not, with its error, which is null when this code
 * aborted it
 * @typedef {{committed: true} | {committed: false, error: DOMException | null}} Ending
 */

/**
 * How `tx` ends: `complete` commits it, `abort` aborts it, and its connection's own `close` event
 * ends it as aborted. Chrome fires that event only when it closes a connection itself (the
 * database deleted, or its storage failing), and a transaction that close catches, one opened
 * after Chrome aborted what was open and before the close reached the page, fires neither
 * `complete` nor `abort` (e2e/connection-closing.spec.js), so a wait on either alone never ends.
 * A connection this code closes, as on another context's upgrade, fires no `close` event and
 * lets what's open finish, so its transactions end as they always did, and a `complete` that
 * comes before Chrome's `close` wins. Whichever comes first, the other listeners go.
 * @param {IDBTransaction} tx
 * @returns {Promise<Ending>}
 */
export function endOf(tx) {
  return new Promise(resolve => {
    const { db } = tx;
    /** @param {Ending} end */
    const settle = end => {
      tx.removeEventListener('complete', completed);
      tx.removeEventListener('abort', aborted);
      db.removeEventListener('close', closed);
      resolve(end);
    };
    const completed = () => settle({ committed: true });
    const aborted = () => settle({ committed: false, error: tx.error });
    const closed = () =>
      settle({ committed: false, error: tx.error || new DOMException('The connection closed', 'AbortError') });
    tx.addEventListener('complete', completed);
    tx.addEventListener('abort', aborted);
    db.addEventListener('close', closed);
  });
}

/**
 * Resolves when `tx` commits, and rejects with its error when it aborts or Chrome closes its
 * connection under it (endOf)
 * @param {IDBTransaction} tx
 * @returns {Promise<void>}
 */
export async function committed(tx) {
  const end = await endOf(tx);
  if (!end.committed) throw end.error || new DOMException('The transaction aborted', 'AbortError');
}

/**
 * Aborts `tx`, unless it has already finished
 * @param {IDBTransaction | null} tx
 */
export function abort(tx) {
  try {
    if (tx) tx.abort();
  } catch {
    // Already finished
  }
}
