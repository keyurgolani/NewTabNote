/**
 * getPopupInsightsEnabled, catalog version 1: whether Popup shows the day's summary, read
 * where 1.4.x has always read it, IndexedDB's `settings` store, which Storage.setSetting
 * never writes. #4 reads the setting the new tab saves instead when it rebuilds Popup.
 */

import * as v from '../../../../lib/valibot/index.mjs';
import { queryPayload } from '../operation.js';
import { queryStateSchema } from '../outcome-schemas.js';

export const payload = queryPayload('getPopupInsightsEnabled', {});

export const result = queryStateSchema(v.strictObject({ insightsEnabled: v.boolean() }));

/** @typedef {v.InferOutput<typeof payload>} GetPopupInsightsEnabled */
