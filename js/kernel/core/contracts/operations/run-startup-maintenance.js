/**
 * runStartupMaintenance, catalog version 1: default settings where none are stored, which the
 * new tab and the service worker run as they start. The read-only integrity check it also ran
 * went with #17 PR 4a.
 */

import { commandPayload } from '../operation.js';
import { outcomeSchema } from '../outcome-schemas.js';

export const payload = commandPayload('runStartupMaintenance', {});

export const result = outcomeSchema;

/** @typedef {import('../../../../lib/valibot/index.mjs').InferOutput<typeof payload>} RunStartupMaintenance */
