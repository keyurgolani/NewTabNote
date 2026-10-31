/**
 * Seeded markup for e2e/block-projections.spec.js's differential check: strings built from the
 * tags, references and fragments html-text.js has rules for, which the spec reads both in
 * Chromium and through the page's block projections. The same seed gives the same strings.
 * The declared differences (html-text.js's header) are left out: a `table`, a hex reference
 * with no digits, a `<` before a NUL, a `select`, and a `foreignObject` start tag with a
 * `foreignObject` end tag.
 *
 * Nothing in the extension loads this file. It requires nothing, so the spec can evaluate it in
 * the page.
 */

'use strict';

const TAGS = [
  'b', 'i', 'em', 'strong', 'a', 'span', 'div', 'p', 'br', 'pre', 'listing', 'code', 'ul', 'li', 'tr', 'td',
  'svg', 'math', 'g', 'text', 'foreignObject', 'desc', 'title', 'mi', 'mtext', 'annotation-xml', 'script', 'style',
  'xmp', 'iframe', 'noembed', 'noframes', 'noscript', 'textarea', 'template', 'plaintext', 'select', 'option', 'font',
  'img', 'input', 'html', 'body', 'head', 'form', 'button', 'frameset', 'image', 'SCRIPT', 'Style', 'TeXtArea',
  'h1', 'h2', 'dd', 'dt', 'mglyph', 'mo',
];
const REFERENCES = [
  '&amp;', '&amp', '&lt;', '&gt', '&nbsp;', '&notin;', '&notit;', '&#65;', '&#x41;', '&#;', '&#0;', '&#x80;',
  '&#xD800;', '&#1114112;', '&#10;', '&#x0A;', '&NewLine;', '&zzz;', '&', '&#', '&AElig', '&copy', '&#X1F600',
];
const BITS = [
  'x', 'hello', ' ', '\n', '\r\n', '\t', '<', '>', '/', '"', "'", '=', '-', '--', '<!--', '-->', '--!>', '<!', '<?',
  '</', '<![CDATA[', ']]>', '\u0000', ';', '#', ' ',
];
const ATTRIBUTES = ['a', 'b', 'color', 'face', 'size', 'encoding', 'href', 'x'];
const VALUES = ['', '=1', '="v>w"', "='q'", '=text/html', '="text/html"', '=a/', '="application/xhtml+xml"'];

/** A string html-text.js declares it reads differently from Chromium */
const isDeclared = html =>
  /<table/i.test(html) || /&#[xX](?![0-9a-fA-F])/.test(html) || /<\u0000/.test(html) || /<select/i.test(html) ||
  (/<foreignobject/i.test(html) && /<\/foreignobject/i.test(html));

/**
 * `count` strings from `seed`, none of a declared shape
 * @param {number} count
 * @param {number} [seed]
 * @returns {string[]}
 */
function fuzzStrings(count, seed = 0x106106) {
  let state = seed >>> 0 || 1;
  const random = () => {
    state ^= state << 13;
    state >>>= 0;
    state ^= state >>> 17;
    state ^= state << 5;
    state >>>= 0;
    return state / 4294967296;
  };
  const pick = list => list[Math.floor(random() * list.length)];
  const tag = () => {
    const name = pick(TAGS);
    const r = random();
    if (r < 0.45) {
      let attributes = '';
      const k = Math.floor(random() * 3);
      for (let j = 0; j < k; j++) attributes += ` ${pick(ATTRIBUTES)}${pick(VALUES)}`;
      return `<${name}${attributes}${random() < 0.1 ? '/' : ''}>`;
    }
    if (r < 0.85) return `</${name}${random() < 0.05 ? ' ' : ''}>`;
    return `<${name}`;
  };
  const piece = () => {
    const r = random();
    return r < 0.4 ? tag() : r < 0.6 ? pick(REFERENCES) : r < 0.85 ? pick(BITS) : 'word';
  };
  const strings = [];
  while (strings.length < count) {
    let html = '';
    const length = 1 + Math.floor(random() * 14);
    for (let j = 0; j < length; j++) html += piece();
    if (!isDeclared(html)) strings.push(html);
  }
  return strings;
}

module.exports = { fuzzStrings, isDeclared };
