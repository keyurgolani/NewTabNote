/**
 * recovery.raise, catalog version 1 (#20, AC2): raise an incident from any context, the
 * service worker included, or update the one with its provider, fault, and subject. Its
 * evidence is the allowlist, field for field, so nothing else gets in.
 */

import * as v from '../../../lib/valibot/index.mjs';
import { commandPayload } from '../../../kernel/core/contracts/operation.js';
import { outcomeSchema } from '../../../kernel/core/contracts/outcome-schemas.js';
import { contributionId, evidenceSchema, faultCode, subjectId } from '../evidence.js';
import { capabilities } from '../records.js';
import { SEVERITIES } from '../vocabulary.js';

export const payload = commandPayload('recovery.raise', {
  providerId: contributionId,
  faultCode,
  subjectId: v.optional(v.nullable(subjectId)),
  severity: v.picklist(SEVERITIES),
  affected: v.optional(capabilities),
  preserved: v.optional(capabilities),
  evidence: v.optional(evidenceSchema),
});

export const result = outcomeSchema;

/** @typedef {v.InferOutput<typeof payload>} RecoveryRaise */
