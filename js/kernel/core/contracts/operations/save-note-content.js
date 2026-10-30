/**
 * saveNoteContent, catalog version 1: an editor save, with the blocks as they were when it
 * started and what the editor derived from them. It writes those, `updatedAt`, and no other
 * note field, and it puts the blocks without deleting any (deleting blocks is its own command).
 * `name` is a title set in the editor since the last save, which the save writes with the
 * blocks, as 1.4.x's editor save did, and which the search entry gets too. `titleOrigin` says
 * who set it: `typed` (the default), the user, which writes `titleManuallySet`, or
 * `generated`, the AI, which writes `lastAutoTitleAt` instead. A generated title is dropped
 * when the note has a title set by hand, as applyDerivedTitle drops one: the rest of the save
 * lands and it answers `content-saved-title-kept`. A save with no title leaves the stored one
 * as it is.
 * `linkedNames` are the note names the text's `[[wiki links]]` hold, which replace the links
 * the note had, as 1.4.x's save replaced them after the note was stored. Note fields and
 * blocks commit together on every adapter. `expectedRevision`, on an adapter with revisions,
 * makes a save over a newer write a conflict.
 */

import * as v from '../../../../lib/valibot/index.mjs';
import { blockInput } from '../entities.js';
import { content, count, entityId, revision } from '../fields.js';
import { commandPayload } from '../operation.js';
import { outcomeSchema } from '../outcome-schemas.js';

export const payload = commandPayload('saveNoteContent', {
  noteId: entityId('note'),
  blocks: v.array(blockInput),
  preview: v.optional(content(v.string())),
  todoProgress: v.optional(v.nullable(v.strictObject({ completed: count, total: count }))),
  name: v.optional(content(v.string())),
  titleOrigin: v.optional(v.picklist(['typed', 'generated'])),
  linkedNames: v.optional(v.array(content(v.string()))),
  expectedRevision: v.optional(revision),
});

export const result = outcomeSchema;

/** @typedef {v.InferOutput<typeof payload>} SaveNoteContent */
