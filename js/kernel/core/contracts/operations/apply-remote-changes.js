/**
 * applyRemoteChanges, catalog version 1 (#17 PR 4b, for #19's sync): notes as another profile
 * has them, each with its blocks and the versions on this profile it was made from, applied a
 * note at a time. Once it runs it answers with an outcome per note, and a plain outcome when it
 * doesn't. A note's title and blocks land only while it's at `expectedRevision`, and its pin,
 * archive, trash, template, and folder only while it's at `expectedPlacementVersion`, a trash
 * also only on the text it was made from; either left out counts as 0. A part that doesn't land
 * is a conflict, kept in `conflicts` with the remote's part, and the note stays as it is. A
 * note's outcome names what each part did. A note this profile doesn't have is made as the
 * remote has it, unless it was deleted here for good (`note-deleted`). It deletes no note
 * (application/remote.js).
 */

import * as v from '../../../../lib/valibot/index.mjs';
import { blockInput, noteRecord } from '../entities.js';
import { content, revision } from '../fields.js';
import { commandPayload } from '../operation.js';
import { bulkResultSchema } from '../outcome-schemas.js';

export const payload = commandPayload('applyRemoteChanges', {
  changes: v.pipe(
    v.array(
      v.strictObject({
        // The note as the remote stores it, its text and title included
        note: content(noteRecord),
        blocks: v.array(blockInput),
        expectedRevision: v.optional(revision),
        expectedPlacementVersion: v.optional(revision),
      }),
    ),
    v.minLength(1),
  ),
});

export const result = bulkResultSchema;

/** @typedef {v.InferOutput<typeof payload>} ApplyRemoteChanges */
