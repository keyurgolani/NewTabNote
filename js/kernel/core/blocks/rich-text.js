/**
 * Rich text's DOM-free rules (#14, "Rendering boundary"), which the worker and every page run
 * the same:
 * - `escapePlainText(text)` writes plain text into a rich-text field: the markup a `div`
 *   holds after its `textContent` is set to the text, so it renders as the text and nothing
 *   else. Capture, Markdown shortcuts and the other plain-text sources write through it.
 * - `escapeAttributeText(text)` does the same for text that may land inside a quoted
 *   attribute value, as a template's values may.
 * - `isLinkHref(href)` is the inline schema's link rule: an `a` links to `http`, `https` or
 *   `mailto`, or to a reference with no scheme, which resolves inside the extension as 1.4.x's
 *   did, and to no other scheme.
 * The trusted-rendering port (js/kernel/core/ports/rendering.js) carries all three, beside the
 * page's render and normalize.
 */

/** The schemes a link in rich text may have */
export const LINK_SCHEMES = Object.freeze(['http', 'https', 'mailto']);

/** @type {Readonly<Record<string, string>>} */
const TEXT_ESCAPES = Object.freeze({ '&': '&amp;', ' ': '&nbsp;', '<': '&lt;', '>': '&gt;' });

/**
 * `text` as rich text: the HTML Standard's escaping of a text node, which is what an element
 * that holds only that text serializes to. Anything but a string reads as its string, and
 * null or undefined as empty.
 * @param {unknown} text
 * @returns {string}
 */
export function escapePlainText(text) {
  const value = text === null || text === undefined ? '' : String(text);
  return value.replace(/[& <>]/g, char => TEXT_ESCAPES[char]);
}

/** @type {Readonly<Record<string, string>>} */
const QUOTE_ESCAPES = Object.freeze({ '"': '&quot;', "'": '&#39;' });

/**
 * `text` as rich text that reads as the text in markup's text and inside a quoted attribute
 * value alike: escapePlainText's escaping, with both quotes escaped too. It shows the same in
 * text. Template values are written with it, since a template's markup may hold one inside an
 * attribute.
 * @param {unknown} text
 * @returns {string}
 */
export function escapeAttributeText(text) {
  return escapePlainText(text).replace(/["']/g, char => QUOTE_ESCAPES[char]);
}

/**
 * Whether a link may point at `href`: it has no scheme, or one of LINK_SCHEMES, read as the
 * URL parser reads it (spaces and C0 controls trimmed from the start, tabs and line breaks
 * dropped, case ignored). Only the start can hold a scheme, so the end is never read, and the
 * rule reads an address in linear time.
 * @param {unknown} href
 * @returns {boolean}
 */
export function isLinkHref(href) {
  if (typeof href !== 'string') return false;
  const cleaned = href.replace(/^[\u0000- ]+/, '').replace(/[\t\n\r]/g, '');
  const scheme = /^([A-Za-z][A-Za-z0-9+.-]*):/.exec(cleaned);
  return scheme === null || LINK_SCHEMES.includes(scheme[1].toLowerCase());
}
