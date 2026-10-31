/**
 * A remediation's preview (#20, "Remediation pipeline"; approved AC4): what applying it would
 * change, as counts per target and nothing else, so a preview holds no title, no text, and no
 * key a user chose. The pipeline shows it before any class that needs a confirmation, and
 * holds the confirmation to it: a run is confirmed against the preview the user saw, and a
 * preview that changed since goes back to the user.
 *
 * Nothing deletes user-owned records on its own: a preview that deletes from a user-owned
 * target is refused for every class but `irreversible`, which needs a recovery file saved in
 * the run and the action's name typed out first, and a non-destructive or regenerable one
 * that changes a user-owned target at all is refused, since neither takes a recovery point.
 */

import * as v from '../../../lib/valibot/index.mjs';
import { count } from '../../../kernel/core/contracts/fields.js';

/**
 * What a remediation can change: CanvasTabDB's stores, the preferences in chrome.storage.local,
 * and a file the user saves
 */
export const PREVIEW_TARGETS = Object.freeze(
  /** @type {const} */ ([
    'canvases',
    'elements',
    'media',
    'folders',
    'themes',
    'snapshots',
    'settings',
    'search_index',
    'links',
    'vectors',
    'preferences',
    'file',
  ]),
);

/** @typedef {(typeof PREVIEW_TARGETS)[number]} PreviewTarget */

/**
 * The targets that hold what the user made: notes, blocks, media, folders, themes, version
 * history, and the legacy IndexedDB settings. The search index, links, and vectors are
 * derived, and a regenerable remediation may rebuild or remove them.
 * @type {readonly PreviewTarget[]}
 */
export const USER_OWNED_TARGETS = Object.freeze([
  'canvases',
  'elements',
  'media',
  'folders',
  'themes',
  'snapshots',
  'settings',
]);

export const previewSchema = v.strictObject({
  changes: v.pipe(
    v.array(
      v.strictObject({
        target: v.picklist(PREVIEW_TARGETS),
        creates: count,
        updates: count,
        deletes: count,
      }),
    ),
    v.maxLength(PREVIEW_TARGETS.length),
  ),
});

/** @typedef {v.InferOutput<typeof previewSchema>} Preview */

/**
 * Whether `preview` deletes anything from a user-owned target
 * @param {Preview} preview
 */
export function deletesUserRecords(preview) {
  return preview.changes.some(change => change.deletes > 0 && USER_OWNED_TARGETS.includes(change.target));
}

/**
 * Whether `preview` changes nothing at all
 * @param {Preview} preview
 */
export function changesNothing(preview) {
  return preview.changes.every(change => change.creates + change.updates + change.deletes === 0);
}

/**
 * Whether two previews say the same, target by target, in any order
 * @param {Preview} a
 * @param {Preview} b
 */
export function samePreview(a, b) {
  return previewKey(a) === previewKey(b);
}

/**
 * What a preview says, as one string, target by target in order
 * @param {Preview} preview
 */
function previewKey(preview) {
  return JSON.stringify(
    [...preview.changes]
      .sort((x, y) => (x.target < y.target ? -1 : x.target > y.target ? 1 : 0))
      .map(change => [change.target, change.creates, change.updates, change.deletes]),
  );
}

/**
 * Whether `preview` changes anything in a user-owned target: what a non-destructive or
 * regenerable run may never do, since neither takes a recovery point
 * @param {Preview} preview
 */
export function changesUserRecords(preview) {
  return preview.changes.some(
    change => change.creates + change.updates + change.deletes > 0 && USER_OWNED_TARGETS.includes(change.target),
  );
}

/**
 * A preview's digest: 16 hex digits over what it says, target by target in any order, which
 * a confirmation sends back to name the preview the user saw. Two FNV-1a hashes, not a
 * cryptographic one: it tells previews apart, it doesn't keep anything secret.
 * @param {Preview} preview
 */
export function digestOf(preview) {
  const text = previewKey(preview);
  let a = 0x811c9dc5;
  let b = 0x01000193 ^ text.length;
  for (let index = 0; index < text.length; index++) {
    const unit = text.charCodeAt(index);
    a = Math.imul(a ^ unit, 0x01000193) >>> 0;
    b = Math.imul(b ^ unit, 0x5bd1e995) >>> 0;
  }
  return a.toString(16).padStart(8, '0') + b.toString(16).padStart(8, '0');
}
