'use strict';

// Characterization, node tier: what the legacy service worker (js/background.js) listens
// to, the context menus it creates, and what its menus and commands save to today's Daily
// Note. The worker loads only through test/helpers/load-background.js, and records are
// read only through its readTodaysDailyNote. The harness tier calls captureToDailyNote in
// a built extension (e2e/characterization/daily-note.spec.js).

const test = require('node:test');
const assert = require('node:assert/strict');
const { loadBackground, readTodaysDailyNote } = require('./helpers/load-background');
const { waitFor } = require('./helpers/legacy-env');
const { expectFailure } = require('./helpers/expect-failure');

/**
 * Today's Daily Note once it holds `count` blocks
 */
function dailyNoteWith(worker, count) {
  return waitFor(async () => {
    const day = await readTodaysDailyNote(worker);
    return day && day.blocks.length >= count ? day : null;
  }, { message: `today's Daily Note with ${count} block(s)` });
}

/**
 * The fields a capture sets, per block
 */
function captured(blocks) {
  return blocks.map(block => (block.type === 'bookmark'
    ? { type: block.type, url: block.url, title: block.title }
    : { type: block.type, content: block.content }));
}

test('the worker listens to messages, install, startup, the toolbar action, its context menus, and commands', async () => {
  const worker = await loadBackground();
  assert.deepEqual(worker.listenerCounts(), {
    'runtime.onMessage': 1,
    'runtime.onInstalled': 1,
    'runtime.onStartup': 1,
    'contextMenus.onClicked': 1,
    'commands.onCommand': 1,
    'action.onClicked': 1,
  });
});

test('installing creates the page and selection context menus', async () => {
  const worker = await loadBackground();
  assert.deepEqual(worker.contextMenus(), []);
  await worker.dispatch('runtime.onInstalled', { reason: 'install' });
  assert.deepEqual(worker.contextMenus(), [
    { id: 'capture-page', title: "Add current page to today's note", contexts: ['page'] },
    { id: 'capture-selection', title: "Add selection to today's note", contexts: ['selection'] },
  ]);
});

test("the selection menu saves the selected text and its page to today's Daily Note as a text block", async () => {
  const worker = await loadBackground();
  await worker.dispatch('contextMenus.onClicked', { menuItemId: 'capture-selection', selectionText: 'Quoted words' }, worker.tab);
  const day = await dailyNoteWith(worker, 1);
  assert.deepEqual(captured(day.blocks), [{ type: 'text', content: `Quoted words (Source: ${worker.tab.url})` }]);
});

test("the capture-page menu saves the page to today's Daily Note as a bookmark block", async () => {
  const worker = await loadBackground();
  await worker.dispatch('contextMenus.onClicked', { menuItemId: 'capture-page', pageUrl: worker.tab.url }, worker.tab);
  const day = await dailyNoteWith(worker, 1);
  assert.deepEqual(captured(day.blocks), [{ type: 'bookmark', url: worker.tab.url, title: worker.tab.title }]);
});

test("the capture-page command saves the active tab to today's Daily Note as a bookmark block", async () => {
  const worker = await loadBackground();
  await worker.dispatch('commands.onCommand', 'capture-page');
  const day = await dailyNoteWith(worker, 1);
  assert.deepEqual(captured(day.blocks), [{ type: 'bookmark', url: worker.tab.url, title: worker.tab.title }]);
});

expectFailure("KD-002 the capture-selection command saves the selected text and its source to today's Daily Note", async () => {
  const worker = await loadBackground();
  await worker.dispatch('commands.onCommand', 'capture-selection');
  const day = await dailyNoteWith(worker, 1);
  assert.deepEqual(captured(day.blocks), [{ type: 'text', content: `${worker.selection.text} (Source: ${worker.selection.url})` }]);
});
