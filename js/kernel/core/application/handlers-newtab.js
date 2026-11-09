/**
 * The new tab's table (handlers.js), since its writes go to the worker (#35 slice 4d): every query
 * the catalog allows on the new tab, which it runs in the page on #17's read-only reader, and its
 * workspace session's write, the one command that commits in the page (rule 2), since the list names
 * #17's session-state keys in-context (docs/architecture/committers.json). Every other command goes
 * to the worker over #13's port, through the send chunk (composition/newtab-send-chunk.js), and runs
 * there on the worker's page table (handlers-worker.js), so the new tab's start holds none of their
 * handlers. Its startup maintenance is the worker's now (rule 8), and the close-time drafts' apply
 * sends applyCloseDraft to the worker, as Popup's and Side Panel's do.
 */

import { folderQueries } from './folders.js';
import { forSurface, handlerTable } from './handlers.js';
import { indexQueries } from './indexing.js';
import { jobQueries } from './jobs.js';
import { noteQueries } from './notes.js';
import { preferenceQueries } from './preferences.js';
import { sessionCommands, sessionQueries } from './session.js';
import { snapshotQueries } from './snapshots.js';
import { workspaceDataQueries } from './workspace-data.js';

/** @typedef {import('./handlers.js').HandlerTable} HandlerTable */

/**
 * Every handler the new tab's start holds: its queries, and its session's write
 * @type {HandlerTable}
 */
export const CONTEXT_HANDLERS = handlerTable({
  commands: { ...sessionCommands },
  queries: {
    ...noteQueries,
    ...folderQueries,
    ...preferenceQueries,
    ...sessionQueries,
    ...jobQueries,
    ...snapshotQueries,
    ...workspaceDataQueries,
    ...indexQueries,
  },
});

/** The new tab's: every query the catalog allows on the new tab, and its session's write */
export const NEWTAB_HANDLERS = forSurface(CONTEXT_HANDLERS, 'newtab');
