/**
 * attachInsights, catalog version 1: the insights a job extracted (todos, reminders, deadlines,
 * highlights), which are the note's content too. It writes `insights`,
 * `lastInsightsExtractedAt`, and the content hash, and nothing else, `updatedAt` included.
 */

import * as v from '../../../../lib/valibot/index.mjs';
import { content, entityId } from '../fields.js';
import { commandPayload } from '../operation.js';
import { outcomeSchema } from '../outcome-schemas.js';

export const payload = commandPayload('attachInsights', {
  noteId: entityId('note'),
  insights: content(v.unknown()),
  contentHash: v.optional(v.pipe(v.string(), v.maxLength(128))),
});

export const result = outcomeSchema;

/** @typedef {v.InferOutput<typeof payload>} AttachInsights */
