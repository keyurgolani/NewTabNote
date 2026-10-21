/**
 * createNote, catalog version 1: a note with the fields Storage.createNote has always written,
 * plus its search entry. `folderId` files it, and `blocks` are its first blocks. `pinned` and
 * `titleManuallySet` carry over what a note had when the editor saves its text as a new note,
 * which 1.4.x's next save wrote over the record Storage.createNote made.
 */

import * as v from '../../../../lib/valibot/index.mjs';
import { blockInput } from '../entities.js';
import { content, entityId } from '../fields.js';
import { commandPayload } from '../operation.js';
import { outcomeSchema } from '../outcome-schemas.js';

export const payload = commandPayload('createNote', {
  noteId: entityId('note'),
  name: v.optional(content(v.string())),
  folderId: v.optional(v.nullable(entityId('folder'))),
  blocks: v.optional(v.array(blockInput)),
  pinned: v.optional(v.boolean()),
  titleManuallySet: v.optional(v.boolean()),
});

export const result = outcomeSchema;

/** @typedef {v.InferOutput<typeof payload>} CreateNote */
