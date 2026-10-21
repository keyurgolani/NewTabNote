/**
 * unarchiveNote, catalog version 1: takes a note out of the archive.
 */

import { entityId } from '../fields.js';
import { commandPayload } from '../operation.js';
import { outcomeSchema } from '../outcome-schemas.js';

export const payload = commandPayload('unarchiveNote', { noteId: entityId('note') });

export const result = outcomeSchema;

/** @typedef {import('../../../../lib/valibot/index.mjs').InferOutput<typeof payload>} UnarchiveNote */
