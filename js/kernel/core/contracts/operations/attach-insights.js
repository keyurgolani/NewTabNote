/**
 * attachInsights, catalog version 1: the insights a job extracted (todos, reminders, deadlines,
 * highlights), which are the note's content too. It writes `insights`,
 * `lastInsightsExtractedAt`, and the content hash, and nothing else, `updatedAt` included.
 * `sourceRevision` is the content revision the job read the note at (getNote). On an adapter
 * with revisions, insights from a revision older than the one the note's insights came from
 * write nothing and answer `insights-stale`.
 */

import * as v from '../../../../lib/valibot/index.mjs';
import { content, entityId, revision } from '../fields.js';
import { commandPayload } from '../operation.js';
import { outcomeSchema } from '../outcome-schemas.js';

export const payload = commandPayload('attachInsights', {
  noteId: entityId('note'),
  insights: content(v.unknown()),
  contentHash: v.optional(v.pipe(v.string(), v.maxLength(128))),
  sourceRevision: v.optional(revision),
});

export const result = outcomeSchema;

/** @typedef {v.InferOutput<typeof payload>} AttachInsights */
