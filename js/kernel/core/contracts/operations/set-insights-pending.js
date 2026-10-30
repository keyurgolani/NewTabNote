/**
 * setInsightsPending, catalog version 1: marks a note's insights as being extracted, stamped
 * with the kernel's clock, or clears the mark. The editor shows "Extracting..." while it's
 * set and newer than 5 minutes, and reloads the note's insights once it's cleared.
 */

import * as v from '../../../../lib/valibot/index.mjs';
import { entityId } from '../fields.js';
import { commandPayload } from '../operation.js';
import { outcomeSchema } from '../outcome-schemas.js';

export const payload = commandPayload('setInsightsPending', { noteId: entityId('note'), pending: v.boolean() });

export const result = outcomeSchema;

/** @typedef {v.InferOutput<typeof payload>} SetInsightsPending */
