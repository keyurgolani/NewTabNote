/**
 * convertTemplateToNote, catalog version 1: makes a template a note again. It writes that one
 * field and never the content.
 * `expectedPlacementVersion`, the placement version the caller last read (getNote), makes it a
 * `placement-conflict` on an adapter with revisions when the note's has moved since.
 */

import * as v from '../../../../lib/valibot/index.mjs';
import { entityId, revision } from '../fields.js';
import { commandPayload } from '../operation.js';
import { outcomeSchema } from '../outcome-schemas.js';

export const payload = commandPayload('convertTemplateToNote', {
  noteId: entityId('note'),
  expectedPlacementVersion: v.optional(revision),
});

export const result = outcomeSchema;

/** @typedef {import('../../../../lib/valibot/index.mjs').InferOutput<typeof payload>} ConvertTemplateToNote */
