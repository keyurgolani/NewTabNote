/**
 * getInsightsPending, catalog version 1: since when a note's insights have been being
 * extracted, or null when they aren't. The caller decides when a mark is too old to trust.
 */

import * as v from '../../../../lib/valibot/index.mjs';
import { entityId, timestamp } from '../fields.js';
import { queryPayload } from '../operation.js';
import { queryStateSchema } from '../outcome-schemas.js';

export const payload = queryPayload('getInsightsPending', { noteId: entityId('note') });

export const result = queryStateSchema(v.strictObject({ since: v.nullable(timestamp) }));

/** @typedef {v.InferOutput<typeof payload>} GetInsightsPending */
