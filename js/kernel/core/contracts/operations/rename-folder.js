/**
 * renameFolder, catalog version 1: a folder's new name, and nothing else of it.
 */

import * as v from '../../../../lib/valibot/index.mjs';
import { content, entityId } from '../fields.js';
import { commandPayload } from '../operation.js';
import { outcomeSchema } from '../outcome-schemas.js';

export const payload = commandPayload('renameFolder', {
  folderId: entityId('folder'),
  name: content(v.string()),
});

export const result = outcomeSchema;

/** @typedef {v.InferOutput<typeof payload>} RenameFolder */
