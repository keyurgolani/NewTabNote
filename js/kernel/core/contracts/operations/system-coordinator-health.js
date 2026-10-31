/**
 * system.coordinatorHealth, catalog version 1: the background coordinator's own state (#35,
 * "Incidents and health"), which #20's `coordinator` provider reads. What its welcome says,
 * its instance id and when it started, the commands it ran by outcome, and when the oldest
 * journal entry it couldn't replay was written, null until #35's journal (slice 3). Ids,
 * counts, times, and codes only: nothing in it names a note or holds what the user wrote.
 */

import * as v from '../../../../lib/valibot/index.mjs';
import { code, count, id, timestamp } from '../fields.js';
import { queryPayload } from '../operation.js';
import { OUTCOME_KINDS } from '../outcomes.js';
import { queryStateSchema } from '../outcome-schemas.js';

export const payload = queryPayload('system.coordinatorHealth', {});

/** The coordinator's state since this worker instance started */
export const coordinatorHealth = v.strictObject({
  status: v.picklist(['ready', 'degraded']),
  reason: v.optional(code),
  coordinatorId: id,
  // When its first start began, and null before one
  startedAt: v.nullable(timestamp),
  commands: v.array(v.strictObject({ outcome: v.picklist([...OUTCOME_KINDS, 'bulk']), count })),
  oldestOrphanedEntryAt: v.nullable(timestamp),
});

export const result = queryStateSchema(coordinatorHealth);

/** @typedef {v.InferOutput<typeof payload>} CoordinatorHealthQuery */
/** @typedef {v.InferOutput<typeof coordinatorHealth>} CoordinatorHealth */
