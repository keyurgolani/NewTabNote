/**
 * deleteBlocks, catalog version 1: blocks the user deleted from a note in the editor, which
 * Storage.deleteElement deleted one at a time. A block that's already gone is nothing to
 * delete, and one that another note holds is refused, so nothing is deleted.
 * `expectedRevision`, on an adapter with revisions, makes a delete over a newer write a
 * `revision-conflict`, as it does for saveNoteContent.
 */

import * as v from '../../../../lib/valibot/index.mjs';
import { entityId, revision } from '../fields.js';
import { commandPayload } from '../operation.js';
import { outcomeSchema } from '../outcome-schemas.js';

export const payload = commandPayload('deleteBlocks', {
  noteId: entityId('note'),
  blockIds: v.pipe(v.array(entityId('block')), v.minLength(1)),
  expectedRevision: v.optional(revision),
});

export const result = outcomeSchema;

/** @typedef {v.InferOutput<typeof payload>} DeleteBlocks */
