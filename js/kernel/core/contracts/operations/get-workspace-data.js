/**
 * getWorkspaceData, catalog version 1: what the new tab keeps beside its preferences, all of it
 * unless `keys` names some, each key from the settings area its command writes. A key with
 * nothing stored is left out, and the caller applies its default.
 */

import * as v from '../../../../lib/valibot/index.mjs';
import { WORKSPACE_DATA_KEYS } from '../../domain/workspace-data.js';
import { workspaceDataValues } from '../settings.js';
import { queryPayload } from '../operation.js';
import { queryStateSchema } from '../outcome-schemas.js';

export const payload = queryPayload('getWorkspaceData', { keys: v.optional(v.array(v.picklist(WORKSPACE_DATA_KEYS))) });

export const result = queryStateSchema(workspaceDataValues);

/** @typedef {v.InferOutput<typeof payload>} GetWorkspaceData */
