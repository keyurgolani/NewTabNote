/**
 * recordExportNotice, catalog version 1: the pre-migration export notice's outcome, for the
 * notice version that had it, stamped by the kernel's clock. The notice decides, under its Web
 * Lock, whether an outcome already recorded stands.
 */

import * as v from '../../../../lib/valibot/index.mjs';
import { count } from '../fields.js';
import { commandPayload } from '../operation.js';
import { outcomeSchema } from '../outcome-schemas.js';

export const payload = commandPayload('recordExportNotice', {
  version: count,
  outcome: v.picklist(['exported', 'dismissed', 'not-needed']),
});

export const result = outcomeSchema;

/** @typedef {v.InferOutput<typeof payload>} RecordExportNotice */
