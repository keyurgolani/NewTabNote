/**
 * convertNoteToTemplate, catalog version 1: makes a note a template, out of its folder, as
 * NotesManager.convertNoteToTemplate did. It writes those two fields and never the content.
 */

import { entityId } from '../fields.js';
import { commandPayload } from '../operation.js';
import { outcomeSchema } from '../outcome-schemas.js';

export const payload = commandPayload('convertNoteToTemplate', { noteId: entityId('note') });

export const result = outcomeSchema;

/** @typedef {import('../../../../lib/valibot/index.mjs').InferOutput<typeof payload>} ConvertNoteToTemplate */
