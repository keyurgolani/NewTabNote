/**
 * saveNoteContent, catalog version 1: an editor save, with the blocks as they were when it
 * started and what the editor derived from them. It writes those, `updatedAt`, and no other
 * note field, and it puts the blocks without deleting any (deleting blocks is its own command).
 * Note fields and blocks commit together on every adapter. `expectedRevision`, on an adapter
 * with revisions, makes a save over a newer write a conflict.
 */

import * as v from '../../../../lib/valibot/index.mjs';
import { blockInput } from '../entities.js';
import { content, entityId, revision } from '../fields.js';
import { commandPayload } from '../operation.js';
import { outcomeSchema } from '../outcome-schemas.js';

export const payload = commandPayload('saveNoteContent', {
  noteId: entityId('note'),
  blocks: v.array(blockInput),
  preview: v.optional(content(v.string())),
  todoProgress: v.optional(v.nullable(v.looseObject({ completed: v.number(), total: v.number() }))),
  expectedRevision: v.optional(revision),
});

export const result = outcomeSchema;

/** @typedef {v.InferOutput<typeof payload>} SaveNoteContent */
