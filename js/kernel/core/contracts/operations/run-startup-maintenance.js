/**
 * runStartupMaintenance, catalog version 1: default settings and the read-only integrity check,
 * which the new tab and the service worker run as they start.
 */

import { commandPayload } from '../operation.js';
import { outcomeSchema } from '../outcome-schemas.js';

export const payload = commandPayload('runStartupMaintenance', {});

export const result = outcomeSchema;

/** @typedef {import('../../../../lib/valibot/index.mjs').InferOutput<typeof payload>} RunStartupMaintenance */
