/**
 * recovery.run, catalog version 1 (#20, "Contracts"): run a remediation the user chose.
 * `userInitiated` is always `true`, set only by a click handler on a `newtab` or `recovery`
 * page, so nothing else can start one. Slice 3 builds the pipeline (plan, preview, protect,
 * apply, verify, record) its use case runs, and no root registers a handler for it yet.
 */

import * as v from '../../../lib/valibot/index.mjs';
import { commandPayload } from '../../../kernel/core/contracts/operation.js';
import { outcomeSchema } from '../../../kernel/core/contracts/outcome-schemas.js';
import { contributionId, recordId } from '../evidence.js';

export const payload = commandPayload('recovery.run', {
  remediationId: contributionId,
  incidentId: v.optional(v.nullable(recordId)),
  userInitiated: v.literal(true),
});

export const result = outcomeSchema;

/** @typedef {v.InferOutput<typeof payload>} RecoveryRun */
