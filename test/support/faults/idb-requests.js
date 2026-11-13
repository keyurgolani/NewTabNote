'use strict';

/**
 * The IndexedDB request counter (#28 slice 4, #301): each request a page or the service worker
 * makes on a store, an index or a cursor, as it makes it, on the epoch clock. #27's IndexedDB reads
 * before interaction-ready (#300) read it, and so can any case that has to count a context's
 * requests. Nothing under test/support/ ships.
 *
 * installIdbRequestCounter runs in the context it counts, and holds nothing from outside itself, so
 * it goes in as it is:
 *
 *   await countRequestsIn(extension.context);  // each page, from its next document's first script
 *   await countRequestsIn(extension.worker);   // the service worker, from now on
 *   const record = await readIdbRequests(page);
 *   const ready = await interactionReadyAt(page);  // null for a page that never marks, such as 1.4.0's
 *   countIdbRequests(record, { until: ready });    // throws on that null, rather than count it all
 *
 * The record lives on the context's global, so it lasts only as long as the page's document or the
 * worker's global. A navigation or a reload starts a page's afresh. A worker that restarts or
 * updates loses its own, so a spec calls countRequestsIn(extension.worker) again after either.
 *
 * In Node it takes fake-indexeddb's classes as its scope (test/idb-request-counter.test.js). It
 * wraps the request methods of IDBObjectStore and IDBIndex, and IDBCursor's steps and writes. Each
 * wrapper calls the method it replaced as it was and adds no await, so the same request goes out
 * in the same order, for one small object per request, and a call that throws throws as before and
 * counts nothing. Database opens and deletes (indexedDB.open, deleteDatabase), databases() and
 * transactions aren't counted, and a dedicated worker or the offscreen document, where no init
 * script goes, isn't seen.
 *
 * An entry is one request: { kind, method, database, store, index, at }. `kind` is 'read' for get,
 * getKey, getAll, getAllKeys, getAllRecords, count, openCursor and openKeyCursor, on a store or an
 * index, and 'write' for put, add, delete and clear on a store and update and delete on a cursor.
 * `index` is the index's name, or null on a store, and on a cursor its source's. `at` is
 * performance.timeOrigin + performance.now(), in ms, so a page's entries and the worker's share one
 * clock. A cursor's continue, advance and continuePrimaryKey move one request along rather than
 * make one, so they go in a list of their own, cursor steps, as { method, database, store, index,
 * at }.
 */

/**
 * The earliest `until` countIdbRequests takes, 1e12 epoch ms, in September 2001: no epoch time a
 * test makes is earlier, and no page's own performance.now() gets this late
 */
const EPOCH_FLOOR = 1e12;

/**
 * @typedef {{kind: 'read' | 'write', method: string, database: string | null, store: string | null, index: string | null, at: number}} IdbRequestEntry
 * @typedef {{method: string, database: string | null, store: string | null, index: string | null, at: number}} IdbCursorStep
 * @typedef {{entries: IdbRequestEntry[], cursorSteps: IdbCursorStep[]}} IdbRequestRecord
 * @typedef {{reads: number, writes: number, cursorSteps: number}} IdbCounts
 */

/**
 * Installs the counter in `scope`, a global object, or one that holds IDBObjectStore, IDBIndex,
 * IDBCursor and performance as a global does. A scope that has one keeps it. The record is
 * scope.__ntnIdbRequests: entries() and cursorSteps(), copies in the order made; reset(), which
 * empties both; and uninstall(), which puts every method back and takes the record away. One
 * counter at a time over a set of classes.
 * @param {any} [scope]
 * @returns {true}
 */
function installIdbRequestCounter(scope = globalThis) {
  if (scope.__ntnIdbRequests) return true;
  /** @type {IdbRequestEntry[]} */
  const entries = [];
  /** @type {IdbCursorStep[]} */
  const steps = [];
  /** @type {Array<() => void>} */
  const undo = [];
  const now = () => scope.performance.timeOrigin + scope.performance.now();
  // A store, an index, or a cursor's source: its database, its store, and the index, or null. The
  // call it counts has already gone through, so a name it can't read is null and never a throw
  const where = (/** @type {any} */ source) => {
    try {
      return source.objectStore
        ? { database: source.objectStore.transaction.db.name, store: source.objectStore.name, index: source.name }
        : { database: source.transaction.db.name, store: source.name, index: null };
    } catch {
      return { database: null, store: null, index: null };
    }
  };
  /**
   * @param {any} proto
   * @param {string[]} methods
   * @param {(method: string, target: any) => void} record
   */
  const wrap = (proto, methods, record) => {
    for (const method of methods) {
      const original = proto && proto[method];
      if (typeof original !== 'function') continue;
      proto[method] = /** @this {any} @param {...any} args */ function (...args) {
        const result = original.apply(this, args);
        record(method, this);
        return result;
      };
      undo.push(() => {
        proto[method] = original;
      });
    }
  };
  const request = (/** @type {'read' | 'write'} */ kind) => (/** @type {string} */ method, /** @type {any} */ target) => {
    entries.push({ kind, method, ...where(target), at: now() });
  };
  const READS = ['get', 'getKey', 'getAll', 'getAllKeys', 'getAllRecords', 'count', 'openCursor', 'openKeyCursor'];
  for (const name of ['IDBObjectStore', 'IDBIndex']) wrap(scope[name] && scope[name].prototype, READS, request('read'));
  const cursor = scope.IDBCursor && scope.IDBCursor.prototype;
  wrap(scope.IDBObjectStore && scope.IDBObjectStore.prototype, ['put', 'add', 'delete', 'clear'], request('write'));
  wrap(cursor, ['update', 'delete'], (method, target) => request('write')(method, target.source));
  wrap(cursor, ['continue', 'advance', 'continuePrimaryKey'], (method, target) => {
    steps.push({ method, ...where(target.source), at: now() });
  });
  Object.defineProperty(scope, '__ntnIdbRequests', {
    configurable: true,
    value: {
      entries: () => entries.map((entry) => ({ ...entry })),
      cursorSteps: () => steps.map((step) => ({ ...step })),
      reset: () => {
        entries.length = 0;
        steps.length = 0;
      },
      uninstall: () => {
        undo.splice(0).forEach((put) => put());
        delete scope.__ntnIdbRequests;
      },
    },
  });
  return true;
}

