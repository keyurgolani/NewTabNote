'use strict';

// Smart paste through production js/editor.js: each paste goes to the editor's onPaste, the
// handler the new tab's document sends its paste events to, with focus in a block of a
// stored note. What it detects shows in the note and in what is stored: a URL becomes a
// bookmark, fenced code a code block, TSV or CSV a table, Markdown its blocks, and anything
// else is the browser's to paste. test/paste.test.js covers which pane and field a paste
// belongs to; this file covers what each kind of text turns into.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  createLegacyEnv, FakeDocument, createDatabase, dumpDatabase, recordsOf, settle, makeEditor, note, block,
} = require('./helpers/legacy-env');

const FILES = [
  'js/utils.js', 'js/core/storage-error.js', 'js/storage.js', 'js/sidebar-utils.js', 'js/blocks.js',
  'js/ai-response-utils.js', 'js/editor.js',
];

/**
 * The fields of a block a paste sets, for comparing: type and content, plus the URL of a
 * bookmark, the rows of a table, and whether a todo is checked
 * @param {Object} b
 */
function fields(b) {
  const out = { type: b.type, content: b.content };
  if (b.type === 'bookmark') out.url = b.url;
  if (b.type === 'table') Object.assign(out, { tableData: b.tableData, rows: b.rows, cols: b.cols });
  if (b.type === 'todo') out.checked = Boolean(b.checked);
  return JSON.parse(JSON.stringify(out));
}

/**
 * A new tab with an editor on note N, stored with one text block (`content`), in the
 * active pane. `paste(text)` pastes plain text with focus in that block.
 * @param {string} content - The block's text; '' for an empty block
 */
async function noteWith(content) {
  const env = createLegacyEnv({ document: new FakeDocument() });
  await createDatabase(env.indexedDB, {
    records: { canvases: [note('N', { name: 'Groceries' })], elements: [block('b1', 'N', 0, content)] },
  });
  env.load(...FILES);
  // The editor's URL check, as a page has it
  env.global.URL = URL;
  await env.get('Storage').init();

  const doc = env.document;
  const pane = doc.body.appendChild(doc.createElement('div'));
  pane.className = 'editor-pane active';
  const editor = makeEditor(env, doc, { root: pane });
  const noop = () => {};
  // Rendering is the page's; the note's blocks and what is stored are what's checked
  Object.assign(editor, { insertBlockDOM: noop, rerenderBlock: noop, focusBlock: noop });
  await editor.loadNote('N');
  // The block's element, where focus is. It sits in the pane outside the blocks container,
  // since rendering is stubbed and a type change would otherwise redraw it.
  const row = pane.appendChild(doc.createElement('div'));
  row.className = 'block';
  row.setAttribute('data-id', 'b1');
  const text = row.appendChild(doc.createElement('div'));
  text.className = 'block-content';
  text.setAttribute('contenteditable', 'true');

  /** @param {string} clipboard @returns {boolean} whether the editor kept the browser from pasting it */
  const paste = (clipboard) => {
    text.focus();
    const event = {
      type: 'paste',
      target: text,
      clipboardData: { items: [], getData: (type) => (type === 'text/plain' ? clipboard : '') },
      defaultPrevented: false,
    };
    event.preventDefault = () => { event.defaultPrevented = true; };
    editor.onPaste(event);
    return event.defaultPrevented;
  };
  const shown = () => editor.blocks.map(fields);
  /** The note's blocks as stored, once the editor has written what it has pending */
  const saved = async () => {
    env.clock.tick(500);
    env.frames();
    await editor.flushSave();
    await settle();
    const rows = Object.values(recordsOf(await dumpDatabase(env.indexedDB), 'elements'));
    return rows.sort((a, b) => a.order - b.order).map(fields);
  };
  return { paste, shown, saved };
}

const EGGS = { type: 'text', content: 'eggs' };

