/**
 * getPreferences, catalog version 1: stored preferences, all of them unless `keys` names some. A
 * key with nothing stored is left out, and the caller applies its default.
 */

import * as v from '../../../../lib/valibot/index.mjs';
import { PREFERENCE_KEYS } from '../../domain/preferences.js';
import { preferenceValues } from '../settings.js';
import { queryPayload } from '../operation.js';
import { queryStateSchema } from '../outcome-schemas.js';

export const payload = queryPayload('getPreferences', { keys: v.optional(v.array(v.picklist(PREFERENCE_KEYS))) });

export const result = queryStateSchema(preferenceValues);

/** @typedef {v.InferOutput<typeof payload>} GetPreferences */
