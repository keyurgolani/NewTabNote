/**
 * Version history use cases and queries (#12 slice 4, Req 31): the editor's snapshots of a
 * note, and a revert to one. 1.4.x stored a snapshot, read the note's snapshots, and pruned
 * them past 50 in three transactions, and a revert took its own snapshot first, then deleted
 * the note's blocks, put the snapshot's one at a time, and put the whole note back. Here a
 * snapshot is one unit, and a revert is one unit over the snapshots, blocks, and note, with
 * only the search entry's name after it. Joining 1.4.x's transactions splits none of them.
 *
 * A database an older profile left without the `snapshots` store has no version history: a
 * write to it is refused as `store-unavailable`, and nothing else of the command commits.
 */

import { isId } from '../contracts/checks.js';
import { committed, empty, failed, ready, rejected } from '../contracts/outcomes.js';
import { inBlockOrder } from '../domain/note.js';
import {
  newestFirst,
  snapshotBlocks,
  snapshotRecord,
  snapshotSummary,
  snapshotsPastLimit,
} from '../domain/snapshot.js';
import { blockRecords, invalid, noteNotFound, noteRecord, renameSearchEntry } from './notes.js';
import { contentChanged, unitsWork } from './work.js';

/** @typedef {import('../ports/repository.js').Unit} Unit */
/** @typedef {import('../ports/repository.js').Tx} Tx */
/** @typedef {import('../domain/snapshot.js').SnapshotRecord} SnapshotRecord */

/**
 * @template {import('../contracts/commands.js').CommandType} T
 * @typedef {import('./work.js').CommandHandler<T>} CommandHandler
 */

/**
 * @template {import('../contracts/queries.js').QueryType} T
 * @typedef {import('./work.js').QueryHandler<T>} QueryHandler
 */

const snapshotExists = () => rejected('validation', 'snapshot-exists');

/**
 * Store `snapshot` and delete the note's snapshots past the newest 50, in `tx`. The note's
 * snapshots are read before the put, so no adapter has to read back its own write.
 * @param {Tx} tx
 * @param {SnapshotRecord} snapshot
 * @returns {Promise<import('../contracts/outcomes.js').Rejected | undefined>}
 */
async function keepSnapshot(tx, snapshot) {
  if (await tx.get('snapshots', snapshot.id)) return snapshotExists();
  const kept = await tx.getAllByIndex('snapshots', 'noteId', snapshot.noteId);
  tx.put('snapshots', snapshot);
  for (const id of snapshotsPastLimit([...kept, snapshot])) tx.delete('snapshots', id);
  return undefined;
}

/**
 * @param {unknown} value
 * @returns {value is string | undefined}
 */
const isOptionalString = value => value === undefined || typeof value === 'string';

/** @type {{saveSnapshot: CommandHandler<'saveSnapshot'>, restoreSnapshot: CommandHandler<'restoreSnapshot'>}} */
export const snapshotCommands = {
  saveSnapshot(command, { clock }) {
    const { noteId, snapshotId, blocks, title } = command;
    if (!isId(noteId) || !isId(snapshotId) || typeof title !== 'string' || !Array.isArray(blocks)) return invalid();
    const now = clock.now();
    /** @type {Unit} */
    const save = {
      stores: ['notes', 'snapshots'],
      async run(tx) {
        // A note deleted since the editor took the copy gets no snapshot
        if (!(await tx.get('notes', noteId))) return noteNotFound();
        return keepSnapshot(tx, snapshotRecord({ id: snapshotId, noteId, timestamp: now, blocks, title }));
      },
    };
    // A snapshot changes no note, so it moves no revision and a note list ignores it
    return unitsWork(command, [save], () => committed('snapshot-saved', [snapshotId]));
  },

  restoreSnapshot(command, { clock }) {
    const { noteId, snapshotId, preSnapshotId, blocks, name } = command;
    if (!isId(noteId) || !isId(snapshotId) || !isId(preSnapshotId) || !isOptionalString(name)) return invalid();
    if (preSnapshotId === snapshotId) return invalid();
    const records = blockRecords(blocks, noteId);
    if (!Array.isArray(records)) return records;
    const now = clock.now();
    /** @type {Unit} */
    const restore = {
      stores: ['notes', 'blocks', 'snapshots'],
      async run(tx) {
        const note = await tx.get('notes', noteId);
        if (!note) return noteNotFound();
        const snapshot = await tx.get('snapshots', snapshotId);
        if (!snapshot) return rejected('not-found', 'snapshot-not-found');
        if (snapshot.noteId !== noteId) return rejected('validation', 'snapshot-of-another-note');
        // The note as stored now, the editor's last save included, becomes a snapshot first, as
        // 1.4.x took one before it reverted
        const stored = inBlockOrder(await tx.getAllByIndex('blocks', 'canvasId', noteId));
        const title = typeof note.name === 'string' && note.name ? note.name : 'Untitled';
        const pre = snapshotRecord({ id: preSnapshotId, noteId, timestamp: now, blocks: snapshotBlocks(stored), title });
        const refused = await keepSnapshot(tx, pre);
        if (refused) return refused;
        // The snapshot's blocks replace the note's, in its order
        const restoring = new Set(records.map(block => block.id));
        for (const block of stored) if (!restoring.has(block.id)) tx.delete('blocks', block.id);
        records.forEach((block, order) => tx.put('blocks', { ...block, order }));
        // Its title, and no other note field: a pin, folder, trash, or hand-set title stays
        tx.put('notes', name === undefined ? { ...note, updatedAt: now } : { ...note, name, updatedAt: now });
        return undefined;
      },
    };
    /** @type {Unit[]} */
    const units = [restore];
    if (name !== undefined) units.push(renameSearchEntry(noteId, name, now));
    return unitsWork(command, units, () => committed('snapshot-restored', [noteId]), {
      primary: noteRecord(noteId),
      revised: contentChanged,
    });
  },
};

/** @type {{listSnapshots: QueryHandler<'listSnapshots'>, getSnapshot: QueryHandler<'getSnapshot'>}} */
export const snapshotQueries = {
  async listSnapshots({ noteId }, { adapter, clock }) {
    if (!isId(noteId)) return failed('validation', 'invalid-query');
    const snapshots = await adapter.read(['snapshots'], tx => tx.getAllByIndex('snapshots', 'noteId', noteId));
    return snapshots.length > 0 ? ready(clock.now(), newestFirst(snapshots).map(snapshotSummary)) : empty(clock.now());
  },

  async getSnapshot({ snapshotId }, { adapter, clock }) {
    if (!isId(snapshotId)) return failed('validation', 'invalid-query');
    const snapshot = await adapter.read(['snapshots'], tx => tx.get('snapshots', snapshotId));
    return snapshot ? ready(clock.now(), /** @type {SnapshotRecord} */ (snapshot)) : empty(clock.now());
  },
};
