/**
 * findDailyNote, catalog version 1: the Daily Note for a day (`YYYY-MM-DD`), as
 * Storage.ensureDailyNoteForDate finds it, or empty when there's none. The new tab reads the
 * Daily Note it opens with it after ensureDailyNote, whether that found the note or made it.
 */

import * as v from '../../../../lib/valibot/index.mjs';
import { noteRecord } from '../entities.js';
import { queryPayload } from '../operation.js';
import { queryStateSchema } from '../outcome-schemas.js';

export const payload = queryPayload('findDailyNote', { dateStr: v.pipe(v.string(), v.regex(/^\d{4}-\d{2}-\d{2}$/)) });

export const result = queryStateSchema(v.strictObject({ note: noteRecord }));

/** @typedef {v.InferOutput<typeof payload>} FindDailyNote */
