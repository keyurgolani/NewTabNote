const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildAIInsertPreview,
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
