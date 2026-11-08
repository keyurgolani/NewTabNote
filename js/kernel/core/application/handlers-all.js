/**
 * Every handler the catalog has (handlers.js), which tests build their kernels on, so the
 * policy alone decides what a test's caller may send, as it did before each page had its table
 * (#17 PR 4b): the new tab's and its storage maintenance's (handlers-newtab.js), each command a page
 * sends the worker as the worker runs it (handlers-worker.js, #35 slice 4d), and the service
 * worker's own: its capture (capture.js), its journal drain's (journal.js, #35 slice 3), the
 * records' catch-up (record-catch-up.js) and the integrity check's command (integrity-check.js,
 * #35 slice 3c). It runs on the worker's catalog, the shared one composed with the worker's part
 * (contracts/worker-catalog.js), which holds every command and query. No page imports this
 * module, so no page's start loads the worker's handlers. The new tab's table comes from
 * handlers-newtab.js, and is here too for the tests that read it.
 */

import { WORKER_CATALOG } from '../contracts/worker-catalog.js';
import { captureCommands } from './capture.js';
import { CONTEXT_HANDLERS, NEWTAB_HANDLERS } from './handlers-newtab.js';
import { WORKER_PAGE_HANDLERS } from './handlers-worker.js';
import { handlerTable } from './handlers.js';
import { integrityCommands } from './integrity-check.js';
import { journalCommands, journalQueries } from './journal.js';
import { recordCatchUpCommands } from './record-catch-up.js';

/** @typedef {import('./handlers.js').HandlerTable} HandlerTable */

/** @type {HandlerTable} */
export const ALL_HANDLERS = handlerTable(
  {
    commands: {
      ...CONTEXT_HANDLERS.commands,
      ...WORKER_PAGE_HANDLERS.commands,
      ...integrityCommands,
      ...recordCatchUpCommands,
      ...captureCommands,
      ...journalCommands,
    },
    queries: { ...CONTEXT_HANDLERS.queries, ...journalQueries },
    refusals: CONTEXT_HANDLERS.refusals,
  },
  WORKER_CATALOG,
);

export { NEWTAB_HANDLERS };
