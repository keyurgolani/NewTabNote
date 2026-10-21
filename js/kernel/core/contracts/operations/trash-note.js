/**
 * trashNote, catalog version 1: moves a note to trash, out of the archive. An untitled note with
 * no content is deleted instead, blocks, media, vectors, and snapshots included, as
 * Storage.trashNote does.
 */

import { entityId } from '../fields.js';
import { commandPayload } from '../operation.js';
import { outcomeSchema } from '../outcome-schemas.js';

export const payload = commandPayload('trashNote', { noteId: entityId('note') });

export const result = outcomeSchema;

/** @typedef {import('../../../../lib/valibot/index.mjs').InferOutput<typeof payload>} TrashNote */
