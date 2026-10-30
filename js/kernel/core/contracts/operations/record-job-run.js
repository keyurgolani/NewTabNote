/**
 * recordJobRun, catalog version 1: a job's run started now, by the kernel's clock. The next
 * start reads it to catch up on a run it missed while the browser was closed.
 */

import * as v from '../../../../lib/valibot/index.mjs';
import { commandPayload } from '../operation.js';
import { outcomeSchema } from '../outcome-schemas.js';

export const payload = commandPayload('recordJobRun', { job: v.picklist(['autoTitle', 'insights']) });

export const result = outcomeSchema;

/** @typedef {v.InferOutput<typeof payload>} RecordJobRun */
