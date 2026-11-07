/**
 * A measurement for #20 slice 4c, not for merging: the chunk the new tab's status line would load
 * at idle after interaction-ready, with no view and no words. It opens NewTabNoteTrust's records,
 * reads them, summarizes them with the rows of the providers that run on the new tab, and holds
 * the records and the summary, as a status line that reads again when the tab is shown again
 * would, so CI's perf job reads the new tab's heap with it.
 */

import { systemClock } from '../core/ports/runtime.js';
import { createTrustDatabase } from '../adapters/indexeddb/trust.js';
import { PROVIDER_ROWS } from '../../trust/core/providers/rows.js';
import { summarize } from '../../trust/core/summary.js';
import { createTrustRecords } from '../../trust/core/trust-records.js';

/** @typedef {import('../../trust/core/ports.js').Locks} Locks */
/** @typedef {import('../../trust/core/operations/trust-summary.js').TrustSummary} TrustSummary */

/** The providers that run on the new tab */
const ROWS = PROVIDER_ROWS.filter(row => row.hosts.includes('workspace'));

/**
 * What the status line holds once it has read: the records, to read again, and their summary
 * @type {{records: ReturnType<typeof createTrustRecords>, summary: TrustSummary} | null}
 */
let held = null;

/**
 * Opens the records, reads them, and summarizes them, as the status line would at idle
 * @returns {Promise<TrustSummary>}
 */
export async function startTrustStatus() {
  const scope = /** @type {{navigator?: {locks?: Locks}}} */ (globalThis);
  const store = createTrustDatabase({ indexedDB: globalThis.indexedDB, keyRange: globalThis.IDBKeyRange });
  const records = createTrustRecords({
    store,
    settings: {
      get: keys => chrome.storage.local.get(keys),
      set: items => chrome.storage.local.set(items),
    },
    clock: systemClock,
    ids: { next: () => crypto.randomUUID() },
    locks: (scope.navigator && scope.navigator.locks) || null,
    timers: {
      set: (callback, ms) => setTimeout(callback, ms),
      clear: handle => clearTimeout(/** @type {ReturnType<typeof setTimeout>} */ (handle)),
    },
  });
  await records.open();
  const receipts = await records.latestReceipts();
  const { incidents, copyRead, recordsRead } = await records.incidentsRead();
  const summary = summarize({
    providers: ROWS,
    receipts,
    incidents,
    copyRead,
    recordsRead,
    recordsState: records.state(),
    now: systemClock.now(),
  });
  held = { records, summary };
  return held.summary;
}
