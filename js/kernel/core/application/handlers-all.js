/**
 * Every handler the catalog has (handlers.js), and the new tab's table, the part of it the
 * catalog allows there: the new tab sends nearly every command and query. Tests build their
 * kernels on ALL_HANDLERS, so the policy alone decides what a test's caller may send, as it
 * did before each page had its table (#17 PR 4b).
 */

import { folderCommands, folderQueries } from './folders.js';
import { forSurface, handlerTable } from './handlers.js';
import { indexCommands, indexQueries } from './indexing.js';
import { jobCommands, jobQueries } from './jobs.js';
import { maintenanceCommands } from './maintenance.js';
import { bulkRefusal, noteCommands, noteQueries } from './notes.js';
import { preferenceCommands, preferenceQueries } from './preferences.js';
import { remoteChangesRefusal, remoteCommands } from './remote.js';
import { sessionCommands, sessionQueries } from './session.js';
import { snapshotCommands, snapshotQueries } from './snapshots.js';
import { workspaceDataCommands, workspaceDataQueries } from './workspace-data.js';

/** @typedef {import('./handlers.js').HandlerTable} HandlerTable */

/** @type {HandlerTable} */
export const ALL_HANDLERS = handlerTable({
  commands: {
    ...noteCommands,
    ...folderCommands,
    ...preferenceCommands,
    ...sessionCommands,
    ...maintenanceCommands,
    ...jobCommands,
    ...snapshotCommands,
    ...workspaceDataCommands,
    ...indexCommands,
    ...remoteCommands,
  },
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
  refusals: { runBulkAction: bulkRefusal, applyRemoteChanges: remoteChangesRefusal },
});

/** The new tab's: every handler the catalog allows on the new tab */
export const NEWTAB_HANDLERS = forSurface(ALL_HANDLERS, 'newtab');
