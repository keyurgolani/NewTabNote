/**
 * recovery.raise, catalog version 1 (#20, AC2): raise an incident from any context, the
 * service worker included, or update the one with its provider, fault, and subject. Its
 * evidence is the allowlist, field for field, so nothing else gets in. It answers an outcome,
 * or `held` for a storage incident NewTabNoteTrust wouldn't take yet.
 */

import * as v from '../../../lib/valibot/index.mjs';
import { commandPayload } from '../../../kernel/core/contracts/operation.js';
import {
  committedSchema,
  conflictSchema,
  rejectedSchema,
  unavailableSchema,
  unknownSchema,
} from '../../../kernel/core/contracts/outcome-schemas.js';
import { evidenceSchema, faultCode, providerId, recordId, subjectId } from '../evidence.js';
import { capabilities } from '../records.js';
import { SEVERITIES } from '../vocabulary.js';

export const payload = commandPayload('recovery.raise', {
  providerId,
  faultCode,
  subjectId: v.optional(v.nullable(subjectId)),
  severity: v.picklist(SEVERITIES),
  affected: v.optional(capabilities),
  preserved: v.optional(capabilities),
  evidence: v.optional(evidenceSchema),
});

/**
 * The answer for a storage incident NewTabNoteTrust wouldn't take, which memory and the
 * settings copy hold until it does: not a committed write, so it has its own kind
 */
export const heldSchema = v.strictObject({
  kind: v.literal('held'),
  code: v.literal('incident-held'),
  incidentId: recordId,
  messageKey: v.literal('held.incident-held'),
  severity: v.literal('warning'),
});

/** @typedef {v.InferOutput<typeof heldSchema>} Held */

export const result = v.variant('kind', [
  committedSchema,
  rejectedSchema,
  conflictSchema,
  unavailableSchema,
  unknownSchema,
  heldSchema,
]);

/** @typedef {v.InferOutput<typeof payload>} RecoveryRaise */
