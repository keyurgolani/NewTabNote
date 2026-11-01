/**
 * applyRemoteContent, catalog version 1 (#17 PR 4b): one note's title and blocks as another
 * profile has them, which applyRemoteChanges sends for each note. They replace the note's, with
 * its preview and todo progress from them, its search entry's name, and its wiki links, as a
 * save and an insert have them. A note that's moved past `expectedRevision` is a
 * `revision-conflict`, kept in `conflicts` with the remote's title and blocks, and changes in
 * nothing; one whose title and blocks are already the remote's changes in nothing either.
 * `expectedRevision` is null when the change said none, which counts as 0: one that lands then,
 * on a note as 1.4.x stored it, keeps the title and blocks it replaced in `conflicts` and
 * answers `remote-content-replaced-legacy` (R131). A note this profile doesn't have is made as
 * the remote has it, its flags and folder included, unless it was deleted here for good, which
 * answers `note-deleted` and keeps nothing.
 */

import * as v from '../../../../lib/valibot/index.mjs';
import { blockInput, noteRecord } from '../entities.js';
import { content, entityId, revision } from '../fields.js';
import { commandPayload } from '../operation.js';
import { outcomeSchema } from '../outcome-schemas.js';

export const payload = commandPayload('applyRemoteContent', {
  noteId: entityId('note'),
  note: content(noteRecord),
  blocks: v.array(blockInput),
  expectedRevision: v.nullable(revision),
});

export const result = outcomeSchema;

/** @typedef {v.InferOutput<typeof payload>} ApplyRemoteContent */
