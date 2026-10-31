/**
 * getNotesByIds, catalog version 1: the notes among `noteIds` that are stored, and their
 * search entries, read in one transaction. The note-list projection reads what a commit
 * changed with it, in place of reading every list again.
 */

import * as v from '../../../../lib/valibot/index.mjs';
import { entityId } from '../fields.js';
import { noteRecord, searchEntryRecord } from '../entities.js';
import { queryPayload } from '../operation.js';
import { queryStateSchema } from '../outcome-schemas.js';

export const payload = queryPayload('getNotesByIds', {
  noteIds: v.pipe(v.array(entityId('note')), v.minLength(1)),
});

export const result = queryStateSchema(
  v.strictObject({ notes: v.array(noteRecord), searchEntries: v.array(searchEntryRecord) }),
);

/** @typedef {v.InferOutput<typeof payload>} GetNotesByIds */