/** [what is pasted, the text, the blocks it adds after a block holding "eggs"] */
const DETECTED = [
  ['an https URL', 'https://example.com', [{ type: 'bookmark', content: '', url: 'https://example.com' }]],
  ['an http URL with a path and query', 'http://example.com/path?q=1', [{ type: 'bookmark', content: '', url: 'http://example.com/path?q=1' }]],
  ['a URL on a subdomain', 'https://sub.domain.co.uk/page', [{ type: 'bookmark', content: '', url: 'https://sub.domain.co.uk/page' }]],
  ['a URL with spaces around it', '  https://example.com/a  ', [{ type: 'bookmark', content: '', url: 'https://example.com/a' }]],
  ['fenced code', '```\nconst x = 1;\n```', [{ type: 'code', content: 'const x = 1;' }]],
  ['fenced code with a language', '```js\nconsole.log("hi");\n```', [{ type: 'code', content: 'console.log(&quot;hi&quot;);' }]],
  ['fenced code over two lines', '```\nline1\nline2\n```', [{ type: 'code', content: 'line1\nline2' }]],
  ['fenced code holding markup, escaped', '```\n<script>alert(\'x\')</script>\n```', [{ type: 'code', content: '&lt;script&gt;alert(&#39;x&#39;)&lt;/script&gt;' }]],
  ['tab-separated rows', 'Name\tAge\nAlice\t30\nBob\t25', [{ type: 'table', content: '', tableData: [['Name', 'Age'], ['Alice', '30'], ['Bob', '25']], rows: 3, cols: 2 }]],
  ['comma-separated rows', 'Name,Age\nAlice,30', [{ type: 'table', content: '', tableData: [['Name', 'Age'], ['Alice', '30']], rows: 2, cols: 2 }]],
  ['rows with tabs and commas, split on tabs', 'a,b\tc,d\ne,f\tg,h', [{ type: 'table', content: '', tableData: [['a,b', 'c,d'], ['e,f', 'g,h']], rows: 2, cols: 2 }]],
  ['cells with spaces around them, trimmed', 'a , b\n c,d ', [{ type: 'table', content: '', tableData: [['a', 'b'], ['c', 'd']], rows: 2, cols: 2 }]],
  ['a heading', '# Title', [{ type: 'h1', content: 'Title' }]],
  ['a second-level heading', '## Subtitle', [{ type: 'h2', content: 'Subtitle' }]],
  ['a third-level heading', '### Section', [{ type: 'h3', content: 'Section' }]],
  ['a dash bullet', '- item one', [{ type: 'bullet', content: 'item one' }]],
  ['a star bullet', '* item one', [{ type: 'bullet', content: 'item one' }]],
  ['a numbered item', '1. first item', [{ type: 'numbered', content: 'first item' }]],
  ['a quote', '> quoted text', [{ type: 'quote', content: 'quoted text' }]],
  ['a done todo', '- [x] done task', [{ type: 'todo', content: 'done task', checked: true }]],
  ['an open todo', '- [ ] pending task', [{ type: 'todo', content: 'pending task', checked: false }]],
  ['a dash divider', '---', [{ type: 'divider', content: '' }]],
  ['a star divider', '***', [{ type: 'divider', content: '' }]],
  ['Markdown over several lines', '# Plan\n- milk\n- [ ] bread', [
    { type: 'h1', content: 'Plan' }, { type: 'bullet', content: 'milk' }, { type: 'todo', content: 'bread', checked: false },
  ]],
];

/** [what is pasted, the text] for pastes the editor leaves to the browser */
const PLAIN = [
  ['plain words', 'hello world'],
  ['more plain words', 'just plain text here'],
  ['a URL with more text on the next line', 'https://example.com\nmore text'],
  ['an ftp URL', 'ftp://example.com'],
  ['a javascript: URL', 'javascript:alert(1)'],
  ['one line with no delimiters', 'just one line'],
  ['lines with no delimiters', 'line one\nline two\nline three'],
  ['rows with a different number of commas', 'a,b\nc'],
  ['only spaces', '   '],
  ['nothing', ''],
];

describe('smart paste after a block with text', () => {
  for (const [label, text, added] of DETECTED) {
    it(`${label} is added after it`, async () => {
      const { paste, shown, saved } = await noteWith('eggs');
      assert.equal(paste(text), true, 'the browser does not paste it too');
      assert.deepEqual(shown(), [EGGS, ...added]);
      assert.deepEqual(await saved(), [EGGS, ...added]);
    });
  }

  for (const [label, text] of PLAIN) {
    it(`${label} is left to the browser`, async () => {
      const { paste, shown, saved } = await noteWith('eggs');
      assert.equal(paste(text), false);
      assert.deepEqual(shown(), [EGGS]);
      assert.deepEqual(await saved(), [EGGS]);
    });
  }
});

describe('smart paste into an empty block', () => {
  const INTO_EMPTY = [
    ['a URL', 'https://example.com', [{ type: 'bookmark', content: '', url: 'https://example.com' }]],
    ['fenced code', '```\na < b\n```', [{ type: 'code', content: 'a &lt; b' }]],
    ['comma-separated rows', 'x,y\n1,2', [{ type: 'table', content: '', tableData: [['x', 'y'], ['1', '2']], rows: 2, cols: 2 }]],
    ['Markdown, its first block in place', '## Steps\n1. mix', [{ type: 'h2', content: 'Steps' }, { type: 'numbered', content: 'mix' }]],
  ];
  for (const [label, text, blocks] of INTO_EMPTY) {
    it(`${label} becomes the block`, async () => {
      const { paste, shown, saved } = await noteWith('');
      assert.equal(paste(text), true);
      assert.deepEqual(shown(), blocks);
      assert.deepEqual(await saved(), blocks);
    });
  }

  it('plain text is left to the browser', async () => {
    const { paste, shown, saved } = await noteWith('');
    assert.equal(paste('just words'), false);
    assert.deepEqual(shown(), [{ type: 'text', content: '' }]);
    assert.deepEqual(await saved(), [{ type: 'text', content: '' }]);
  });
});
