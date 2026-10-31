/**
 * setPinned, catalog version 1: pins or unpins a note, which leaves its content revision as it was.
 * `expectedPlacementVersion`, the placement version the caller last read (getNote), makes it a
 * `placement-conflict` on an adapter with revisions when the note's has moved since.
 */

import * as v from '../../../../lib/valibot/index.mjs';
import { entityId, revision } from '../fields.js';
import { commandPayload } from '../operation.js';
import { outcomeSchema } from '../outcome-schemas.js';

export const payload = commandPayload('setPinned', {
  noteId: entityId('note'),
  pinned: v.boolean(),
  expectedPlacementVersion: v.optional(revision),
});

export const result = outcomeSchema;

/** @typedef {v.InferOutput<typeof payload>} SetPinned */
