'use strict';

// #14: the text readers on the save, AI chat, AI insights and paste paths give what their 1.4.x
// code gave, on the corpus, on seeded strings and on shapes built for each expression, and
// read in linear time. The 1.4.x code is word for word in test/fixtures/legacy-text-paths.cjs
// and the v1.4.1 release copy of js/utils.js.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
require('./helpers/block-projections');
const { createLegacyEnv } = require('./helpers/legacy-env');
const legacy = require('./fixtures/legacy-text-paths.cjs');
const { CASES } = require('./fixtures/blocks/corpus.cjs');
const { linear } = require('./helpers/linear-time.js');

const env = createLegacyEnv();
env.load(
  'js/utils.js', 'js/core/storage-error.js', 'js/storage.js', 'js/sidebar-utils.js', 'js/blocks.js', 'js/editor.js',
  'js/ai-response-utils.js', 'js/controllers/ai-chat-controller.js',
);
const Utils = env.get('Utils');
const editor = env.get('BlockEditor').prototype;
const chat = env.get('AIChatController').prototype;

const oldEnv = createLegacyEnv();
oldEnv.load('test/fixtures/storage/releases/v1.4.1/js/utils.js');
const OldUtils = oldEnv.get('Utils');

const llmSource = fs.readFileSync(path.join(__dirname, '..', 'js', 'llm.js'), 'utf8');
const llmContext = vm.createContext({ window: {}, console, chrome: undefined, setTimeout, clearTimeout, AbortController });
new vm.Script(llmSource).runInContext(llmContext);
// llm.js leaves its one instance on window
const llm = llmContext.window.LLM;

/**
 * What a call gave, as JSON across realms: its value, or the name of the error class it threw
 * @param {(value: any) => unknown} fn
 * @param {unknown} value
 */
const outcome = (fn, value) => {
  try {
    return JSON.stringify({ value: fn(value) });
  } catch (error) {
    return JSON.stringify({ threw: error.name });
  }
};

/** Every string a corpus block holds, and a few values that aren't strings */
const corpusValues = () => {
  const values = new Set([null, undefined, '', 0, 5, true, ['[[a]]'], { a: 1 }, new String('[[x]] ```a```')]);
  for (const [, block] of CASES) {
    if (block === null || typeof block !== 'object') continue;
    for (const value of Object.values(block)) if (typeof value === 'string') values.add(value);
  }
  return [...values];
};

/**
 * `count` seeded strings from `pieces`
 * @param {string[]} pieces
 * @param {number} count
 */
const seeded = (pieces, count) => {
  let seed = 0x14e1;
  const random = n => {
    seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
    return seed % n;
  };
  const strings = [];
  for (let k = 0; k < count; k++) {
    let text = '';
    const length = 1 + random(14);
    for (let j = 0; j < length; j++) text += pieces[random(pieces.length)];
    strings.push(text);
  }
  return strings;
};

/**
 * The values from `values` where `fn` and `old` give different outcomes, the first five
 * @param {(value: any) => unknown} fn
 * @param {(value: any) => unknown} old
 * @param {unknown[]} values
 */
const differences = (fn, old, values) => values.filter(value => outcome(fn, value) !== outcome(old, value)).slice(0, 5);

const WIKI_PIECES = ['[', '[[', ']', ']]', '[[a]]', '[[ b ]]', 'x', ' ', '\n', '\t', ' ', '[[]]', ']]]', '[[[', 'a]b'];
const MARKDOWN_PIECES = [
  '```', '```js\n', '```\n', '`', '``', 'x', 'a b', ' ', '\n', '\n\n', '\r', '\t', ' ', '[[', ']]', '[', ']', '(', ')',
  '](', '[a](b)', '[[n]]', '# ', '## ', '### ', '- ', '* ', '1. ', '> ', '---', '***', '|', '|a|b|\n', '|-|:-:|\n', '**',
  '__', '*', '_', '<li>', '</li>', '<li>x</li>\n', '<oli>', '</oli>', '- a\n', '1. a\n', '<p>', '&', '<', '>', '"', "'",
  '$$', '$&', "$'", '$1', '$', '\u0000', '\u2028', 'json',
];
const TABLE_PIECES = ['|', '||', '|a|', '|a|b|', '|-|', '|:-:|', '-', ':', ' ', '\t', '\n', '\r', '\r\n', '\u2028', 'x', '|-\n', '|-|\n', '|a|\n'];
const RETRY_PIECES = ['1', '12', '0', ' ', '  ', '\t', '\n', ' ', 's', 'S', 'sec', 'secs', 'second', 'seconds', 'x', 'ms', 'ſ', 'Retry in '];
const INSIGHT_PIECES = ['```', '```json', '```JSON', 'json', ' ', '\n', '\t', '{', '}', '{"a": 1}', 'x', '`', '``', '[', ']', '"'];
const FENCE_PIECES = ['```', '`', '``', '\n', '\r', '\r\n', ' ', 'x', ' ', '\t', ' ', 'js', 'a b', '\n```', '```\n'];

