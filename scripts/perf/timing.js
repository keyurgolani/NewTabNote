'use strict';

/**
 * One install-cold run on `ref-desktop` (#27 slice 4a, docs/testing.md "The performance
 * probe"): a fresh profile with the package installed through #34's harness, the fixture
 * profile seeded, then the first new tab, timed from the outside, so any package works the
 * same way, whatever built it:
 *
 * - The clock starts in the service worker right before it calls `chrome.tabs.create` for the
 *   new tab page, and stops when the first printable key typed into the focused editor is in
 *   the editor's text (interaction-ready). The page's own `ntn:interaction-ready` mark is read
 *   too, where the package has one (1.4.0 doesn't).
 * - The driver waits for an editable block in the editor, focuses it, and types one key, so
 *   the time includes how long the driver took to see the editor (`driverMs`, reported). A key
 *   that hasn't echoed after RETYPE_MS (something else took focus, as the 1.4.0 walkthrough does
 *   when it opens) is typed again, after focusing the block again; the run reports how many it
 *   took (`keyTries`).
 * - CPU throttling (4x, CDP Emulation.setCPUThrottlingRate) starts once the harness sees the
 *   page, 10 to 27 ms after its document exists in the baseline's runs, the same for every
 *   package, since Playwright can't throttle a page before it has one; `throttledAtMs` says
 *   when, and `documentAtMs` when the document existed, both on the page's clock.
 * - JS heap is CDP Runtime.getHeapUsage's usedSize after HeapProfiler.collectGarbage, once the
 *   save the probe's own key sets off has committed: from the echo, the driver waits until a
 *   readwrite IndexedDB transaction has begun and none is open, for SAVE_WAIT_MS at most, and
 *   reports when the save ended (`saveMs`, after the echo; null when none began in time). Read
 *   at the echo, the heap counted what that save allocates, which is garbage once it commits,
 *   so where the save started against the collection moved #147's typical heap between modes
 *   0.8 MiB apart (#147's T2 profile).
 * - The network is off in Chromium itself (the harness's `network: 'offline'`: a dead proxy and
 *   no host resolution), not through a route, which would send each of the page's own requests
 *   through this process and cost a package by its file count.
 */

const { launchExtension } = require('../../e2e/harness/extension');
const { fixtureHost } = require('../../e2e/harness/fixture-host');

const THROTTLE = 4;
/** After seeding, before the new tab opens, so the install's own start work is done */
const SETTLE_MS = 1000;
const TIMEOUT_MS = 60_000;
/** An editable block in the editor of the legacy new tab (the 1.4.x app and its builds) */
const EDITOR = '#editor-container #blocks-container .block-content[contenteditable="true"]';
const KEY = 'q';
/**
 * How long a typed key may take to echo before the driver focuses the block and types again.
 * Short, so a key the page's focus change swallowed costs little; a slow echo of the first key
 * still counts, at the time it lands.
 */
const RETYPE_MS = 50;
const MAX_TRIES = 200;
const MARK = 'ntn:interaction-ready';
/**
 * How long the heap reading waits after the echo for the save the probe's key sets off. The
 * stack's begins 19 to 69 ms after the echo and commits by 160, so this is only a bound for a
 * package that never saves the key.
 */
const SAVE_WAIT_MS = 5000;

/**
 * Runs in the new tab before its scripts: watches the focused block for the probe's key, and
 * the page's readwrite IndexedDB transactions for the save the key sets off
 */
function probeInit({ editor, key }) {
  const count = node => (node.textContent || '').split(key).length - 1;
  const probe = {
    // When the document existed and this ran, before the page's own scripts
    documentAt: performance.now(),
    seenAt: null,
    echoedAt: null,
    target: null,
    /** Each readwrite transaction the page opened, by when it began and ended: times only */
    writes: [],
    /** When the last write begun since the echo ended, once saved() first answered true */
    savedAt: null,
    /** Whether a write has begun since the echo and none is open */
    saved() {
      if (probe.echoedAt === null) return false;
      const since = probe.writes.filter(write => write.began >= probe.echoedAt);
      if (since.length === 0 || probe.writes.some(write => write.ended === null)) return false;
      probe.savedAt = Math.max(...since.map(write => write.ended));
      return true;
    },
    /** Focuses the first editable block, caret at its end, and starts watching it */
    focus() {
      const element = document.querySelector(editor);
      if (!element) return false;
      element.focus();
      const selection = document.getSelection();
      if (selection) {
        const range = document.createRange();
        range.selectNodeContents(element);
        range.collapse(false);
        selection.removeAllRanges();
        selection.addRange(range);
      }
      const before = count(element);
      probe.target = element;
      new MutationObserver((_, observer) => {
        if (probe.echoedAt === null && count(element) > before) {
          probe.echoedAt = performance.now();
          observer.disconnect();
        }
      }).observe(element, { childList: true, characterData: true, subtree: true });
      return document.activeElement === element || element.contains(document.activeElement);
    },
  };
  Object.defineProperty(window, '__ntnProbe', { value: probe });
  const transaction = IDBDatabase.prototype.transaction;
  IDBDatabase.prototype.transaction = function (...args) {
    const made = transaction.apply(this, args);
    if (args[1] === 'readwrite') {
      const write = { began: performance.now(), ended: null };
      probe.writes.push(write);
      const end = () => {
        if (write.ended === null) write.ended = performance.now();
      };
      made.addEventListener('complete', end);
      made.addEventListener('abort', end);
    }
    return made;
  };
}

