/**
 * catchUpNoteRecords, catalog version 1: one batch of the worker's one-time catch-up after the
 * update (#33, the lead's Q9 and QA3), the notes it names, in key order, at most 100 of them.
 * Each note's preview and to-do progress are made again from its blocks where they lag.
 */

import * as v from '../../../../lib/valibot/index.mjs';
import { entityId } from '../fields.js';
import { commandPayload } from '../operation.js';
import { outcomeSchema } from '../outcome-schemas.js';

export const payload = commandPayload('catchUpNoteRecords', {
  noteIds: v.pipe(v.array(entityId('note')), v.minLength(1), v.maxLength(100)),
});

export const result = outcomeSchema;

/** @typedef {v.InferOutput<typeof payload>} CatchUpNoteRecords */
