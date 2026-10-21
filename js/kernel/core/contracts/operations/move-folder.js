/**
 * moveFolder, catalog version 1: a new parent, null for the root. A move into the folder itself
 * or a folder inside it is rejected, against the folders as committed.
 */

import * as v from '../../../../lib/valibot/index.mjs';
import { entityId } from '../fields.js';
import { commandPayload } from '../operation.js';
import { outcomeSchema } from '../outcome-schemas.js';

export const payload = commandPayload('moveFolder', {
  folderId: entityId('folder'),
  parentId: v.nullable(entityId('folder')),
});

export const result = outcomeSchema;

/** @typedef {v.InferOutput<typeof payload>} MoveFolder */
