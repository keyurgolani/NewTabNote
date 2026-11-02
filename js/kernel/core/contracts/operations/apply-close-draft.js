/**
 * applyCloseDraft, catalog version 1: the next start's apply of one close-time draft (#33), as
 * a closing page wrote it to its localStorage, in 1.4.3's format or the stack's
 * (domain/close-draft.js). The whole draft is what the user wrote, with the digests of what the
 * page saw, so all of it is content. Its outcome codes are application/close-drafts.js's.
 */

import * as v from '../../../../lib/valibot/index.mjs';
import { blockInput } from '../entities.js';
import { content, entityId, id } from '../fields.js';
import { commandPayload } from '../operation.js';
import { outcomeSchema } from '../outcome-schemas.js';

export const payload = commandPayload('applyCloseDraft', {
  draft: content(
    v.looseObject({
      v: v.literal(1),
      id,
      noteId: entityId('note'),
      at: v.number(),
      base: v.looseObject({}),
      blocks: v.array(blockInput),
      deletedBlockIds: v.array(entityId('block')),
    }),
  ),
});

export const result = outcomeSchema;

/** @typedef {v.InferOutput<typeof payload>} ApplyCloseDraft */
