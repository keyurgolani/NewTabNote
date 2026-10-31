/**
 * recordBackup, catalog version 1: a full export or a backup was handed to the browser now, by
 * the kernel's clock. `fullExport` marks the full export the pre-migration notice listens for,
 * and `backup` the time auto-backup counts from. At least one is true.
 */

import * as v from '../../../../lib/valibot/index.mjs';
import { commandPayload } from '../operation.js';
import { outcomeSchema } from '../outcome-schemas.js';

export const payload = commandPayload('recordBackup', { fullExport: v.boolean(), backup: v.boolean() });

export const result = outcomeSchema;

/** @typedef {v.InferOutput<typeof payload>} RecordBackup */
