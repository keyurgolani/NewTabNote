/**
 * setFolderCollapsed, catalog version 1: whether the sidebar shows a folder collapsed, and
 * nothing else of it.
 */

import * as v from '../../../../lib/valibot/index.mjs';
import { entityId } from '../fields.js';
import { commandPayload } from '../operation.js';
import { outcomeSchema } from '../outcome-schemas.js';

export const payload = commandPayload('setFolderCollapsed', {
  folderId: entityId('folder'),
  collapsed: v.boolean(),
});

export const result = outcomeSchema;

/** @typedef {v.InferOutput<typeof payload>} SetFolderCollapsed */
