/**
 * #27 slice 4a's performance probe, timed: one install-cold run of the typical profile on the
 * build under test (scripts/perf/timing.js), so the probe keeps working on whatever the build
 * makes. It checks that the run measures something sensible, not how fast it is; the numbers
 * are docs/performance/baseline-1.4.0.md's. The bytes are test/perf-probe.test.js's. The heap
 * reading waits for the save the probe's own key sets off, on a package whose save holds what
 * it writes until it commits. The probe types its key once on a page too busy to answer as the
 * key lands. And the probe's network-off mode (the harness's `network:
 * 'offline'`, no route) still stops every request outside the extension, from a page and from
 * the service worker, loopback included, where a control launch with the route taken off gets
 * through. A counted run (scripts/perf/counts.js, #300) counts the new tab's IndexedDB reads before
 * its mark and the requests each page and the worker make outside the extension, on the build and
 * on a written package with reads and requests on both sides of each window it counts.
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

/** How long the blocked package's page stays busy once the probe's key is in */
const BLOCKED_MS = 200;

/**
 * A package whose page is blocked for BLOCKED_MS as the probe's key lands, as the stack's new tab
 * can be while its start runs: its editor takes the key in 5 ms after the keydown, with an input
 * event, then stays busy in the same task, so the key's echo and everything the driver asks the
 * page wait until it's done. It blocks for the first key only. The package is written to a
 * temporary directory, which the caller removes.
 */
function blockedPackage() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ntn-perf-blocked-'));
  const files = {
    'manifest.json': JSON.stringify({ manifest_version: 3, name: 'Blocked as the key lands', version: '1.0.0', background: { service_worker: 'background.js' } }),
    'background.js': '// The probe opens newtab.html itself\n',
    'newtab.html':
      '<!doctype html><html><head><meta charset="utf-8"><title>Blocked</title></head><body>'
      + '<div id="editor-container"><div id="blocks-container"><div class="block-content" contenteditable="true"></div></div></div>'
      + '<script src="newtab.js"></script></body></html>\n',
    'newtab.js': `
const block = document.querySelector('.block-content');
let blocked = false;
block.addEventListener('keydown', event => {
  if (event.key.length !== 1) return;
  event.preventDefault();
  const first = !blocked;
  blocked = true;
  setTimeout(() => {
    block.append(event.key);
    block.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: event.key }));
    if (!first) return;
    const until = performance.now() + ${BLOCKED_MS};
    while (performance.now() < until) {}
  }, 5);
});
`,
  };
  for (const [file, text] of Object.entries(files)) fs.writeFileSync(path.join(root, file), text);
  return root;
}

