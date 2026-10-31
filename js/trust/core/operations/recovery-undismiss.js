/**
 * recovery.undismiss, catalog version 1 (#20 slice 4a): "Show it again", which puts a dismissed
 * incident back in Needs action. Its answers are recovery.dismiss's.
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

export const payload = commandPayload('recovery.undismiss', { incidentId: recordId });

export const result = v.variant('kind', [committedSchema, rejectedSchema, unavailableSchema, unknownSchema]);

/** @typedef {v.InferOutput<typeof payload>} RecoveryUndismiss */
