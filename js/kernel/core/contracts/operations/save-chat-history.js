/**
 * saveChatHistory, catalog version 1: one of AI chat's two conversations, the note chat or the
 * global chat, as its history (what the provider is sent) and its messages (what the panel
 * shows), saved together.
 */

import * as v from '../../../../lib/valibot/index.mjs';
import { content } from '../fields.js';
import { commandPayload } from '../operation.js';
import { outcomeSchema } from '../outcome-schemas.js';

export const payload = commandPayload('saveChatHistory', {
  chat: v.picklist(['note', 'global']),
  history: content(v.array(v.unknown())),
  messages: content(v.array(v.unknown())),
});

export const result = outcomeSchema;

/** @typedef {v.InferOutput<typeof payload>} SaveChatHistory */