test("the probe types its key once when the page is too busy to answer as it lands, so a second key can't add a save", async ({ playwright }) => {
  test.setTimeout(120_000);
  const dist = blockedPackage();
  try {
    const run = await installCold({ dist, fixture: null, chromium: playwright.chromium });
    // The editor took the key in before the page went busy, so the wait was no reason to type
    // it again
    expect(run.keyTries).toBe(1);
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

test("a counted run counts the new tab's IndexedDB reads before its mark, the page's and the worker's, and each page's and the worker's requests outside the extension (#300)", async ({ playwright }) => {
  test.setTimeout(180_000);
  // Loaded here, so the rest of this file runs without it
  const { countedRun, ENTRIES } = require('../scripts/perf/counts');
  const { fixture } = await profileFixture('typical');
  const run = await countedRun({ dist: resolveDist(), fixture, chromium: playwright.chromium });
  // The new tab reads its settings and its notes before it marks itself ready
  expect(run.newtab.pageReads).toBeGreaterThan(0);
  expect(run.newtab.reads).toBe(run.newtab.pageReads + run.newtab.workerReads);
  for (const name of ENTRIES) expect(Number.isInteger(run[name].requests), name).toBe(true);
  // Each request it counted left the extension, and says where it went
  expect(run.urls.length).toBe(ENTRIES.reduce((sum, name) => sum + run[name].requests, 0));
  for (const { url, from } of run.urls) {
    expect(url).not.toMatch(/^(chrome-extension|data|blob|about):/);
    expect(ENTRIES).toContain(from);
  }
  // and none came from a page that's no entry, which no row would count
  expect(run.unattributed).toEqual([]);
});

/**
 * A package with IndexedDB reads and requests on both sides of each window a counted run counts
 * (scripts/perf/counts.js, #300). Its new tab reads 3 times, has the worker read once and fetches
 * once before it marks itself ready. In the mark's own task, where the probe can't read the
 * record before they're in it, it then reads twice and has the worker read once, so only the cut
 * at the mark keeps them out, and 2 s on it fetches once more. Popup, the Side Panel,
 * recovery.html and the offscreen document each fetch once at their load, and once 2 s on, past
 * their window. As Popup loads, it has the worker fetch once and open welcome.html, a page that's
 * no entry, which fetches once as it loads. Each fetch goes to loopback, which the network-off
 * mode's dead proxy fails, so nothing answers it. The package is written to a temporary
 * directory, which the caller removes.
 */
function countingPackage() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ntn-perf-counts-'));
  const page = (/** @type {string} */ title, /** @type {string} */ script) => `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title></head><body><script src="${script}"></script></body></html>\n`;
  const files = {
    'manifest.json': JSON.stringify({ manifest_version: 3, name: 'Counted in its windows', version: '1.0.0', background: { service_worker: 'background.js' } }),
    'background.js': `
const open = () => new Promise(resolve => {
  const request = indexedDB.open('counted', 1);
  request.onupgradeneeded = () => request.result.createObjectStore('notes');
  request.onsuccess = () => resolve(request.result);
});
chrome.runtime.onMessage.addListener((message, sender, reply) => {
  if (message === 'read') {
    open().then(db => {
      db.transaction('notes').objectStore('notes').get(1).onsuccess = () => reply(true);
    });
    return true;
  }
  if (message === 'fetch') fetch('http://localhost:9/worker').catch(() => {});
  if (message === 'welcome') chrome.tabs.create({ url: chrome.runtime.getURL('welcome.html'), active: false });
  return false;
});
`,
    'newtab.html': page('Counted', 'newtab.js'),
    'newtab.js': `
const fetchOnce = name => fetch('http://localhost:9/' + name).catch(() => {});
const request = indexedDB.open('counted', 1);
request.onupgradeneeded = () => request.result.createObjectStore('notes');
request.onsuccess = async () => {
  const read = () => new Promise(resolve => {
    request.result.transaction('notes').objectStore('notes').get(1).onsuccess = resolve;
  });
  await read();
  await read();
  await read();
  await chrome.runtime.sendMessage('read');
  fetchOnce('newtab-before');
  performance.mark('ntn:interaction-ready');
  // In the mark's own task, 1 ms past its clock tick: two reads, and one the worker makes while
  // the task holds, so all three are in the records before the probe can see the mark
  const hold = ms => {
    for (const until = performance.now() + ms; performance.now() < until;);
  };
  hold(1);
  read();
  read();
  chrome.runtime.sendMessage('read').catch(() => {});
  hold(300);
  setTimeout(() => fetchOnce('newtab-after'), 2000);
};
`,
    'later.js': `
const name = location.pathname.slice(1, -'.html'.length);
fetch('http://localhost:9/' + name + '-load').catch(() => {});
if (name === 'popup') {
  chrome.runtime.sendMessage('fetch').catch(() => {});
  chrome.runtime.sendMessage('welcome').catch(() => {});
}
setTimeout(() => fetch('http://localhost:9/' + name + '-later').catch(() => {}), 2000);
`,
    ...Object.fromEntries(['popup', 'sidepanel', 'recovery', 'offscreen'].map(name => [`${name}.html`, page(name, 'later.js')])),
    'welcome.html': page('Welcome', 'welcome.js'),
    'welcome.js': "fetch('http://localhost:9/welcome').catch(() => {});\n",
  };
  for (const [file, text] of Object.entries(files)) fs.writeFileSync(path.join(root, file), text);
  return root;
}

test('a counted run counts what each window holds and nothing past it, on a package with reads and requests on both sides of each (#300)', async ({ playwright }) => {
  test.setTimeout(180_000);
  const { countedRun, ENTRIES } = require('../scripts/perf/counts');
  const dist = countingPackage();
  try {
    const run = await countedRun({ dist, fixture: null, chromium: playwright.chromium });
    expect(run.newtab).toEqual({ reads: 4, pageReads: 3, workerReads: 1, requests: 1 });
    for (const entry of ENTRIES.filter(entry => entry !== 'newtab')) expect(run[entry], entry).toEqual({ requests: 1 });
    // The list holds what the counts hold, and nothing made past a window
    expect(run.urls.map(({ url, from }) => `${from} ${new URL(url).pathname}`).sort()).toEqual([
      'background /worker',
      'newtab /newtab-before',
      'offscreen /offscreen-load',
      'popup /popup-load',
      'recovery /recovery-load',
      'sidepanel /sidepanel-load',
    ]);
    // The welcome tab's is on no entry's list, and held apart
    expect(run.unattributed).toEqual([{ url: 'http://localhost:9/welcome', from: 'unknown' }]);
  } finally {
    fs.rmSync(dist, { recursive: true, force: true });
  }
});

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
