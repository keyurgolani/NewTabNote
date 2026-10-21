/**
 * getNoteBlocks, catalog version 1: a note's blocks, in note order.
 */

import * as v from '../../../../lib/valibot/index.mjs';
import { entityId } from '../fields.js';
import { blockRecord } from '../entities.js';
import { queryPayload } from '../operation.js';
import { queryStateSchema } from '../outcome-schemas.js';

export const payload = queryPayload('getNoteBlocks', { noteId: entityId('note') });

export const result = queryStateSchema(v.array(blockRecord));

/** @typedef {v.InferOutput<typeof payload>} GetNoteBlocks */
