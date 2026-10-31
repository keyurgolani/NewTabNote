/**
 * saveSnapshot, catalog version 1: a copy of a note's blocks and title for its version
 * history, which the editor takes every 5 minutes while the note is edited. The kernel's clock
 * stamps it, and the note keeps its newest 50, as Storage.saveSnapshot kept them, in the same
 * unit. A note that's gone gets none, where 1.4.x stored one for no note.
 */

import * as v from '../../../../lib/valibot/index.mjs';
import { blockInput } from '../entities.js';
import { content, entityId } from '../fields.js';
import { commandPayload } from '../operation.js';
import { outcomeSchema } from '../outcome-schemas.js';

export const payload = commandPayload('saveSnapshot', {
  noteId: entityId('note'),
  snapshotId: entityId('snapshot'),
  blocks: v.array(blockInput),
  title: content(v.string()),
});

export const result = outcomeSchema;

/** @typedef {v.InferOutput<typeof payload>} SaveSnapshot */
