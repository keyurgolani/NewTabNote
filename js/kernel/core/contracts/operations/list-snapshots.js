/**
 * listSnapshots, catalog version 1: a note's snapshots, newest first, each as its id, time,
 * and title. getSnapshot reads one's blocks, so the list of up to 50 stays small.
 */

import * as v from '../../../../lib/valibot/index.mjs';
import { content, entityId, timestamp } from '../fields.js';
import { queryPayload } from '../operation.js';
import { queryStateSchema } from '../outcome-schemas.js';

export const payload = queryPayload('listSnapshots', { noteId: entityId('note') });

export const result = queryStateSchema(
  v.array(v.strictObject({ id: entityId('snapshot'), timestamp, title: content(v.string()) })),
);

/** @typedef {v.InferOutput<typeof payload>} ListSnapshots */
