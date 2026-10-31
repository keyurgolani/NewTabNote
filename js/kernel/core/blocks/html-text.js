/**
 * Markup's text without a DOM (#14, "Security and privacy": projections read no DOM): what
 * `element.innerHTML = html; element.textContent` gives for a `div`, which is how the editor,
 * AI chat, and the AI jobs read a block's text in 1.4.x: AI chat and the AI jobs in the page's
 * document, where scripting is on, and the editor in an inert document of its own (since #105),
 * where it's off. The one difference that makes is `noscript`'s (below). It runs
 * the HTML Standard's tokenizer (13.2.5) far enough to know which characters end up in text
 * nodes, and the tree-construction rules that change that:
 *
 * - Input is normalized first: CR LF and CR become LF.
 * - Tags, comments, doctypes and bogus comments add nothing. A tag cut off by the end of the
 *   input adds nothing; a `<` or `</` that starts no tag is text.
 * - Character references decode in text, as the tokenizer does: every named reference (the
 *   legacy ones without `;` too, longest match first), and numeric ones with the standard's
 *   replacements (0, surrogates and anything past U+10FFFF become U+FFFD; 0x80 to 0x9F map
 *   through windows-1252).
 * - `script` (with its escaped and double-escaped states), `style`, `xmp`, `iframe`,
 *   `noembed`, `noframes` and, with scripting on, `noscript` hold raw text up to their own end
 *   tag (with scripting off, `noscript` is an element like any other), and `textarea`
 *   and `title` hold text with references decoded; all of it is in `textContent`. `plaintext`
 *   makes the rest of the input text.
 * - A newline right after `<pre>`, `<listing>` or `<textarea>` is dropped, written or as a
 *   reference.
 * - What a `template` holds isn't in `textContent` (it's in the template's own fragment).
 * - Foreign content follows the tree builder's stack of open elements: `svg` and `math` open
 *   it, and an element inside it takes its parent's namespace. There, raw-text elements aren't
 *   raw, `<![CDATA[` sections are text, NUL is U+FFFD, and the breakout tags (and `font` with
 *   `color`, `face` or `size`) go back to HTML. At an integration point (`foreignObject`,
 *   `desc` and `title` in SVG; `mi`, `mo`, `mn`, `ms`, `mtext`, and `annotation-xml` with an
 *   HTML encoding in MathML) start tags and text are HTML's, and CDATA is still text there. An
 *   end tag closes the innermost foreign element with its name, or, where an HTML element is
 *   open inside that, goes by HTML's rules, which close an element opened outside the foreign
 *   content when it's in scope. Outside foreign content, NUL in text is dropped, and in raw
 *   text it's U+FFFD.
 *
 * Text only depends on the stack where foreign content starts and ends, so the HTML side is
 * kept as far as that needs: scopes, special elements, and the start tags that close a `p`, a
 * list item, a heading or an option. The adoption agency, the table and select modes, and
 * references in attribute values aren't modelled.
 *
 * Known differences from Chromium (156), each in test/fixtures/blocks/html-text-cases.json with
 * Chromium's reading:
 * - Text inside a `table` outside its cells is moved before the table by the tree builder
 *   (foster parenting); here it stays in source order. A text block can hold a pasted table,
 *   but markup the editor serializes never has text outside a table's cells, so no saved
 *   block's text reads differently.
 * - A hex reference with no digits (`&#x;`) is text here, as the standard says and as
 *   Chromium's full parser reads it. Chromium's innerHTML reads it as U+FFFD for some inputs
 *   and as text for others, depending on the rest of the markup, so 1.4.x had no one answer
 *   for it. The editor never writes one (it serializes `&` as `&amp;`).
 * - A `<` right before a NUL is text and the NUL is dropped, as the standard says; Chromium
 *   keeps U+FFFD for the NUL.
 * - Inside a `select`, an end tag for an element opened outside it closes that element here,
 *   and an `svg` or `math` opened inside the select with it. Chromium ignores the end tag
 *   there, so the foreign content stays open.
 * - A `</foreignObject>` inside an `svg` closes an HTML element named `foreignobject` opened
 *   outside any `svg`, as the standard's end-tag rules do; Chromium leaves both open.
 *
 * The last two need markup whose tags don't balance, which the editor never serializes.
 *
 * It reads in time linear in its input: each comment, tag and raw-text run is scanned once, and
 * the stack answers every question an end tag asks with a lookup (createStack).
 */

