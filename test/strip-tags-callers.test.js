'use strict';

// The legacy scripts' tag stripping drops tags in one pass (replaceTags). Each caller gives what
// its 1.4.x code gave, byte for byte, on the corpus and on seeded strings, and strips tags in
// linear time.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { createLegacyEnv } = require('./helpers/legacy-env');
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

// The editor's expression as it reads now, with the page's Utils
const env = createLegacyEnv();
env.load('js/utils.js');
const Utils = env.get('Utils');
const snapshotText = content =>
  content ? Utils.replaceTags(String(content.replace(/(?:)/, '')), '', false) : '';

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

describe("the legacy scripts' tag stripping keeps 1.4.x's bytes", () => {
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

  it("the editor's version history preview reads through Utils.replaceTags", () => {
    const source = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'js', 'editor.js'), 'utf8');
    assert.ok(source.includes("Utils.replaceTags(String(blockData.content.replace(/(?:)/, '')), '', false)"));
    assert.equal(/\.replace\(\/<\[\^>\]\*>\/g/.test(source), false);
  });
});

describe('the legacy scripts strip tags in linear time', () => {
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
