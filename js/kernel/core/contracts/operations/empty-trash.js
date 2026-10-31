/**
 * emptyTrash, catalog version 1: deletes every note in the trash as committed, each with what
 * Storage.permanentlyDeleteNote deletes, in one transaction. The outcome names the notes it
 * deleted.
 */

import { commandPayload } from '../operation.js';
import { outcomeSchema } from '../outcome-schemas.js';

export const payload = commandPayload('emptyTrash', {});

export const result = outcomeSchema;

/** @typedef {import('../../../../lib/valibot/index.mjs').InferOutput<typeof payload>} EmptyTrash */
