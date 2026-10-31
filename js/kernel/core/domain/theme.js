/**
 * Custom themes, as IndexedDB's `themes` store has kept them since 1.4.0: a name, the CSS
 * custom properties the theme sets, and when it was last saved. The theme a page shows is the
 * `theme` preference, which names a built-in theme or one of these.
 */

import { compareKeys, isIndexKey } from './note.js';

/**
 * The CSS custom properties a custom theme sets: the ones js/theme-engine.js's light theme
 * has, which the Theme Builder offers a color picker for
 */
export const THEME_PROPERTIES = Object.freeze([
  '--bg-primary',
  '--bg-secondary',
  '--bg-hover',
  '--bg-active',
  '--text-primary',
  '--text-secondary',
  '--text-muted',
  '--text-placeholder',
  '--border-color',
  '--accent-color',
  '--accent-hover',
  '--danger-color',
  '--code-bg',
  '--selection-bg',
]);

/**
 * @typedef {object} ThemeFields
 * @property {string} name
 * @property {Record<string, string>} properties - CSS custom property, to its value
 * @property {number} updatedAt
 */

/** @typedef {{id: string} & Partial<ThemeFields> & Record<string, unknown>} ThemeRecord */

/**
 * The theme a save leaves: a new one, field for field what Storage.saveCustomTheme wrote for
 * the Theme Builder, or a stored one with its name and properties replaced and the rest of it
 * kept.
 * @param {ThemeRecord | undefined} stored
 * @param {{id: string, name: string, properties: Record<string, string>, now: number}} fields
 * @returns {ThemeRecord & ThemeFields}
 */
export function savedTheme(stored, { id, name, properties, now }) {
  return { ...(stored || {}), id, name, properties: { ...properties }, updatedAt: now };
}

/**
 * Whether `value` is a theme's properties: some of THEME_PROPERTIES, each with a text value
 * @param {unknown} value
 * @returns {value is Record<string, string>}
 */
export function isThemeProperties(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  return Object.entries(value).every(([key, item]) => THEME_PROPERTIES.includes(key) && typeof item === 'string');
}

/**
 * The custom themes in the order Storage.getCustomThemes listed them: the last saved first.
 * It read through the `updatedAt` index, which leaves out a theme without a usable updatedAt,
 * so this does too.
 * @param {ThemeRecord[]} themes
 * @returns {ThemeRecord[]}
 */
export function themesInListOrder(themes) {
  return themes
    .filter(theme => isIndexKey(theme.updatedAt))
    .sort((a, b) => compareKeys(a.updatedAt, b.updatedAt) || compareKeys(a.id, b.id))
    .reverse();
}
