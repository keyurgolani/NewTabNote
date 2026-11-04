/**
 * The journal (#35 slice 3b): a command a page sent that hadn't landed when the page went is
 * kept in NewTabNoteJournal, and lands later.
 * - An editor's save that its new tab sent, then died before it committed, is applied by the next
 *   page at its idle, within 3 s of that page's first read (the lead's bound).
 * - A Popup quick note sent while its note couldn't land yet, then closed, is in the next new
 *   tab, which wakes the worker's drain for it.
 * - A capture the worker was stopped in the middle of lands at the worker's next start, in
 *   today's Daily Note.
 * In each, another page holds the stores the command writes in a readwrite transaction, so the
 * command is sent and waits there. The tests also fail on an uncaught exception that
 * test/known-defects.json doesn't list.
 */

const { test, expect, expectNoUncaught } = require('./harness');
const { profileStore } = require('./harness/profile-store');
const driver = require('./characterization/driver');

/** How long the holding page keeps the stores, which is longer than each test needs to set up */
const HOLD_MS = 4000;

/** In `page`: a readwrite transaction over CanvasTabDB's `stores`, kept busy for `ms` */
function holdStores(page, stores, ms) {
  return page.evaluate(([names, holdMs]) => new Promise((resolve, reject) => {
    const open = indexedDB.open('CanvasTabDB');
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const db = open.result;
      const tx = db.transaction(names, 'readwrite');
      const until = performance.now() + holdMs;
      const spin = () => {
        if (performance.now() < until) tx.objectStore(names[0]).get('ntn-hold').onsuccess = spin;
      };
      spin();
      tx.oncomplete = () => db.close();
      resolve();
    };
  }), [stores, ms]);
}

/** Whether `page` holds its journal's owner lock, which it takes once its journal chunk is in */
function journalIn(page) {
  return page.evaluate(async () => (await navigator.locks.query()).held.some(lock => lock.name.startsWith('journal.owner.')));
}

/** The entries in NewTabNoteJournal, read from `page`: each one's command type. Makes no journal. */
function journalEntries(page) {
  return page.evaluate(() => new Promise((resolve, reject) => {
    const open = indexedDB.open('NewTabNoteJournal');
    open.onupgradeneeded = () => {
      // There's none yet: this open would make it, so it stops here
      open.transaction.abort();
    };
    open.onerror = () => resolve([]);
    open.onsuccess = () => {
      const db = open.result;
      if (!db.objectStoreNames.contains('entries')) {
        db.close();
        resolve([]);
        return;
      }
      const request = db.transaction('entries').objectStore('entries').getAll();
      request.onsuccess = () => {
        db.close();
        resolve(request.result.map(entry => (entry.command ? entry.command.type : null)));
      };
      request.onerror = () => {
        db.close();
        reject(request.error);
      };
    };
  }));
}

/** How long a page's renderer may take to go once it's told to crash */
const CRASH_WAIT_MS = 5000;

/**
 * Kill `page`'s renderer, as a crash does: no pagehide runs, so it writes no close-time draft.
 * Chromium never answers Page.crash once the renderer is gone, so the command isn't awaited, and
 * the page's crash event says it went. An extension's pages and its service worker share that
 * renderer, so its other pages and its worker go too: each page that crashed is closed, so the
 * context holds no crashed page, and the worker starts again on its next event (wakeWorker).
 */
async function crash(extension, page) {
  const origin = `chrome-extension://${extension.extensionId}/`;
  const others = extension.context.pages().filter(other => other !== page && other.url().startsWith(origin));
  const crashedWith = others.map(other =>
    other.waitForEvent('crash', { timeout: CRASH_WAIT_MS }).then(
      () => other,
      () => null,
    ),
  );
  const cdp = await extension.context.newCDPSession(page);
  const crashed = page.waitForEvent('crash', { timeout: CRASH_WAIT_MS }).catch(() => {
    throw new Error(`the page didn't crash within ${CRASH_WAIT_MS / 1000} s of Page.crash`);
  });
  cdp.send('Page.crash').catch(() => {});
  await crashed;
  await page.close().catch(() => {});
  for (const other of await Promise.all(crashedWith)) {
    if (other) await other.close().catch(() => {});
  }
}

/**
 * Wake the extension's service worker from `page` as a page's session does, as harness.spec.js
 * does after a stop: open #13's port and say hello. A port that closes first, or no answer within
 * 10 s, fails rather than hangs.
 */
async function wakeWorker(page) {
  await page.evaluate(
    () =>
      new Promise((resolve, reject) => {
        const port = chrome.runtime.connect({ name: 'ntn-rpc' });
        const timer = setTimeout(() => {
          port.disconnect();
          reject(new Error('The worker never answered the hello'));
        }, 10_000);
        port.onDisconnect.addListener(() => {
          clearTimeout(timer);
          reject(new Error(`The port closed: ${chrome.runtime.lastError ? chrome.runtime.lastError.message : 'by the worker'}`));
        });
        port.onMessage.addListener(() => {
          clearTimeout(timer);
          port.disconnect();
          resolve();
        });
        port.postMessage(
          JSON.stringify({
            frame: 'hello',
            protocol: { major: 1, minor: 0 },
            extensionVersion: chrome.runtime.getManifest().version,
            surface: 'newtab',
            sessionId: 'journal-spec-wake',
          }),
        );
      }),
  );
}

