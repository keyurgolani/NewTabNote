/**
 * renameNote, catalog version 1: a new title, which the search entry gets too. `typed` (the
 * default) is a title the user typed, which marks it as set by hand when it differs, and
 * `generated` one the user asked the AI for, which records `lastAutoTitleAt` instead.
 * `expectedRevision`, on an adapter with revisions, makes a rename over a newer write a
 * `revision-conflict`, as it does for saveNoteContent.
 */

import * as v from '../../../../lib/valibot/index.mjs';
import { content, entityId, revision } from '../fields.js';
import { commandPayload } from '../operation.js';
import { outcomeSchema } from '../outcome-schemas.js';

export const payload = commandPayload('renameNote', {
  noteId: entityId('note'),
  name: content(v.string()),
  origin: v.optional(v.picklist(['typed', 'generated'])),
  expectedRevision: v.optional(revision),
});

export const result = outcomeSchema;

/** @typedef {v.InferOutput<typeof payload>} RenameNote */
