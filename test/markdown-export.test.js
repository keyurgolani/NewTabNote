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

/** The time of one call, in ms */
const timeOnce = (fn, value) => {
  const start = performance.now();
  fn(value);
  return performance.now() - start;
};

/**
 * Whether `fn` grows linearly: four times the input takes well under the sixteen times a
 * quadratic read would. The two sizes take turns, five calls each, and each keeps its best, so
 * a busy machine slows both alike. The measure runs up to three times, so one stalled attempt
 * doesn't decide it; a quadratic read misses every attempt.
 */
const linear = (fn, make) => {
  const small = make(20_000);
  const large = make(80_000);
  for (let attempt = 0; attempt < 3; attempt++) {
    let bestSmall = Number.POSITIVE_INFINITY;
    let bestLarge = Number.POSITIVE_INFINITY;
    for (let k = 0; k < 5; k++) {
      bestSmall = Math.min(bestSmall, timeOnce(fn, small));
      bestLarge = Math.min(bestLarge, timeOnce(fn, large));
    }
    if (bestLarge < Math.max(bestSmall * 8, 50)) return true;
  }
  return false;
};

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
