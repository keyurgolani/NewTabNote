/**
 * trust.verify, catalog version 1 (#20, "Contracts"): run the checks of the providers named,
 * or of every enabled provider, and store a receipt for each. `trigger` says what asked, so
 * slice 2 can hold `network` checks back on open.
 */

import * as v from '../../../lib/valibot/index.mjs';
import { commandPayload } from '../../../kernel/core/contracts/operation.js';
import { outcomeSchema } from '../../../kernel/core/contracts/outcome-schemas.js';
import { providerId } from '../evidence.js';
import { TRIGGERS } from '../vocabulary.js';

export const payload = commandPayload('trust.verify', {
  providerIds: v.optional(v.pipe(v.array(providerId), v.maxLength(64))),
  trigger: v.picklist(TRIGGERS),
});

export const result = outcomeSchema;

/** @typedef {v.InferOutput<typeof payload>} TrustVerify */
