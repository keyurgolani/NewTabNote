/**
 * A pre-migration recovery point as the file 1.4.1's Import reads (#17, "Recovery points"), so
 * a user can always go back to 1.4.1: `{version: 1, exportedAt, canvases, elements, media,
 * folders}`, the shape 1.4.1's exportAll writes and its Storage.importData takes. #17 PR 1b
 * puts it behind Settings > Data & Backup (Q8); nothing calls it yet.
 *
 * - `canvases`: every note 1.4.1's own export holds, which is every note outside trash,
 *   archived notes and templates included, with every field as the point copied it
 * - `elements`: the blocks of those notes, and `orphanElements` every other block, since
 *   1.4.1's import refuses a file with a block whose note isn't in it and ignores keys it
 *   doesn't know. A trashed note's blocks are there too, and the trashed notes themselves are
 *   under `trashedCanvases`, which 1.4.1 ignores as well, so the file loses nothing (#18 reads
 *   both).
 * - `media`: every media row, each Blob as a data URL; 1.4.1 skips a row whose note isn't in
 *   the file, as it does for 1.4.0's exports
 * - `folders`: every folder
 * Blobs anywhere else become data URLs too (recovery.js), so the file is plain JSON.
 *
 * It exports only a point that is verified and reads back verified now, so a damaged copy is
 * never handed out as a backup. #17 PR 3 writes placement, `kind`, `lifecycle`, and `dailyKey`
 * back as the legacy fields here, once points can hold them.
 */

import { UnavailableError } from '../../core/contracts/outcomes.js';
import { withDataUrls } from './recovery.js';
import { DEFAULT_LIMITS, listPoints, openRecovery, readPointStore, verifyPoint } from './recovery-points.js';

/** @typedef {import('./recovery-points.js').Point} Point */
/** @typedef {import('./records.js').Digester} Digester */
/** @typedef {import('../../core/ports/runtime.js').Clock} Clock */

/**
 * @typedef {object} LegacyExport
 * @property {1} version
 * @property {number} exportedAt
 * @property {object[]} canvases
 * @property {object[]} elements
 * @property {object[]} media
 * @property {object[]} folders
 * @property {object[]} orphanElements
 * @property {object[]} trashedCanvases
 */

/**
 * Every value a point holds for `store`, Blobs as data URLs, or none when it didn't copy it
 * @param {IDBDatabase} recovery
 * @param {Point} point
 * @param {string} store
 * @param {import('./recovery-points.js').Io} io
 * @returns {Promise<any[]>}
 */
async function valuesOf(recovery, point, store, io) {
  if (!point.stores.includes(store)) return [];
  const values = [];
  for (const { value } of await readPointStore(recovery, point, store, io)) values.push(await withDataUrls(value));
  return values;
}

/**
 * The export of point `pointId`. Rejects with an UnavailableError, `storage`, when there's no
 * such pre-migration point (`no-recovery-point`) or it doesn't verify
 * (`recovery-point-unverified`).
 * @param {{indexedDB: IDBFactory, keyRange: typeof IDBKeyRange, crypto: Digester, clock: Clock, pointId: string}} options
 * @returns {Promise<LegacyExport>}
 */
export async function exportPoint({ indexedDB, keyRange, crypto, clock, pointId }) {
  const recovery = await openRecovery(indexedDB, { create: false });
  if (!recovery) throw new UnavailableError('storage', 'no-recovery-point', false);
  try {
    const io = { keyRange, crypto, limits: DEFAULT_LIMITS };
    const point = (await listPoints(recovery)).find(candidate => candidate.id === pointId);
    if (!point || point.kind !== 'pre-migration' || point.status !== 'verified') {
      throw new UnavailableError('storage', 'no-recovery-point', false);
    }
    const verdict = await verifyPoint({ recovery, point, io });
    if (!verdict.ok) throw new UnavailableError('storage', 'recovery-point-unverified', false);

    const notes = await valuesOf(recovery, point, 'canvases', io);
    const canvases = notes.filter(note => !note.trashed);
    const trashedCanvases = notes.filter(note => note.trashed);
    const exported = new Set(canvases.map(note => note.id));
    const blocks = await valuesOf(recovery, point, 'elements', io);
    return {
      version: 1,
      exportedAt: clock.now(),
      // Key name 'canvases' kept, as 1.4.1 reads it
      canvases,
      elements: blocks.filter(block => exported.has(block.canvasId)),
      media: await valuesOf(recovery, point, 'media', io),
      folders: await valuesOf(recovery, point, 'folders', io),
      orphanElements: blocks.filter(block => !exported.has(block.canvasId)),
      trashedCanvases,
    };
  } finally {
    recovery.close();
  }
}

/**
 * The newest verified pre-migration point's id, the pinned one first, or null
 * @param {{indexedDB: IDBFactory}} options
 * @returns {Promise<string | null>}
 */
export async function exportablePoint({ indexedDB }) {
  const recovery = await openRecovery(indexedDB, { create: false });
  if (!recovery) return null;
  try {
    const points = (await listPoints(recovery)).filter(
      point => point.kind === 'pre-migration' && point.status === 'verified',
    );
    const pinned = points.filter(point => point.pinned).pop();
    return (pinned || points.pop() || { id: null }).id;
  } finally {
    recovery.close();
  }
}
