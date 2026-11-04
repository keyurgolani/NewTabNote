/**
 * The service worker's part of the catalog (#35 slice 3, the lead's split for #182): what only
 * the worker runs, and its grant on the shared commands it runs too. Composed with the shared
 * catalog (commands.js, queries.js), it's the catalog the worker's root builds its kernel,
 * policy and adapter on (composition/background.js). No page's start loads this module, so a
 * page's start carries nothing only the worker runs, and a page's policy, built on the shared
 * catalog alone, refuses everything here before any handler.
 *
 * The worker's part only adds `worker-internal`: its own entries name that surface alone, and a
 * grant adds it to a shared entry and changes nothing else of it. No type is in both parts. The
 * router stays on the shared catalog, so no port sender reaches what's here once slice 4 serves
 * commands over the port.
 */

import { COMMANDS, JOURNALED, commandEntry } from './commands.js';
import { MAINTENANCE_DEADLINE_MS, MAX_MESSAGE_BYTES } from './limits.js';
import { QUERIES, queryEntry } from './queries.js';

/** @typedef {import('./commands.js').CommandEntry} CommandEntry */
/** @typedef {import('./commands.js').CommandType} CommandType */
/** @typedef {import('./commands.js').WorkerOnlyCommandType} WorkerOnlyCommandType */
/** @typedef {import('./queries.js').QueryEntry} QueryEntry */
/** @typedef {import('./queries.js').QueryType} QueryType */
/** @typedef {import('./surfaces.js').Surface} Surface */

/** The worker's own surface, the one surface this part names, as a new list for each entry */
const worker = () => /** @type {Surface[]} */ (['worker-internal']);

/**
 * The commands only the worker runs
 * @type {Readonly<Record<WorkerOnlyCommandType, CommandEntry>>}
 */
export const WORKER_ONLY_COMMANDS = Object.freeze({
  // A page, or selected text and the page it came from, added to a Daily Note from the context
  // menu or the keyboard command (js/background.js), journaled first (#35 slice 3)
  captureToDailyNote: commandEntry('capture-to-daily-note', 'note', worker(), {
    entityTypes: ['note', 'block'],
    ...JOURNALED,
  }),
  // The read-only integrity check after an install or an update (#35)
  runIntegrityCheck: commandEntry('run-integrity-check', 'system', worker(), {
    entityTypes: [],
    deadlineMs: MAINTENANCE_DEADLINE_MS,
  }),
  // The one-time catch-up of 1.4.x's lagging records after the update, in batches (#33)
  catchUpNoteRecords: commandEntry('catch-up-note-records', 'note', worker(), { entityTypes: ['note'] }),
  // A journal entry the drain can't replay as written, kept as a conflict record (#35 slice 3)
  keepJournalEntry: commandEntry('keep-journal-entry', 'note', worker(), {
    entityTypes: ['note'],
    maxBytes: MAX_MESSAGE_BYTES,
  }),
});

/**
 * The query only the worker reads: which of the notes the journal's entries name were deleted
 * for good, which the drain reads before it replays any (#35 slice 3). A journal can name as
 * many notes as the user had open.
 * @type {Readonly<Record<'findTombstones', QueryEntry>>}
 */
export const WORKER_ONLY_QUERIES = Object.freeze({
  findTombstones: queryEntry('find-tombstones', ['note'], Object.freeze(worker()), MAX_MESSAGE_BYTES),
});

/**
 * The shared commands the worker runs too, by type, and why
 * @type {Readonly<Partial<Record<CommandType, string>>>}
 */
export const WORKER_GRANTS = Object.freeze({
  runStartupMaintenance: 'the maintenance its kernel runs as it opens',
  createNote: "a page's note creation, which its drain replays as the page sent it",
  insertBlocks: "a page's append, which its drain replays as the page sent it",
});

/**
 * `entry` with the worker's surface added, and nothing else of it changed
 * @param {CommandEntry} entry
 * @returns {CommandEntry}
 */
const granted = entry =>
  Object.freeze({
    ...entry,
    surfaces: Object.freeze([...entry.surfaces, .../** @type {Surface[]} */ (['worker-internal'])]),
  });

/**
 * The worker's commands: the shared catalog's, with its grants, and its own
 * @type {Readonly<Record<CommandType, CommandEntry>>}
 */
export const WORKER_COMMANDS = Object.freeze(
  /** @type {Record<CommandType, CommandEntry>} */ ({
    ...Object.fromEntries(
      Object.entries(COMMANDS).map(([type, entry]) => [
        type,
        Object.hasOwn(WORKER_GRANTS, type) ? granted(entry) : entry,
      ]),
    ),
    ...WORKER_ONLY_COMMANDS,
  }),
);

/**
 * The worker's queries: the shared catalog's, and its own
 * @type {Readonly<Record<QueryType, QueryEntry>>}
 */
export const WORKER_QUERIES = Object.freeze({ ...QUERIES, ...WORKER_ONLY_QUERIES });

/** @type {readonly CommandType[]} */
export const WORKER_COMMAND_TYPES = Object.freeze(/** @type {CommandType[]} */ (Object.keys(WORKER_COMMANDS)));

/** @type {readonly QueryType[]} */
export const WORKER_QUERY_TYPES = Object.freeze(/** @type {QueryType[]} */ (Object.keys(WORKER_QUERIES)));

/**
 * The worker's catalog, which its root's kernel, policy and adapter run on
 * @type {import('./commands.js').Catalog}
 */
export const WORKER_CATALOG = Object.freeze({ commands: WORKER_COMMANDS, queries: WORKER_QUERIES });
