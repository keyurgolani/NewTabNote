/**
 * Schemas for #12's closed outcome union and query states (contracts/outcomes.js), so a reply
 * is validated as strictly as a request (#13, AC1). An outcome carries codes, ids, a
 * messageKey, and a severity, never content, and these schemas leave no room for any.
 * test/kernel/schemas.test.mjs holds each schema's type equal to the typedef it checks.
 */

import * as v from '../../../lib/valibot/index.mjs';
import { code, commitSeq, count, id, revision } from './fields.js';
import { FAIL_CAUSES, REJECT_REASONS, STORAGE_EXCEPTIONS, UNAVAILABLE_CAUSES } from './outcomes.js';

/** @typedef {import('./outcomes.js').Outcome} Outcome */

const severity = v.picklist(['success', 'info', 'warning', 'error']);

/** `<kind>.<code>`, as every outcome's messageKey is */
const messageKey = v.pipe(v.string(), v.regex(/^[a-z]+\.[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/), v.maxLength(80));

export const committedSchema = v.strictObject({
  kind: v.literal('committed'),
  code,
  changedIds: v.array(id),
  revision: v.optional(revision),
  commitSeq: v.optional(commitSeq),
  messageKey,
  severity,
});

export const rejectedSchema = v.strictObject({
  kind: v.literal('rejected'),
  reason: v.picklist(REJECT_REASONS),
  code,
  messageKey,
  severity,
});

export const conflictSchema = v.strictObject({
  kind: v.literal('conflict'),
  code,
  currentRevision: revision,
  messageKey,
  severity,
});

export const unavailableSchema = v.strictObject({
  kind: v.literal('unavailable'),
  cause: v.picklist(UNAVAILABLE_CAUSES),
  code,
  retryable: v.boolean(),
  exception: v.optional(v.picklist(STORAGE_EXCEPTIONS)),
  messageKey,
  severity,
});

export const unknownSchema = v.strictObject({
  kind: v.literal('unknown'),
  code,
  commandId: id,
  messageKey,
  severity,
});

/** Any command's answer but a bulk command's */
export const outcomeSchema = v.variant('kind', [
  committedSchema,
  rejectedSchema,
  conflictSchema,
  unavailableSchema,
  unknownSchema,
]);

export const bulkOutcomeSchema = v.strictObject({
  kind: v.literal('bulk'),
  code,
  items: v.array(v.strictObject({ id, outcome: outcomeSchema })),
  committedIds: v.array(id),
  messageKey,
  severity,
});

/** A bulk command's answer: a BulkOutcome once it ran, and a plain outcome when it didn't */
export const bulkResultSchema = v.variant('kind', [
  bulkOutcomeSchema,
  committedSchema,
  rejectedSchema,
  conflictSchema,
  unavailableSchema,
  unknownSchema,
]);

export const failedSchema = v.strictObject({ kind: v.literal('failed'), cause: v.picklist(FAIL_CAUSES), code });

/**
 * A query's answer, carrying `data` in its ready and stale states.
 * @template {v.GenericSchema} D
 * @param {D} data
 */
export function queryStateSchema(data) {
  return v.variant('kind', [
    v.strictObject({ kind: v.literal('loading') }),
    v.strictObject({ kind: v.literal('ready'), asOf: count, data }),
    v.strictObject({ kind: v.literal('empty'), asOf: count }),
    v.strictObject({ kind: v.literal('stale'), asOf: count, data }),
    failedSchema,
  ]);
}
