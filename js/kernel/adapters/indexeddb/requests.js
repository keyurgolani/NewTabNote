/**
 * The IndexedDB request helpers both kernel adapters over CanvasTabDB use: #17's (adapter.js)
 * and #12's legacy one (adapters/legacy/adapter.js), which takes these, the store names
 * (schema.js), and the setting keys (settings.js) from here, so the two can't drift apart.
 */

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
