/**
 * A pre-migration recovery point as the file 1.4.1's Import reads (#17, "Recovery points"), so
 * a user can always go back to 1.4.1: `{version: 1, exportedAt, canvases, elements, media,
 * folders}`, the shape 1.4.1's exportAll writes and its Storage.importData takes. Settings >
 * Data & Backup's Export Pre-Update Copy runs it (Q8), through the new tab's composition root.
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
 * Blobs anywhere else become data URLs too, so the file is plain JSON.
 *
 * It exports only a point that is verified and reads back verified now, so a damaged copy is
 * never handed out as a backup. It reads the point across many transactions, so it holds Web
 * Lock `storage.migrate` shared while it does (#17 PR 2b): the worker's purge and migration
 * runner hold it exclusive, so the export never reads a point between two of their batches,
 * and a note deleted for good is either all there, before its purge, or not there at all.
 * #17 PR 3 writes placement, `kind`, `lifecycle`, and `dailyKey` back as the legacy fields
 * here, once points can hold them.
 */

import { UnavailableError } from '../../core/contracts/outcomes.js';
import {
  DEFAULT_LIMITS,
  POINTS_LOCK,
  listPoints,
  openRecovery,
  readPointStore,
  verifyPoint,
} from './recovery-points.js';

/** How deep a value is searched for a Blob, as Storage searches it */
const MAX_DEPTH = 32;

/**
 * Whether `value` holds a Blob anywhere within MAX_DEPTH levels
 * @param {unknown} value
 * @param {number} depth
 * @returns {boolean}
 */
function hasBlob(value, depth) {
  if (value instanceof Blob) return true;
  if (!value || typeof value !== 'object' || depth > MAX_DEPTH || ArrayBuffer.isView(value)) return false;
  const items = Array.isArray(value) ? value : Object.values(value);
  return items.some(item => hasBlob(item, depth + 1));
}

/**
 * A Blob as the data URL FileReader.readAsDataURL gives for it
 * @param {Blob} blob
 * @returns {Promise<string>}
 */
async function dataUrl(blob) {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = '';
  // In pieces, so a large image can't overflow the call stack
  for (let start = 0; start < bytes.length; start += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(start, start + 0x8000));
  }
  return `data:${blob.type || 'application/octet-stream'};base64,${btoa(binary)}`;
}

/**
 * A copy of a stored value with each Blob in it as a data URL
 * @param {unknown} value
 * @returns {Promise<unknown>}
 */
async function withDataUrls(value) {
  if (value instanceof Blob) return dataUrl(value);
  if (!hasBlob(value, 0)) return value;
  if (Array.isArray(value)) {
    const out = [];
    for (const item of value) out.push(await withDataUrls(item));
    return out;
  }
  /** @type {Record<string, unknown>} */
  const out = {};
  for (const [key, item] of Object.entries(/** @type {Record<string, unknown>} */ (value))) {
    out[key] = await withDataUrls(item);
  }
  return out;
}

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
 * Web Locks, or anything with its request(name, options, callback)
 * @typedef {{request: (name: string, options: {mode: 'shared'}, callback: () => Promise<any>) => Promise<any>}} SharedLocks
 */

/**
 * The export of point `pointId`, read under `locks`' points lock, shared, when there are
 * locks. Rejects with an UnavailableError, `storage`, when there's no such pre-migration point
 * (`no-recovery-point`) or it doesn't verify (`recovery-point-unverified`).
 * @param {{indexedDB: IDBFactory, keyRange: typeof IDBKeyRange, crypto: Digester, clock: Clock, pointId: string, locks?: SharedLocks | null}} options
 * @returns {Promise<LegacyExport>}
 */
export function exportPoint(options) {
  const { locks } = options;
  if (locks && typeof locks.request === 'function') {
    return locks.request(POINTS_LOCK, { mode: 'shared' }, () => exportUnlocked(options));
  }
  return exportUnlocked(options);
}

/**
 * exportPoint's read, under whatever lock its caller holds
 * @param {{indexedDB: IDBFactory, keyRange: typeof IDBKeyRange, crypto: Digester, clock: Clock, pointId: string}} options
 * @returns {Promise<LegacyExport>}
 */
async function exportUnlocked({ indexedDB, keyRange, crypto, clock, pointId }) {
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
  const point = await exportablePointRecord({ indexedDB });
  return point ? point.id : null;
}

/**
 * The newest verified pre-migration point, the pinned one first, as its record (ids, versions,
 * times, and hashes, never content), or null. Settings > Data & Backup shows its `createdAt`.
 * Makes no recovery database on a profile without one.
 * @param {{indexedDB: IDBFactory}} options
 * @returns {Promise<Point | null>}
 */
export async function exportablePointRecord({ indexedDB }) {
  const recovery = await openRecovery(indexedDB, { create: false });
  if (!recovery) return null;
  try {
    const points = (await listPoints(recovery)).filter(
      point => point.kind === 'pre-migration' && point.status === 'verified',
    );
    const pinned = points.filter(point => point.pinned).pop();
    return pinned || points.pop() || null;
  } finally {
    recovery.close();
  }
}
