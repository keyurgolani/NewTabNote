'use strict';

// Characterization, node tier: what the legacy service worker (js/background.js) listens
// to, the context menus it creates, and what its menus and commands save to today's Daily
// Note. The worker loads only through test/helpers/load-background.js, and records are
// read only through its readTodaysDailyNote. The harness tier calls captureToDailyNote in
// a built extension (e2e/characterization/daily-note.spec.js).

const test = require('node:test');
const assert = require('node:assert/strict');
const { loadBackground, readTodaysDailyNote } = require('./helpers/load-background');
const { expectFailure } = require('./helpers/expect-failure');

/**
 * The fields a capture sets, per block in today's Daily Note. Nothing there throws a plain
 * Error rather than failing an assertion, so an expected failure can't hide it.
 */
async function capturedToday(worker) {
  const day = await readTodaysDailyNote(worker);
  if (!day) throw new Error("Nothing landed in today's Daily Note");
  return day.blocks.map(block => (block.type === 'bookmark'
    ? { type: block.type, url: block.url, title: block.title }
    : { type: block.type, content: block.content }));
}

async function selectionMenuSavesText(worker) {
  await worker.dispatch('contextMenus.onClicked', { menuItemId: 'capture-selection', selectionText: 'Quoted words' }, worker.tab);
  assert.deepEqual(await capturedToday(worker), [{ type: 'text', content: `Quoted words (Source: ${worker.tab.url})` }]);
}

async function pageMenuSavesBookmark(worker) {
  await worker.dispatch('contextMenus.onClicked', { menuItemId: 'capture-page', pageUrl: worker.tab.url }, worker.tab);
  assert.deepEqual(await capturedToday(worker), [{ type: 'bookmark', url: worker.tab.url, title: worker.tab.title }]);
}

async function pageCommandSavesBookmark(worker) {
  await worker.dispatch('commands.onCommand', 'capture-page');
  assert.deepEqual(await capturedToday(worker), [{ type: 'bookmark', url: worker.tab.url, title: worker.tab.title }]);
}

test("the worker listens to messages, install, startup, the toolbar action, its context menus, commands, and #13's port", async () => {
  const worker = await loadBackground();
  assert.deepEqual(worker.listenerCounts(), {
    'runtime.onMessage': 1,
    'runtime.onInstalled': 1,
    'runtime.onStartup': 1,
    'runtime.onConnect': 1,
    'contextMenus.onClicked': 1,
    'commands.onCommand': 1,
    'action.onClicked': 1,
  });
});

test('answers no PING, which nothing sends: only API_REQUEST gets an answer (#13)', async () => {
  const worker = await loadBackground();
  const answers = [];
  await worker.dispatch('runtime.onMessage', { type: 'PING' }, { id: 'test-extension' }, (answer) => answers.push(answer));
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(answers, []);
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
  await selectionMenuSavesText(await loadBackground());
});

test("the capture-page menu saves the page to today's Daily Note as a bookmark block", async () => {
  await pageMenuSavesBookmark(await loadBackground());
});

test("the capture-page command saves the active tab to today's Daily Note as a bookmark block", async () => {
  await pageCommandSavesBookmark(await loadBackground());
});

expectFailure("KD-002 the capture-selection command saves the selected text and its source to today's Daily Note", async () => {
  const worker = await loadBackground();
  await worker.dispatch('commands.onCommand', 'capture-selection');
  assert.deepEqual(await capturedToday(worker), [{ type: 'text', content: `${worker.selection.text} (Source: ${worker.selection.url})` }]);
});

// Self-tests: the capture checks fail on a worker that writes more than one capture's worth
const CAPTURE_CHECKS = [selectionMenuSavesText, pageMenuSavesBookmark, pageCommandSavesBookmark];

// Every block written to the elements store is written a second time under another id. The
// worker writes through #17's adapter on IndexedDB itself (#17 PR 1b), so this changes
// fake-indexeddb's put, and gives back what puts it back.
function saveEachBlockTwice() {
  const { IDBObjectStore } = require('fake-indexeddb');
  const put = IDBObjectStore.prototype.put;
  IDBObjectStore.prototype.put = function putTwice(value, key) {
    if (this.name === 'elements' && value && typeof value === 'object') {
      put.call(this, { ...value, id: `${value.id}-again` }, key);
    }
    return put.call(this, value, key);
  };
  return () => {
    IDBObjectStore.prototype.put = put;
  };
}

function captureTwice(worker) {
  const capture = worker.captureToDailyNote;
  worker.captureToDailyNote = item => capture(item).then(() => capture(item));
}

for (const [mutant, mutate] of [['saves each block twice', saveEachBlockTwice], ['captures each time twice', captureTwice]]) {
  test(`the capture checks fail on a worker that ${mutant}`, async () => {
    for (const check of CAPTURE_CHECKS) {
      let undo = null;
      try {
        const worker = await loadBackground({ mutate: global => { undo = mutate(global); } });
        await assert.rejects(check(worker), assert.AssertionError, `${check.name} passed`);
      } finally {
        if (typeof undo === 'function') undo();
      }
    }
  });
}
