'use strict';

// #14 slice 1: AIResponseUtils.markdownInlineToHtml, which AI responses and Markdown import read
// inline Markdown with (through markdownToBlocks), gives what its 1.4.x code gave, byte for byte,
// on the corpus and on seeded strings, and converts Markdown links in linear time. Slice 2's one
// declared change: a link whose address has a scheme other than http, https or mailto stays as
// its text.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
require('./helpers/block-projections');
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

// ============ The same, with slice 2's declared change to links ============

const { isLinkHref } = require('../js/kernel/core/blocks/rich-text.js');
const unescapeHtml = html => html.replace(/&(amp|lt|gt|quot|#39);/g, (_, name) => ({ amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'" })[name]);

/** 1.4.x's code, where a link match whose address the schema refuses stays as its text */
function declaredMarkdownInlineToHtml(text) {
  let result = escapeHtml(text || '');

  result = result.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  result = result.replace(/__([^_]+)__/g, '<strong>$1</strong>');
  result = result.replace(/(?<![*\w])\*([^*]+)\*(?![*\w])/g, '<em>$1</em>');
  result = result.replace(/(?<![_\w])_([^_]+)_(?![_\w])/g, '<em>$1</em>');
  result = result.replace(/~~([^~]+)~~/g, '<del>$1</del>');
  result = result.replace(/`([^`]+)`/g, '<code>$1</code>');
  result = result.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (match, label, href) => (isLinkHref(unescapeHtml(href)) ? `<a href="${href}">${label}</a>` : match));
  result = result.replace(/\[\[([^\]]+)\]\]/g, '<a href="#" class="wiki-link" data-note-name="$1">$1</a>');
  result = result.replace(/\n/g, '<br>');

  return result;
}

/** Whether `text` has a link match whose address the schema refuses, by the 1.4.x expression */
const refusesALink = text =>
  typeof text === 'string' && [...escapeHtml(text).matchAll(/\[([^\]]+)\]\(([^)]+)\)/g)].some(match => !isLinkHref(unescapeHtml(match[2])));

/** Every string a corpus block holds, seeded strings, and values that aren't strings */
function values() {
  const found = new Set([null, undefined, 0, 5, true, ['a'], { a: 1 }, '']);
  for (const [, block] of CASES) {
    if (block === null || typeof block !== 'object') continue;
    for (const value of Object.values(block)) if (typeof value === 'string') found.add(value);
  }
  const PIECES = [
    '[', ']', '(', ')', '[[', ']]', '](', '[a](b)', '[[N]]', '*', '**', '_', '__', '~~', '`', 'x', ' ', '\n', '\r', '$1', '$&', '<', '&', '"',
    '\u2028', '\u2029', '](javascript:', '[a](JavaScript:x)', '[b](data:y)', '(java\tscript:', '[c](https:', '](mailto:', ':', '\t',
    '&colon;', '&#58;',
  ];
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

/**
 * Whether four times the input takes well under the sixteen times a quadratic read would. A
 * busy machine can stall a measurement, so it measures up to three times; a quadratic read
 * grows too fast every time.
 */
const linear = (fn, make) => {
  const small = make(20_000);
  const large = make(80_000);
  for (let attempt = 0; attempt < 3; attempt++) {
    if (timeOf(fn, large) < Math.max(timeOf(fn, small) * 8, 50)) return true;
  }
  return false;
};

describe("AIResponseUtils' inline Markdown keeps 1.4.x's bytes (#14 slice 1)", () => {
  it('markdownInlineToHtml gives what it gave, wherever no link has a refused scheme', () => {
    const all = values();
    const kept = all.filter(value => !refusesALink(value));
    assert.ok(kept.length > all.length / 2, `${kept.length} of ${all.length}`);
    const wrong = kept.filter(value => markdownInlineToHtml(value) !== oldMarkdownInlineToHtml(value));
    assert.deepEqual(wrong.slice(0, 5), []);
  });

  it('keeps a link whose scheme the schema refuses as its text, and nothing else changes (#14 slice 2, declared)', () => {
    const all = values();
    assert.ok(all.filter(refusesALink).length > 1000);
    const wrong = all.filter(value => markdownInlineToHtml(value) !== declaredMarkdownInlineToHtml(value));
    assert.deepEqual(wrong.slice(0, 5), []);
    assert.equal(markdownInlineToHtml('[a](javascript:alert(1))'), '[a](javascript:alert(1))');
    assert.equal(markdownInlineToHtml('[a](mailto:me@a.test) [b](example.com)'), '<a href="mailto:me@a.test">a</a> <a href="example.com">b</a>');
  });

  it('still converts links and wiki links', () => {
    assert.equal(markdownInlineToHtml('see [docs](https://example.test/a) and [[Other note]]'),
      'see <a href="https://example.test/a">docs</a> and <a href="#" class="wiki-link" data-note-name="Other note">Other note</a>');
  });
});

describe("AIResponseUtils' inline Markdown reads in linear time (#14 slice 1)", () => {
  it('Markdown links convert in linear time', () => {
    for (const piece of ['[', '#[', '[a]', '[a](', '[[', ')[[', '[[a]', '[a](javascript:x)', '[a](javascript:']) {
      assert.ok(linear(markdownInlineToHtml, n => piece.repeat(Math.ceil(n / piece.length))), piece);
    }
    assert.ok(linear(markdownToBlocks, n => '['.repeat(n)));
  });

  it("reads a link's address in linear time", () => {
    for (const run of [' ', '\t']) {
      assert.ok(linear(markdownInlineToHtml, n => `[a](b${run.repeat(n)}c)`), JSON.stringify(run));
      assert.ok(linear(markdownToBlocks, n => `[a](b${run.repeat(n)}c)`), JSON.stringify(run));
      assert.ok(linear(markdownToBlocks, n => `- [a](b${run.repeat(n)}c)`), JSON.stringify(run));
    }
  });
});
