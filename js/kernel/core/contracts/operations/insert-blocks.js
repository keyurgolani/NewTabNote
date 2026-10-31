/**
 * insertBlocks, catalog version 1: new blocks AI chat adds to a note, at `atOrder` (the
 * blocks at or past it move down to make room) or after the last block. In one unit over the
 * note and its blocks it moves them, stores the new ones, and sets the note's preview, todo
 * progress, and `updatedAt` from its blocks as stored. The note's wiki links follow, as a save
 * replaces them. A block id that's already stored is refused. `expectedRevision`, on an adapter
 * with revisions, makes an insert into a note that's moved past it a conflict, which keeps the
 * blocks in `conflicts` and writes nothing (#17 PR 4b, Q3).
 */

import * as v from '../../../../lib/valibot/index.mjs';
import { blockInput } from '../entities.js';
import { count, entityId, revision } from '../fields.js';
import { commandPayload } from '../operation.js';
import { outcomeSchema } from '../outcome-schemas.js';

export const payload = commandPayload('insertBlocks', {
  noteId: entityId('note'),
  blocks: v.pipe(v.array(blockInput), v.minLength(1)),
  atOrder: v.optional(count),
  expectedRevision: v.optional(revision),
});

export const result = outcomeSchema;

/** @typedef {v.InferOutput<typeof payload>} InsertBlocks */
