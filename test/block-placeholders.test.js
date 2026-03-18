const test = require('node:test');
const assert = require('node:assert/strict');

const { DEFAULT_TEXT_BLOCK_PLACEHOLDER, getBlockPlaceholder } = require('../js/block-placeholders.js');

test('getBlockPlaceholder returns the shared text placeholder for text blocks', () => {
  assert.equal(getBlockPlaceholder('text', ''), DEFAULT_TEXT_BLOCK_PLACEHOLDER);
});

test('getBlockPlaceholder preserves existing placeholders for non-text blocks', () => {
  assert.equal(getBlockPlaceholder('h2', 'Heading 2'), 'Heading 2');
});
