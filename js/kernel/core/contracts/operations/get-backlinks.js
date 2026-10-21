/**
 * getBacklinks, catalog version 1: the notes whose wiki links point at a note, as
 * Storage.getBacklinks has listed them for the editor's backlinks panel, in the order the
 * links are stored, whatever list each note is in.
 */

import * as v from '../../../../lib/valibot/index.mjs';
import { entityId } from '../fields.js';
import { noteRecord } from '../entities.js';
import { queryPayload } from '../operation.js';
import { queryStateSchema } from '../outcome-schemas.js';

export const payload = queryPayload('getBacklinks', { noteId: entityId('note') });

export const result = queryStateSchema(v.array(noteRecord));

/** @typedef {v.InferOutput<typeof payload>} GetBacklinks */
