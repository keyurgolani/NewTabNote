/**
 * The Markdown export's way of reading markup without a DOM, as 1.4.x's
 * AIResponseUtils.htmlToMarkdown read it, which every Markdown export runs and the block codec
 * keeps byte for byte until slice 4 unifies the readers (#14 scope, answer 5). The note list's
 * reader is strip-tags.js; what `innerHTML` and `textContent` give is html-text.js's.
 *
 * 1.4.x wrote it as a chain of regular expressions. Here each step of the chain gives what its
 * expression gave, in one pass over its input: every search only moves forward, and what a step
 * looks up again (the next `>`, quote, closing tag or line end) is found once, so each reads in
 * time linear in its input. test/kernel/blocks-markup.test.mjs holds it to the chain.
 */

import { replaceTags } from './strip-tags.js';

/** What `.` doesn't match: the line terminators */
const LINE_END = /[\n\r\u2028\u2029]/g;

/** @param {string} c */
const isRegexSpace = c => /\s/.test(c);

/**
 * `text` with ASCII letters lowercased and nothing else changed, so indices stay the same: how
 * a case-insensitive expression without the `u` flag compares these ASCII patterns
 * @param {string} text
 */
const asciiLower = text => text.replace(/[A-Z]+/g, upper => upper.toLowerCase());

/**
 * A search for the first match at or after a position, for positions that never go back: the
 * last answer is reused while it's still ahead
 * @param {(from: number) => number} find - the first index at or after `from`, or -1
 * @returns {(from: number) => number}
 */
function forward(find) {
  let from = Number.POSITIVE_INFINITY;
  let found = -1;
  return at => {
    if (at >= from && (found === -1 || found >= at)) return found;
    from = at;
    found = find(at);
    return found;
  };
}

/**
 * The first line terminator at or after a position, or the text's end
 * @param {string} text
 */
function lineEnds(text) {
  return forward(at => {
    LINE_END.lastIndex = at;
    const match = LINE_END.exec(text);
    return match ? match.index : text.length;
  });
}

/**
 * `/<tag>(.*?)<\/tag>/gi` replaced by `before` + the content + `after`: each opening tag with
 * the first closing tag after it on its line
 * @param {string} text
 * @param {string} tag
 * @param {string} before
 * @param {string} after
 */
function replacePairs(text, tag, before, after) {
  const lower = asciiLower(text);
  const open = `<${tag}>`;
  const close = `</${tag}>`;
  const nextClose = forward(at => lower.indexOf(close, at));
  const lineEnd = lineEnds(text);
  let out = '';
  let from = 0;
  let at = lower.indexOf(open);
  while (at !== -1) {
    const inside = at + open.length;
    const end = nextClose(inside);
    const line = lineEnd(inside);
    if (end !== -1 && end < line) {
      out += text.slice(from, at) + before + text.slice(inside, end) + after;
      from = end + close.length;
      at = lower.indexOf(open, from);
    } else {
      // No opening tag later on this line has a closing one either
      at = line < text.length ? lower.indexOf(open, line + 1) : -1;
    }
  }
  return out + text.slice(from);
}

/**
 * Per position, the first index at or after it where `needle` starts, or -1
 * @param {string} lower
 * @param {string} needle
 */
function nextIndex(lower, needle) {
  const next = new Int32Array(lower.length + 2).fill(-1);
  const starts = [];
  for (let at = lower.indexOf(needle); at !== -1; at = lower.indexOf(needle, at + 1)) starts.push(at);
  let k = starts.length - 1;
  for (let i = lower.length; i >= 0; i--) {
    while (k >= 0 && starts[k] >= i) k--;
    next[i] = k + 1 < starts.length ? starts[k + 1] : -1;
  }
  return next;
}

/**
 * `/<a\s+[^>]*class="wiki-link"[^>]*data-note-name="([^"]*)"[^>]*>.*?<\/a>/gi` replaced by
 * `[[$1]]`. From an `<a` and white space, the tag up to its first `>` must hold the class, and
 * after it a `data-note-name="`; the name runs to the next quote, then the tag to the next `>`,
 * then the link to the first `</a>` on that line. Of the names that complete, the expression's
 * backtracking takes the last one in the tag, which a table of the last completing name at or
 * before each position gives at once.
 * @param {string} text
 */
