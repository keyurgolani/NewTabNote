/**
 * moveNoteToFolder, catalog version 1: files a note in a folder, or at the root with null. It
 * writes the note's folderId and nothing else, so an open note's next save keeps it. A folder
 * that isn't stored is refused, against the folders as committed.
 */

import * as v from '../../../../lib/valibot/index.mjs';
import { entityId } from '../fields.js';
import { commandPayload } from '../operation.js';
import { outcomeSchema } from '../outcome-schemas.js';

export const payload = commandPayload('moveNoteToFolder', {
  noteId: entityId('note'),
  folderId: v.nullable(entityId('folder')),
});

export const result = outcomeSchema;

/** @typedef {v.InferOutput<typeof payload>} MoveNoteToFolder */
