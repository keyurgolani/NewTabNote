/**
 * recovery.dismiss, catalog version 1 (#20 slice 4a): take an open incident out of Needs
 * action, from the Recovery Center's Dismiss. It stays listed, as dismissed, and the dismissal
 * holds until the problem changes: its severity rises, its cause changes, or it's resolved and
 * comes back (incidents.js). `occurrences` is what the problem's card showed: a capture-risk
 * problem sighted since isn't dismissed, and the answer is conflict `incident-changed` with
 * its occurrences now as `currentRevision`, so the view shows it again. It answers committed
 * with the incident's id, rejected `incident-not-found` for one that isn't there or is
 * resolved, or unavailable while NewTabNoteTrust takes no writes.
 */

import * as v from '../../../lib/valibot/index.mjs';
import { commandPayload } from '../../../kernel/core/contracts/operation.js';
import { count } from '../../../kernel/core/contracts/fields.js';
import {
  committedSchema,
  conflictSchema,
  rejectedSchema,
  unavailableSchema,
  unknownSchema,
} from '../../../kernel/core/contracts/outcome-schemas.js';
import { recordId } from '../evidence.js';

export const payload = commandPayload('recovery.dismiss', {
  incidentId: recordId,
  occurrences: v.pipe(count, v.minValue(1)),
});

export const result = v.variant('kind', [
  committedSchema,
  rejectedSchema,
  conflictSchema,
  unavailableSchema,
  unknownSchema,
]);

/** @typedef {v.InferOutput<typeof payload>} RecoveryDismiss */
