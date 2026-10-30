/**
 * Version history (Req 31): copies of a note's blocks and title, as IndexedDB's `snapshots`
 * store has held them since 1.4.0. Storage.saveSnapshot wrote each one and kept the newest 50
 * of a note's.
 */

/** @typedef {import('./note.js').BlockRecord} BlockRecord */

/**
 * A snapshot, as Storage.saveSnapshot has stored it: `blocks` are the blocks as the editor
 * serializes them, with no note or position of their own.
 * @typedef {{id: string, noteId: string, timestamp: number, blocks: unknown[], title: string}
 *   & Record<string, unknown>} SnapshotRecord
 */

/** A snapshot list entry: what the version history panel shows of each */
/** @typedef {{id: string, timestamp: number, title: string}} SnapshotSummary */

/** How many snapshots of a note are kept, as Storage.saveSnapshot pruned them */
export const SNAPSHOT_LIMIT = 50;

/**
 * @param {{id: string, noteId: string, timestamp: number, blocks: unknown[], title: string}} fields
 * @returns {SnapshotRecord}
 */
export function snapshotRecord({ id, noteId, timestamp, blocks, title }) {
  return { id, noteId, timestamp, blocks, title };
}

/**
 * A note's stored blocks as a snapshot holds them: without the note they're in and their
 * place, which a block the editor serializes doesn't carry either
 * @param {BlockRecord[]} blocks - in note order
 * @returns {Array<Record<string, unknown>>}
 */
export function snapshotBlocks(blocks) {
  return blocks.map(({ canvasId, order, ...block }) => block);
}

/**
 * @param {unknown} value
 * @returns {number}
 */
const timeOf = value => (typeof value === 'number' && !Number.isNaN(value) ? value : 0);

/**
 * A note's snapshots newest first, as Storage.getSnapshots lists them: by time, and in key
 * order for one time
 * @template {{id: string, timestamp?: unknown}} S
 * @param {S[]} snapshots
 * @returns {S[]}
 */
export function newestFirst(snapshots) {
  return [...snapshots].sort((a, b) => timeOf(b.timestamp) - timeOf(a.timestamp) || (a.id < b.id ? -1 : 1));
}

/**
 * The ids of the snapshots past the newest SNAPSHOT_LIMIT, which Storage.pruneSnapshots deleted
 * @param {Array<{id: string, timestamp?: unknown}>} snapshots - every snapshot of one note
 * @returns {string[]}
 */
export function snapshotsPastLimit(snapshots) {
  return newestFirst(snapshots)
    .slice(SNAPSHOT_LIMIT)
    .map(snapshot => snapshot.id);
}

/**
 * @param {{id: string, timestamp?: unknown, title?: unknown}} snapshot
 * @returns {SnapshotSummary}
 */
export function snapshotSummary({ id, timestamp, title }) {
  return { id, timestamp: timeOf(timestamp), title: typeof title === 'string' ? title : '' };
}
