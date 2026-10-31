'use strict';

// #17 PR 1b in the shipped service worker (js/background.js): it upgrades a version-8 profile
// to this build's version (10 since #17 PR 2a) at start, answers a page's storage.migrate once its run has finished (Q12), and while an
// older build's open page blocks the upgrade, a capture says "Not captured" with why, at once,
// rather than wait or claim it saved. storage.migrate is accepted only from the extension's own
// senders (#21's isOwnSender), as API_REQUEST is.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  createLegacyEnv, createDatabase, createLockManager, dumpDatabase, recordsOf, requestToPromise, waitFor, note, plain,
} = require('./helpers/legacy-env');
const { startWorker } = require('./helpers/load-background');

// This build's version, which the worker's run brings a profile to (js/storage.js's dbVersion)
const THIS_VERSION = 10;

const TAB = { id: 7, windowId: 1, url: 'https://example.test/page', title: 'Example page' };
const OWN = 'chrome-extension://test-extension';

/** One of the extension's pages as Chrome names it the sender of a message, in a tab or not */
const page = (file, tab) => ({ id: 'test-extension', url: `${OWN}/${file}`, origin: OWN, ...(tab ? { tab, frameId: 0 } : {}) });

/** The new tab page in its tab: where a page's storage.migrate comes from most often */
const NEW_TAB = page('newtab.html', { id: 3, windowId: 1, url: `${OWN}/newtab.html` });

/** What else could send it a message, were anything to reach it */
const FOREIGN = [
  // a web page
  { url: 'https://evil.example/page', origin: 'https://evil.example', tab: { id: 4, windowId: 1, url: 'https://evil.example/page' }, frameId: 0 },
  // another extension's page
  { id: 'another-extension', url: 'chrome-extension://another-extension/page.html', origin: 'chrome-extension://another-extension' },
  // a content script's: this extension's id, from a web page in a tab
  { id: 'test-extension', url: 'https://evil.example/page', origin: 'https://evil.example', tab: { id: 4, windowId: 1, url: 'https://evil.example/page' }, frameId: 0 },
  // no id, and no URL
  {},
];

/**
 * A worker's environment. URL is a global in every extension context, and isOwnSender reads the
 * sender's URL with it; legacy-env's sandbox leaves it out.
 */
function workerEnv(options = {}) {
  const env = createLegacyEnv({ context: 'worker', ...options });
  env.global.URL = URL;
  return env;
}

/** Send the worker a runtime message as `sender` would, the new tab page unless it's another, and resolve its answer */
function message(env, request, sender = NEW_TAB) {
  return new Promise((resolve) => {
    let answered = false;
    for (const listener of env.chrome.api.runtime.onMessage.listeners) {
      const keepsChannel = listener(request, sender, (response) => {
        answered = true;
        resolve(plain(response));
      });
      if (keepsChannel === true) return;
    }
    if (!answered) resolve(undefined);
  });
}

