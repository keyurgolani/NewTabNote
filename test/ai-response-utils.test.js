const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildAIInsertPreview,
  blockToMarkdown,
  htmlToMarkdown,
  markdownToBlocks,
  parseAIResponseToBlocks,
} = require('../js/ai-response-utils.js');

test('AI response parser converts markdown structure into ordered block payloads', () => {
  const blocks = parseAIResponseToBlocks(`# Plan

- [x] Review backlog
- [ ] Ship preview
- Draft release note

Closing paragraph.`);

  assert.deepEqual(
    blocks.map(block => ({
      type: block.type,
      content: block.content || '',
      checked: block.checked || false,
    })),
    [
      { type: 'h1', content: 'Plan', checked: false },
      { type: 'todo', content: 'Review backlog', checked: true },
      { type: 'todo', content: 'Ship preview', checked: false },
      { type: 'bullet', content: 'Draft release note', checked: false },
      { type: 'text', content: 'Closing paragraph.', checked: false },
    ]
  );
});

test('AI response parser falls back to a single text block for unstructured content', () => {
  const blocks = parseAIResponseToBlocks('   ');

  assert.deepEqual(blocks, [
    { type: 'text', content: '' },
  ]);
});

test('AI insert preview reports per-type counts and total block count', () => {
  const preview = buildAIInsertPreview([
    { type: 'h2', content: 'Summary' },
    { type: 'bullet', content: 'Point one' },
    { type: 'bullet', content: 'Point two' },
    { type: 'text', content: 'Wrap up' },
  ]);

  assert.equal(preview.totalBlocks, 4);
  assert.deepEqual(preview.counts, [
    { type: 'h2', count: 1 },
    { type: 'bullet', count: 2 },
    { type: 'text', count: 1 },
  ]);
});

test('AI insert preview builds a short summary from parsed block content in order', () => {
  const preview = buildAIInsertPreview([
    { type: 'h1', content: 'Launch checklist' },
    { type: 'todo', content: 'QA build', checked: false },
    { type: 'text', content: 'Final review before release.' },
  ]);

  assert.equal(preview.summary, 'Launch checklist QA build Final review before release.');
  assert.deepEqual(preview.items.map(item => item.type), ['h1', 'todo', 'text']);
});

// ─── blockToMarkdown tests ───

test('blockToMarkdown converts all core block types to markdown', () => {
  assert.equal(blockToMarkdown({ type: 'h1', content: 'Title' }), '# Title\n\n');
  assert.equal(blockToMarkdown({ type: 'h2', content: 'Sub' }), '## Sub\n\n');
  assert.equal(blockToMarkdown({ type: 'h3', content: 'Minor' }), '### Minor\n\n');
  assert.equal(blockToMarkdown({ type: 'bullet', content: 'item' }), '- item\n');
  assert.equal(blockToMarkdown({ type: 'numbered', content: 'step' }), '1. step\n');
  assert.equal(blockToMarkdown({ type: 'todo', content: 'task', checked: false }), '- [ ] task\n');
  assert.equal(blockToMarkdown({ type: 'todo', content: 'done', checked: true }), '- [x] done\n');
  assert.equal(blockToMarkdown({ type: 'quote', content: 'wise words' }), '> wise words\n\n');
  assert.equal(blockToMarkdown({ type: 'code', content: 'let x = 1;' }), '```\nlet x = 1;\n```\n\n');
  assert.equal(blockToMarkdown({ type: 'divider', content: '' }), '---\n\n');
});

test('blockToMarkdown converts table blocks with header separator', () => {
  const block = {
    type: 'table',
    content: '',
    tableData: [['Name', 'Age'], ['Alice', '30']],
  };
  assert.equal(blockToMarkdown(block), '| Name | Age |\n| --- | --- |\n| Alice | 30 |\n\n');
});

test('blockToMarkdown converts bookmark and image blocks', () => {
  assert.equal(
    blockToMarkdown({ type: 'bookmark', content: '', title: 'Example', url: 'https://example.com' }),
    '[Example](https://example.com)\n\n'
  );
  assert.equal(
    blockToMarkdown({ type: 'image', content: '', caption: 'Photo', imageUrl: 'img.png' }),
    '![Photo](img.png)\n\n'
  );
});

test('blockToMarkdown converts equation blocks with $$ delimiters', () => {
  assert.equal(
    blockToMarkdown({ type: 'equation', content: '', equation: 'E = mc^2' }),
    '$$\nE = mc^2\n$$\n\n'
  );
});

test('blockToMarkdown strips HTML inline formatting to markdown', () => {
  assert.equal(
    blockToMarkdown({ type: 'text', content: '<strong>bold</strong> and <em>italic</em>' }),
    '**bold** and *italic*\n\n'
  );
});

// ─── htmlToMarkdown tests ───

