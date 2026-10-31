'use strict';

// #14 slice 1: the legacy scripts' own tag stripping goes through the block model layer's
// stripTags and replaceTags, which the new tab's bridge puts on BlockProjections. Each caller
// gives what its 1.4.x code gave, byte for byte, on the corpus and on seeded strings, and
// strips tags in linear time.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
// The page's BlockProjections, as the new tab's bridge sets it
require('./helpers/block-projections');
const AIResponseUtils = require('../js/ai-response-utils.js');
const SidebarUtils = require('../js/sidebar-utils.js');
const { CASES } = require('./fixtures/blocks/corpus.cjs');

// ============ The 1.4.x code, word for word ============

// AIResponseUtils.stripHtml (js/ai-response-utils.js)
function oldAiStripHtml(text) {
  return String(text || '')
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// SidebarUtils.stripHtml (js/sidebar-utils.js)
function oldSidebarStripHtml(value = '') {
  return String(value)
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// BlockEditor's version history preview of a block's content (js/editor.js)
const oldSnapshotText = content => (content ? content.replace(/<[^>]*>/g, '') : '');

// ============ Now ============

// The editor's expression as it reads now
const snapshotText = content =>
  content ? globalThis.BlockProjections.replaceTags(String(content.replace(/(?:)/, '')), '', false) : '';

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
  const found = new Set([null, undefined, 0, 5, true, false, ['<b>a</b>'], { a: 1 }, new String('<b>x</b>')]);
  for (const [, block] of CASES) {
    if (block === null || typeof block !== 'object') continue;
    for (const value of Object.values(block)) if (typeof value === 'string') found.add(value);
  }
  const PIECES = ['<', '>', '<>', '<br>', '<br/>', '<BR />', '<br ', '<b>', '</b>', 'x', ' ', '\n', '\t', '&nbsp;', '&NBSP;', '\u00a0', '"', '<a href="x">'];
  let seed = 0x5719;
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

describe("the legacy scripts' tag stripping keeps 1.4.x's bytes (#14 slice 1)", () => {
  const all = values();
  for (const [label, now, then] of [
    ['AIResponseUtils.stripHtml', AIResponseUtils.stripHtml, oldAiStripHtml],
    ['SidebarUtils.stripHtml', SidebarUtils.stripHtml, oldSidebarStripHtml],
    ["the editor's version history preview", snapshotText, oldSnapshotText],
  ]) {
    it(label, () => {
      const wrong = all.filter(value => outcome(now, value) !== outcome(then, value));
      assert.deepEqual(wrong.slice(0, 5), []);
    });
  }

  it("the editor's version history preview reads through BlockProjections", () => {
    const source = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'js', 'editor.js'), 'utf8');
    assert.ok(source.includes("globalThis.BlockProjections.replaceTags(String(blockData.content.replace(/(?:)/, '')), '', false)"));
    assert.equal(/\.replace\(\/<\[\^>\]\*>\/g/.test(source), false);
  });
});

describe('the legacy scripts strip tags in linear time (#14 slice 1)', () => {
  it('the AI path strips tags in linear time', () => {
    assert.ok(linear(AIResponseUtils.stripHtml, n => '<br '.repeat(n / 4)));
    assert.ok(linear(AIResponseUtils.stripHtml, n => '<'.repeat(n)));
  });

  it('the note list strips tags in linear time', () => {
    assert.ok(linear(SidebarUtils.stripHtml, n => '<br '.repeat(n / 4)));
    assert.ok(linear(SidebarUtils.stripHtml, n => '<'.repeat(n)));
  });

  it("the editor's version history preview strips tags in linear time", () => {
    assert.ok(linear(snapshotText, n => '<'.repeat(n)));
  });
});
