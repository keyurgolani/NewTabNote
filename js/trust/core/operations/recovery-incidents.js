/**
 * recovery.incidents, catalog version 1 (#20, "Contracts"): the open incidents, dismissed ones
 * included, worst severity first and then most recently seen, and the resolved ones after
 * them when asked
 */

import * as v from '../../../lib/valibot/index.mjs';
import { queryPayload } from '../../../kernel/core/contracts/operation.js';
import { queryStateSchema } from '../../../kernel/core/contracts/outcome-schemas.js';
import { incidentSchema } from '../records.js';

export const payload = queryPayload('recovery.incidents', { includeResolved: v.optional(v.boolean()) });

export const result = queryStateSchema(v.strictObject({ incidents: v.array(incidentSchema) }));

/** @typedef {v.InferOutput<typeof payload>} RecoveryIncidentsQuery */
