/**
 * #27 slice 4a's performance probe, timed: one install-cold run of the typical profile on the
 * build under test (scripts/perf/timing.js), so the probe keeps working on whatever the build
 * makes. It checks that the run measures something sensible, not how fast it is; the numbers
 * are docs/performance/baseline-1.4.0.md's. The bytes are test/perf-probe.test.js's. And the
 * probe's network-off mode (the harness's `network: 'offline'`, no route) still stops every
 * request outside the extension, from a page and from the service worker, loopback included,
 * where a control launch with the route taken off gets through.
 */

const http = require('http');
const { test, expect, resolveDist, launchExtension } = require('./harness');
const { installCold } = require('../scripts/perf/timing');
const { profileFixture } = require('../scripts/perf/profiles');

test('an install-cold run measures interaction-ready, the mark and the heap', async ({ playwright }) => {
  test.setTimeout(120_000);
  const { fixture } = await profileFixture('typical');
  const run = await installCold({ dist: resolveDist(), fixture, chromium: playwright.chromium });
  expect(run.interactionReadyMs).toBeGreaterThan(0);
  expect(run.interactionReadyMs).toBeLessThan(60_000);
  // This build has the legacy app's mark
  expect(run.markMs).not.toBeNull();
  expect(run.markMs).toBeGreaterThan(0);
  expect(run.driverMs).toBeGreaterThanOrEqual(0);
  expect(run.domContentLoadedMs).toBeLessThanOrEqual(run.interactionReadyMs);
  expect(run.heapBytes).toBeGreaterThan(1024 * 1024);
  expect(run.browser).toMatch(/^\d+\./);
});

/**
 * Fetches each URL and answers what happened, with any CSP violation it raised, so a failure
 * the CSP caused can't pass for the network rule's
 */
function tryAll(list) {
  const violations = [];
  self.addEventListener('securitypolicyviolation', event => violations.push(event.blockedURI));
  return Promise.all(list.map(url => fetch(url, { cache: 'no-store' }).then(response => `answered ${response.status}`, error => `failed: ${error.name}`)))
    .then(results => new Promise(resolve => setTimeout(() => resolve({ results, violations }), 200)));
}

test("the probe's network-off mode stops requests outside the extension, from a page and the worker", async ({ playwright }) => {
  // A server the CSP lets the extension reach (connect-src allows http://localhost:*), on
  // loopback, which a dead proxy alone would let through without --proxy-bypass-list=<-loopback>
  const server = http.createServer((request, response) => response.end('answered'));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const urls = [`http://localhost:${server.address().port}/`, 'https://api.openai.com/v1/models'];
  // The stand-in is the stored Ollama URL, the one loopback origin the network guard lets a
  // page and the worker reach (#21 slice 1b), so the network-off mode is what stops it
  const storeOllamaUrl = page => page.evaluate(url => chrome.storage.local.set({ setting_ollamaUrl: url }), urls[0].replace(/\/$/, ''));
  try {
    // Control: with the route taken off, the page and the worker reach the local server
    const control = await launchExtension({ dist: resolveDist(), chromium: playwright.chromium });
    try {
      await control.context.unrouteAll({ behavior: 'ignoreErrors' });
      const page = await control.openSurface('popup');
      await storeOllamaUrl(page);
      for (const target of [page, control.worker]) {
        const { results, violations } = await target.evaluate(tryAll, urls.slice(0, 1));
        expect(results).toEqual(['answered 200']);
        expect(violations).toEqual([]);
      }
    } finally {
      await control.close();
    }

    const extension = await launchExtension({ dist: resolveDist(), chromium: playwright.chromium, network: 'offline' });
    try {
      const page = await extension.openSurface('popup');
      await expect(page.getByRole('textbox', { name: 'Quick note input' })).toBeVisible();
      await storeOllamaUrl(page);
      for (const target of [page, extension.worker]) {
        const { results, violations } = await target.evaluate(tryAll, urls);
        expect(results).toEqual(['failed: TypeError', 'failed: TypeError']);
        // Stopped by the network rule, not the CSP
        expect(violations).toEqual([]);
      }
      // The extension's own files still load
      expect(await page.evaluate(() => fetch(chrome.runtime.getURL('manifest.json')).then(response => response.ok))).toBe(true);
    } finally {
      await extension.close();
    }
  } finally {
    server.close();
  }
});
