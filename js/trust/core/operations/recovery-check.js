/**
 * recovery.check, catalog version 1 (#20 slice 4a): "Checking that it's fixed", what a view
 * asks after a repair's run verified. A verified run never resolves its incident: this runs
 * the incident's provider's check (trust.verify, `verify-now`), and only a pass resolves it.
 * `result` says what the check found:
 * - `fixed`: the incident is resolved (by this check, or already was);
 * - `still-there`: the check answered and still reports it, or saw a new sighting while it ran;
 * - `not-checked`: the check timed out, threw, or answered outside its schema, or its provider
 *   isn't registered here or doesn't observe the fault, so nothing was decided either way.
 * A check whose receipt or incidents wouldn't write answers unavailable `not-recorded`.
 */

import * as v from '../../../lib/valibot/index.mjs';
import { commandPayload } from '../../../kernel/core/contracts/operation.js';
import { rejectedSchema, unavailableSchema } from '../../../kernel/core/contracts/outcome-schemas.js';
import { providerId, recordId } from '../evidence.js';

export const payload = commandPayload('recovery.check', { incidentId: recordId });

export const CHECK_RESULTS = Object.freeze(/** @type {const} */ (['fixed', 'still-there', 'not-checked']));

export const checkedSchema = v.strictObject({
  kind: v.literal('checked'),
  incidentId: recordId,
  providerId,
  result: v.picklist(CHECK_RESULTS),
  // The receipt the check stored, null when none ran
  receiptId: v.nullable(recordId),
});

/** @typedef {v.InferOutput<typeof checkedSchema>} Checked */

export const result = v.variant('kind', [checkedSchema, rejectedSchema, unavailableSchema]);

/** @typedef {v.InferOutput<typeof payload>} RecoveryCheck */
