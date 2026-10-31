/**
 * The block model layer (#14 slice 1): what the kernel, the worker, and the legacy callers
 * read blocks through. DOM-free and synchronous, statically imported, so the worker bundles
 * it; nothing here loads lazily.
 *
 * The functions here run on the built-ins' catalog: the 18 built-in models, less any whose
 * definition is invalid (contract.js), which npm test fails on. A root that registers the
 * `block` family on #15's kit (js/kernel/composition/blocks.js) gets a catalog of what resolved
 * there, and the same projections over it.
 *
 * Each projection keeps its 1.4.x caller's output byte for byte, and what it did with
 * something that isn't a block:
 * - previewText and searchText: the note list's and the kernel's text of a block, `''` for
 *   anything that isn't an object;
 * - plainText: the editor's, `''` for anything falsy;
 * - aiContextText: AI chat's and the AI jobs', `''` for anything falsy;
 * - markdownOf: every Markdown export's, which reads `content` first, so it throws for null or
 *   undefined, and for content that's neither a string nor falsy.
 */

import { BUILT_IN_BLOCKS } from './builtins.js';
import { createCatalog } from './catalog.js';
import { replaceTags, stripTags } from './strip-tags.js';
import { wikiLinkNames } from './wiki-links.js';

/** @typedef {import('./catalog.js').Catalog} Catalog */
/** @typedef {import('./catalog.js').Decoded} Decoded */
/** @typedef {import('./catalog.js').Created} Created */

/**
 * The projections' version, which #22's index and #8's caches key on: it changes whenever any
 * projection's output does
 */
export const PROJECTION_VERSION = 1;

/** @type {Catalog | null} */
let builtIns = null;

/** The built-ins' catalog, made on first use */
export function builtInCatalog() {
  builtIns ??= createCatalog(BUILT_IN_BLOCKS);
  return builtIns;
}

/**
 * The projections over one catalog
 * @param {Catalog} catalog
 */
export function projectionsOf(catalog) {
  return Object.freeze({
    PROJECTION_VERSION,
    /** @param {unknown} block @returns {string} */
    previewText: block =>
      block === null || typeof block !== 'object' ? '' : /** @type {string} */ (catalog.project('preview', block)),
    /** @param {unknown} block @returns {string} */
    searchText: block =>
      block === null || typeof block !== 'object' ? '' : /** @type {string} */ (catalog.project('search', block)),
    /** @param {unknown} block @returns {string} */
    plainText: block => (block ? /** @type {string} */ (catalog.project('plainText', block)) : ''),
    /** @param {unknown} block @returns {string} */
    aiContextText: block => (block ? /** @type {string} */ (catalog.project('aiContext', block)) : ''),
    /** @param {any} block @returns {string} */
    markdownOf: block => catalog.markdown(block),
  });
}

/**
 * What the new tab's legacy scripts read blocks and markup through, as `BlockProjections`
 * (js/kernel/composition/block-projections.js sets it): the projections over a catalog, and
 * the tag stripping in linear time that the note list, AI responses and the editor's version
 * history use, and the wiki-link names the editor's save reads, also in linear time
 * @param {Catalog} catalog
 */
export function pageReaders(catalog) {
  return Object.freeze({ ...projectionsOf(catalog), stripTags, replaceTags, wikiLinkNames });
}

/** @type {ReturnType<typeof projectionsOf> | null} */
let builtInProjections = null;

/** The projections over the built-ins' catalog */
const projections = () => (builtInProjections ??= projectionsOf(builtInCatalog()));

/** @param {unknown} block */
export const previewText = block => projections().previewText(block);
/** @param {unknown} block */
export const searchText = block => projections().searchText(block);
/** @param {unknown} block */
export const plainText = block => projections().plainText(block);
/** @param {unknown} block */
export const aiContextText = block => projections().aiContextText(block);
/** @param {any} block */
export const markdownOf = block => projections().markdownOf(block);

/**
 * Accept a stored or received record (the opaque rule: it's kept whatever its state)
 * @param {unknown} record
 * @returns {Decoded}
 */
export const decodeBlock = record => builtInCatalog().decode(record);

/**
 * The record to store for a decoded block: an opaque one verbatim, a known one at its version
 * @param {Decoded} decoded
 */
export const encodeBlock = decoded => builtInCatalog().encode(decoded);

/**
 * Make a new block of `type`
 * @param {string} type
 * @param {Readonly<Record<string, unknown>>} input
 * @returns {Created}
 */
export const createBlock = (type, input) => builtInCatalog().create(type, input);
