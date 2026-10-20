/**
 * Self-tests for the harness. Each launches the build, or a copy of it edited in a temp dir
 * outside the repo, and checks that the harness sees what it has to.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { test, expect, launchExtension, resolveDist } = require('./harness');

/**
 * Copy the build to a temp dir and edit it: `edits` maps each file to a function from its
 * text (empty for a new file) to the text to write
 */
function editedBuild(edits) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ntn-e2e-edited-'));
  fs.cpSync(resolveDist(), dir, { recursive: true });
  for (const [file, edit] of Object.entries(edits)) {
    const target = path.join(dir, file);
    fs.writeFileSync(target, edit(fs.existsSync(target) ? fs.readFileSync(target, 'utf8') : ''));
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

// A listener the edited workers below register; a message from a page makes it throw
const THROWING_LISTENER = `
chrome.runtime.onMessage.addListener(message => {
  if (message === 'ntn-self-test') throw new Error('self-test: startup listener');
});
`;

for (const [title, edits, thrown] of [
  ['throws at the top level', { 'js/background.js': text => `${text}\nthrow new Error('self-test: background.js throws');\n` }, 'self-test: background.js throws'],
  // background.js catches what importScripts throws, then its Storage.init() call throws
  ['loses storage.js', { 'js/storage.js': text => `if (typeof window === 'undefined') throw new Error('self-test: storage.js throws');\n${text}` }, 'Storage is not defined'],
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

test('still sees what the worker throws after it restarts, and fails while it is stopped', async ({ extension }) => {
  const page = await extension.openSurface('popup');
  const instance = () => extension.worker.evaluate(() => self.__ntnHarness.instance);
  const before = await instance();

  const cdp = await extension.context.newCDPSession(page);
  await cdp.send('ServiceWorker.enable');
  await cdp.send('ServiceWorker.stopAllWorkers');
  await expect(extension.uncaught()).rejects.toThrow('may be stopped');

  // A message wakes the worker, and background.js answers PING
  expect(await page.evaluate(() => chrome.runtime.sendMessage({ type: 'PING' }))).toEqual({ status: 'ok' });
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
