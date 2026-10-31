/**
 * getNoteList, catalog version 1: every note, every folder, and every search entry, read in
 * one transaction, for the new tab's note-list projection (application/note-list.js). It
 * takes the place of the six reads App and the sidebar made after each change.
 */

import * as v from '../../../../lib/valibot/index.mjs';
import { folderRecord, noteRecord, searchEntryRecord } from '../entities.js';
import { queryPayload } from '../operation.js';
import { queryStateSchema } from '../outcome-schemas.js';

export const payload = queryPayload('getNoteList', {});

export const result = queryStateSchema(
  v.strictObject({
    notes: v.array(noteRecord),
    folders: v.array(folderRecord),
    searchEntries: v.array(searchEntryRecord),
  }),
);

/** @typedef {v.InferOutput<typeof payload>} GetNoteList */
