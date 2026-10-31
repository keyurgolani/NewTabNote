/**
 * The block previews (#14 slice 1) on their own: the text the note list shows of a block and
 * the kernel's note metadata reads (SidebarUtils' `extractBlockText` and the kernel's
 * `blockText` in 1.4.x), with the regex `stripTags` and nothing else. The models
 * (models.js) take their `preview` and `search` projections from here, so there's one of each.
 *
 * The kernel's note domain reads previews through this module rather than the catalog, so the
 * Popup, the Side Panel and the service worker, which need nothing else of the model layer
 * yet, load neither html-text.js's tokenizer nor its table of character references.
 * `previewText` here gives what the built-ins' catalog gives for every record
 * (test/blocks-characterization.test.js holds the two together).
 */

import { stripTags } from './strip-tags.js';

/** @typedef {Readonly<Record<string, unknown>>} BlockRecord */
/** @typedef {(record: BlockRecord) => string} Preview */

/**
 * A text-like block's preview, and every type's with no preview of its own, a type no
 * definition has included
 * @param {BlockRecord} record
 */
export const previewOfContent = record => stripTags(record.content);

/**
 * The types whose preview reads other fields than `content`
 * @type {Readonly<Record<string, Preview>>}
 */
export const PREVIEWS = Object.freeze({
  toggle: record => [stripTags(record.content), stripTags(record.children)].filter(Boolean).join(' '),
  table: record =>
    Array.isArray(record.tableData)
      ? record.tableData
          .flat()
          .map(cell => stripTags(cell))
          .filter(Boolean)
          .join(' ')
      : stripTags(record.content),
  bookmark: record => [record.title, record.description, record.url].filter(Boolean).join(' '),
  video: record => stripTags(record.videoUrl),
  file: record => stripTags(record.fileName),
  equation: record => stripTags(record.equation),
});

/**
 * A block's preview, `''` for anything that isn't an object. Only an own, exact type matches,
 * as the catalog matches it.
 * @param {unknown} block
 * @returns {string}
 */
export function previewText(block) {
  if (block === null || typeof block !== 'object') return '';
  const record = /** @type {BlockRecord} */ (block);
  const type = record.type;
  const preview = typeof type === 'string' && Object.hasOwn(PREVIEWS, type) ? PREVIEWS[type] : previewOfContent;
  return preview(record);
}
