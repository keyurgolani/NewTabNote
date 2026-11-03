/**
 * The new tab's table (handlers.js): the part the catalog allows on the new tab of every handler
 * the page and its storage maintenance run, since the new tab sends nearly every command and
 * query. The close-time drafts' apply loads its handler at its first use
 * (close-drafts-on-demand.js), as on Popup and Side Panel, so the new tab's start holds none of
 * the applier (#33). The service worker's own handlers, its capture (capture.js) and its journal
 * drain's (journal.js, #35 slice 3), aren't here, so the new tab's start loads none of them
 * either: handlers-all.js adds them to the table the tests run on.
 */

import { applyCloseDraftOnDemand } from './close-drafts-on-demand.js';
import { folderCommands, folderQueries } from './folders.js';
import { forSurface, handlerTable } from './handlers.js';
import { indexCommands, indexQueries } from './indexing.js';
import { jobCommands, jobQueries } from './jobs.js';
import { maintenanceCommands } from './maintenance.js';
import { bulkRefusal, noteCommands, noteQueries } from './notes.js';
import { preferenceCommands, preferenceQueries } from './preferences.js';
import { recordCatchUpCommands } from './record-catch-up.js';
import { remoteChangesRefusal, remoteCommands } from './remote.js';
import { sessionCommands, sessionQueries } from './session.js';
import { snapshotCommands, snapshotQueries } from './snapshots.js';
import { workspaceDataCommands, workspaceDataQueries } from './workspace-data.js';

/** @typedef {import('./handlers.js').HandlerTable} HandlerTable */

/**
 * Every handler but the worker's capture and its journal drain's: what the pages, the startup
 * maintenance and the worker's catch-up run
 * @type {HandlerTable}
 */
export const CONTEXT_HANDLERS = handlerTable({
  commands: {
    ...noteCommands,
    applyCloseDraft: applyCloseDraftOnDemand,
    ...folderCommands,
    ...preferenceCommands,
    ...sessionCommands,
    ...maintenanceCommands,
    ...recordCatchUpCommands,
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
export const NEWTAB_HANDLERS = forSurface(CONTEXT_HANDLERS, 'newtab');
