/**
 * createFolder, catalog version 1: a folder, under a parent that exists, or at the root.
 */

import * as v from '../../../../lib/valibot/index.mjs';
import { content, entityId } from '../fields.js';
import { commandPayload } from '../operation.js';
import { outcomeSchema } from '../outcome-schemas.js';

export const payload = commandPayload('createFolder', {
  folderId: entityId('folder'),
  name: content(v.string()),
  parentId: v.nullable(entityId('folder')),
});

export const result = outcomeSchema;

/** @typedef {v.InferOutput<typeof payload>} CreateFolder */
