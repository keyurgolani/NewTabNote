/**
 * The worker's status read (#20 slice 4c): its answer to the new tab's status read, and to
 * Popup's and the Side Panel's after it (js/trust/core/status-message.js), from the worker's
 * NewTabNoteTrust records, so no status page loads the records or opens the database. It's one of
 * js/background.js's own handlers on installWorkerNetwork, which runs it only for this
 * extension's own senders (isOwnSender), and it takes the new tab, Popup and the Side Panel alone,
 * by the sender's page and never by its tab: recovery.html, which reads its own summary, and the
 * offscreen document are refused, as any other sender is.
 *
 * It only reads. The records are never opened, so nothing is pruned, raised or resolved; their
 * store answers no write and makes no NewTabNoteTrust where there's none yet
 * (readOnlyTrustStore), and their settings copy takes no write either. It runs no check: it reads
 * the latest receipts, which recovery.html's checks write, and the incidents, and summarizes them
 * with the new tab's rows (rowsOn('workspace')), narrowed to what the lines and cards read. Those
 * are the rows that list the coordinator, whose problems the worker raises itself, so they count
 * in their group's needs and cause; recovery.html's rows leave it out. The worker keeps one
 * store, made at the first ask, and builds the records over it at each ask, so no ask's open
 * state reaches another's. A store or records build that fails is tried again at the next ask,
 * and an ask that fails answers that it's unavailable, with nothing of why.
 */

import { readOnlyTrustStore } from '../adapters/indexeddb/trust.js';
import { principalOf } from '../adapters/messaging/runtime-port.js';
import { systemClock } from '../core/ports/runtime.js';
import { rowsOn } from '../../trust/core/providers/rows.js';
import { TRUST_STATUS_MESSAGE, narrowStatus } from '../../trust/core/status-message.js';
import { summarize } from '../../trust/core/summary.js';
import { createTrustRecords } from '../../trust/core/trust-records.js';
import { browserTrustHost } from './trust.js';

/** @typedef {import('../../trust/core/trust-records.js').TrustRecords} TrustRecords */
/** @typedef {import('../../trust/core/status-message.js').TrustStatus} TrustStatus */
/** @typedef {import('../../trust/core/ports.js').Clock} Clock */
/** @typedef {import('../../trust/core/ports.js').TrustStore} TrustStore */

export { TRUST_STATUS_MESSAGE };

/** The rows the worker summarizes with: the new tab's, the only host's that lists the coordinator */
export const STATUS_ROWS = rowsOn('workspace');

/** The pages the status read answers, by #13's names for them */
export const STATUS_PAGES = Object.freeze(['newtab', 'popup', 'sidepanel']);

/** What a sender that isn't one of them hears, as the worker's network answers another's */
const REFUSED = Object.freeze({ error: 'request-refused' });

/** What an ask that couldn't read the records hears */
const UNAVAILABLE = Object.freeze({ error: 'unavailable' });

/**
 * The worker's handler for the status read. It keeps one store for the worker's life,
 * NewTabNoteTrust read only, whose one connection every ask waits on, and builds the records over
 * it at each ask, so each ask has its own open state: two asks that overlap a cold open both wait
 * for it, and an ask after one whose open failed opens the store again, so no failed open holds a
 * later ask blind. `store` makes the store and `records` builds the records over it,
 * NewTabNoteTrust's on this browser's host unless a test passes others; `extensionId` is
 * chrome.runtime.id unless a test passes another.
 * @param {{
 *   store?: () => TrustStore,
 *   records?: (store: TrustStore) => TrustRecords,
 *   clock?: Clock,
 *   extensionId?: () => string | undefined,
 * }} [options]
 * @returns {(request: unknown, sender: unknown) => Promise<TrustStatus | {error: string}>}
 */
export function workerStatusRead({
  store: makeStore = browserStore,
  records: build = browserRecords,
  clock = systemClock,
  extensionId = () => globalThis.chrome?.runtime?.id,
} = {}) {
  /** @type {TrustStore | null} */
  let store = null;
  return async (request, sender) => {
    const page = principalOf(sender, extensionId());
    if (page === null || !STATUS_PAGES.includes(page)) return REFUSED;
    const now = clock.now();
    try {
      // The worker's store, made at the first ask, and at the next when making it threw
      if (!store) store = makeStore();
      const records = build(store);
      const receipts = await records.latestReceipts();
      const { incidents, copyRead, recordsRead } = await records.incidentsRead();
      return narrowStatus(
        summarize({
          providers: STATUS_ROWS,
          receipts,
          incidents,
          copyRead,
          recordsRead,
          // This ask's own records, never opened, so never closed by a failed write: they're
          // open to it unless its read couldn't reach their store
          recordsState: records.state() === 'fallback' ? 'fallback' : 'open',
          now,
        }),
      );
    } catch {
      return UNAVAILABLE;
    }
  };
}

/** @param {...unknown} _ */
const noWrite = async (..._) => {
  throw new Error('The status read writes nothing');
};

/**
 * NewTabNoteTrust on this browser's host (composition/trust.js), read only: it makes no database
 * and takes no write, and holds the one connection the worker's asks read through
 * @returns {TrustStore}
 */
function browserStore() {
  return readOnlyTrustStore({ indexedDB: browserTrustHost().indexedDB });
}

/**
 * The records over `store`, the worker's, on this browser's host, for one ask: their settings
 * copy takes no write
 * @param {TrustStore} store
 * @returns {TrustRecords}
 */
function browserRecords(store) {
  const { settings, locks, clock, ids, timers = null } = browserTrustHost();
  return createTrustRecords({
    store,
    settings: { get: settings.get, set: noWrite },
    clock,
    ids,
    locks,
    timers,
  });
}
