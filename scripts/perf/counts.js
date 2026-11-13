'use strict';

/**
 * One counted run on `ref-desktop` (#27 AC3, #300; docs/testing.md "The performance probe"): a
 * fresh profile with the package installed and the fixture profile seeded, as an install-cold run
 * has it (scripts/perf/timing.js), and no clock. It counts the new tab's IndexedDB reads before its
 * interaction-ready mark, and the requests each page and the service worker make outside the
 * extension in the windows below, but for what the worker sends through the offscreen document
 * it creates. The timed runs never count: the counter wraps every IndexedDB request method, so it
 * runs here alone.
 *
 * - IndexedDB requests come from #301's counter (test/support/faults/): in every page from its
 *   first script, and in the service worker from right before it opens the new tab. The new tab's
 *   reads are its own and the worker's, cut at its `ntn:interaction-ready` mark.
 * - The new tab opens as the timed runs open it, from the service worker with chrome.tabs.create,
 *   under the same CPU throttling. Its requests count until the probe sees its mark.
 * - Then Popup, the Side Panel, recovery.html and the offscreen document open, one at a time, each
 *   counted to its load and SETTLE_MS after it, since none has a ready mark yet (#4, #5). The
 *   offscreen document opens as a page, where the worker would create it only for a request it
 *   sends there.
 * - The service worker's requests count from just before it opens the new tab to the run's end,
 *   while the pages start. Its own start, its install and a restart come before that, and no run
 *   counts them yet: that takes the listener on before the worker runs, which launchExtension
 *   can't give.
 * - What the worker sends through the offscreen document it creates, the requests to the Ollama
 *   URL, isn't seen at all: Playwright doesn't attach to that document (e2e/network-guard.spec.js),
 *   so those requests land on no row. Counting them takes a CDP session on the offscreen target.
 * - A request from a page that's no entry, such as a tab the extension opens, lands on no row
 *   either: the run holds it apart, as `unattributed`, and the perf summary lists it.
 * - A request outside the extension is one to any URL but a chrome-extension:// one, of any
 *   extension, and data:, blob: and about:. The network is off in Chromium itself, so none is
 *   answered, and each one still counts as made. One the network guard refuses is never made, and
 *   isn't counted.
 */

const { launchExtension } = require('../../e2e/harness/extension');
const { fixtureHost } = require('../../e2e/harness/fixture-host');
const { countIdbRequests, countRequestsIn, readIdbRequests, interactionReadyAt } = require('../../test/support/faults');
const { THROTTLE, SETTLE_MS } = require('./timing');

const TIMEOUT_MS = 60_000;
const MARK = 'ntn:interaction-ready';
/** The pages a counted run opens after the new tab, by entry, each counted to its load and SETTLE_MS */
const LATER_PAGES = Object.freeze({ popup: 'popup.html', sidepanel: 'sidepanel.html', recovery: 'recovery.html', offscreen: 'offscreen.html' });
/** Each entry a counted run counts requests for */
const ENTRIES = Object.freeze(['newtab', ...Object.keys(LATER_PAGES), 'background']);

/**
 * Whether a request to `url` goes outside every extension: any URL but chrome-extension://, data:,
 * blob: and about:
 * @param {string} url
 */
function offOrigin(url) {
  return !/^(chrome-extension|data|blob|about):/.test(url);
}

/**
 * The entry a page's request comes from, by its page's file, or 'unknown'
 * @param {any} request - a Playwright Request
 */
function entryOf(request) {
  if (request.serviceWorker()) return 'background';
  try {
    const file = new URL(request.frame().page().mainFrame().url()).pathname.slice(1);
    if (file === 'newtab.html') return 'newtab';
    return Object.keys(LATER_PAGES).find(entry => LATER_PAGES[entry] === file) || 'unknown';
  } catch {
    return 'unknown';
  }
}

/**
 * @param {{dist: string, fixture: object | null, chromium?: any}} options
 * @returns {Promise<{newtab: {reads: number, pageReads: number, workerReads: number, requests: number}, popup: {requests: number}, sidepanel: {requests: number}, recovery: {requests: number}, offscreen: {requests: number}, background: {requests: number}, urls: Array<{url: string, from: string}>, unattributed: Array<{url: string, from: string}>}>}
 */
async function countedRun({ dist, fixture, chromium }) {
  const extension = await launchExtension({ dist, network: 'offline', ...(chromium ? { chromium } : {}) });
  try {
    if (fixture) await fixtureHost(extension.worker).loadFixture(fixture);
    await new Promise(resolve => setTimeout(resolve, SETTLE_MS));
    /** @type {Array<{url: string, from: string}>} every request seen, and those each window held */
    const seen = [];
    /** @type {Array<{url: string, from: string}>} */
    const urls = [];
    extension.context.on('request', request => {
      if (offOrigin(request.url())) seen.push({ url: request.url(), from: entryOf(request) });
    });
    // An entry's count and its share of the list, as its window closes: a request made later is in neither
    const requestsOf = (/** @type {string} */ entry) => {
      const held = seen.filter(request => request.from === entry);
      urls.push(...held);
      return held.length;
    };
    await countRequestsIn(extension.context);
    await countRequestsIn(extension.worker);

    const opened = extension.context.waitForEvent('page', { timeout: TIMEOUT_MS });
    await extension.worker.evaluate(() => {
      chrome.tabs.create({ url: chrome.runtime.getURL('newtab.html') });
    });
    const newtab = await opened;
    await (await extension.context.newCDPSession(newtab)).send('Emulation.setCPUThrottlingRate', { rate: THROTTLE });
    await newtab.waitForFunction(name => performance.getEntriesByName(name, 'mark').length > 0, MARK, { polling: 50, timeout: TIMEOUT_MS });
    const ready = /** @type {number} */ (await interactionReadyAt(newtab));
    const pageReads = countIdbRequests(await readIdbRequests(newtab), { until: ready }).reads;
    const workerReads = countIdbRequests(await readIdbRequests(extension.worker), { until: ready }).reads;
    const counts = { newtab: { reads: pageReads + workerReads, pageReads, workerReads, requests: requestsOf('newtab') } };

    for (const [entry, file] of Object.entries(LATER_PAGES)) {
      const page = await extension.context.newPage();
      await (await extension.context.newCDPSession(page)).send('Emulation.setCPUThrottlingRate', { rate: THROTTLE });
      await page.goto(extension.url(file), { waitUntil: 'load', timeout: TIMEOUT_MS });
      await new Promise(resolve => setTimeout(resolve, SETTLE_MS));
      counts[entry] = { requests: requestsOf(entry) };
    }
    const unattributed = seen.filter(({ from }) => from === 'unknown');
    return { ...counts, background: { requests: requestsOf('background') }, urls, unattributed };
  } finally {
    await extension.close();
  }
}

module.exports = { countedRun, offOrigin, ENTRIES, LATER_PAGES };