function replaceWikiLinks(text) {
  const lower = asciiLower(text);
  const CLASS = 'class="wiki-link"';
  const NAME = 'data-note-name="';
  const nextGt = nextIndex(lower, '>');
  const nextQuote = nextIndex(lower, '"');
  const nextClass = nextIndex(lower, CLASS);
  const nextName = nextIndex(lower, NAME);
  const nextCloseA = nextIndex(lower, '</a>');
  const nextLineEnd = new Int32Array(text.length + 2).fill(-1);
  for (let i = text.length - 1; i >= 0; i--) {
    const c = text[i];
    nextLineEnd[i] = c === '\n' || c === '\r' || c === '\u2028' || c === '\u2029' ? i : nextLineEnd[i + 1];
  }

  /**
   * Where the link that a name at `d` starts ends, and the name's closing quote, or null
   * @param {number} d
   */
  const completion = d => {
    const quote = nextQuote[d + NAME.length];
    if (quote === -1) return null;
    const gt = nextGt[quote + 1];
    if (gt === -1) return null;
    const closeA = nextCloseA[gt + 1];
    if (closeA === -1) return null;
    const lineEnd = nextLineEnd[gt + 1];
    if (lineEnd !== -1 && lineEnd < closeA) return null;
    return { quote, end: closeA + 4 };
  };

  // Per position, the last name at or before it whose link completes
  const lastName = new Int32Array(text.length + 1).fill(-1);
  for (let i = 0; i <= text.length; i++) {
    const here = nextName[i] === i && completion(i) !== null ? i : -1;
    lastName[i] = here !== -1 ? here : i > 0 ? lastName[i - 1] : -1;
  }

  let out = '';
  let from = 0;
  for (let st = lower.indexOf('<a', from); st !== -1; st = lower.indexOf('<a', st + 1)) {
    if (st < from) continue;
    if (st + 2 >= text.length || !isRegexSpace(text[st + 2])) continue;
    const tagEnd = nextGt[st];
    if (tagEnd === -1) break;
    const classAt = nextClass[st + 3];
    if (classAt === -1 || classAt + CLASS.length > tagEnd) continue;
    const latest = tagEnd - NAME.length;
    const d = latest >= 0 ? lastName[latest] : -1;
    if (d === -1 || d < classAt + CLASS.length) continue;
    const done = /** @type {{quote: number, end: number}} */ (completion(d));
    out += `${text.slice(from, st)}[[${text.slice(d + NAME.length, done.quote)}]]`;
    from = done.end;
    st = from - 1;
  }
  return out + text.slice(from);
}

/**
 * `/<a\s+href="([^"]*)"[^>]*>(.*?)<\/a>/gi` replaced by `[$2]($1)`: an `<a`, white space,
 * then `href="` at once; the address runs to the next quote, the tag to the next `>`, and the
 * text to the first `</a>` on its line
 * @param {string} text
 */
function replaceLinks(text) {
  const lower = asciiLower(text);
  const nextQuote = forward(at => lower.indexOf('"', at));
  const nextGt = forward(at => lower.indexOf('>', at));
  const nextCloseA = forward(at => lower.indexOf('</a>', at));
  const lineEnd = lineEnds(text);
  let out = '';
  let from = 0;
  for (let st = lower.indexOf('<a'); st !== -1; st = lower.indexOf('<a', st + 1)) {
    if (st < from) continue;
    let w = st + 2;
    while (w < text.length && isRegexSpace(text[w])) w++;
    if (w === st + 2 || !lower.startsWith('href="', w)) continue;
    const quote = nextQuote(w + 6);
    if (quote === -1) continue;
    const gt = nextGt(quote + 1);
    if (gt === -1) continue;
    const closeA = nextCloseA(gt + 1);
    if (closeA === -1 || lineEnd(gt + 1) < closeA) continue;
    out += `${text.slice(from, st)}[${text.slice(gt + 1, closeA)}](${text.slice(w + 6, quote)})`;
    from = closeA + 4;
    st = from - 1;
  }
  return out + text.slice(from);
}

/**
 * Inline markup as Markdown, as 1.4.x's AIResponseUtils.htmlToMarkdown made it: wiki links, bold,
 * italic, code, strike-through, links and line breaks, then every other tag dropped. Its
 * input is a string, or anything falsy, which reads as empty; anything else throws, as
 * 1.4.x's `.replace` did.
 * @param {string} html
 * @returns {string}
 */
export function inlineMarkdown(html) {
  if (!html) return '';
  // 1.4.x called the value's own replace first: a String object has one, and nothing else does
  if (typeof html !== 'string') /** @type {any} */ (html).replace(/(?:)/, '');
  let text = replaceWikiLinks(String(html));
  text = replacePairs(text, 'b', '**', '**');
  text = replacePairs(text, 'strong', '**', '**');
  text = replacePairs(text, 'i', '*', '*');
  text = replacePairs(text, 'em', '*', '*');
  text = replacePairs(text, 'code', '`', '`');
  text = replacePairs(text, 'del', '~~', '~~');
  text = replacePairs(text, 's', '~~', '~~');
  text = replacePairs(text, 'strike', '~~', '~~');
  text = replaceLinks(text);
  text = text.replace(/<br\s*\/?>/gi, '\n');
  return replaceTags(text, '', true);
}