import { LONGEST_REFERENCE, namedReferences } from './entities.js';

/** Elements whose content is raw text up to their end tag */
const RAW_TEXT = new Set(['style', 'xmp', 'iframe', 'noembed', 'noframes', 'noscript']);

/** Elements whose content is text with references decoded, up to their end tag */
const ESCAPABLE_RAW_TEXT = new Set(['textarea', 'title']);

/** Elements that drop a newline right after their start tag */
const LEADING_NEWLINE = new Set(['pre', 'listing', 'textarea']);

/** Start tags that leave foreign content (the HTML Standard's "in foreign content" list) */
const BREAKOUT = new Set([
  'b', 'big', 'blockquote', 'body', 'br', 'center', 'code', 'dd', 'div', 'dl', 'dt', 'em', 'embed',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'head', 'hr', 'i', 'img', 'li', 'listing', 'menu', 'meta',
  'nobr', 'ol', 'p', 'pre', 'ruby', 's', 'small', 'span', 'strong', 'strike', 'sub', 'sup',
  'table', 'tt', 'u', 'ul', 'var',
]);

/** windows-1252's characters for numeric references 0x80 to 0x9F (the standard's table) */
const C1_REPLACEMENTS = Object.freeze({
  0x80: 0x20ac, 0x82: 0x201a, 0x83: 0x0192, 0x84: 0x201e, 0x85: 0x2026, 0x86: 0x2020, 0x87: 0x2021,
  0x88: 0x02c6, 0x89: 0x2030, 0x8a: 0x0160, 0x8b: 0x2039, 0x8c: 0x0152, 0x8e: 0x017d, 0x91: 0x2018,
  0x92: 0x2019, 0x93: 0x201c, 0x94: 0x201d, 0x95: 0x2022, 0x96: 0x2013, 0x97: 0x2014, 0x98: 0x02dc,
  0x99: 0x2122, 0x9a: 0x0161, 0x9b: 0x203a, 0x9c: 0x0153, 0x9e: 0x017e, 0x9f: 0x0178,
});

const REPLACEMENT = '�';

