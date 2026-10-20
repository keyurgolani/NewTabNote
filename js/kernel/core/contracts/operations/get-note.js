/**
 * getNote, catalog version 1: a note, with its revision from an adapter with revisions, for
 * saveNoteContent's `expectedRevision`.
 */

import * as v from '../../../../lib/valibot/index.mjs';
import { entityId, revision } from '../fields.js';
import { noteRecord } from '../entities.js';
import { queryPayload } from '../operation.js';
import { queryStateSchema } from '../outcome-schemas.js';

export const payload = queryPayload('getNote', { noteId: entityId('note') });

export const result = queryStateSchema(v.strictObject({ note: noteRecord, revision: v.optional(revision) }));

/** @typedef {v.InferOutput<typeof payload>} GetNote */
