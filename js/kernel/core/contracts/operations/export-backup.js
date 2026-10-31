/**
 * exportBackup, catalog version 1: the JSON file Export JSON downloads, or with `backup` the
 * one Create Backup does, which adds its backup fields. An adapter with the `backups` flag
 * makes it with 1.4.x's own Storage code. Its data is the file, a Blob, which the new tab's
 * kernel answers in the page; #18's backup engine replaces it.
 */

import * as v from '../../../../lib/valibot/index.mjs';
import { queryPayload } from '../operation.js';
import { queryStateSchema } from '../outcome-schemas.js';

export const payload = queryPayload('exportBackup', { backup: v.boolean() });

export const result = queryStateSchema(v.blob());

/** @typedef {v.InferOutput<typeof payload>} ExportBackup */