/**
 * A string whose 1.4.x rendering the restore declares it doesn't keep (below): code holding a
 * replacement pattern that copies the text around it, or a NUL that can spell a placeholder
 * @param {unknown} value
 */
const isDeclaredMarkdown = value =>
  typeof value === 'string' && (value.includes('$`') || (value.includes('\u0000') && /CODEBLOCK|INLINECODE/.test(value)));

/** Markdown pieces whose text holds no markup */
const PLAIN_MARKDOWN_PIECES = [
  '```', '```js\n', '```\n', '`', '``', 'x', 'a b', ' ', '\n', '\n\n', '\t', '[[', ']]', '[', ']', '(', ')', '](', '[a](b)',
  '[a](https://a.test/x)', '[m](mailto:a@b.test)', '[[n]]', '[[a b]]', '# ', '## ', '### ', '- ', '* ', '1. ', '> ', '---', '***',
  '|', '|a|b|\n', '|-|:-:|\n', '**', '__', '*', '_', '- a\n', '1. a\n', '> q\n', '`a > b`', '"', "'", '>', 'Tom', 'x > y',
];

/**
 * Whether `value`'s text holds markup, which the chat now shows as text (declared): a tag or
 * a character reference, or a Markdown link to an address the link rule refuses
 * @param {unknown} value
 */
const holdsMarkup = value => {
  if (typeof value !== 'string') return false;
  if (/[<&]/.test(value)) return true;
  return [...value.matchAll(/\[([^\]]+)\]\(([^)]+)\)/g)].some(([, , address]) => !env.global.BlockRendering.isLinkHref(address));
};

/** @type {Record<string, string>} */
const SHOWN_THE_SAME = { '&gt;': '>', '&quot;': '"', '&#39;': "'" };

/**
 * `html` with the characters a text node shows the same, escaped or not, written as themselves
 * @param {unknown} html
 */
