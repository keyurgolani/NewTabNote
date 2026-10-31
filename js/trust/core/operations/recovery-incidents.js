/**
 * recovery.incidents, catalog version 1 (#20, "Contracts"): the open incidents, dismissed ones
 * included, worst severity first and then most recently seen, and the resolved ones after
 * them when asked. `next` holds each open one's card action from next-action.js (its repair,
 * or null when Dismiss is all it has), so no view picks its own.
 */

import * as v from '../../../lib/valibot/index.mjs';
import { queryPayload } from '../../../kernel/core/contracts/operation.js';
import { queryStateSchema } from '../../../kernel/core/contracts/outcome-schemas.js';
import { recordId } from '../evidence.js';
import { nextActionSchema } from '../next-action.js';
import { incidentSchema } from '../records.js';

export const payload = queryPayload('recovery.incidents', { includeResolved: v.optional(v.boolean()) });

// `copyRead` and `recordsRead`: whether this read of the settings copy, and of NewTabNoteTrust,
// answered; when either didn't, incidents may be missing
export const result = queryStateSchema(
  v.strictObject({
    incidents: v.array(incidentSchema),
    copyRead: v.boolean(),
    recordsRead: v.boolean(),
    next: v.array(v.strictObject({ incidentId: recordId, next: v.nullable(nextActionSchema) })),
  }),
);

/** @typedef {v.InferOutput<typeof payload>} RecoveryIncidentsQuery */
