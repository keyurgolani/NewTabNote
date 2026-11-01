'use strict';

// AIResponseUtils.htmlToMarkdown, which every Markdown export runs (a note's Export and Export
// all as Markdown), gives what its 1.4.x chain of expressions gave, byte for byte, on the
// corpus and on seeded strings, throws where it threw, and reads in linear time.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { htmlToMarkdown } = require('../js/ai-response-utils.js');
const { CASES } = require('./fixtures/blocks/corpus.cjs');

// ============ The 1.4.x code, word for word (js/ai-response-utils.js) ============

function oldHtmlToMarkdown(html) {
  if (!html) return '';
  return html
    .replace(/<a\s+[^>]*class="wiki-link"[^>]*data-note-name="([^"]*)"[^>]*>.*?<\/a>/gi, '[[$1]]')
    .replace(/<b>(.*?)<\/b>/gi, '**$1**')
    .replace(/<strong>(.*?)<\/strong>/gi, '**$1**')
    .replace(/<i>(.*?)<\/i>/gi, '*$1*')
    .replace(/<em>(.*?)<\/em>/gi, '*$1*')
    .replace(/<code>(.*?)<\/code>/gi, '`$1`')
    .replace(/<del>(.*?)<\/del>/gi, '~~$1~~')
    .replace(/<s>(.*?)<\/s>/gi, '~~$1~~')
    .replace(/<strike>(.*?)<\/strike>/gi, '~~$1~~')
    .replace(/<a\s+href="([^"]*)"[^>]*>(.*?)<\/a>/gi, '[$2]($1)')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '');
}

/** What a call gave: its value, or the name of the error class it threw */
function outcome(fn, value) {
  try {
    return JSON.stringify({ value: fn(value) });
  } catch (error) {
    return JSON.stringify({ threw: error.name });
  }
}

/** Every string a corpus block holds, seeded strings, and values that aren't strings */
function values() {
  const found = new Set([null, undefined, 0, 5, true, ['<b>a</b>'], { a: 1 }, new String('<b>x</b>')]);
  for (const [, block] of CASES) {
    if (block === null || typeof block !== 'object') continue;
    for (const value of Object.values(block)) if (typeof value === 'string') found.add(value);
  }
  const PIECES = [
    '<a ', '<A\t', '<a\n', 'class="wiki-link"', 'CLASS="WIKI-LINK"', 'data-note-name="', 'href="', 'HREF="', '"', '>',
    '</a>', '</A>', '<b>', '</b>', '<B>', '<strong>', '</strong>', '<i>', '</i>', '<em>', '</em>', '<code>', '</code>',
    '<del>', '</del>', '<s>', '</s>', '<strike>', '</strike>', '<br>', '<br/>', '<BR />', '<br  ', '<', '<>', 'x', ' ',
    '\n', '\r', '\u2028', '\u2029', '\u00a0', '&nbsp;', '&NBSP;', '$1', '$&', '<a class="wiki-link" data-note-name="N">', '<a href="u">',
    // White space past ASCII after an `<a`, a name right after the class, and letters whose full
    // lowercasing changes length or turns into an ASCII letter
    '<a', '\u3000', '<a class="wiki-link"data-note-name="N">', '\u0130', '\u212a', 'class="wi\u212ai-link"', '<stri\u212ae>',
  ];
  let seed = 0x14d00d;
  const random = n => {
    seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
    return seed % n;
  };
  for (let k = 0; k < 20000; k++) {
    let html = '';
    const length = 1 + random(12);
    for (let j = 0; j < length; j++) html += PIECES[random(PIECES.length)];
    found.add(html);
  }
  return [...found];
}

/** How long one call takes, the fastest of three */
function timeOf(fn, value) {
  let best = Infinity;
  for (let k = 0; k < 3; k++) {
    const start = performance.now();
    fn(value);
    best = Math.min(best, performance.now() - start);
  }
  return best;
}

/** Whether four times the input takes well under the sixteen times a quadratic read would */
const linear = (fn, make) => timeOf(fn, make(80_000)) < Math.max(timeOf(fn, make(20_000)) * 8, 50);

describe("the Markdown export keeps 1.4.x's bytes", () => {
  it('htmlToMarkdown gives what it gave, and throws where it threw', () => {
    const wrong = values().filter(value => outcome(htmlToMarkdown, value) !== outcome(oldHtmlToMarkdown, value));
    assert.deepEqual(wrong.slice(0, 5), []);
  });
});

describe('the Markdown export reads in linear time', () => {
  it('a long run of wiki link starts reads in linear time', () => {
    assert.ok(linear(htmlToMarkdown, n => '<a class="wiki-link" '.repeat(n / 21)));
    assert.ok(linear(htmlToMarkdown, n => `<a ${'class="wiki-link"'.repeat(n / 17)}`));
  });

  it('a long run of unclosed formatting and links reads in linear time', () => {
    assert.ok(linear(htmlToMarkdown, n => '<b>'.repeat(n / 3)));
    assert.ok(linear(htmlToMarkdown, n => '<a href="x">'.repeat(n / 12)));
    assert.ok(linear(htmlToMarkdown, n => '<'.repeat(n)));
  });
});
