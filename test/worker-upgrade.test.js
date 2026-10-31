'use strict';

// #17 PR 1b in the shipped service worker (js/background.js): it upgrades a version-8 profile
// to 9 at start, answers a page's storage.migrate once its run has finished (Q12), and while an
// older build's open page blocks the upgrade, a capture says "Not captured" with why, at once,
// rather than wait or claim it saved.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { createLegacyEnv, createDatabase, dumpDatabase, recordsOf, requestToPromise, waitFor, note, plain } = require('./helpers/legacy-env');
const { startWorker } = require('./helpers/load-background');

const TAB = { id: 7, windowId: 1, url: 'https://example.test/page', title: 'Example page' };

/** Send the worker a runtime message as a page would, and resolve its answer */
function message(env, request) {
  return new Promise((resolve) => {
    let answered = false;
    for (const listener of env.chrome.api.runtime.onMessage.listeners) {
      const keepsChannel = listener(request, {}, (response) => {
        answered = true;
        resolve(plain(response));
      });
      if (keepsChannel === true) return;
    }
    if (!answered) resolve(undefined);
  });
}

describe('the worker upgrades the database and answers the pages that wait on it', () => {
  it('upgrades a version-8 profile to 9 at start, every record kept, and answers storage.migrate with the outcome', async () => {
    const env = createLegacyEnv({ context: 'worker' });
    await createDatabase(env.indexedDB, { records: { canvases: [note('n1', { name: 'Kept' })] } });
    await startWorker(env);
    assert.deepEqual(await message(env, { type: 'storage.migrate' }), { status: 'migrated' });
    const dump = await dumpDatabase(env.indexedDB);
    assert.equal(dump.version, 9);
    assert.deepEqual(Object.keys(recordsOf(dump, 'canvases')), ['n1']);
    assert.ok(Object.keys(dump.stores).includes('meta') && Object.keys(dump.stores).includes('migrations'));
    // A second ask on the same worker answers at once, the same way
    assert.deepEqual(await message(env, { type: 'storage.migrate' }), { status: 'migrated' });
  });

  it('while an older page blocks the upgrade, a capture says Not captured and why, and saves nothing; then captures save', async () => {
    const env = createLegacyEnv({ context: 'worker' });
    await createDatabase(env.indexedDB, { records: { canvases: [note('n1')] } });
    // 1.4.1's new tab holds its connection and never closes it on versionchange
    const blocker = await requestToPromise(env.indexedDB.open('CanvasTabDB'));
    let blockerOpen = true;
    try {
      await startWorker(env);
      const answer = message(env, { type: 'storage.migrate' });
      env.chrome.api.contextMenus.onClicked.listeners[0]({ menuItemId: 'capture-page' }, TAB);
      await waitFor(() => env.chrome.notifications.length === 1, { message: 'the capture notification' });
      assert.deepEqual(env.chrome.notifications[0], {
        type: 'basic',
        iconUrl: 'icons/icon48.png',
        title: 'Not captured',
        message: 'NewTabNote is updating how your notes are stored, and an open NewTabNote tab or window is holding them. Close or reload it, then try again.',
      });
      // (A dump would wait behind the blocked upgrade, so the database is read once it lands)
      blocker.close();
      blockerOpen = false;
      assert.deepEqual(await answer, { status: 'migrated' });
      const upgraded = await dumpDatabase(env.indexedDB);
      assert.equal(upgraded.version, 9);
      assert.deepEqual(Object.keys(recordsOf(upgraded, 'canvases')), ['n1'], 'nothing was captured while blocked');
      env.chrome.api.contextMenus.onClicked.listeners[0]({ menuItemId: 'capture-page' }, TAB);
      await waitFor(() => env.chrome.notifications.length === 2, { message: 'the second notification' });
      assert.equal(env.chrome.notifications[1].title, 'Captured to New Tab Note');
      assert.equal((await dumpDatabase(env.indexedDB)).version, 9);
    } finally {
      if (blockerOpen) blocker.close();
    }
  });
});
