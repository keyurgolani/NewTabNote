/**
 * The service worker's own storage tasks on #17's adapter (adapter.js, `workerTasks`, #35 slice
 * 3c): the read-only integrity check after an install or an update (integrity.js, #35 slice 1),
 * and the ledger's retention at its start (ledger-sweep.js, #17 PR 2a). Only the worker's root
 * passes them (composition/background.js), so no page's start holds their code. An adapter
 * without them refuses a check as `integrity-check-needs-worker` and a sweep as
 * `ledger-sweep-needs-worker`.
 */

import { checkIntegrity } from './integrity.js';
import { sweepLedger } from './ledger-sweep.js';

/**
 * @typedef {object} WorkerTasks
 * @property {(database: () => IDBDatabase, log?: import('./integrity.js').IntegrityLog) => Promise<void>} checkIntegrity
 * @property {typeof sweepLedger} sweepLedger
 */

/** @type {WorkerTasks} */
export const WORKER_TASKS = Object.freeze({ checkIntegrity, sweepLedger });
