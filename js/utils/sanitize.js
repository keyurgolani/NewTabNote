/**
 * HTML sanitization utilities.
 * Strips dangerous elements and attributes from HTML content to prevent XSS.
 *
 * @module sanitize
 */

/** Tags that are always removed along with their content. */
const DANGEROUS_TAGS = new Set([
  'script', 'iframe', 'object', 'embed', 'form',
]);

/** URL schemes considered dangerous (matched case-insensitively). */
const DANGEROUS_URL_RE = /^\s*(javascript|vbscript):/i;

/** data: URLs that are NOT images should be stripped. */
const SAFE_DATA_URL_RE = /^\s*data:image\//i;

/** Attributes whose values are URLs that need scheme checking. */
const URL_ATTRIBUTES = new Set([
  'href', 'src', 'action', 'formaction', 'xlink:href', 'poster', 'background',
]);

/**
 * Return true when a URL value is considered dangerous.
 * - `javascript:` and `vbscript:` are always dangerous.
 * - `data:` is dangerous unless it is a `data:image/…` URL.
 * @param {string} value
 * @returns {boolean}
 */
function isDangerousUrl(value) {
  if (DANGEROUS_URL_RE.test(value)) return true;
  if (/^\s*data:/i.test(value) && !SAFE_DATA_URL_RE.test(value)) return true;
  return false;
}

/**
 * Sanitize HTML content, stripping dangerous elements and attributes.
 * Uses DOMParser + TreeWalker for robust, non-regex-based sanitization.
 *
 * @param {string} html - Raw HTML string
 * @returns {string} Sanitized HTML safe for innerHTML
 */
function sanitizeHtml(html) {
  if (!html || typeof html !== 'string') return '';

  const doc = new DOMParser().parseFromString(html, 'text/html');
  sanitizeNode(doc.body);
  return doc.body.innerHTML;
}

/**
 * Recursively sanitize a DOM node in-place.
 * Removes dangerous elements entirely and strips dangerous attributes.
 * @param {Node} node
 */
function sanitizeNode(node) {
  const walker = node.ownerDocument.createTreeWalker(
    node,
    1 /* NodeFilter.SHOW_ELEMENT */,
    null,
  );

  /** @type {Element[]} */
  const toRemove = [];

  /** @type {Element|null} */
  let el = /** @type {Element|null} */ (walker.nextNode());
  while (el) {
    if (DANGEROUS_TAGS.has(el.tagName.toLowerCase())) {
      toRemove.push(el);
    } else {
      stripDangerousAttributes(el);
    }
    el = /** @type {Element|null} */ (walker.nextNode());
  }

  for (const bad of toRemove) {
    bad.parentNode && bad.parentNode.removeChild(bad);
  }
}

/**
 * Remove dangerous attributes from a single element.
 * - All `on*` event handler attributes
 * - URL attributes containing `javascript:`, `vbscript:`, or non-image `data:` URLs
 * @param {Element} el
 */
function stripDangerousAttributes(el) {
  /** @type {string[]} */
  const toRemove = [];

  for (let i = 0; i < el.attributes.length; i++) {
    const attr = el.attributes[i];
    const name = attr.name.toLowerCase();

    // Remove all on* event handlers
    if (name.startsWith('on')) {
      toRemove.push(attr.name);
      continue;
    }

    // Check URL-bearing attributes for dangerous schemes
    if (URL_ATTRIBUTES.has(name) && isDangerousUrl(attr.value)) {
      toRemove.push(attr.name);
    }
  }

  for (const name of toRemove) {
    el.removeAttribute(name);
  }
}

// Dual CommonJS / browser export
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { sanitizeHtml, isDangerousUrl, stripDangerousAttributes };
} else if (typeof window !== 'undefined') {
  window.sanitizeHtml = sanitizeHtml;
}
