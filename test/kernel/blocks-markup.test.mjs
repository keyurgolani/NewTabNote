// #14 slice 1: the two regex readers the block projections keep from 1.4.x, the note list's
// stripTags and the Markdown export's inlineMarkdown, give what 1.4.x's expressions gave, byte
// for byte, and read in linear time. The 1.4.x chains are the verbatim copies in
// test/fixtures/blocks/legacy-projections.cjs.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

import { inlineMarkdown } from '../../js/kernel/core/blocks/markup.js';
import { stripTags } from '../../js/kernel/core/blocks/strip-tags.js';
import { linear } from '../helpers/linear-time.js';

const requireCommonJs = createRequire(import.meta.url);
/** @type {{sidebarExtractBlockText: (block: unknown) => string, htmlToMarkdown: (html: unknown) => string}} */
const legacy = requireCommonJs('../fixtures/blocks/legacy-projections.cjs');
/** @type {{CASES: [string, unknown][]}} */
const { CASES } = requireCommonJs('../fixtures/blocks/corpus.cjs');

/** 1.4.x's note list stripHtml, as legacy-projections.cjs keeps it inside its extractor */
const oldStripTags = (/** @type {unknown} */ value) => legacy.sidebarExtractBlockText({ type: 'text', content: value });

/**
 * What a call gave: its value, or the name of the error class it threw
 * @param {(value: any) => unknown} fn
 * @param {unknown} value
 */
const outcome = (fn, value) => {
  try {
    return { value: fn(value) };
  } catch (error) {
    return { threw: /** @type {Error} */ (error).name };
  }
};

/** Every string a corpus block holds in a field 1.4.x read, and a few that aren't strings */
const corpusValues = () => {
  /** @type {Set<unknown>} */
  const values = new Set([null, undefined, 0, 5, true, ['<b>a</b>'], { a: 1 }, new String('<b>x</b>')]);
  for (const [, block] of CASES) {
    if (block === null || typeof block !== 'object') continue;
    for (const value of Object.values(block)) if (typeof value === 'string') values.add(value);
  }
  return [...values];
};

/** Seeded strings from the pieces the expressions look for */
const seededStrings = (/** @type {number} */ count) => {
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
  const random = (/** @type {number} */ n) => {
    seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
    return seed % n;
  };
  const strings = [];
  for (let k = 0; k < count; k++) {
    let html = '';
    const length = 1 + random(12);
    for (let j = 0; j < length; j++) html += PIECES[random(PIECES.length)];
    strings.push(html);
  }
  return strings;
};

describe("the regex readers give 1.4.x's bytes (#14 slice 1, answer 5)", () => {
  const values = [...corpusValues(), ...seededStrings(20_000)];

  it("stripTags gives what the note list's stripHtml gave", () => {
    const wrong = values.filter(value => JSON.stringify(outcome(stripTags, value)) !== JSON.stringify(outcome(oldStripTags, value)));
    assert.deepEqual(wrong.slice(0, 5), []);
  });

  it("inlineMarkdown gives what AIResponseUtils' htmlToMarkdown gave, and throws where it threw", () => {
    const wrong = values.filter(value => JSON.stringify(outcome(inlineMarkdown, value)) !== JSON.stringify(outcome(legacy.htmlToMarkdown, value)));
    assert.deepEqual(wrong.slice(0, 5), []);
  });
});

describe('the regex readers read in linear time (#14 slice 1)', () => {
  it('previews strip a long run of unclosed tags in linear time', () => {
    assert.ok(linear(stripTags, n => '<br '.repeat(n / 4)));
    assert.ok(linear(stripTags, n => '<'.repeat(n)));
  });

  it('Markdown export reads a long run of wiki link starts in linear time', () => {
    assert.ok(linear(inlineMarkdown, n => '<a class="wiki-link" '.repeat(n / 21)));
    assert.ok(linear(inlineMarkdown, n => `<a ${'class="wiki-link"'.repeat(n / 17)}`));
  });

  it('Markdown export reads a long run of unclosed formatting and links in linear time', () => {
    assert.ok(linear(inlineMarkdown, n => '<b>'.repeat(n / 3)));
    assert.ok(linear(inlineMarkdown, n => '<a href="x">'.repeat(n / 12)));
    assert.ok(linear(inlineMarkdown, n => '<'.repeat(n)));
  });

  // The inputs above complete nothing; these complete a wiki link, a formatting pair or a link
  // in every few characters
  it('Markdown export reads many completed wiki links, formatting and links in linear time', () => {
    assert.ok(linear(inlineMarkdown, n => '<a class="wiki-link" data-note-name="N">N</a>'.repeat(n / 46)));
    assert.ok(linear(inlineMarkdown, n => '<b>x</b>'.repeat(n / 8)));
    assert.ok(linear(inlineMarkdown, n => '<a href="x">y</a>'.repeat(n / 17)));
  });
});
