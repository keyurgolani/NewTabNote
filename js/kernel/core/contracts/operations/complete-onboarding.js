/**
 * completeOnboarding, catalog version 1: the first-run walkthrough finished, so it never shows
 * again.
 */

import { commandPayload } from '../operation.js';
import { outcomeSchema } from '../outcome-schemas.js';

export const payload = commandPayload('completeOnboarding', {});

export const result = outcomeSchema;

/** @typedef {import('../../../../lib/valibot/index.mjs').InferOutput<typeof payload>} CompleteOnboarding */
