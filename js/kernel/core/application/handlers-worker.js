/**
 * The service worker's table (handlers.js), on the worker's catalog (contracts/worker-catalog.js):
 * its capture (js/background.js, capture.js), the integrity check its coordinator runs after an
 * install or an update (composition/coordinator.js), the startup maintenance its kernel runs as
 * it opens, the one-time catch-up of 1.4.x's lagging records after the update
 * (composition/background.js, #33), and its journal drain (application/journal-drain.js, #35
 * slice 3): the journaled commands it replays, the tombstones it reads first, and the conflict
 * record it keeps of an entry it can't replay. A journaled editor save is the pages' to replay,
 * as a close-time draft by #33's rules (slice 3b, the lead's call on #182). What pages send over the
 * port runs here too, on their kernels' table below: the new tab's commands (#35 slice 4d), and
 * Popup's and Side Panel's own applies of a close-time draft, so the worker loads the applier, as
 * #35 slice 4b-2's rule 6 has it in place of #182's ruling for the worker.
 */

import { WORKER_CATALOG } from '../contracts/worker-catalog.js';
import { captureCommands } from './capture.js';
import { closeDraftCommands } from './close-drafts.js';
import { folderCommands } from './folders.js';
import { handlerTable } from './handlers.js';
import { indexCommands } from './indexing.js';
import { integrityCommands } from './integrity-check.js';
import { jobCommands } from './jobs.js';
import { journalCommands, journalQueries } from './journal.js';
import { maintenanceCommands } from './maintenance.js';
import { bulkRefusal, noteCommands } from './notes.js';
import { preferenceCommands } from './preferences.js';
import { recordCatchUpCommands } from './record-catch-up.js';
import { remoteChangesRefusal, remoteCommands } from './remote.js';
import { snapshotCommands } from './snapshots.js';
import { workspaceDataCommands } from './workspace-data.js';

export const WORKER_HANDLERS = handlerTable(
  {
    commands: {
      captureToDailyNote: captureCommands.captureToDailyNote,
      runStartupMaintenance: maintenanceCommands.runStartupMaintenance,
      runIntegrityCheck: integrityCommands.runIntegrityCheck,
      catchUpNoteRecords: recordCatchUpCommands.catchUpNoteRecords,
      createNote: noteCommands.createNote,
      insertBlocks: noteCommands.insertBlocks,
      keepJournalEntry: journalCommands.keepJournalEntry,
    },
    queries: {
      findTombstones: journalQueries.findTombstones,
    },
  },
  WORKER_CATALOG,
);

/**
 * What the worker runs for a page that sends over the port (#35 slice 4b-2, rules 5 and 6): every
 * command the new tab sends but its session's write, which it commits itself, and startup
 * maintenance, which the worker's own start runs (#35 slice 4d), with the two bulk commands'
 * refusals, so Popup's quick note and Popup's and Side Panel's applies of a close-time draft (#35
 * slice 4c) are among them. It's on the shared catalog, so each page's kernel in the worker allows
 * only what that page may send. The applier is imported, not loaded at its first use as a page's
 * is (close-drafts-on-demand.js), since a service worker can't import()
 */
export const WORKER_PAGE_HANDLERS = handlerTable({
  commands: {
    ...noteCommands,
    applyCloseDraft: closeDraftCommands.applyCloseDraft,
    ...folderCommands,
    ...preferenceCommands,
    ...jobCommands,
    ...snapshotCommands,
    ...workspaceDataCommands,
    ...indexCommands,
    ...remoteCommands,
  },
  refusals: { runBulkAction: bulkRefusal, applyRemoteChanges: remoteChangesRefusal },
});
