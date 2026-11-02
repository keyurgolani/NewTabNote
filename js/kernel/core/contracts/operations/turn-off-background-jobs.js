/**
 * turnOffBackgroundJobs, catalog version 1 (NTN-21): both background AI jobs, titles and
 * insights, switched off, with the one-time switch-off's marker beside them, in one settings
 * write. The new tab sends it at its first start without the marker, and at a first run.
 */

import { commandPayload } from '../operation.js';
import { outcomeSchema } from '../outcome-schemas.js';

export const payload = commandPayload('turnOffBackgroundJobs', {});

export const result = outcomeSchema;

/** @typedef {import('../../../../lib/valibot/index.mjs').InferOutput<typeof payload>} TurnOffBackgroundJobs */
