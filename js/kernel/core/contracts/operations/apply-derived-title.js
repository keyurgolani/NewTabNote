/**
 * applyDerivedTitle, catalog version 1: a title a background job derived, which is dropped when
 * the note has a title set by hand. `contentHash` names the content it was derived from.
 */

import * as v from '../../../../lib/valibot/index.mjs';
import { content, entityId } from '../fields.js';
import { commandPayload } from '../operation.js';
import { outcomeSchema } from '../outcome-schemas.js';

export const payload = commandPayload('applyDerivedTitle', {
  noteId: entityId('note'),
  name: content(v.string()),
  contentHash: v.optional(v.pipe(v.string(), v.maxLength(128))),
});

export const result = outcomeSchema;

/** @typedef {v.InferOutput<typeof payload>} ApplyDerivedTitle */
