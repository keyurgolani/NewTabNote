'use strict';

// An AI reply's text is shown as text. Utils.parseMarkdownText escapes the reply's `&`, `<` and
// `"` before Markdown is read, everywhere but in code fences, code spans and wiki-link names,
// which parseMarkdown escapes itself, so only the Markdown becomes markup and nothing is escaped
// twice. A link keeps its address for http, https and mailto only. A reply in plain Markdown
// renders exactly as 1.4.1 rendered it (test/fixtures/v1.4.1/js/utils.js), and the reader runs
// in linear time.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { createLegacyEnv } = require('./helpers/legacy-env');

const env = createLegacyEnv();
env.load('js/utils.js');
const Utils = env.get('Utils');

const oldEnv = createLegacyEnv();
oldEnv.load('test/fixtures/v1.4.1/js/utils.js');
const OldUtils = oldEnv.get('Utils');

const render = (text) => Utils.parseMarkdownText(text);

/** Replies in plain Markdown: every construct parseMarkdown reads, with no `&`, `<` or `"` outside code */
const PLAIN = [
  '# Plan\n\n## Week one\n\n### Monday',
  'Some **bold**, some __strong__, some *italic* and some _emphasis_.',
  '- milk\n- eggs\n* bread',
  '1. first\n2. second\n3. third',
  '> a quote\n> on two lines',
  'Above\n\n---\n\nBelow\n\n***',
  'Run `npm test` before `git push`.',
  '```js\nconst a = b < c && d > e;\nconsole.log("x");\n```',
  '```\nplain <fence> & "text"\n```\n\nAfter the fence.',
  'See [the docs](https://example.test/docs?a=1), [the site](http://example.test) and [mail](mailto:team@example.test).',
  '| Name | Count |\n| :--- | ---: |\n| Milk | 2 |\n| Eggs | 12 |',
  'Linked notes: [[Groceries]] and [[ Weekly review ]].',
  'Line one\nline two\n\nA new paragraph.',
  'Mixed: **bold with `code`** and a list\n\n- item with [a link](https://example.test)\n- item with [[A note]]',
];

/** `count` seeded strings from `pieces` */
const seeded = (pieces, count) => {
  let seed = 0x5eed;
  const random = (n) => {
    seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
    return seed % n;
  };
  const strings = [];
  for (let i = 0; i < count; i++) {
    let text = '';
    for (let k = random(24); k >= 0; k--) text += pieces[random(pieces.length)];
    strings.push(text);
  }
  return strings;
};

/** Markdown pieces with no link syntax and nothing a reply's text escapes outside code */
const PLAIN_PIECES = [
  '```', '```js\n', '```\n', '`', '``', 'x', 'a b', ' ', '\n', '\n\n', '\t', '[[', ']]', '[', ']', '[[n]]', '# ', '## ', '### ',
  '- ', '* ', '1. ', '> ', '---', '***', '|', '|a|b|\n', '|-|:-:|\n', '**', '__', '*', '_', '- a\n', '1. a\n', "'", 'json',
];

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

describe("an AI reply's text is shown as text", () => {
  it("a reply's markup characters show as the reply wrote them", () => {
    assert.equal(render('Sure. <b>bold</b> & "quoted"'), '<p>Sure. &lt;b>bold&lt;/b> &amp; &quot;quoted&quot;</p>');
    assert.equal(render('# A <i>heading</i>\n\n- a <u>list</u> item'), '<h1>A &lt;i>heading&lt;/i></h1>\n<ul><li>a &lt;u>list&lt;/u> item</li></ul>');
  });

  it('code fences, code spans and wiki-link names are escaped once, as before', () => {
    for (const text of [
      'Use `a < b && "c"` here.',
      '```html\n<p class="x">a & b</p>\n```',
      'See [[Q&A "notes" <draft>]] today.',
      '`[[a <b>]]` and [[`x`]]',
    ]) {
      assert.equal(render(text), Utils.parseMarkdown(text), text);
    }
  });

  it('a link keeps its address for http, https and mailto, and loses it for any other', () => {
    assert.equal(
      render('[a](https://example.test/x?y=1&z=2) [b](HTTP://example.test) [c](mailto:team@example.test)'),
      '<p><a href="https://example.test/x?y=1&amp;z=2" target="_blank" rel="noopener noreferrer">a</a> '
        + '<a href="HTTP://example.test" target="_blank" rel="noopener noreferrer">b</a> '
        + '<a href="mailto:team@example.test" target="_blank" rel="noopener noreferrer">c</a></p>',
    );
    assert.equal(render('[d](ftp://example.test/file) [e](notes.html) [f](#top)'), '<p><a>d</a> <a>e</a> <a>f</a></p>');
  });

  it('a wiki link keeps its address and its name', () => {
    assert.equal(render('[[Groceries & more]]'), '<p><a href="#" class="wiki-link" data-note-name="Groceries &amp; more">[[Groceries &amp; more]]</a></p>');
  });

  it('a NUL is dropped, as parsing the HTML drops it', () => {
    assert.equal(render('a\u0000b'), '<p>ab</p>');
  });

  it('a reply in plain Markdown renders exactly as 1.4.1 rendered it', () => {
    for (const text of PLAIN) assert.equal(render(text), OldUtils.parseMarkdown(text), text);
    const different = seeded(PLAIN_PIECES, 4000).filter(text => render(text) !== OldUtils.parseMarkdown(text));
    assert.deepEqual(different.slice(0, 5), []);
  });

  it('reads a reply in linear time', () => {
    assert.ok(linear(render, n => '['.repeat(n)));
    assert.ok(linear(render, n => '[['.repeat(n / 2)));
    assert.ok(linear(render, n => '[[a'.repeat(n / 3)));
    assert.ok(linear(render, n => '`x`     '.repeat(n / 8)));
    assert.ok(linear(render, n => '```a\n```\n'.repeat(n / 9)));
    assert.ok(linear(render, n => `\`\`\`${'a'.repeat(n)}`));
    assert.ok(linear(render, n => '&<"'.repeat(n / 3)));
    assert.ok(linear(render, n => '[a](b)'.repeat(n / 6)));
    assert.ok(linear(render, n => `a${' '.repeat(n)}b`));
    assert.ok(linear(render, n => `[a](b${'\t'.repeat(n)}c)`));
  });
});
