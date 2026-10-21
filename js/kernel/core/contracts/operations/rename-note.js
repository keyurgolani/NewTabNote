/**
 * renameNote, catalog version 1: a new title, which the search entry gets too. `typed` (the
 * default) is a title the user typed, which marks it as set by hand when it differs, and
 * `generated` one the user asked the AI for, which records `lastAutoTitleAt` instead.
 */

import * as v from '../../../../lib/valibot/index.mjs';
import { content, entityId } from '../fields.js';
import { commandPayload } from '../operation.js';
import { outcomeSchema } from '../outcome-schemas.js';

export const payload = commandPayload('renameNote', {
  noteId: entityId('note'),
  name: content(v.string()),
  origin: v.optional(v.picklist(['typed', 'generated'])),
});

export const result = outcomeSchema;

/** @typedef {v.InferOutput<typeof payload>} RenameNote */
