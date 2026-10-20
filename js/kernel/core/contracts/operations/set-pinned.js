/**
 * setPinned, catalog version 1: pins or unpins a note, which leaves its content revision as it was.
 */

import * as v from '../../../../lib/valibot/index.mjs';
import { entityId } from '../fields.js';
import { commandPayload } from '../operation.js';
import { outcomeSchema } from '../outcome-schemas.js';

export const payload = commandPayload('setPinned', { noteId: entityId('note'), pinned: v.boolean() });

export const result = outcomeSchema;

/** @typedef {v.InferOutput<typeof payload>} SetPinned */
