/**
 * deleteFolder, catalog version 1: deletes a folder and every folder inside it, as committed,
 * and files every note in them at the root, the trashed ones and templates too, in one transaction.
 */

import { entityId } from '../fields.js';
import { commandPayload } from '../operation.js';
import { outcomeSchema } from '../outcome-schemas.js';

export const payload = commandPayload('deleteFolder', { folderId: entityId('folder') });

export const result = outcomeSchema;

/** @typedef {import('../../../../lib/valibot/index.mjs').InferOutput<typeof payload>} DeleteFolder */
