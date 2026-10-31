/**
 * deleteNotePermanently, catalog version 1: deletes a note in the trash for good, with what
 * Storage.permanentlyDeleteNote deletes (its blocks, media, vectors, and snapshots), in one
 * transaction. A note that isn't in the trash is refused.
 */

import { entityId } from '../fields.js';
import { commandPayload } from '../operation.js';
import { outcomeSchema } from '../outcome-schemas.js';

export const payload = commandPayload('deleteNotePermanently', { noteId: entityId('note') });

export const result = outcomeSchema;

/** @typedef {import('../../../../lib/valibot/index.mjs').InferOutput<typeof payload>} DeleteNotePermanently */
