/**
 * The journaled commands the service worker's drain replays, as operations (#35 slice 3): each
 * entry the worker's catalog marks `journaled` (contracts/worker-catalog.js), with the schemas
 * its module exports, which the drain upcasts a journal entry against (contracts/upcast.js)
 * before it replays it. A journaled editor save isn't here: the pages replay it, as a
 * close-time draft by #33's rules (slice 3b, the lead's call on #182). An MV3 worker can't
 * import() a module, so the worker imports these three statically (messaging/operations.js).
 * test/kernel/catalog.test.mjs holds the list to the catalog's.
 */

import * as captureToDailyNote from '../contracts/operations/capture-to-daily-note.js';
import * as createNote from '../contracts/operations/create-note.js';
import * as insertBlocks from '../contracts/operations/insert-blocks.js';
import { WORKER_COMMANDS } from '../contracts/worker-catalog.js';
import { createLookup, operationOf } from './operations.js';

/** @typedef {import('../contracts/validate.js').Operation} Operation */
/** @typedef {import('./operations.js').Lookup} Lookup */

/** @type {Readonly<Record<string, Operation>>} */
export const JOURNALED_OPERATIONS = Object.freeze({
  createNote: operationOf(WORKER_COMMANDS.createNote, createNote),
  insertBlocks: operationOf(WORKER_COMMANDS.insertBlocks, insertBlocks),
  captureToDailyNote: operationOf(WORKER_COMMANDS.captureToDailyNote, captureToDailyNote),
});

/** @type {Lookup} */
export const journaledLookup = createLookup(JOURNALED_OPERATIONS);
