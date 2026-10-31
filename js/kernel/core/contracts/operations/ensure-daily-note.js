/**
 * ensureDailyNote, catalog version 1: the Daily Note for a day, made when there's none. With no
 * `dateStr` it's today's, keyed by the UTC date, as Storage.ensureDailyNote keys it; a calendar
 * day names its own `YYYY-MM-DD`, as Storage.ensureDailyNoteForDate takes it. `noteId` is the id
 * the Daily Note gets if this command makes it. `at`, with no `dateStr`, is the instant that
 * decides which day is today, so its caller reads that same day back with findDailyNote; it's
 * the kernel's clock when left out. A new one starts with the Daily Note template's blocks.
 * One that's there already answers `daily-note-exists` and changes nothing.
 */

import * as v from '../../../../lib/valibot/index.mjs';
import { entityId, timestamp } from '../fields.js';
import { commandPayload } from '../operation.js';
import { outcomeSchema } from '../outcome-schemas.js';

export const payload = commandPayload('ensureDailyNote', {
  noteId: entityId('note'),
  dateStr: v.optional(v.pipe(v.string(), v.regex(/^\d{4}-\d{2}-\d{2}$/))),
  at: v.optional(timestamp),
});

export const result = outcomeSchema;

/** @typedef {v.InferOutput<typeof payload>} EnsureDailyNote */
