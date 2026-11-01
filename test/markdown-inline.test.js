'use strict';

// AIResponseUtils.markdownInlineToHtml, which AI responses and Markdown import read
// inline Markdown with (through markdownToBlocks), gives what its 1.4.x code gave, byte for byte,
// on the corpus and on seeded strings, and converts Markdown links in linear time.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { markdownInlineToHtml, markdownToBlocks } = require('../js/ai-response-utils.js');
const { CASES } = require('./fixtures/blocks/corpus.cjs');

// ============ The 1.4.x code, word for word (js/ai-response-utils.js) ============

function escapeHtml(text) {
  return String(text || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function oldMarkdownInlineToHtml(text) {
  let result = escapeHtml(text || '');

  result = result.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  result = result.replace(/__([^_]+)__/g, '<strong>$1</strong>');
  result = result.replace(/(?<![*\w])\*([^*]+)\*(?![*\w])/g, '<em>$1</em>');
  result = result.replace(/(?<![_\w])_([^_]+)_(?![_\w])/g, '<em>$1</em>');
  result = result.replace(/~~([^~]+)~~/g, '<del>$1</del>');
  result = result.replace(/`([^`]+)`/g, '<code>$1</code>');
  result = result.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');
  result = result.replace(/\[\[([^\]]+)\]\]/g, '<a href="#" class="wiki-link" data-note-name="$1">$1</a>');
  result = result.replace(/\n/g, '<br>');

  return result;
}

/** Every string a corpus block holds, seeded strings, and values that aren't strings */
function values() {
  const found = new Set([null, undefined, 0, 5, true, ['a'], { a: 1 }, '']);
  for (const [, block] of CASES) {
    if (block === null || typeof block !== 'object') continue;
    for (const value of Object.values(block)) if (typeof value === 'string') found.add(value);
  }
  const PIECES = ['[', ']', '(', ')', '[[', ']]', '](', '[a](b)', '[[N]]', '*', '**', '_', '__', '~~', '`', 'x', ' ', '\n', '\r', '$1', '$&', '<', '&', '"', '\u2028', '\u2029'];
  let seed = 0x1a4d;
  const random = n => {
    seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
    return seed % n;
  };
  for (let k = 0; k < 30000; k++) {
    let text = '';
    const length = 1 + random(14);
    for (let j = 0; j < length; j++) text += PIECES[random(PIECES.length)];
    found.add(text);
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

describe("AIResponseUtils' inline Markdown keeps 1.4.x's bytes", () => {
  it('markdownInlineToHtml gives what it gave', () => {
    const wrong = values().filter(value => markdownInlineToHtml(value) !== oldMarkdownInlineToHtml(value));
    assert.deepEqual(wrong.slice(0, 5), []);
  });

  it('still converts links and wiki links', () => {
    assert.equal(markdownInlineToHtml('see [docs](https://example.test/a) and [[Other note]]'),
      'see <a href="https://example.test/a">docs</a> and <a href="#" class="wiki-link" data-note-name="Other note">Other note</a>');
  });
});

describe("AIResponseUtils' inline Markdown reads in linear time", () => {
  it('Markdown links convert in linear time', () => {
    for (const piece of ['[', '#[', '[a]', '[a](', '[[', ')[[', '[[a]']) {
      assert.ok(linear(markdownInlineToHtml, n => piece.repeat(Math.ceil(n / piece.length))), piece);
    }
    assert.ok(linear(markdownToBlocks, n => '['.repeat(n)));
  });
});
