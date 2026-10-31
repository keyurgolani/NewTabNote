/**
 * saveTheme, catalog version 1: a custom theme's name and CSS custom properties, under an id
 * taken when the save happens. A new id makes the theme; a stored one has its name and
 * properties replaced and the rest kept.
 */

import * as v from '../../../../lib/valibot/index.mjs';
import { THEME_PROPERTIES } from '../../domain/theme.js';
import { content, id } from '../fields.js';
import { commandPayload } from '../operation.js';
import { outcomeSchema } from '../outcome-schemas.js';

export const payload = commandPayload('saveTheme', {
  themeId: id,
  name: content(v.pipe(v.string(), v.maxLength(256))),
  properties: v.strictObject(
    Object.fromEntries(THEME_PROPERTIES.map(property => [property, v.optional(v.pipe(v.string(), v.maxLength(256)))])),
  ),
});

export const result = outcomeSchema;

/** @typedef {v.InferOutput<typeof payload>} SaveTheme */