const asShown = html => (typeof html === 'string' ? html.replace(/&gt;|&quot;|&#39;/g, entity => SHOWN_THE_SAME[entity]) : html);

describe("the text paths give 1.4.x's output (#14)", () => {
  const corpus = corpusValues();

  it("the save's and the AI insert's wiki-link names are the ones 1.4.x read", () => {
    const values = [...corpus, ...seeded(WIKI_PIECES, 20_000)];
    const strings = values.filter(value => typeof value === 'string');
    assert.equal(globalThis.BlockProjections.wikiLinkNames, env.global.BlockProjections.wikiLinkNames);
    assert.deepEqual(differences(globalThis.BlockProjections.wikiLinkNames, legacy.wikiLinkNames, values), []);
    // The save reads the editor's text, always a string, where 1.4.x ran Utils.extractWikiLinks
    assert.deepEqual(differences(globalThis.BlockProjections.wikiLinkNames, OldUtils.extractWikiLinks.bind(OldUtils), strings), []);
    assert.equal(Utils.extractWikiLinks, undefined);
  });

  it('AI chat renders Markdown as 1.4.x did, where its text holds no markup', () => {
    // 1.4.x let a link's address or a wiki link's name run into the HTML it had made; the chat
    // shows that text as text now (declared)
    const ranIntoHtml = value => {
      try {
        return /(?:href|data-note-name)="[^"]*</.test(OldUtils.parseMarkdown(value));
      } catch {
        return false;
      }
    };
    const values = [...corpus, ...seeded(MARKDOWN_PIECES, 20_000), ...seeded(PLAIN_MARKDOWN_PIECES, 20_000)]
      .filter(value => !isDeclaredMarkdown(value) && !holdsMarkup(value) && !ranIntoHtml(value));
    assert.ok(values.length > 25_000);
    assert.deepEqual(differences(text => asShown(Utils.parseMarkdown(text)), text => asShown(OldUtils.parseMarkdown(text)), values), []);
    assert.deepEqual(
      differences(html => Utils.convertWikiLinksToHtml(html), html => OldUtils.convertWikiLinksToHtml(html), [...corpus, ...seeded(WIKI_PIECES, 5000)]),
      [],
    );
    const tables = [...corpus.filter(value => typeof value === 'string'), ...seeded(TABLE_PIECES, 20_000)];
    assert.deepEqual(differences(text => Utils.parseMarkdownTables(text), text => OldUtils.parseMarkdownTables(text), tables), []);
  });

  it("AI chat restores code as 1.4.x did, but writes the patterns that copy the text around it as they stand, and reads only the placeholders it made (declared)", () => {
    const copying = 'lead\n\n```\n$`\n```';
    assert.equal(Utils.parseMarkdown(copying), '<p>lead</p>\n<pre><code>$`</code></pre>');
    assert.notEqual(OldUtils.parseMarkdown(copying), Utils.parseMarkdown(copying));
    const spelled = '```\n\u0000INLINECODE0\u0000\n``` `x`';
    assert.equal(Utils.parseMarkdown(spelled), '<pre><code>\u0000INLINECODE0\u0000</code></pre> <code>x</code>');
    assert.notEqual(OldUtils.parseMarkdown(spelled), Utils.parseMarkdown(spelled));
    // The bounded patterns keep 1.4.x's output
    for (const text of ['a `$$` b', 'a `$&` b', 'a `$<` b', '```\n$$ $& $1\n```']) assert.equal(Utils.parseMarkdown(text), OldUtils.parseMarkdown(text), text);
  });

  it("a rate limit's wait is the one 1.4.x read", () => {
    const values = [...corpus, ...seeded(RETRY_PIECES, 20_000)];
    assert.deepEqual(differences(message => chat._parseRetryAfter(message), legacy.parseRetryAfter, values), []);
  });

  it('the AI insights read the JSON 1.4.x read', () => {
    const values = [...corpus, ...seeded(INSIGHT_PIECES, 20_000)];
    assert.deepEqual(differences(response => llm._insightsJson(response), legacy.insightsJson, values), []);
  });

  it('a paste finds fenced code, and its code, as 1.4.x did', () => {
    const values = [...corpus, ...seeded(FENCE_PIECES, 20_000)];
    assert.deepEqual(differences(text => editor.isFencedCode(text), legacy.isFencedCode, values), []);
    assert.deepEqual(differences(text => editor.extractFencedCode(text), legacy.extractFencedCode, values), []);
  });
});

describe('the text paths read in linear time (#14)', () => {
  it('reads wiki-link names in linear time', () => {
    const read = globalThis.BlockProjections.wikiLinkNames;
    assert.ok(linear(read, n => '['.repeat(n)));
    assert.ok(linear(read, n => '[[a'.repeat(n / 3)));
    assert.ok(linear(read, n => `]${'[['.repeat(n / 2)}`));
  });

  // The inputs above find no name; these find one in every few characters, one name again and
  // again, and names all different
  it('reads many wiki-link names in linear time', () => {
    const read = globalThis.BlockProjections.wikiLinkNames;
    assert.ok(linear(read, n => '[[a]] '.repeat(n / 6)));
    assert.ok(linear(read, n => Array.from({ length: Math.floor(n / 8) }, (_, i) => `[[${i}]]`).join('')));
  });

  it('renders Markdown in linear time', () => {
    const render = text => Utils.parseMarkdown(text);
    assert.ok(linear(render, n => '['.repeat(n)));
    assert.ok(linear(render, n => '(['.repeat(n / 2)));
    assert.ok(linear(render, n => '`x`     '.repeat(n / 8)));
    assert.ok(linear(render, n => `\`\`\`${'a'.repeat(n)}`));
    assert.ok(linear(render, n => '```a\n```\n'.repeat(n / 9)));
    // List items come only from list lines: plain text is escaped before the list step (#132)
    assert.ok(linear(render, n => '- a\n'.repeat(n / 4)));
    assert.ok(linear(render, n => '1. a\n'.repeat(n / 5)));
    assert.ok(linear(render, n => '|-|\n|-\n'.repeat(n / 7)));
    assert.ok(linear(render, n => '|a|\n'.repeat(n / 4)));
    assert.ok(linear(render, n => `|a|\n|${'-'.repeat(n)}`));
  });

  // Each of these grows a unit the renderer does work for once it's found: links, wiki links,
  // a table's rows, and paragraphs
  it('renders Markdown with many links, wiki links, table rows and paragraphs in linear time', () => {
    const render = text => Utils.parseMarkdown(text);
    assert.ok(linear(render, n => '[a](https://a.test) '.repeat(n / 21)));
    assert.ok(linear(render, n => '[[a]] '.repeat(n / 6)));
    assert.ok(linear(render, n => `|a|\n|-|\n${'|b|\n'.repeat(n / 4)}`));
    assert.ok(linear(render, n => 'a\n\n'.repeat(n / 3)));
  });

  it("reads a rate limit's wait in linear time", () => {
    const read = message => chat._parseRetryAfter(message);
    assert.ok(linear(read, n => ` ${'1'.repeat(n)}`));
    assert.ok(linear(read, n => `1${' '.repeat(n)}`));
  });

  it("reads an insights response's JSON in linear time", () => {
    const read = response => llm._insightsJson(response);
    assert.ok(linear(read, n => `\`\`\`${' '.repeat(n)}x`));
    assert.ok(linear(read, n => `{${'={'.repeat(n / 2)}\n`));
  });

  it('reads pasted fenced code in linear time', () => {
    const find = text => editor.isFencedCode(text);
    const extract = text => editor.extractFencedCode(text);
    assert.ok(linear(find, n => '```a\n'.repeat(n / 5)));
    assert.ok(linear(extract, n => `\`\`\`s${'`'.repeat(n)}!`));
    assert.ok(linear(extract, n => `\`\`\`${'a'.repeat(n)}\`\`\``));
    assert.ok(linear(extract, n => `\`\`\`\nx\`\`\`${' '.repeat(n)}`));
  });
});