describe('the worker upgrades the database and answers the pages that wait on it', () => {
  it("upgrades a version-8 profile to this build's version at start, every record kept, and answers storage.migrate with the outcome", async () => {
    const env = workerEnv();
    await createDatabase(env.indexedDB, { records: { canvases: [note('n1', { name: 'Kept' })] } });
    await startWorker(env);
    assert.deepEqual(await message(env, { type: 'storage.migrate' }), { status: 'migrated' });
    const dump = await dumpDatabase(env.indexedDB);
    assert.equal(dump.version, THIS_VERSION);
    assert.deepEqual(Object.keys(recordsOf(dump, 'canvases')), ['n1']);
    assert.ok(Object.keys(dump.stores).includes('meta') && Object.keys(dump.stores).includes('migrations'));
    // A second ask on the same worker answers at once, the same way
    assert.deepEqual(await message(env, { type: 'storage.migrate' }), { status: 'migrated' });
  });

  it("answers this extension's storage.purge with the sweep's status, and refuses anyone else's, as storage.migrate does (#17 PR 2b)", async () => {
    const env = workerEnv();
    await createDatabase(env.indexedDB, { records: { canvases: [note('n1')] } });
    await startWorker(env);
    assert.deepEqual(await message(env, { type: 'storage.migrate' }), { status: 'migrated' });
    assert.deepEqual(await message(env, { type: 'storage.purge' }), { status: 'nothing' });
    for (const sender of FOREIGN) {
      assert.deepEqual(await message(env, { type: 'storage.purge' }, sender), { status: 'refused' }, JSON.stringify(sender));
    }
  });

  it('while an older page blocks the upgrade, a capture says Not captured and why, and saves nothing; then captures save', async () => {
    const env = workerEnv();
    await createDatabase(env.indexedDB, { records: { canvases: [note('n1')] } });
    // 1.4.1's new tab holds its connection and never closes it on versionchange
    const blocker = await requestToPromise(env.indexedDB.open('CanvasTabDB'));
    let blockerOpen = true;
    try {
      await startWorker(env);
      const answer = message(env, { type: 'storage.migrate' });
      env.chrome.api.contextMenus.onClicked.listeners[0]({ menuItemId: 'capture-page' }, TAB);
      await waitFor(() => env.chrome.notifications.length === 1, { withinMs: 10000, message: 'the capture notification' });
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
      assert.equal(upgraded.version, THIS_VERSION);
      assert.deepEqual(Object.keys(recordsOf(upgraded, 'canvases')), ['n1'], 'nothing was captured while blocked');
      env.chrome.api.contextMenus.onClicked.listeners[0]({ menuItemId: 'capture-page' }, TAB);
      await waitFor(() => env.chrome.notifications.length === 2, { withinMs: 10000, message: 'the second notification' });
      assert.equal(env.chrome.notifications[1].title, 'Captured to New Tab Note');
      assert.equal((await dumpDatabase(env.indexedDB)).version, THIS_VERSION);
    } finally {
      if (blockerOpen) blocker.close();
    }
  });
});

describe("storage.migrate is accepted only from the extension's own senders", () => {
  /**
   * A version-8 profile whose run at start failed before it read anything: its first try at Web
   * Lock storage.migrate is refused. A request after that runs again at once (Q12), so whoever
   * it answers starts a run.
   */
  async function afterAFailedRun() {
    const locks = createLockManager();
    let refusals = 1;
    const env = workerEnv({
      locks: {
        request: (name, ...rest) => (name === 'storage.migrate' && refusals-- > 0
          ? Promise.reject(new DOMException('lock manager unavailable', 'InvalidStateError'))
          : locks.request(name, ...rest)),
      },
    });
    await createDatabase(env.indexedDB, { records: { canvases: [note('n1', { name: 'Kept' })] } });
    await startWorker(env);
    await waitFor(() => env.chrome.local.setting_storageUpgrade?.status === 'failed', { withinMs: 10000, message: 'the failed run' });
    return env;
  }

  it("refuses a web page's, another extension's, a content script's, and an unnamed sender's, and starts no run", async () => {
    const env = await afterAFailedRun();
    for (const sender of FOREIGN) {
      assert.deepEqual(await message(env, { type: 'storage.migrate' }, sender), { status: 'refused' }, JSON.stringify(sender));
    }
    assert.equal((await dumpDatabase(env.indexedDB)).version, 8, 'no run started');
    assert.equal(env.chrome.local.setting_storageUpgrade.status, 'failed');
  });

  it('answers the new tab page in its tab with the run it starts, and Popup and Side Panel with its outcome', async () => {
    const env = await afterAFailedRun();
    assert.deepEqual(await message(env, { type: 'storage.migrate' }, NEW_TAB), { status: 'migrated' });
    assert.equal((await dumpDatabase(env.indexedDB)).version, THIS_VERSION);
    for (const sender of [page('popup.html'), page('sidepanel.html')]) {
      assert.deepEqual(await message(env, { type: 'storage.migrate' }, sender), { status: 'migrated' }, sender.url);
    }
  });
});
