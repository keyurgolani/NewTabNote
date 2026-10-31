/**
 * trashNote, catalog version 1: moves a note to trash, out of the archive. An untitled note with
 * no content is deleted instead, blocks, media, vectors, and snapshots included, as
 * Storage.trashNote does.
 * `expectedPlacementVersion`, the placement version the caller last read (getNote), makes it a
 * `placement-conflict` on an adapter with revisions when the note's has moved since.
 */

import * as v from '../../../../lib/valibot/index.mjs';
import { entityId, revision } from '../fields.js';
import { commandPayload } from '../operation.js';
import { outcomeSchema } from '../outcome-schemas.js';

export const payload = commandPayload('trashNote', {
  noteId: entityId('note'),
  expectedPlacementVersion: v.optional(revision),
});

export const result = outcomeSchema;

/** @typedef {import('../../../../lib/valibot/index.mjs').InferOutput<typeof payload>} TrashNote */
