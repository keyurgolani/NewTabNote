/**
 * findTombstones, catalog version 1: which of `noteIds` were deleted for good, and why, by the
 * tombstones their deletes left (#17 PR 2b, domain/tombstone.js). The coordinator's drain reads
 * it before it replays, so it deletes the journal entries of a note deleted for good and never
 * replays one (#35 slice 3). Ids and reasons only, empty when none of them was.
 */

import * as v from '../../../../lib/valibot/index.mjs';
import { code, entityId } from '../fields.js';
import { queryPayload } from '../operation.js';
import { queryStateSchema } from '../outcome-schemas.js';

export const payload = queryPayload('findTombstones', { noteIds: v.array(entityId('note')) });

export const result = queryStateSchema(
  v.strictObject({ tombstones: v.array(v.strictObject({ id: entityId('note'), reason: code })) }),
);

/** @typedef {v.InferOutput<typeof payload>} FindTombstones */
