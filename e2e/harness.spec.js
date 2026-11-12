/**
 * Self-tests for the harness. Each launches the build, or a copy of it edited in a temp dir
 * outside the repo, and checks that the harness sees what it has to.
 */

const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { test, expect, launchExtension, resolveDist, builtFiles } = require('./harness');
const driver = require('./characterization/driver');

/**
 * Copy the build to a temp dir and edit it: `edits` maps each file of the sources to a function
 * from its text (empty for a new file) to the text to write. A module the bundler folded into
 * chunks is edited in each chunk that holds it (dist-report/modules.json).
 */
function editedBuild(edits) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ntn-e2e-edited-'));
  fs.cpSync(resolveDist(), dir, { recursive: true });
  for (const [file, edit] of Object.entries(edits)) {
    const holders = builtFiles(resolveDist(), file);
    for (const built of holders.length > 0 ? holders : [file]) {
      const target = path.join(dir, built);
      fs.writeFileSync(target, edit(fs.existsSync(target) ? fs.readFileSync(target, 'utf8') : ''));
    }
  }
  return dir;
}

/**
 * Launch an edited copy of the build, run `body` with the session, and clean up both
 */
async function withEditedBuild({ playwright, headless }, edits, body) {
  const dist = editedBuild(edits);
  try {
    const extension = await launchExtension({ dist, headless, chromium: playwright.chromium });
    try {
      await body(extension);
    } finally {
      await extension.close();
    }
  } finally {
    fs.rmSync(dist, { recursive: true, force: true });
  }
}

const describe = ({ source, where, message }) => `${source} | ${where} | ${message}`;

/**
 * A server on the loopback address only, on a port of its own, that answers every request with a
 * 404 and keeps what it was asked. Something the harness should block points at it, so a request
 * that gets past the harness shows up in `asked` instead of leaving the machine.
 */
