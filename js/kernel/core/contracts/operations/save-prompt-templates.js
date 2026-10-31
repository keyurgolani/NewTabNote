/**
 * savePromptTemplates, catalog version 1: AI chat's prompt templates, as the chat sanitized
 * them.
 */

import * as v from '../../../../lib/valibot/index.mjs';
import { content } from '../fields.js';
import { commandPayload } from '../operation.js';
import { outcomeSchema } from '../outcome-schemas.js';

export const payload = commandPayload('savePromptTemplates', { templates: content(v.array(v.unknown())) });

export const result = outcomeSchema;

/** @typedef {v.InferOutput<typeof payload>} SavePromptTemplates */
