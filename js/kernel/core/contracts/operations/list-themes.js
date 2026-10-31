/**
 * listThemes, catalog version 1: the custom themes, the last saved first, as
 * Storage.getCustomThemes listed them.
 */

import * as v from '../../../../lib/valibot/index.mjs';
import { themeRecord } from '../entities.js';
import { queryPayload } from '../operation.js';
import { queryStateSchema } from '../outcome-schemas.js';

export const payload = queryPayload('listThemes', {});

export const result = queryStateSchema(v.array(themeRecord));

/** @typedef {v.InferOutput<typeof payload>} ListThemes */
