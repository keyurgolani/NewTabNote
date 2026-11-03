/**
 * Every handler the catalog has (handlers.js), which tests build their kernels on, so the
 * policy alone decides what a test's caller may send, as it did before each page had its table
 * (#17 PR 4b): the new tab's and its storage maintenance's (handlers-newtab.js), and the service
 * worker's journal drain's own (journal.js, #35 slice 3). No page imports this module, so no
 * page's start loads the drain's handlers. The new tab's table comes from handlers-newtab.js,
 * and is here too for the tests that read it.
 */

import { CONTEXT_HANDLERS, NEWTAB_HANDLERS } from './handlers-newtab.js';
import { handlerTable } from './handlers.js';
import { journalCommands, journalQueries } from './journal.js';

/** @typedef {import('./handlers.js').HandlerTable} HandlerTable */

/** @type {HandlerTable} */
export const ALL_HANDLERS = handlerTable({
  commands: { ...CONTEXT_HANDLERS.commands, ...journalCommands },
  queries: { ...CONTEXT_HANDLERS.queries, ...journalQueries },
  refusals: CONTEXT_HANDLERS.refusals,
});

export { NEWTAB_HANDLERS };
