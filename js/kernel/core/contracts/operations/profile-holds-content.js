/**
 * profileHoldsContent, catalog version 1: whether a note Export JSON exports, one outside trash,
 * has a title or a block that holds something, by the rule trash goes by (domain/note.js
 * isUntitled and isEmpty). The export notice asks it once.
 */

import * as v from '../../../../lib/valibot/index.mjs';
import { queryPayload } from '../operation.js';
import { queryStateSchema } from '../outcome-schemas.js';

export const payload = queryPayload('profileHoldsContent', {});

export const result = queryStateSchema(v.boolean());

/** @typedef {v.InferOutput<typeof payload>} ProfileHoldsContent */
