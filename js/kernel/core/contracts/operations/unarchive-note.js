/**
 * unarchiveNote, catalog version 1: takes a note out of the archive.
 * `expectedPlacementVersion`, the placement version the caller last read (getNote), makes it a
 * `placement-conflict` on an adapter with revisions when the note's has moved since.
 */

import * as v from '../../../../lib/valibot/index.mjs';
import { entityId, revision } from '../fields.js';
import { commandPayload } from '../operation.js';
import { outcomeSchema } from '../outcome-schemas.js';

export const payload = commandPayload('unarchiveNote', {
  noteId: entityId('note'),
  expectedPlacementVersion: v.optional(revision),
});

export const result = outcomeSchema;

/** @typedef {import('../../../../lib/valibot/index.mjs').InferOutput<typeof payload>} UnarchiveNote */
