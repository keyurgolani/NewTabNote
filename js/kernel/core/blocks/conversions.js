/**
 * Lossless conversions (#14 slice 3): what a block keeps when it turns into another type, and
 * the structure that goes, which the editor asks about first. DOM-free, like the models.
 *
 * A conversion never deletes text the user wrote. Each built-in's model declares its part
 * (models.js, `convert`): the lines of rich text its own fields keep, escaped, the structure
 * that goes, and the rich text that moves to new text blocks after it. Here the parts become
 * one answer:
 * - `content`: the new block's text. A type that keeps no lines keeps its content as it is; one
 *   that does keeps its content first, unless that's blank, then its lines, one per line.
 * - `removes`: what goes, in STRUCTURE's order: a table's `grid`, an `image` (every type's
 *   `imageUrl`, unless it turns into an image), a `video`'s embed, an attached `file`, and a
 *   toggle's `arrow` when it hides something. The editor asks before any of them goes.
 * - `after`: new text blocks to add right after it, a toggle's hidden content.
 *
 * Only a block decode reads as known (current or upcast) converts, into a type with a
 * definition, other than its own. Anything else, a block in a safe state among them, converts
 * to nothing, so nothing re-encodes it. So does a model with no `convert`, or one whose answer
 * isn't well formed.
 */

import { isBlankText } from './meaningful.js';

/** @typedef {import('./catalog.js').Catalog} Catalog */

/** The structure a conversion can remove, in the order the editor names it */
export const STRUCTURE = Object.freeze(/** @type {const} */ (['grid', 'image', 'video', 'file', 'arrow']));

/** @typedef {typeof STRUCTURE[number]} Structure */

/**
 * What a model's `convert` gives for one of its records
 * @typedef {Readonly<{text: readonly string[], removes: readonly Structure[], after: readonly string[]}>} ConvertPart
 */

/**
 * A conversion, frozen
 * @typedef {Readonly<{content: string, removes: readonly Structure[], after: readonly Readonly<{type: 'text', content: string}>[]}>} Conversion
 */

/** @param {unknown} value @returns {value is readonly string[]} */
const isTextList = value => Array.isArray(value) && value.every(item => typeof item === 'string');

/**
 * What `record` keeps and removes when it turns into `target`, on `catalog`, or null when it
 * doesn't convert
 * @param {Catalog} catalog
 * @param {unknown} record
 * @param {unknown} target
 * @returns {Conversion | null}
 */
export function conversionOn(catalog, record, target) {
  if (typeof target !== 'string' || !catalog.definition(target)) return null;
  const decoded = catalog.decode(record);
  if (decoded.state !== 'current' && decoded.state !== 'upcast') return null;
  const { block, type } = decoded;
  if (type === target) return null;
  const convert = catalog.definition(type)?.model.convert;
  if (typeof convert !== 'function') return null;
  const part = convert(block);
  if (part === null || typeof part !== 'object' || !isTextList(part.text) || !isTextList(part.after)) return null;
  if (!Array.isArray(part.removes) || !part.removes.every(item => STRUCTURE.includes(item))) return null;

  const content = typeof block.content === 'string' ? block.content : '';
  const lines = part.text.length === 0 ? [content] : [...(isBlankText(content) ? [] : [content]), ...part.text];
  const removed = new Set(part.removes);
  // Every type has an imageUrl, which only an image keeps
  if (typeof block.imageUrl === 'string' && block.imageUrl !== '' && target !== 'image') removed.add('image');
  return Object.freeze({
    content: lines.join('<br>'),
    removes: Object.freeze(STRUCTURE.filter(item => removed.has(item))),
    after: Object.freeze(part.after.map(text => Object.freeze({ type: /** @type {'text'} */ ('text'), content: text }))),
  });
}