async function loopbackServer() {
  const asked = [];
  const server = http.createServer((request, response) => {
    asked.push(`${request.method} ${request.url}`);
    response.writeHead(404).end();
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return {
    asked,
    url: file => `http://127.0.0.1:${server.address().port}/${file}`,
    close: () => new Promise(resolve => {
      server.closeAllConnections();
      server.close(() => resolve());
    }),
  };
}

/** Open the pop-out from `page`, the new tab, and wait until it holds the note's blocks */
async function openPopOut(extension, page, blocks) {
  const [pip] = await Promise.all([extension.context.waitForEvent('page'), page.locator('#pip-toggle').click()]);
  await expect.poll(() => page.evaluate(() => (app.tabController.pipEditor ? app.tabController.pipEditor.blocks.length : 0))).toBe(blocks);
  return pip;
}

// A listener the edited workers below register; a message from a page makes it throw
const THROWING_LISTENER = `
chrome.runtime.onMessage.addListener(message => {
  if (message === 'ntn-self-test') throw new Error('self-test: startup listener');
});
`;

for (const [title, edits, thrown] of [
  ['throws at the top level', { 'js/background.js': text => `${text}\nthrow new Error('self-test: background.js throws');\n` }, 'self-test: background.js throws'],
  // The worker's one module holds #17's adapter, as the pages' chunks do, so what it throws stops
  // the worker, and the pages run it with a window. Since #17 PR 4a the worker has no storage.js.
  ['throws in a module it shares with the pages', { 'js/kernel/adapters/indexeddb/adapter.js': text => `if (typeof window === 'undefined') throw new Error('self-test: adapter.js throws');\n${text}` }, 'self-test: adapter.js throws'],
]) {
  test(`fails the launch when the worker ${title} while starting`, async ({ playwright, headless }) => {
    const dist = editedBuild(edits);
    try {
      const error = await launchExtension({ dist, headless, chromium: playwright.chromium })
        .then(extension => extension.close().then(() => null), launchError => launchError);
      expect(error, 'the launch succeeded').not.toBeNull();
      expect(error.message).toContain('The service worker never activated (state: redundant)');
      expect(error.message).toContain(thrown);
    } finally {
      fs.rmSync(dist, { recursive: true, force: true });
    }
  });
}

test('counts uncaught exceptions in pages and the worker, chrome.* listeners and callbacks included', async ({ extension }) => {
  const page = await extension.openSurface('popup');
  await page.evaluate(() => {
    setTimeout(() => { throw new Error('self-test: page throws'); }, 0);
    chrome.storage.onChanged.addListener(() => { throw new TypeError('self-test: page listener'); });
    chrome.storage.local.get(null, () => { throw new Error('self-test: page callback'); });
  });
  await extension.worker.evaluate(() => {
    setTimeout(() => { throw new Error('self-test: worker throws'); }, 0);
    chrome.storage.onChanged.addListener(() => { throw new Error('self-test: worker listener'); });
    chrome.storage.local.get(null, () => { throw new Error('self-test: worker callback'); });
  });
  await page.evaluate(() => chrome.storage.local.set({ selfTest: true }));

  await expect.poll(async () => (await extension.uncaught()).map(describe)).toEqual(expect.arrayContaining([
    'popup.html |  | self-test: page throws',
    'popup.html | chrome.* event listener | self-test: page listener',
    'popup.html | chrome.* API callback | self-test: page callback',
    'service worker |  | self-test: worker throws',
    'service worker | chrome.storage.onChanged listener | self-test: worker listener',
    'service worker | chrome.storage.local.get callback | self-test: worker callback',
  ]));
});

test('hooks what the worker does while it starts', async ({ playwright, headless }) => {
  const edits = {
    'js/background.js': text => `${text}${THROWING_LISTENER}Promise.reject(new Error('self-test: rejected while starting'));\n`,
  };
  await withEditedBuild({ playwright, headless }, edits, async extension => {
    const page = await extension.openSurface('popup');
    await page.evaluate(() => chrome.runtime.sendMessage('ntn-self-test').catch(() => {}));
    await expect.poll(async () => (await extension.uncaught()).map(describe)).toEqual(expect.arrayContaining([
      'service worker | unhandled rejection | self-test: rejected while starting',
      'service worker | chrome.runtime.onMessage listener | self-test: startup listener',
    ]));
  });
});

test('hooks a module worker the same way', async ({ playwright, headless }) => {
  const edits = {
    'manifest.json': text => JSON.stringify({ ...JSON.parse(text), background: { service_worker: 'js/module-worker.js', type: 'module' } }),
    'js/module-dependency.js': () => "export const loaded = 'self-test: module dependency';\n",
    'js/module-worker.js': () => `import { loaded } from './module-dependency.js';\nself.moduleDependency = loaded;\n${THROWING_LISTENER}`,
  };
  await withEditedBuild({ playwright, headless }, edits, async extension => {
    expect(await extension.worker.evaluate(() => self.moduleDependency)).toBe('self-test: module dependency');
    const page = await extension.openSurface('popup');
    await page.evaluate(() => chrome.runtime.sendMessage('ntn-self-test').catch(() => {}));
    await expect.poll(async () => (await extension.uncaught()).map(describe))
      .toContain('service worker | chrome.runtime.onMessage listener | self-test: startup listener');
  });
});

test("runs the worker at the path the build's manifest names, production's URL, which the offscreen document's sender check reads", async ({ extension }) => {
  const manifest = JSON.parse(fs.readFileSync(path.join(extension.dist, 'manifest.json'), 'utf8'));
  expect(extension.worker.url()).toBe(`chrome-extension://${extension.extensionId}/${manifest.background.service_worker}`);
});

test('still sees what the worker throws after it restarts, and fails while it is stopped', async ({ extension }) => {
  const page = await extension.openSurface('popup');
  // Popup's start wakes the worker on purpose while the database is below this build's version,
  // with storage.migrate, and waits for the worker's run (#17, Q12), so a stop sent before that
  // start settles can be undone at once. Popup lists its notes once it has.
  await expect(page.locator('#page-list')).not.toContainText('Loading...');
  const instance = () => extension.worker.evaluate(() => self.__ntnHarness.instance);
  const before = await instance();

  const cdp = await extension.context.newCDPSession(page);
  await cdp.send('ServiceWorker.enable');
  await cdp.send('ServiceWorker.stopAllWorkers');
  await expect(extension.uncaught()).rejects.toThrow('may be stopped');

  // Opening #13's port wakes the worker, and its router answers the hello. A port that closes
  // first, or no answer within 10 s, fails the test rather than hanging it.
  expect(await page.evaluate(() => new Promise((resolve, reject) => {
    const port = chrome.runtime.connect({ name: 'ntn-rpc' });
    const timer = setTimeout(() => {
      port.disconnect();
      reject(new Error('The worker never answered the hello'));
    }, 10_000);
    port.onDisconnect.addListener(() => {
      clearTimeout(timer);
      reject(new Error(`The port closed: ${chrome.runtime.lastError ? chrome.runtime.lastError.message : 'by the worker'}`));
    });
    port.onMessage.addListener((text) => {
      clearTimeout(timer);
      port.disconnect();
      resolve(JSON.parse(text).frame);
    });
    port.postMessage(JSON.stringify({
      frame: 'hello',
      protocol: { major: 1, minor: 0 },
      extensionVersion: chrome.runtime.getManifest().version,
      surface: 'popup',
      sessionId: 'harness-self-test',
    }));
  }))).toBe('welcome');
  expect(await instance(), 'the worker restarted').not.toBe(before);
  await extension.worker.evaluate(() => {
    setTimeout(() => { throw new Error('self-test: thrown after a restart'); }, 0);
  });
  await expect.poll(async () => (await extension.uncaught()).map(describe))
    .toContain('service worker |  | self-test: thrown after a restart');
});

test("reads the worker's own record, and fails when the worker runs without the hooks", async ({ extension }) => {
  // A report whose console line never arrived, as when the worker logs before the harness listens
  await extension.worker.evaluate(() => {
    const { reports } = self.__ntnHarness;
    reports.push({ seq: reports.length, where: '', message: 'self-test: never logged' });
  });
  expect((await extension.uncaught()).map(describe)).toContain('service worker |  | self-test: never logged');

  await extension.worker.evaluate(() => { delete self.__ntnHarness; });
  await expect(extension.uncaught()).rejects.toThrow('running without the harness hooks');
});

test('update() loads a new version in place, keeping the profile and the ID, and still sees what pages throw', async ({ extension }) => {
  await extension.worker.evaluate(() => chrome.storage.local.set({ ntnSelfTest: 'kept' }));
  const { extensionId } = extension;
  const instance = await extension.worker.evaluate(() => self.__ntnHarness.instance);

  await extension.update({ version: '9.9.9' });
  expect(extension.extensionId).toBe(extensionId);
  expect(await extension.worker.evaluate(() => self.__ntnHarness.instance), 'a new worker started').not.toBe(instance);
  expect(await extension.worker.evaluate(() => chrome.runtime.getManifest().version)).toBe('9.9.9');
  expect(await extension.worker.evaluate(async () => (await chrome.storage.local.get('ntnSelfTest')).ntnSelfTest)).toBe('kept');

  const page = await extension.openSurface('popup');
  await page.evaluate(() => { setTimeout(() => { throw new Error('self-test: page throws after an update'); }, 0); });
  await expect.poll(async () => (await extension.uncaught()).map(describe)).toContain('popup.html |  | self-test: page throws after an update');
});

test("a pop-out window loads the extension's own files, and what it asks of anywhere else is blocked and logged", async ({ extension }) => {
  test.setTimeout(60_000);
  // The note's image comes from a server on the loopback address (the CSP's img-src allows http:),
  // so if the harness let it out, that server would see it, with a network or without one
  const server = await loopbackServer();
  try {
    const early = server.url('harness-pop-out-early.png');
    // An origin the extension's connect-src allows, so the fetch gets as far as the network
    const late = 'https://api.openai.com/harness-pop-out-late';
    await extension.seedOnboarded();
    await driver.seedNotes(extension, [{ name: 'Pop-out', blocks: [{ type: 'text', content: 'A line' }, { type: 'image', imageUrl: early }] }]);
    const page = await driver.openNewTab(extension);
    const pip = await openPopOut(extension, page, 2);

    // The new tab copies its stylesheet in as a <link> as the window opens
    await expect.poll(() => pip.evaluate(() => Boolean(document.querySelector('link[rel="stylesheet"]').sheet)), "the pop-out's copy of the new tab's stylesheet loads").toBe(true);
    expect(await pip.evaluate(async () => (await fetch(document.querySelector('link[rel="stylesheet"]').href)).status), "a later fetch of the extension's own file").toBe(200);

    // The note's image outside the extension, asked for as the window opens, and a later fetch
    await expect.poll(() => pip.evaluate(src => {
      const img = document.querySelector(`img[src="${src}"]`);
      return Boolean(img && img.complete && img.naturalWidth === 0);
    }, early), "the note's image outside the extension doesn't load").toBe(true);
    expect(await pip.evaluate(url => fetch(url).then(() => 'answered', () => 'failed'), late), 'a later fetch outside the extension').toBe('failed');
    expect(extension.log(), 'the later fetch is logged as blocked').toContain(`blocked GET ${late} from the pop-out window`);
    expect(server.asked, "the note's image never reached its server").toEqual([]);
    await pip.close().catch(() => {});
  } finally {
    await server.close();
  }
});

// What the pop-out's setup does when a spec has changed what it works with
test("a pop-out window opened with a spec's own route on the context, or on the new tab, is left alone and logged", async ({ extension }) => {
  test.setTimeout(60_000);
  await extension.seedOnboarded();
  await driver.seedNotes(extension, [{ name: 'Pop-out', blocks: [{ type: 'text', content: 'A line' }] }]);
  // A route on the new tab itself isn't on the context, but it keeps the interception on as well
  const page = await driver.openNewTab(extension);
  await page.route('**/harness-page-route', route => route.abort());
  let pip = await openPopOut(extension, page, 1);
  await expect.poll(() => extension.log(), 'the setup skipped for a page with routes of its own').toContain('a pop-out window opened from newtab.html while that page has routes of its own');
  await pip.close().catch(() => {});
  await page.unroute('**/harness-page-route');

  await expect.poll(() => page.evaluate(() => app.tabController.pipWindow === null)).toBe(true);
  await extension.context.route('**/harness-context-route', route => route.abort());
  pip = await openPopOut(extension, page, 1);
  await expect.poll(() => extension.log(), "the setup skipped for the spec's own route").toContain("a pop-out window opened from newtab.html with the spec's own routes on");
  expect(extension.log(), 'and no setup is logged as done').not.toContain('set up the route again for a pop-out window');
  await pip.close().catch(() => {});
  await extension.context.unroute('**/harness-context-route');
});

test('a pop-out window opened while a spec has the network off leaves it off', async ({ extension }) => {
  test.setTimeout(60_000);
  await extension.seedOnboarded();
  await driver.seedNotes(extension, [{ name: 'Pop-out', blocks: [{ type: 'text', content: 'A line' }] }]);
  const page = await driver.openNewTab(extension);
  await extension.context.setOffline(true);
  const pip = await openPopOut(extension, page, 1);
  await expect.poll(() => extension.log(), 'the setup ran').toContain('set up the route again for a pop-out window from newtab.html');
  expect(await page.evaluate(() => navigator.onLine), 'the new tab is still offline after it').toBe(false);
  await expect.poll(() => pip.evaluate(() => Boolean(document.querySelector('link[rel="stylesheet"]').sheet)), "the pop-out's stylesheet still loads, from the extension").toBe(true);
  await pip.close().catch(() => {});
  await extension.context.setOffline(false);
});
