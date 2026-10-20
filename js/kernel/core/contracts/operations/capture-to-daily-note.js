/**
 * captureToDailyNote, catalog version 1: a page, or selected text and the page it came from,
 * added to today's Daily Note. `noteId` is the id the Daily Note gets if this capture creates it,
 * and `blockId` the captured block's. A tab can lack a URL or a title.
 */

import * as v from '../../../../lib/valibot/index.mjs';
import { content, entityId } from '../fields.js';
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
});

export const result = outcomeSchema;

/** @typedef {v.InferOutput<typeof payload>} CaptureToDailyNote */