test('htmlToMarkdown converts inline HTML tags to markdown syntax', () => {
  assert.equal(htmlToMarkdown('<strong>bold</strong>'), '**bold**');
  assert.equal(htmlToMarkdown('<em>italic</em>'), '*italic*');
  assert.equal(htmlToMarkdown('<code>code</code>'), '`code`');
  assert.equal(htmlToMarkdown('<del>struck</del>'), '~~struck~~');
  assert.equal(htmlToMarkdown('<a href="https://x.com">link</a>'), '[link](https://x.com)');
});

test('htmlToMarkdown preserves wiki-links from data attributes', () => {
  const html = '<a href="#" class="wiki-link" data-note-name="My Note">My Note</a>';
  assert.equal(htmlToMarkdown(html), '[[My Note]]');
});

// ─── markdownToBlocks wiki-link support ───

test('markdownToBlocks parses wiki-links in inline text', () => {
  const blocks = markdownToBlocks('See [[My Note]] for details');
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].type, 'text');
  assert.ok(blocks[0].content.includes('data-note-name="My Note"'));
  assert.ok(blocks[0].content.includes('class="wiki-link"'));
});

// ─── Round-trip tests ───

test('round-trip: headings export then import preserves type and content', () => {
  const blocks = [
    { type: 'h1', content: 'Main Title' },
    { type: 'h2', content: 'Section' },
    { type: 'h3', content: 'Subsection' },
  ];
  const md = blocks.map(b => blockToMarkdown(b)).join('');
  const imported = markdownToBlocks(md);

  assert.equal(imported.length, 3);
  assert.equal(imported[0].type, 'h1');
  assert.equal(imported[1].type, 'h2');
  assert.equal(imported[2].type, 'h3');
});

test('round-trip: list blocks export then import preserves type', () => {
  const blocks = [
    { type: 'bullet', content: 'First' },
    { type: 'bullet', content: 'Second' },
    { type: 'numbered', content: 'Step one' },
    { type: 'todo', content: 'Buy milk', checked: false },
    { type: 'todo', content: 'Done task', checked: true },
  ];
  const md = blocks.map(b => blockToMarkdown(b)).join('');
  const imported = markdownToBlocks(md);

  assert.equal(imported.length, 5);
  assert.equal(imported[0].type, 'bullet');
  assert.equal(imported[1].type, 'bullet');
  assert.equal(imported[2].type, 'numbered');
  assert.equal(imported[3].type, 'todo');
  assert.equal(imported[3].checked, false);
  assert.equal(imported[4].type, 'todo');
  assert.equal(imported[4].checked, true);
});

test('round-trip: quote and code blocks preserve type and content', () => {
  const blocks = [
    { type: 'quote', content: 'A wise saying' },
    { type: 'code', content: 'const x = 42;' },
  ];
  const md = blocks.map(b => blockToMarkdown(b)).join('');
  const imported = markdownToBlocks(md);

  assert.equal(imported.length, 2);
  assert.equal(imported[0].type, 'quote');
  assert.equal(imported[1].type, 'code');
});

test('round-trip: table block preserves structure', () => {
  const block = {
    type: 'table',
    content: '',
    tableData: [['Col A', 'Col B'], ['1', '2']],
  };
  const md = blockToMarkdown(block);
  const imported = markdownToBlocks(md);

  assert.equal(imported.length, 1);
  assert.equal(imported[0].type, 'table');
  assert.deepEqual(imported[0].tableData, [['Col A', 'Col B'], ['1', '2']]);
});

test('round-trip: wiki-links in text survive export and import', () => {
  const block = {
    type: 'text',
    content: 'See <a href="#" class="wiki-link" data-note-name="My Note">My Note</a> here',
  };
  const md = blockToMarkdown(block);
  assert.ok(md.includes('[[My Note]]'));

  const imported = markdownToBlocks(md);
  assert.equal(imported.length, 1);
  assert.ok(imported[0].content.includes('data-note-name="My Note"'));
});

test('round-trip: divider block preserves type', () => {
  const md = blockToMarkdown({ type: 'divider', content: '' });
  const imported = markdownToBlocks(md);

  assert.equal(imported.length, 1);
  assert.equal(imported[0].type, 'divider');
});

test('round-trip: mixed content note produces equivalent block structure', () => {
  const blocks = [
    { type: 'h1', content: 'Project Plan' },
    { type: 'text', content: 'Overview of the project.' },
    { type: 'h2', content: 'Tasks' },
    { type: 'todo', content: 'Design', checked: true },
    { type: 'todo', content: 'Implement', checked: false },
    { type: 'bullet', content: 'Note A' },
    { type: 'quote', content: 'Important quote' },
    { type: 'code', content: 'console.log("hi");' },
    { type: 'divider', content: '' },
    { type: 'table', content: '', tableData: [['X', 'Y'], ['1', '2']] },
  ];

  const md = blocks.map(b => blockToMarkdown(b)).join('');
  const imported = markdownToBlocks(md);

  assert.equal(imported.length, blocks.length);
  for (let i = 0; i < blocks.length; i++) {
    assert.equal(imported[i].type, blocks[i].type, `Block ${i} type mismatch`);
  }
});
