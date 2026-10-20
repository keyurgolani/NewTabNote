/**
 * saveWorkspaceSession, catalog version 1: the workspace session keys TabController hands over.
 */

import { workspaceSession } from '../settings.js';
import { commandPayload } from '../operation.js';
import { outcomeSchema } from '../outcome-schemas.js';

export const payload = commandPayload('saveWorkspaceSession', { session: workspaceSession });

export const result = outcomeSchema;

/** @typedef {import('../../../../lib/valibot/index.mjs').InferOutput<typeof payload>} SaveWorkspaceSession */
