/**
 * applyDerivedTitle, catalog version 1: a title a background job derived, which is dropped when
 * the note has a title set by hand. `contentHash` names the content it was derived from.
 * `expectedRevision`, on an adapter with revisions, makes a title derived from a note that's
 * moved past it a conflict, kept in `conflicts`, which changes nothing (#17 PR 4b, Q3).
 */

import * as v from '../../../../lib/valibot/index.mjs';
import { content, entityId, revision } from '../fields.js';
import { commandPayload } from '../operation.js';
import { outcomeSchema } from '../outcome-schemas.js';

export const payload = commandPayload('applyDerivedTitle', {
  noteId: entityId('note'),
  name: content(v.string()),
  contentHash: v.optional(v.pipe(v.string(), v.maxLength(128))),
  expectedRevision: v.optional(revision),
});

export const result = outcomeSchema;

/** @typedef {v.InferOutput<typeof payload>} ApplyDerivedTitle */
