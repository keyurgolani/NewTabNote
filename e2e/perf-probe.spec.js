/**
 * #27 slice 4a's performance probe, timed: one install-cold run of the typical profile on the
 * build under test (scripts/perf/timing.js), so the probe keeps working on whatever the build
 * makes. It checks that the run measures something sensible, not how fast it is; the numbers
 * are docs/performance/baseline-1.4.0.md's. The bytes are test/perf-probe.test.js's. The heap
 * reading waits for the save the probe's own key sets off, on a package whose save holds what
 * it writes until it commits. And the probe's network-off mode (the harness's `network:
 * 'offline'`, no route) still stops every request outside the extension, from a page and from
 * the service worker, loopback included, where a control launch with the route taken off gets
 * through.
 */

const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { test, expect, resolveDist, launchExtension } = require('./harness');
const { installCold } = require('../scripts/perf/timing');
const { profileFixture } = require('../scripts/perf/profiles');

const MIB = 1024 * 1024;

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

/** How long each of the save package's writes stays open, from its first put */
const HOLD_MS = 400;
/** How long after the save commits the package's follow-up write begins */
const FOLLOW_UP_MS = 50;

/**
 * A package whose editor saves the way the stack's does for the probe's key, but slower and
 * bigger: on the first input it holds about 10 MiB of objects, opens a readwrite transaction
 * 20 ms later, keeps it open with a chain of puts for HOLD_MS, and lets the objects go once it
 * commits. With `followUp`, as that save commits it holds another 10 MiB for a second write,
 * FOLLOW_UP_MS later and as long, as the stack's snapshot and search-index writes follow its
 * save. The editor shows only once its database is open, so the key always finds the save
 * ready. The package is written to a temporary directory, which the caller removes.
 * @param {{followUp?: boolean}} [options]
 */
function savingPackage({ followUp = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ntn-perf-save-'));
  const files = {
    'manifest.json': JSON.stringify({ manifest_version: 3, name: 'Save in the reading window', version: '1.0.0', background: { service_worker: 'background.js' } }),
    'background.js': '// The probe opens newtab.html itself\n',
    'newtab.html': '<!doctype html><html><head><meta charset="utf-8"><title>Save</title></head><body><script src="newtab.js"></script></body></html>\n',
    'newtab.js': `
const FOLLOW_UP = ${followUp};
const open = indexedDB.open('save-in-the-window', 1);
open.onupgradeneeded = () => open.result.createObjectStore('notes');
open.onsuccess = () => {
  const db = open.result;
  document.body.innerHTML = '<div id="editor-container"><div id="blocks-container"><div class="block-content" contenteditable="true"></div></div></div>';
  const objects = () => Array.from({ length: 200000 }, (_, index) => ({ index, text: 'block ' + index }));
  // Holds what objects() makes until a write of it, \`after\` ms on, commits, then calls done
  const write = (after, done) => {
    let held = objects();
    setTimeout(() => {
      const transaction = db.transaction('notes', 'readwrite');
      const store = transaction.objectStore('notes');
      const until = performance.now() + ${HOLD_MS};
      const put = index => {
        store.put(held.length, index).onsuccess = () => {
          if (performance.now() < until) put(index + 1);
        };
      };
      put(0);
      transaction.oncomplete = () => {
        held = null;
        done();
      };
    }, after);
  };
  let saving = false;
  document.querySelector('.block-content').addEventListener('input', () => {
    if (saving) return;
    saving = true;
    write(20, () => {
      if (FOLLOW_UP) write(${FOLLOW_UP_MS}, () => {});
    });
  });
};
`,
  };
  for (const [file, text] of Object.entries(files)) fs.writeFileSync(path.join(root, file), text);
  return root;
}

test("the heap reading waits for the save the probe's key sets off, so what that save holds can't lift it", async ({ playwright }) => {
  test.setTimeout(120_000);
  const dist = savingPackage();
  try {
    const run = await installCold({ dist, fixture: null, chromium: playwright.chromium });
    // The save's 10 MiB went once it committed, at least HOLD_MS after the echo
    expect(run.heapBytes / MIB).toBeLessThan(4);
    expect(run.saveMs).toBeGreaterThanOrEqual(HOLD_MS);
  } finally {
    fs.rmSync(dist, { recursive: true, force: true });
  }
});

test('the heap reading waits out the writes the save sets off too, so what they hold until they commit can\'t lift it', async ({ playwright }) => {
  test.setTimeout(120_000);
  const dist = savingPackage({ followUp: true });
  try {
    const run = await installCold({ dist, fixture: null, chromium: playwright.chromium });
    // Both writes' 10 MiB went once the second committed, at least 2 * HOLD_MS after the echo
    expect(run.heapBytes / MIB).toBeLessThan(4);
    expect(run.saveMs).toBeGreaterThanOrEqual(2 * HOLD_MS + FOLLOW_UP_MS);
  } finally {
    fs.rmSync(dist, { recursive: true, force: true });
  }
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
