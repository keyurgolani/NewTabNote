/**
 * getWorkspaceSession, catalog version 1: the workspace session keys that are stored.
 */

import { workspaceSession } from '../settings.js';
import { queryPayload } from '../operation.js';
import { queryStateSchema } from '../outcome-schemas.js';

export const payload = queryPayload('getWorkspaceSession', {});

export const result = queryStateSchema(workspaceSession);

/** @typedef {import('../../../../lib/valibot/index.mjs').InferOutput<typeof payload>} GetWorkspaceSession */
