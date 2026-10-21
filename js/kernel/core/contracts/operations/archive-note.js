/**
 * archiveNote, catalog version 1: puts a note in the archive.
 */

import { entityId } from '../fields.js';
import { commandPayload } from '../operation.js';
import { outcomeSchema } from '../outcome-schemas.js';

export const payload = commandPayload('archiveNote', { noteId: entityId('note') });

export const result = outcomeSchema;

/** @typedef {import('../../../../lib/valibot/index.mjs').InferOutput<typeof payload>} ArchiveNote */