test("an editor's save that its new tab died before committing is applied by the next page at its idle, within 3 s of its first read", async ({ extension }) => {
  await extension.seedOnboarded();
  const [{ id }] = await driver.seedNotes(extension, [{ name: 'Kept', blocks: [{ type: 'text', content: 'Before the crash' }] }]);
  const page = await driver.openNewTab(extension);
  await driver.openNote(page, 'Kept');
  await expect.poll(() => journalIn(page), { message: "the new tab's journal is in" }).toBe(true);
  const holder = await extension.openSurface('popup');
  await holdStores(holder, ['canvases', 'elements'], HOLD_MS);

  // Typed, and sent: it waits behind the hold, and its entry is in the journal
  await page.locator('#blocks-container > .block .block-content').first().click();
  await page.keyboard.press('End');
  await page.keyboard.type(', and after');
  await page.evaluate(() => {
    app.editor.flushSave();
  });
  await expect.poll(() => journalEntries(holder), { message: 'the save is journaled' }).toEqual(['saveNoteContent']);
  await crash(extension, page);

  // The next page applies it at its idle, after its first read
  const next = await driver.openNewTab(extension);
  const read = Date.now();
  await expect.poll(async () => (await profileStore(next).getElementsByNote(id)).map(element => element.content), {
    message: "the dead tab's save, applied",
    timeout: 3000,
  }).toEqual(['Before the crash, and after']);
  expect(Date.now() - read, 'within 3 s of the first read').toBeLessThan(3000);
  await expect.poll(() => journalEntries(next), { message: 'its entry is gone' }).toEqual([]);
  // The crash took the worker too, and its uncaught exceptions went with it, so the check reads
  // the new worker's, which #13's port wakes
  await wakeWorker(next);
  await expectNoUncaught(extension, next);
});

test("a Popup quick note sent while its note couldn't land yet, then closed, is in the next new tab", async ({ extension }) => {
  await extension.seedOnboarded();
  await driver.seedNotes(extension, [{ name: 'Already here', blocks: [{ type: 'text', content: 'An older note' }] }]);
  const popup = await extension.openSurface('popup');
  await expect.poll(() => journalIn(popup), { message: "Popup's journal is in" }).toBe(true);
  const holder = await extension.openSurface('sidepanel');
  await holdStores(holder, ['canvases'], HOLD_MS);

  // Sent: it waits behind the hold, and its entry is in the journal
  const input = popup.locator('#quick-note-input');
  await input.fill('Call the plumber');
  await input.press('Enter');
  await expect.poll(() => journalEntries(holder), { message: 'the quick note is journaled' }).toEqual(['createNote']);
  await popup.close();

  // The next new tab wakes the worker's drain, which makes the note once
  const page = await driver.openNewTab(extension);
  await expect.poll(async () => (await profileStore(page).getAllNotes(true)).map(note => note.name).sort(), {
    message: 'the quick note, made once',
    timeout: 10_000,
  }).toEqual(['Already here', 'Call the plumber']);
  await expect.poll(() => journalEntries(page), { message: 'its entry is gone' }).toEqual([]);
  await expectNoUncaught(extension, page);
});

test('a capture the worker was stopped in the middle of lands at its next start, in the Daily Note', async ({ extension }) => {
  await extension.seedOnboarded();
  const page = await driver.openNewTab(extension);
  const holder = await extension.openSurface('popup');
  await holdStores(holder, ['canvases', 'elements'], HOLD_MS);

  // Sent: it waits behind the hold, and its entry is in the journal. The worker it ran in is
  // stopped before it answers, so what the call answers is nothing to wait on
  driver.captureText(extension, { text: 'Kept through a stop', source: 'https://example.test/stopped' }).catch(() => {});
  await expect.poll(() => journalEntries(holder), { message: 'the capture is journaled' }).toEqual(['captureToDailyNote']);
  const blank = await extension.context.newPage();
  const cdp = await extension.context.newCDPSession(blank);
  await cdp.send('ServiceWorker.enable');
  await cdp.send('ServiceWorker.stopAllWorkers');
  await cdp.detach();
  await blank.close();
  await page.close();

  // The worker's next start drains the journal once its coordinator is ready
  const next = await driver.openNewTab(extension);
  /** How many blocks today's Daily Note stores, none while there's no Daily Note */
  const dailyBlocks = async () => {
    const store = profileStore(next);
    const daily = (await store.getAllNotes(true)).find(note => note.name === driver.todaysDailyNoteTitle());
    return daily ? (await store.getElementsByNote(daily.id)).length : 0;
  };
  await expect.poll(dailyBlocks, { message: 'the capture landed', timeout: 10_000 }).toBe(1);
  await driver.reload(next);
  await driver.openTodaysDailyNote(next);
  await expect.poll(() => driver.blocks(next)).toEqual([
    { type: 'text', text: 'Kept through a stop (Source: https://example.test/stopped)' },
  ]);
  await expect.poll(() => journalEntries(next), { message: 'its entry is gone' }).toEqual([]);
  await expectNoUncaught(extension, next);
});
