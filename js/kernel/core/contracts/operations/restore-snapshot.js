/**
 * restoreSnapshot, catalog version 1: the user reverts a note to one of its snapshots. In one
 * unit it stores the note as it is now as a new snapshot, `preSnapshotId`, keeping the newest
 * 50, replaces the note's blocks with `blocks`, the snapshot's, and sets `name`, the snapshot's
 * title when it has one, and `updatedAt`, and no other note field, so a pin, folder, trash, or
 * hand-set title made since stays. The search entry's name follows. A snapshot that's gone, or
 * that belongs to another note, is refused, and so is a note that's gone.
 */

import * as v from '../../../../lib/valibot/index.mjs';
import { blockInput } from '../entities.js';
import { content, entityId } from '../fields.js';
import { commandPayload } from '../operation.js';
import { outcomeSchema } from '../outcome-schemas.js';

export const payload = commandPayload('restoreSnapshot', {
  noteId: entityId('note'),
  snapshotId: entityId('snapshot'),
  preSnapshotId: entityId('snapshot'),
  blocks: v.array(blockInput),
  name: v.optional(content(v.string())),
});

export const result = outcomeSchema;

/** @typedef {v.InferOutput<typeof payload>} RestoreSnapshot */
