/**
 * getSnapshot, catalog version 1: one snapshot, blocks included, for its preview and a revert.
 */

import * as v from '../../../../lib/valibot/index.mjs';
import { snapshotRecord } from '../entities.js';
import { entityId } from '../fields.js';
import { queryPayload } from '../operation.js';
import { queryStateSchema } from '../outcome-schemas.js';

export const payload = queryPayload('getSnapshot', { snapshotId: entityId('snapshot') });

export const result = queryStateSchema(snapshotRecord);

/** @typedef {v.InferOutput<typeof payload>} GetSnapshot */
