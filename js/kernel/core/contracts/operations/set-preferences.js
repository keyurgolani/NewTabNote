/**
 * setPreferences, catalog version 1: preferences, each one the kernel owns, with its value.
 */

import { preferenceValues } from '../settings.js';
import { commandPayload } from '../operation.js';
import { outcomeSchema } from '../outcome-schemas.js';

export const payload = commandPayload('setPreferences', { values: preferenceValues });

export const result = outcomeSchema;

/** @typedef {import('../../../../lib/valibot/index.mjs').InferOutput<typeof payload>} SetPreferences */
