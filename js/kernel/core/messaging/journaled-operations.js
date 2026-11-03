/**
 * The journaled commands as operations (#35 slice 3): each catalog entry marked `journaled`,
 * with the schemas its module exports, which the coordinator's drain upcasts a journal entry
 * against (contracts/upcast.js) before it replays it. An MV3 worker can't import() a module, so
 * the worker imports these four statically (messaging/operations.js). test/kernel/catalog.test.mjs
 * holds the list to the catalog's.
 */

import { COMMANDS } from '../contracts/commands.js';
import * as captureToDailyNote from '../contracts/operations/capture-to-daily-note.js';
import * as createNote from '../contracts/operations/create-note.js';
import * as insertBlocks from '../contracts/operations/insert-blocks.js';
import * as saveNoteContent from '../contracts/operations/save-note-content.js';
import { createLookup, operationOf } from './operations.js';

/** @typedef {import('../contracts/validate.js').Operation} Operation */
/** @typedef {import('./operations.js').Lookup} Lookup */

/** @type {Readonly<Record<string, Operation>>} */
export const JOURNALED_OPERATIONS = Object.freeze({
  createNote: operationOf(COMMANDS.createNote, createNote),
  saveNoteContent: operationOf(COMMANDS.saveNoteContent, saveNoteContent),
  insertBlocks: operationOf(COMMANDS.insertBlocks, insertBlocks),
  captureToDailyNote: operationOf(COMMANDS.captureToDailyNote, captureToDailyNote),
});

/** @type {Lookup} */
export const journaledLookup = createLookup(JOURNALED_OPERATIONS);
