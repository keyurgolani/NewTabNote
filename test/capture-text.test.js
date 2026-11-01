'use strict';

// A captured selection and the page it came from are plain text in a text block's rich
// content, so the block shows them exactly as they were selected.

const test = require('node:test');
const assert = require('node:assert/strict');
const { loadBackground, readTodaysDailyNote } = require('./helpers/load-background');

test("a captured selection and its page's address are stored as text", async () => {
  const worker = await loadBackground();
  const tab = { ...worker.tab, url: 'https://example.test/a?x=1&para=2' };
  const selectionText = 'a <b>bold</b> & <i>italic</i> word';
  await worker.dispatch('contextMenus.onClicked', { menuItemId: 'capture-selection', selectionText }, tab);
  const day = await readTodaysDailyNote(worker);
  assert.deepEqual(Array.from(day.blocks, block => block.content), [
    'a &lt;b&gt;bold&lt;/b&gt; &amp; &lt;i&gt;italic&lt;/i&gt; word (Source: https://example.test/a?x=1&amp;para=2)',
  ]);
});

test('a captured selection with no markup characters is stored as it was', async () => {
  const worker = await loadBackground();
  await worker.dispatch('contextMenus.onClicked', { menuItemId: 'capture-selection', selectionText: 'Quoted words' }, worker.tab);
  const day = await readTodaysDailyNote(worker);
  assert.deepEqual(Array.from(day.blocks, block => block.content), [`Quoted words (Source: ${worker.tab.url})`]);
});
