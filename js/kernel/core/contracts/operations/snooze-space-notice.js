/**
 * snoozeSpaceNotice, catalog version 1: the space notice, which says the storage upgrade waits
 * for free space, put off for seven days in every tab, from the kernel's clock (#17 PR 1b).
 */

import { commandPayload } from '../operation.js';
import { outcomeSchema } from '../outcome-schemas.js';

export const payload = commandPayload('snoozeSpaceNotice', {});

export const result = outcomeSchema;

/** @typedef {import('../../../../lib/valibot/index.mjs').InferOutput<typeof payload>} SnoozeSpaceNotice */