/**
 * How many reads, writes and cursor steps `record` holds, in all and by `<database>/<store>`: every
 * one, or with `until` (epoch ms), those made at or before it. A null or non-finite `until` throws,
 * and so does one below EPOCH_FLOOR, as a page's own performance.now() or a mark's startTime would
 * be: cut there, a record would count nothing. The mark's cut goes through interactionReadyAt.
 * The cut is inclusive, so a request in the interaction-ready mark's own clock tick (100 µs, where
 * the page isn't cross-origin isolated) counts as made before it: for a budget, counting one request
 * too many is safer than missing one
 * @param {IdbRequestRecord} record
 * @param {{until?: number}} [options]
 * @returns {IdbCounts & {byStore: Record<string, IdbCounts>}}
 */
function countIdbRequests(record, { until } = {}) {
  if (until !== undefined && !Number.isFinite(until)) {
    throw new TypeError(
      `countIdbRequests: until is an epoch time in ms, not ${String(until)} (${typeof until}). ` +
        'interactionReadyAt answers null for a page that never marked, so cut that page at another epoch time, ' +
        'such as its performance.timeOrigin plus its echo',
    );
  }
  if (until !== undefined && until < EPOCH_FLOOR) {
    throw new RangeError(
      `countIdbRequests: until is an epoch time in ms, and ${until} is too early for one: ` +
        "add performance.timeOrigin to a page's own time, as interactionReadyAt does",
    );
  }
  const counts = { reads: 0, writes: 0, cursorSteps: 0, byStore: /** @type {Record<string, IdbCounts>} */ ({}) };
  const add = (/** @type {{database: string | null, store: string | null, at: number}} */ item, /** @type {keyof IdbCounts} */ field) => {
    if (until !== undefined && item.at > until) return;
    const key = `${item.database}/${item.store}`;
    counts.byStore[key] = counts.byStore[key] || { reads: 0, writes: 0, cursorSteps: 0 };
    counts.byStore[key][field]++;
    counts[field]++;
  };
  for (const entry of record.entries) add(entry, entry.kind === 'read' ? 'reads' : 'writes');
  for (const step of record.cursorSteps) add(step, 'cursorSteps');
  return counts;
}

/**
 * Starts counting in `target`: a Playwright BrowserContext or Page gets the counter as an init
 * script, so each page's next document counts from its first script; a Worker, such as the
 * extension's service worker, gets it through evaluate, so it counts from now on. The record lives
 * only as long as that document or that worker's global, so count in the worker again after it
 * restarts or updates
 * @param {any} target
 * @returns {Promise<void>}
 */
async function countRequestsIn(target) {
  if (typeof target.addInitScript === 'function') await target.addInitScript(installIdbRequestCounter);
  else await target.evaluate(installIdbRequestCounter);
}

/**
 * What `target`, a Playwright Page or Worker, has counted: { entries, cursorSteps }. It throws in a
 * context with no record: a page whose document loaded before countRequestsIn, or a worker that
 * restarted or updated since
 * @param {any} target
 * @returns {Promise<IdbRequestRecord>}
 */
function readIdbRequests(target) {
  return target.evaluate(() => {
    const counter = /** @type {any} */ (globalThis).__ntnIdbRequests;
    if (!counter) {
      throw new Error(
        "No IndexedDB request counter here. The record lives on a page's document or a worker's global, so " +
          'countRequestsIn the context before the page loads, and the worker again after it restarts or updates',
      );
    }
    return { entries: counter.entries(), cursorSteps: counter.cursorSteps() };
  });
}

/**
 * When `page` marked itself interaction-ready (#27's `ntn:interaction-ready`, js/entries/boot.js),
 * on the epoch clock, or null while it hasn't
 * @param {any} page
 * @returns {Promise<number | null>}
 */
function interactionReadyAt(page) {
  return page.evaluate(() => {
    const [mark] = performance.getEntriesByName('ntn:interaction-ready', 'mark');
    return mark ? performance.timeOrigin + mark.startTime : null;
  });
}

module.exports = { installIdbRequestCounter, countIdbRequests, countRequestsIn, readIdbRequests, interactionReadyAt };
