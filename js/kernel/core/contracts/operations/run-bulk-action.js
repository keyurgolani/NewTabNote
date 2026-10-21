/**
 * runBulkAction, catalog version 1: one note command per id, in order. Once it runs it answers
 * with an outcome per note, and a plain outcome when it doesn't.
 */

import * as v from '../../../../lib/valibot/index.mjs';
import { entityId } from '../fields.js';
import { commandPayload } from '../operation.js';
import { bulkResultSchema } from '../outcome-schemas.js';

export const payload = commandPayload('runBulkAction', {
  action: v.picklist(['archive', 'unarchive', 'trash', 'restore']),
  noteIds: v.pipe(v.array(entityId('note')), v.minLength(1)),
});

export const result = bulkResultSchema;

/** @typedef {v.InferOutput<typeof payload>} RunBulkAction */
