/**
 * restoreNote, catalog version 1: takes a note out of the trash.
 */

import { entityId } from '../fields.js';
import { commandPayload } from '../operation.js';
import { outcomeSchema } from '../outcome-schemas.js';

export const payload = commandPayload('restoreNote', { noteId: entityId('note') });

export const result = outcomeSchema;

/** @typedef {import('../../../../lib/valibot/index.mjs').InferOutput<typeof payload>} RestoreNote */
