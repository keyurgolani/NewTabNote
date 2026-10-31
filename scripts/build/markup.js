'use strict';

/**
 * What the output checks read from shipped HTML and CSS: each tag with its attributes, inline
 * scripts and stylesheets, and the URLs a stylesheet names. Comments are blanked out first,
 * keeping every position, and script and style bodies stay out of the tag scan.
 */

/**
 * @typedef {object} Tag
 * @property {string} name - lowercased
 * @property {Map<string, string>} attributes - lowercased names; a bare attribute's value is ''
 * @property {string} at - line:column of its `<`
 */

/** @typedef {{value: string, at: string}} Located */

// A tag whose quoted attribute values may hold `>`
const TAG = /<([a-zA-Z][\w:-]*)((?:\s+[^\s"'>/=]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'=<>`]+))?)*)\s*\/?>/g;
const ATTRIBUTE = /([^\s"'>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
const RAW_TEXT = /<(script|style)\b((?:[^>"']|"[^"]*"|'[^']*')*)>([\s\S]*?)<\/\1\s*>/gi;
const CSS_URL = /url\(\s*(?:"([^"]*)"|'([^']*)'|([^)\s]*))\s*\)|@import\s+(?:"([^"]*)"|'([^']*)')/gi;

/**
 * `text` with each match of `pattern` turned into spaces, line breaks kept, so positions
 * still count from the original
 * @param {string} text
 * @param {RegExp} pattern
 * @returns {string}
 */
function blank(text, pattern) {
  return text.replace(pattern, (match) => match.replace(/[^\n]/g, ' '));
}

/**
 * A function from an offset in `text` to its line:column, both counted from 1
 * @param {string} text
 * @returns {(offset: number) => string}
 */
function locator(text) {
  const starts = [0];
  for (let i = 0; i < text.length; i++) if (text[i] === '\n') starts.push(i + 1);
  return (offset) => {
    let low = 0;
    let high = starts.length - 1;
    while (low < high) {
      const middle = (low + high + 1) >> 1;
      if (starts[middle] <= offset) low = middle;
      else high = middle - 1;
    }
    return `${low + 1}:${offset - starts[low] + 1}`;
  };
}

/**
 * @param {string} text - an attribute list
 * @returns {Map<string, string>}
 */
function parseAttributes(text) {
  /** @type {Map<string, string>} */
  const attributes = new Map();
  for (const match of text.matchAll(ATTRIBUTE)) {
    const name = match[1].toLowerCase();
    if (!attributes.has(name)) attributes.set(name, match[2] ?? match[3] ?? match[4] ?? '');
  }
  return attributes;
}

/**
 * Every tag in an HTML page, outside comments and outside script and style bodies
 * @param {string} html
 * @returns {Tag[]}
 */
function htmlTags(html) {
  const at = locator(html);
  const uncommented = blank(html, /<!--[\s\S]*?-->/g);
  // Keep each script and style element's tags, and blank out its body
  const scanned = uncommented.replace(RAW_TEXT, (match, name, attributes, body) => {
    const open = `<${name}${attributes}>`;
    return `${open}${String(body).replace(/[^\n]/g, ' ')}${match.slice(open.length + String(body).length)}`;
  });
  /** @type {Tag[]} */
  const tags = [];
  for (const match of scanned.matchAll(TAG)) {
    tags.push({ name: match[1].toLowerCase(), attributes: parseAttributes(match[2]), at: at(match.index) });
  }
  return tags;
}

/**
 * Each script and style element, with its body, outside comments
 * @param {string} html
 * @returns {Array<{name: 'script' | 'style', attributes: Map<string, string>, body: string, at: string, bodyAt: number}>}
 */
function rawTextElements(html) {
  const at = locator(html);
  const uncommented = blank(html, /<!--[\s\S]*?-->/g);
  /** @type {Array<{name: 'script' | 'style', attributes: Map<string, string>, body: string, at: string, bodyAt: number}>} */
  const elements = [];
  for (const match of uncommented.matchAll(RAW_TEXT)) {
    const name = match[1].toLowerCase() === 'script' ? 'script' : 'style';
    const bodyAt = match.index + match[0].indexOf('>') + 1;
    elements.push({ name, attributes: parseAttributes(match[2]), body: match[3], at: at(match.index), bodyAt });
  }
  return elements;
}

/**
 * The URLs a stylesheet names, in url() and in CSS imports, outside comments
 * @param {string} css
 * @returns {Located[]}
 */
function cssUrls(css) {
  const at = locator(css);
  const uncommented = blank(css, /\/\*[\s\S]*?\*\//g);
  /** @type {Located[]} */
  const urls = [];
  for (const match of uncommented.matchAll(CSS_URL)) {
    const value = match[1] ?? match[2] ?? match[3] ?? match[4] ?? match[5] ?? '';
    urls.push({ value: value.trim(), at: at(match.index) });
  }
  return urls;
}

module.exports = { htmlTags, rawTextElements, cssUrls, locator };
