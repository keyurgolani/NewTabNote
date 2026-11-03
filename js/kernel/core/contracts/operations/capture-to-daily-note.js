/**
 * captureToDailyNote, catalog version 1: a page, or selected text and the page it came from,
 * added to today's Daily Note. `noteId` is the id the Daily Note gets if this capture creates it,
 * and `blockId` the captured block's. A tab can lack a URL or a title. `at` is the instant the
 * capture was made, which decides which day is today, as ensureDailyNote's does, so one the
 * coordinator's drain replays on a later day lands in its own day's note (#35 slice 3); it's
 * the kernel's clock when left out.
 */

import * as v from '../../../../lib/valibot/index.mjs';
import { content, entityId, timestamp } from '../fields.js';
import { commandPayload } from '../operation.js';
import { outcomeSchema } from '../outcome-schemas.js';

export const payload = commandPayload('captureToDailyNote', {
  noteId: entityId('note'),
  blockId: entityId('block'),
  capture: v.variant('type', [
    v.strictObject({
      type: v.literal('bookmark'),
      url: v.optional(content(v.string())),
      title: v.optional(content(v.string())),
    }),
    v.strictObject({
      type: v.literal('text'),
      content: content(v.string()),
      source: v.optional(content(v.string())),
    }),
  ]),
  at: v.optional(timestamp),
});

export const result = outcomeSchema;

/** @typedef {v.InferOutput<typeof payload>} CaptureToDailyNote */
