/**
 * recovery.dismiss, catalog version 1 (#20 slice 4a): take an open incident out of Needs
 * action, from the Recovery Center's Dismiss. It stays listed, as dismissed, and the dismissal
 * holds until the problem changes: its severity rises, its cause changes, or it's resolved and
 * comes back (incidents.js). It answers committed with the incident's id, rejected
 * `incident-not-found` for one that isn't there or is resolved, or unavailable while
 * NewTabNoteTrust takes no writes.
 */

import * as v from '../../../lib/valibot/index.mjs';
import { commandPayload } from '../../../kernel/core/contracts/operation.js';
import {
  committedSchema,
  rejectedSchema,
  unavailableSchema,
  unknownSchema,
} from '../../../kernel/core/contracts/outcome-schemas.js';
import { recordId } from '../evidence.js';

export const payload = commandPayload('recovery.dismiss', { incidentId: recordId });

export const result = v.variant('kind', [committedSchema, rejectedSchema, unavailableSchema, unknownSchema]);

/** @typedef {v.InferOutput<typeof payload>} RecoveryDismiss */
