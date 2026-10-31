/**
 * runTrashCleanup, catalog version 1: deletes the notes that have been in the trash longer than
 * the trashRetention preference keeps them (30 days when nothing is stored, and never when it's
 * 0), as Storage.cleanupTrash does, in one transaction. The outcome names the notes it deleted.
 */

import { commandPayload } from '../operation.js';
import { outcomeSchema } from '../outcome-schemas.js';

export const payload = commandPayload('runTrashCleanup', {});

export const result = outcomeSchema;

/** @typedef {import('../../../../lib/valibot/index.mjs').InferOutput<typeof payload>} RunTrashCleanup */