/**
 * @param {{dist: string, fixture: object | null, chromium?: any, page?: string}} options
 * @returns {Promise<{interactionReadyMs: number, markMs: number | null, heapBytes: number, saveMs: number | null, driverMs: number, throttledAtMs: number, documentAtMs: number, domContentLoadedMs: number | null, browser: string, keyTries: number}>}
 */
async function installCold({ dist, fixture, chromium, page: file = 'newtab.html' }) {
  const extension = await launchExtension({ dist, network: 'offline', ...(chromium ? { chromium } : {}) });
  try {
    const agent = await extension.worker.evaluate(() => navigator.userAgent);
    if (fixture) await fixtureHost(extension.worker).loadFixture(fixture);
    await new Promise(resolve => setTimeout(resolve, SETTLE_MS));
    await extension.context.addInitScript(probeInit, { editor: EDITOR, key: KEY });

    const opened = extension.context.waitForEvent('page', { timeout: TIMEOUT_MS });
    const startedAt = await extension.worker.evaluate(name => {
      const at = performance.timeOrigin + performance.now();
      chrome.tabs.create({ url: chrome.runtime.getURL(name) });
      return at;
    }, file);
    const page = await opened;
    const cdp = await extension.context.newCDPSession(page);
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: THROTTLE });
    const throttledAt = Date.now();

    await page.waitForFunction(
      selector => {
        if (!document.querySelector(selector)) return false;
        window.__ntnProbe.seenAt = performance.now();
        return true;
      },
      EDITOR,
      { polling: 10, timeout: TIMEOUT_MS },
    );
    // Something on the page may take focus after the driver gave it to the block (the 1.4.0
    // walkthrough focuses its button as it opens), so a key that doesn't echo is typed again
    let tries = 0;
    for (;;) {
      tries++;
      await page.evaluate(() => window.__ntnProbe.focus());
      await page.keyboard.type(KEY);
      const echoed = await page
        .waitForFunction(() => window.__ntnProbe.echoedAt !== null, null, { polling: 10, timeout: RETYPE_MS })
        .then(() => true, () => false);
      if (echoed) break;
      if (tries >= MAX_TRIES) throw new Error(`no key echoed in the editor after ${tries} tries`);
    }

    // The heap once the save the key set off has committed, so what that save allocates, and
    // lets go of as it commits, isn't in the reading
    const saved = await page
      .waitForFunction(() => window.__ntnProbe.saved(), null, { polling: 10, timeout: SAVE_WAIT_MS })
      .then(() => true, () => false);
    await cdp.send('HeapProfiler.collectGarbage');
    const heap = await cdp.send('Runtime.getHeapUsage');
    const read = await page.evaluate(name => {
      const navigation = performance.getEntriesByType('navigation')[0];
      const mark = performance.getEntriesByName(name, 'mark')[0];
      return {
        timeOrigin: performance.timeOrigin,
        documentAt: window.__ntnProbe.documentAt,
        seenAt: window.__ntnProbe.seenAt,
        echoedAt: window.__ntnProbe.echoedAt,
        savedAt: window.__ntnProbe.savedAt,
        markAt: mark ? mark.startTime : null,
        domContentLoaded: navigation ? navigation.domContentLoadedEventStart : null,
      };
    }, MARK);
    const since = at => Math.round((read.timeOrigin + at - startedAt) * 10) / 10;
    return {
      interactionReadyMs: since(read.echoedAt),
      markMs: read.markAt === null ? null : since(read.markAt),
      heapBytes: heap.usedSize,
      saveMs: saved && read.savedAt !== null ? Math.round((read.savedAt - read.echoedAt) * 10) / 10 : null,
      driverMs: Math.round((read.echoedAt - read.seenAt) * 10) / 10,
      throttledAtMs: Math.round(throttledAt - read.timeOrigin),
      documentAtMs: Math.round(read.documentAt),
      domContentLoadedMs: read.domContentLoaded === null ? null : since(read.domContentLoaded),
      browser: (/Chrome\/([\d.]+)/.exec(agent) || [null, 'unknown'])[1],
      keyTries: tries,
    };
  } finally {
    await extension.close();
  }
}

module.exports = { installCold, THROTTLE, SETTLE_MS, EDITOR, KEY, SAVE_WAIT_MS };
