/**
 * listNotes, catalog version 1: one view's notes, in the order Storage lists them.
 */

import * as v from '../../../../lib/valibot/index.mjs';
import { NOTE_VIEWS } from '../../domain/note.js';
import { noteRecord } from '../entities.js';
import { queryPayload } from '../operation.js';
import { queryStateSchema } from '../outcome-schemas.js';

export const payload = queryPayload('listNotes', { view: v.picklist(NOTE_VIEWS) });

export const result = queryStateSchema(v.array(noteRecord));

/** @typedef {v.InferOutput<typeof payload>} ListNotes */