/** @param {string} c */
const isAlpha = c => (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z');
/** @param {string} c */
const isAlphanumeric = c => isAlpha(c) || (c >= '0' && c <= '9');
/** @param {string} c */
const isSpace = c => c === '\t' || c === '\n' || c === '\f' || c === ' ';
/** @param {string} c */
const isHex = c => (c >= '0' && c <= '9') || (c >= 'a' && c <= 'f') || (c >= 'A' && c <= 'F');

/**
 * The character a numeric reference stands for
 * @param {number} value
 */
function numericCharacter(value) {
  if (value === 0 || value > 0x10ffff || (value >= 0xd800 && value <= 0xdfff)) return REPLACEMENT;
  const replaced = /** @type {Record<number, number>} */ (C1_REPLACEMENTS)[value];
  return String.fromCodePoint(replaced ?? value);
}

/**
 * The character reference at `at` (which holds `&`): what it decodes to and where it ends, or
 * null when it isn't one, so the `&` is text
 * @param {string} s
 * @param {number} at
 * @returns {{text: string, end: number} | null}
 */
function characterReference(s, at) {
  let i = at + 1;
  if (s[i] === '#') {
    i++;
    const hex = s[i] === 'x' || s[i] === 'X';
    if (hex) i++;
    const start = i;
    let value = 0;
    while (i < s.length && (hex ? isHex(s[i]) : s[i] >= '0' && s[i] <= '9')) {
      // Past U+10FFFF it's a replacement whatever the rest says, so stop growing
      if (value <= 0x10ffff) value = value * (hex ? 16 : 10) + Number.parseInt(s[i], 16);
      i++;
    }
    if (i === start) return null;
    if (s[i] === ';') i++;
    return { text: numericCharacter(value), end: i };
  }
  if (!isAlphanumeric(s[i] || '')) return null;
  const names = namedReferences();
  // The longest name that matches here, `;` or not
  const most = Math.min(LONGEST_REFERENCE, s.length - i);
  for (let length = most; length >= 1; length--) {
    const candidate = s.slice(i, i + length);
    const decoded = names.get(candidate);
    if (decoded !== undefined) return { text: decoded, end: i + length };
  }
  return null;
}

/**
 * Text from `from` up to `to` with references decoded, and NUL as `nul` gives it
 * @param {string} s
 * @param {number} from
 * @param {number} to
 * @param {string} nul - what a NUL becomes: '' (dropped) or U+FFFD
 * @param {boolean} references
 */
function textBetween(s, from, to, nul, references) {
  let out = '';
  let i = from;
  while (i < to) {
    const c = s[i];
    if (c === '\0') {
      out += nul;
      i++;
    } else if (c === '&' && references) {
      const ref = characterReference(s, i);
      // A reference can't run past the text it's in
      if (ref && ref.end <= to) {
        out += ref.text;
        i = ref.end;
      } else {
        out += '&';
        i++;
      }
    } else {
      out += c;
      i++;
    }
  }
  return out;
}

/**
 * A tag from `at` (just past its name's first character's `<` or `</`): its lowercased name,
 * whether it closes itself, its attributes (lowercased names, the first of each, values as
 * written), and where it ends; null when the input ends inside it
 * @param {string} s
 * @param {number} at - the first character of the name
 * @returns {{name: string, selfClosing: boolean, attributes: Map<string, string>, end: number} | null}
 */
function readTag(s, at) {
  let i = at;
  let name = '';
  while (i < s.length && !isSpace(s[i]) && s[i] !== '/' && s[i] !== '>') {
    name += s[i] === '\0' ? REPLACEMENT : s[i].toLowerCase();
    i++;
  }
  let selfClosing = false;
  /** @type {Map<string, string>} */
  const attributes = new Map();
  for (;;) {
    if (i >= s.length) return null;
    const c = s[i];
    if (isSpace(c)) {
      i++;
    } else if (c === '>') {
      return { name, selfClosing, attributes, end: i + 1 };
    } else if (c === '/') {
      i++;
      if (s[i] === '>') {
        selfClosing = true;
      }
    } else {
      // An attribute: its name (an `=` that starts it is part of it), then maybe `=` and a value
      selfClosing = false;
      const start = i;
      while (i < s.length && !isSpace(s[i]) && s[i] !== '/' && s[i] !== '>' && (s[i] !== '=' || i === start)) i++;
      const attribute = s.slice(start, i).toLowerCase();
      let value = '';
      while (i < s.length && isSpace(s[i])) i++;
      if (s[i] === '=') {
        i++;
        while (i < s.length && isSpace(s[i])) i++;
        const quote = s[i];
        if (quote === '"' || quote === "'") {
          const close = s.indexOf(quote, i + 1);
          if (close === -1) return null;
          value = s.slice(i + 1, close);
          i = close + 1;
        } else if (s[i] !== '>') {
          const from = i;
          while (i < s.length && !isSpace(s[i]) && s[i] !== '>') i++;
          value = s.slice(from, i);
        }
      }
      if (!attributes.has(attribute)) attributes.set(attribute, value);
    }
  }
}

/**
 * Whether `s` at `at` holds `</name` followed by a space, `/` or `>`: the end tag that closes
 * raw text
 * @param {string} s
 * @param {number} at
 * @param {string} name
 */
function closesAt(s, at, name) {
  if (s[at] !== '<' || s[at + 1] !== '/') return false;
  if (s.slice(at + 2, at + 2 + name.length).toLowerCase() !== name) return false;
  const after = s[at + 2 + name.length];
  return after !== undefined && (isSpace(after) || after === '/' || after === '>');
}

/**
 * Where raw text that `name` opened at `from` ends: the start of its end tag, or the input's end
 * @param {string} s
 * @param {number} from
 * @param {string} name
 */
function rawTextEnd(s, from, name) {
  for (let i = s.indexOf('<', from); i !== -1; i = s.indexOf('<', i + 1)) {
    if (closesAt(s, i, name)) return i;
  }
  return s.length;
}

/**
 * Where a script that starts at `from` ends: the start of its end tag, or the input's end,
 * through the script data states (an escaped `<!--` section, and a `<script>` written inside
 * one, which the next `</script>` closes instead of the element)
 * @param {string} s
 * @param {number} from
 */
function scriptEnd(s, from) {
  let state = 'data';
  let dashes = 0;
  let i = from;
  /** Whether `<script` or `</script` with a delimiter after it starts at `at` @param {number} at @param {boolean} end */
  const scriptTagAt = (at, end) => {
    const name = end ? s.slice(at + 2, at + 8) : s.slice(at + 1, at + 7);
    const after = s[at + (end ? 8 : 7)];
    return (
      s[at] === '<' &&
      (!end || s[at + 1] === '/') &&
      name.toLowerCase() === 'script' &&
      after !== undefined &&
      (isSpace(after) || after === '/' || after === '>')
    );
  };
  while (i < s.length) {
    const c = s[i];
    if (state === 'data') {
      if (c === '<' && scriptTagAt(i, true)) return i;
      if (s.startsWith('<!--', i)) {
        state = 'escaped';
        dashes = 2;
        i += 4;
        continue;
      }
      i++;
      continue;
    }
    if (c === '-') {
      dashes++;
      i++;
      continue;
    }
    if (c === '>' && dashes >= 2) {
      state = 'data';
      dashes = 0;
      i++;
      continue;
    }
    dashes = 0;
    if (state === 'escaped') {
      if (c === '<' && scriptTagAt(i, true)) return i;
      if (c === '<' && scriptTagAt(i, false)) {
        state = 'double';
        i += 7;
        continue;
      }
    } else if (c === '<' && scriptTagAt(i, true)) {
      state = 'escaped';
      i += 8;
      continue;
    }
    i++;
  }
  return s.length;
}

/** Elements with no content, which a start tag doesn't leave open */
const VOID = new Set([
  'area', 'base', 'basefont', 'bgsound', 'br', 'col', 'embed', 'frame', 'hr', 'image', 'img', 'input', 'keygen',
  'link', 'meta', 'param', 'source', 'track', 'wbr',
]);

/** Start tags that change nothing in a div */
const IGNORED = new Set(['html', 'head', 'body', 'frameset']);

/** Table parts, which only a table holds */
const TABLE_PARTS = new Set(['caption', 'colgroup', 'tbody', 'thead', 'tfoot', 'tr', 'td', 'th']);

const HEADINGS = new Set(['h1', 'h2', 'h3', 'h4', 'h5', 'h6']);

/** Start tags that close a `p` in button scope */
const CLOSES_P = new Set([
  'address', 'article', 'aside', 'blockquote', 'center', 'details', 'dialog', 'dir', 'div', 'dl', 'fieldset',
  'figcaption', 'figure', 'footer', 'header', 'hgroup', 'main', 'menu', 'nav', 'ol', 'p', 'search', 'section',
  'summary', 'ul', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'pre', 'listing', 'form', 'plaintext', 'table', 'hr', 'xmp',
  'li', 'dd', 'dt',
]);

/** End tags that close their element only when it's in scope */
const SCOPED_END = new Set([
  'address', 'article', 'aside', 'blockquote', 'button', 'center', 'details', 'dialog', 'dir', 'div', 'dl',
  'fieldset', 'figcaption', 'figure', 'footer', 'header', 'hgroup', 'listing', 'main', 'menu', 'nav', 'ol', 'pre',
  'search', 'section', 'summary', 'ul', 'form', 'applet', 'marquee', 'object', 'table', 'caption', 'colgroup',
  'tbody', 'thead', 'tfoot', 'tr', 'td', 'th', 'select', 'dd', 'dt',
  // The formatting elements, which the adoption agency closes when they're in scope
  'a', 'b', 'big', 'code', 'em', 'font', 'i', 'nobr', 's', 'small', 'strike', 'strong', 'tt', 'u',
]);

/** HTML elements that end a scope */
const SCOPE = new Set(['applet', 'caption', 'html', 'table', 'td', 'th', 'marquee', 'object', 'template']);

/** The HTML Standard's special HTML elements */
const SPECIAL = new Set([
  'address', 'applet', 'area', 'article', 'aside', 'base', 'basefont', 'bgsound', 'blockquote', 'body', 'br',
  'button', 'caption', 'center', 'col', 'colgroup', 'dd', 'details', 'dir', 'div', 'dl', 'dt', 'embed', 'fieldset',
  'figcaption', 'figure', 'footer', 'form', 'frame', 'frameset', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'head',
  'header', 'hgroup', 'hr', 'html', 'iframe', 'img', 'input', 'keygen', 'li', 'link', 'listing', 'main', 'marquee',
  'menu', 'meta', 'nav', 'noembed', 'noframes', 'noscript', 'object', 'ol', 'p', 'param', 'plaintext', 'pre',
  'script', 'search', 'section', 'select', 'source', 'style', 'summary', 'table', 'tbody', 'td', 'template',
  'textarea', 'tfoot', 'th', 'thead', 'title', 'tr', 'track', 'ul', 'wbr', 'xmp',
]);

/** MathML's text integration points */
const MATH_TEXT = new Set(['mi', 'mo', 'mn', 'ms', 'mtext']);

/** SVG's HTML integration points */
const SVG_HTML = new Set(['foreignobject', 'desc', 'title']);

/** @typedef {'html' | 'svg' | 'math'} Namespace */
/** @typedef {{ns: Namespace, name: string, key: string, point: 'html' | 'text' | null}} Open */
/** @typedef {'scope' | 'button' | 'list' | 'special' | 'specialLi' | 'html' | 'breakout'} Kind */

/** Every kind of element the stack keeps the deepest of @type {readonly Kind[]} */
const KINDS = Object.freeze(['scope', 'button', 'list', 'special', 'specialLi', 'html', 'breakout']);

/**
 * What kind of integration point a foreign element is
 * @param {Namespace} ns
 * @param {string} name
 * @param {Map<string, string>} attributes
 * @returns {'html' | 'text' | null}
 */
function pointOf(ns, name, attributes) {
  if (ns === 'svg') return SVG_HTML.has(name) ? 'html' : null;
  if (ns !== 'math') return null;
  if (MATH_TEXT.has(name)) return 'text';
  if (name !== 'annotation-xml') return null;
  const encoding = (attributes.get('encoding') ?? '').toLowerCase();
  return encoding === 'text/html' || encoding === 'application/xhtml+xml' ? 'html' : null;
}

/**
 * The kinds an open element is, for the scopes and stops end tags have
 * @param {Open} open
 * @returns {Record<Kind, boolean>}
 */
function kindsOf(open) {
  const html = open.ns === 'html';
  const foreignBoundary =
    (open.ns === 'math' && (MATH_TEXT.has(open.name) || open.name === 'annotation-xml')) ||
    (open.ns === 'svg' && SVG_HTML.has(open.name));
  const scope = foreignBoundary || (html && SCOPE.has(open.name));
  const special = foreignBoundary || (html && SPECIAL.has(open.name));
  return {
    scope,
    button: scope || (html && open.name === 'button'),
    list: scope || (html && (open.name === 'ol' || open.name === 'ul')),
    special,
    specialLi: special && !(html && (open.name === 'address' || open.name === 'div' || open.name === 'p')),
    html,
    breakout: html || open.point !== null,
  };
}

/**
 * The stack of open elements, as far as text needs it: which namespace the current node is
 * in, and which element an end tag closes. Every question it answers is a lookup, never a
 * walk: each element's key keeps the indices of its open copies, and each kind of element an
 * end tag stops at keeps, per depth, the deepest one at or above it. So a push, a pop and each
 * question cost the same however deep the stack is, and reading markup stays linear.
 */
function createStack() {
  /** @type {Open[]} */
  const items = [];
  /** @type {Map<string, number[]>} */
  const byKey = new Map();
  /** Per depth, the index of the deepest element at or above it of each kind */
  const deepest = /** @type {Record<Kind, number[]>} */ (
    Object.fromEntries(KINDS.map(kind => [kind, /** @type {number[]} */ ([])]))
  );

  /** @param {readonly number[] | undefined} list */
  const atTop = list => (list !== undefined && list.length > 0 ? list[list.length - 1] : -1);

  return {
    /** The current node, or null with only the context element open */
    top: () => (items.length > 0 ? items[items.length - 1] : null),
    /**
     * Open an element
     * @param {Namespace} ns
     * @param {string} name
     * @param {'html' | 'text' | null} point
     */
    push(ns, name, point) {
      const open = { ns, name, key: `${ns} ${name}`, point };
      const index = items.length;
      items.push(open);
      const list = byKey.get(open.key);
      if (list) list.push(index);
      else byKey.set(open.key, [index]);
      const is = kindsOf(open);
      for (const kind of KINDS) deepest[kind].push(is[kind] ? index : atTop(deepest[kind]));
    },
    /**
     * Close the element at index `k` and every one opened inside it
     * @param {number} k
     */
    popTo(k) {
      while (items.length > k) {
        const open = /** @type {Open} */ (items.pop());
        /** @type {number[]} */ (byKey.get(open.key)).pop();
        for (const kind of KINDS) deepest[kind].pop();
      }
    },
    /**
     * The index of the innermost open element with this name, or -1
     * @param {Namespace} ns
     * @param {string} name
     */
    last: (ns, name) => atTop(byKey.get(`${ns} ${name}`)),
    /**
     * The index of the deepest open element of a kind, or -1
     * @param {Kind} kind
     */
    deepest: kind => atTop(deepest[kind]),
    /**
     * Whether the element at `k` is in the scope that the kind ends
     * @param {number} k
     * @param {'scope' | 'button' | 'list'} kind
     */
    inScope: (k, kind) => k >= 0 && atTop(deepest[kind]) <= k,
  };
}

/**
 * Past a newline right after a start tag that drops one, written or as a reference
 * @param {string} s
 * @param {number} i
 */
function afterLeadingNewline(s, i) {
  if (s[i] === '\n') return i + 1;
  if (s[i] === '&') {
    const ref = characterReference(s, i);
    if (ref && ref.text === '\n') return ref.end;
  }
  return i;
}

/**
 * The text a `div` holds after `div.innerHTML = html`, as its `textContent` reads it (see the
 * top of this file)
 * @param {string} html
 * @param {{scripting?: boolean}} [options] - whether the div's document runs scripts: the page's
 *   does, and an inert one (`createHTMLDocument`) doesn't
 * @returns {string}
 */
export function textContent(html, { scripting = true } = {}) {
  const s = String(html).replace(/\r\n?/g, '\n');
  const stack = createStack();
  let out = '';
  /** @param {string} text */
  const emit = text => {
    // A template's content is in a fragment of its own, not the div's text
    if (stack.last('html', 'template') === -1) out += text;
  };

  /**
   * Whether a start tag (by name), or a character (null), goes by HTML's rules rather than
   * foreign content's: the tree builder's dispatcher
   * @param {string | null} start
   */
  const htmlRules = start => {
    const top = stack.top();
    if (top === null || top.ns === 'html') return true;
    if (top.point === 'text' && (start === null || (start !== 'mglyph' && start !== 'malignmark'))) return true;
    if (top.ns === 'math' && top.name === 'annotation-xml' && start === 'svg') return true;
    return top.point === 'html';
  };

  const closeP = () => {
    const p = stack.last('html', 'p');
    if (stack.inScope(p, 'button')) stack.popTo(p);
  };

  /**
   * A list item's start tag closes an open item of `names` that no special element covers
   * @param {string[]} names
   */
  const closeItem = names => {
    const k = Math.max(...names.map(name => stack.last('html', name)));
    if (k >= 0 && stack.deepest('specialLi') === k) stack.popTo(k);
  };

  /**
   * An end tag by HTML's rules (in body)
   * @param {string} name
   */
  const htmlEnd = name => {
    if (name === 'template') {
      const k = stack.last('html', 'template');
      if (k >= 0) stack.popTo(k);
    } else if (name === 'p') {
      closeP();
    } else if (name === 'li') {
      const k = stack.last('html', 'li');
      if (stack.inScope(k, 'list')) stack.popTo(k);
    } else if (HEADINGS.has(name)) {
      const k = Math.max(...[...HEADINGS].map(heading => stack.last('html', heading)));
      if (stack.inScope(k, 'scope')) stack.popTo(k);
    } else if (SCOPED_END.has(name)) {
      const k = stack.last('html', name);
      if (stack.inScope(k, 'scope')) stack.popTo(k);
    } else if (name !== 'br' && name !== 'html' && name !== 'body') {
      // Any other end tag: its element closes unless a special element is open inside it
      const k = stack.last('html', name);
      if (k >= 0 && stack.deepest('special') <= k) stack.popTo(k);
    }
  };

  /**
   * A start tag by HTML's rules, other than raw text and plaintext
   * @param {{name: string, selfClosing: boolean}} tag
   */
  const htmlStart = ({ name, selfClosing }) => {
    if (name === 'svg' || name === 'math') {
      if (!selfClosing) stack.push(name, name, null);
      return;
    }
    if (IGNORED.has(name)) return;
    if (TABLE_PARTS.has(name) && stack.last('html', 'table') === -1) return;
    if (name === 'li') closeItem(['li']);
    if (name === 'dd' || name === 'dt') closeItem(['dd', 'dt']);
    if (CLOSES_P.has(name)) closeP();
    const top = stack.top();
    if (HEADINGS.has(name) && top !== null && top.ns === 'html' && HEADINGS.has(top.name)) {
      stack.popTo(stack.last('html', top.name));
    }
    if (name === 'button') {
      const k = stack.last('html', 'button');
      if (stack.inScope(k, 'scope')) stack.popTo(k);
    }
    if ((name === 'option' || name === 'optgroup') && top !== null && top.ns === 'html' && top.name === 'option') {
      stack.popTo(stack.last('html', 'option'));
    }
    if (VOID.has(name)) return;
    stack.push('html', name, null);
  };

  let i = 0;
  while (i < s.length) {
    const lt = s.indexOf('<', i);
    const textEnd = lt === -1 ? s.length : lt;
    if (textEnd > i) emit(textBetween(s, i, textEnd, htmlRules(null) ? '' : REPLACEMENT, true));
    if (lt === -1) break;
    i = lt;
    const next = s[i + 1];

    if (next === '!') {
      if (s.startsWith('<!--', i)) {
        // `<!-->` and `<!--->` end at once; otherwise at the first `-->` or `--!>`, found in one
        // pass over the comment
        const body = i + 4;
        if (s[body] === '>') {
          i = body + 1;
        } else if (s[body] === '-' && s[body + 1] === '>') {
          i = body + 2;
        } else {
          let end = s.length;
          for (let j = s.indexOf('--', body); j !== -1; j = s.indexOf('--', j + 1)) {
            if (s[j + 2] === '>') {
              end = j + 3;
              break;
            }
            if (s[j + 2] === '!' && s[j + 3] === '>') {
              end = j + 4;
              break;
            }
          }
          i = end;
        }
        continue;
      }
      // CDATA is text where the current node is foreign, integration points included
      const top = stack.top();
      if (top !== null && top.ns !== 'html' && s.startsWith('<![CDATA[', i)) {
        const close = s.indexOf(']]>', i + 9);
        // Its characters are characters like any other: NUL as the current node takes it
        emit(textBetween(s, i + 9, close === -1 ? s.length : close, htmlRules(null) ? '' : REPLACEMENT, false));
        i = close === -1 ? s.length : close + 3;
        continue;
      }
      // A doctype or a bogus comment, up to `>`
      const close = s.indexOf('>', i + 2);
      i = close === -1 ? s.length : close + 1;
      continue;
    }

    if (next === '?') {
      const close = s.indexOf('>', i + 2);
      i = close === -1 ? s.length : close + 1;
      continue;
    }

    if (next === '/') {
      const first = s[i + 2];
      if (first === undefined) {
        emit('</');
        break;
      }
      if (first === '>') {
        i += 3;
        continue;
      }
      if (!isAlpha(first)) {
        const close = s.indexOf('>', i + 2);
        i = close === -1 ? s.length : close + 1;
        continue;
      }
      const tag = readTag(s, i + 2);
      if (!tag) break;
      i = tag.end;
      const top = stack.top();
      if (top === null || top.ns === 'html') {
        htmlEnd(tag.name);
      } else if (tag.name === 'br' || tag.name === 'p') {
        stack.popTo(stack.deepest('breakout') + 1);
        htmlEnd(tag.name);
      } else {
        // The innermost foreign element with its name closes, unless an HTML element is open
        // inside it, where HTML's rules take the tag
        const htmlAt = stack.deepest('html');
        const foreign = Math.max(stack.last('svg', tag.name), stack.last('math', tag.name));
        if (foreign > htmlAt) stack.popTo(foreign);
        else if (htmlAt >= 0) htmlEnd(tag.name);
      }
      continue;
    }

    if (next === undefined || !isAlpha(next)) {
      emit('<');
      i++;
      continue;
    }

    const tag = readTag(s, i + 1);
    if (!tag) break;
    i = tag.end;
    if (!htmlRules(tag.name)) {
      const top = /** @type {Open} */ (stack.top());
      const font = tag.name === 'font' && ['color', 'face', 'size'].some(name => tag.attributes.has(name));
      if (!BREAKOUT.has(tag.name) && !font) {
        // A foreign element, in its parent's namespace
        if (!tag.selfClosing) stack.push(top.ns, tag.name, pointOf(top.ns, tag.name, tag.attributes));
        continue;
      }
      // Back to HTML, where this tag goes on as an HTML start tag
      stack.popTo(stack.deepest('breakout') + 1);
    }
    if (tag.name === 'plaintext') {
      closeP();
      emit(textBetween(s, i, s.length, REPLACEMENT, false));
      break;
    }
    const raw = RAW_TEXT.has(tag.name) && (scripting || tag.name !== 'noscript');
    if (tag.name === 'script' || raw || ESCAPABLE_RAW_TEXT.has(tag.name)) {
      if (tag.name === 'xmp') closeP();
      if (tag.name === 'textarea') i = afterLeadingNewline(s, i);
      const end = tag.name === 'script' ? scriptEnd(s, i) : rawTextEnd(s, i, tag.name);
      emit(textBetween(s, i, end, REPLACEMENT, ESCAPABLE_RAW_TEXT.has(tag.name)));
      if (end === s.length) break;
      const close = readTag(s, end + 2);
      if (!close) break;
      i = close.end;
      continue;
    }
    htmlStart(tag);
    if (LEADING_NEWLINE.has(tag.name)) i = afterLeadingNewline(s, i);
  }
  return out;
}
