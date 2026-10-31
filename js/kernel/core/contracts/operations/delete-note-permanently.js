/**
 * deleteNotePermanently, catalog version 1: deletes a note in the trash for good, with what
 * Storage.permanentlyDeleteNote deletes (its blocks, media, vectors, and snapshots), in one
 * transaction. A note that isn't in the trash is refused.
 * `expectedPlacementVersion`, the placement version the caller last read (getNote), makes it a
 * `placement-conflict` on an adapter with revisions when the note's has moved since.
 */

import * as v from '../../../../lib/valibot/index.mjs';
import { entityId, revision } from '../fields.js';
import { commandPayload } from '../operation.js';
import { outcomeSchema } from '../outcome-schemas.js';

export const payload = commandPayload('deleteNotePermanently', {
  noteId: entityId('note'),
  expectedPlacementVersion: v.optional(revision),
});

export const result = outcomeSchema;

/** @typedef {import('../../../../lib/valibot/index.mjs').InferOutput<typeof payload>} DeleteNotePermanently */
