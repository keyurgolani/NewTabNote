/**
 * getJobRuns, catalog version 1: when the auto-title and insights jobs last started, or 0 for
 * a job that never ran.
 */

import * as v from '../../../../lib/valibot/index.mjs';
import { timestamp } from '../fields.js';
import { queryPayload } from '../operation.js';
import { queryStateSchema } from '../outcome-schemas.js';

export const payload = queryPayload('getJobRuns', {});

export const result = queryStateSchema(v.strictObject({ lastAutoTitleRun: timestamp, lastInsightsRun: timestamp }));

/** @typedef {v.InferOutput<typeof payload>} GetJobRuns */
