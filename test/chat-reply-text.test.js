'use strict';

// #21: the AI chat's replies, which it renders from Markdown (Utils.parseMarkdown, then
// sanitizeHtml). Plain text in a reply is shown as text: the only elements a reply renders are
// the ones its Markdown makes, a link goes only where the link rule lets it, and code is shown
// as written. test/linear-text-paths.test.js holds the Markdown itself to 1.4.x's output.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { createLegacyEnv } = require('./helpers/legacy-env');

const env = createLegacyEnv();
env.load('js/utils.js');
const Utils = env.get('Utils');
const { isLinkHref } = env.global.BlockRendering;

/** The elements Markdown makes, each with the attributes it may have */
const MADE = {
  h1: [], h2: [], h3: [], hr: [], blockquote: [], p: [], br: [], strong: [], em: [], ul: [], ol: [], li: [],
  pre: [], code: ['class'], table: [], thead: [], tbody: [], tr: [], th: ['style'], td: ['style'],
  a: ['href', 'target', 'rel', 'class', 'data-note-name'],
};

/** @type {Record<string, string>} */
const REFERENCES = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'" };
const decoded = (/** @type {string} */ value) => value.replace(/&(?:amp|lt|gt|quot|#39);/g, entity => REFERENCES[entity]);

/**
 * What in `html` isn't Markdown's own: an element it doesn't make, an attribute that element
 * doesn't have, an attribute value with a raw quote, a link the link rule refuses, or a `<` or
 * `&` that starts no tag or reference of the ones Markdown writes
 * @param {string} html
 * @returns {string[]}
 */
function notMarkdowns(html) {
  /** @type {string[]} */
  const found = [];
  const rest = html.replace(/<(\/?)([a-z0-9]+)((?: [a-z-]+="[^"]*")*)>/g, (tag, closing, name, attributes) => {
    if (!Object.hasOwn(MADE, name)) {
      found.push(tag);
      return '';
    }
    if (closing && attributes) found.push(tag);
    for (const [, attribute, value] of attributes.matchAll(/ ([a-z-]+)="([^"]*)"/g)) {
      if (!MADE[name].includes(attribute)) found.push(tag);
      if (attribute === 'href' && !isLinkHref(decoded(value))) found.push(tag);
      if (attribute === 'style' && !/^text-align: (left|center|right)$/.test(value)) found.push(tag);
    }
    return '';
  });
  const stray = rest.replace(/&(?:amp|lt|gt|quot|#39);/g, '');
  if (/[<&]/.test(stray)) found.push(`stray: ${stray.slice(0, 80)}`);
  return found;
}

/**
 * `count` seeded strings from `pieces`
 * @param {string[]} pieces
 * @param {number} count
 */
const seeded = (pieces, count) => {
  let seed = 0x21c4;
  const random = (/** @type {number} */ n) => {
    seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
    return seed % n;
  };
  const strings = [];
  for (let k = 0; k < count; k++) {
    let text = '';
    const length = 1 + random(16);
    for (let j = 0; j < length; j++) text += pieces[random(pieces.length)];
    strings.push(text);
  }
  return strings;
};

const PIECES = [
  'x', 'a b', ' ', '\n', '\n\n', '\t', '# ', '## ', '- ', '1. ', '> ', '---', '|a|b|\n', '|-|:-:|\n', '**', '_', '*', '`', '```',
  '```js\n', '[[', ']]', '[[n]]', '[', ']', '(', ')', '](', '[a](https://a.test/x)', '[a](b)', '[a](ftp://a.test)', '[a](x:y)',
  '[a](b"c)', "[a](b'c)", '<', '>', '&', '"', "'", '=', '/', '<b>', '</b>', '<i>x</i>', '<p>', '<li>', '</li>', '<oli>',
  '<span class="c">', '<a href="https://a.test/">', '</a>', '<div style="color: red">', '<br>', '<hr>', '<table>', '<td>',
  '<img alt="x">', '<input value="v">', '<style>p{}</style>', '<!--', '-->', '&amp;', '&lt;', '&#60;', '&nbsp;', '<code>', '</pre>',
];

describe("the AI chat's replies show plain text as text (#21)", () => {
  it('render only the elements and attributes their Markdown makes', () => {
    const failures = seeded(PIECES, 30_000)
      .map(text => ({ text, found: notMarkdowns(Utils.parseMarkdown(text)) }))
      .filter(({ found }) => found.length > 0)
      .slice(0, 5);
    assert.deepEqual(failures, []);
  });

  it('show markup in a reply as written', () => {
    assert.equal(Utils.parseMarkdown('Sure <b>x</b> & <i>y</i>'), '<p>Sure &lt;b&gt;x&lt;/b&gt; &amp; &lt;i&gt;y&lt;/i&gt;</p>');
    assert.equal(Utils.parseMarkdown('<p>a</p>\n\n<ul><li>b</li></ul>'), '<p>&lt;p&gt;a&lt;/p&gt;</p>\n<p>&lt;ul&gt;&lt;li&gt;b&lt;/li&gt;&lt;/ul&gt;</p>');
    assert.equal(Utils.parseMarkdown('&lt; and &amp;'), '<p>&amp;lt; and &amp;amp;</p>');
  });

  it("keep code as written, escaped once, and Markdown's own quotes, links and wiki links", () => {
    assert.equal(Utils.parseMarkdown('Run `a <b> & c`'), '<p>Run <code>a &lt;b&gt; &amp; c</code></p>');
    assert.equal(Utils.parseMarkdown('```html\n<b>x</b>\n```'), '<pre><code class="language-html">&lt;b&gt;x&lt;/b&gt;</code></pre>');
    assert.equal(Utils.parseMarkdown('> quoted'), '<blockquote>quoted</blockquote>');
    assert.equal(Utils.parseMarkdown('See [[Tom & Jerry]]'), '<p>See <a href="#" class="wiki-link" data-note-name="Tom &amp; Jerry">[[Tom &amp; Jerry]]</a></p>');
    assert.equal(
      Utils.parseMarkdown('[docs](https://a.test/?a=1&b=2)'),
      '<p><a href="https://a.test/?a=1&amp;b=2" target="_blank" rel="noopener noreferrer">docs</a></p>',
    );
  });

  it('link only where the link rule lets a link go, and keep an address inside its attribute', () => {
    assert.equal(Utils.parseMarkdown('[a](ftp://a.test/x) and [b](x:y)'), '<p>[a](ftp://a.test/x) and [b](x:y)</p>');
    assert.equal(Utils.parseMarkdown('[m](mailto:a@b.test)'), '<p><a href="mailto:a@b.test" target="_blank" rel="noopener noreferrer">m</a></p>');
    assert.equal(
      Utils.parseMarkdown('[a](https://a.test/" title="t)'),
      '<p><a href="https://a.test/&quot; title=&quot;t" target="_blank" rel="noopener noreferrer">a</a></p>',
    );
  });
});
