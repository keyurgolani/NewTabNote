/**
 * NTN-21 on the built extension: the AI features run only when Settings says they do. Settings
 * shows the stored AI settings each time it opens, without a request or a write, and saves each
 * background job's switch and interval as the user changes them. A first run leaves both jobs
 * off. An install that ran an earlier version has both turned off once, at its first start,
 * before either can run, however many new tabs open at once, and a job the user turns back on
 * stays on. A profile whose switch-off already ran keeps its jobs as stored. The key is a test
 * value, and the harness refuses every request that leaves the extension; the specs only record
 * them. Each test also fails on an uncaught exception that test/known-defects.json doesn't list.
 * The Insights tab's rule is test/smart-tab.test.js's, and a job's stop in every tab
 * test/job-switches.test.js's and settings-session.spec.js's.
 */

const { test, expect, expectNoUncaught } = require('./harness');
const driver = require('./characterization/driver');

const KEY = 'sk-test';
const CONFIGURED = { llmProvider: 'openai', llmApiKey: KEY, llmApiKeyProvider: 'openai', llmModel: 'gpt-4o-mini' };
/** Both jobs on, as a user turns them on in Settings after their one-time switch-off */
const CHOSEN_ON = {
  backgroundJobsOffOnce: true, autoTitleEnabled: true, autoTitleInterval: 30, insightsEnabled: true, insightsInterval: 720,
};
/**
 * Settings as an earlier version's first run left them, with a provider set up since: both jobs
 * on, and each last run two days back, so each job has a catch-up due at the next start
 */
const TWO_DAYS_AGO = Date.now() - 2 * 24 * 60 * 60 * 1000;
const EARLIER = {
  ...CONFIGURED, autoTitleEnabled: true, autoTitleInterval: 15, insightsEnabled: true, insightsInterval: 360,
  lastAutoTitleRun: TWO_DAYS_AGO, lastInsightsRun: TWO_DAYS_AGO,
};
/** An untitled note long enough for both jobs to pick up */
const UNTITLED_NOTE = { name: 'Untitled', blocks: [{ type: 'text', content: 'Ship the beta to testers on Friday, then read every reply before the next build.' }] };

/** Store `settings` before the first new tab opens, as an earlier session left them */
async function storeSettings(extension, settings) {
  const local = { setting_storageInitialized: true };
  for (const [key, value] of Object.entries(settings)) local[`setting_${key}`] = value;
  await extension.worker.evaluate(items => chrome.storage.local.set(items), local);
}

/** The stored values of `keys` */
async function storedSettings(extension, keys) {
  const items = await extension.worker.evaluate(names => chrome.storage.local.get(names), keys.map(key => `setting_${key}`));
  return Object.fromEntries(keys.map(key => [key, items[`setting_${key}`]]));
}

/**
 * Wait until the start's deferred work has run and chrome.storage.local has had no change
 * for half a second, so the background jobs' first runs are done
 */
async function startSettled(page) {
  await page.evaluate(() => new Promise(resolve => requestIdleCallback(() => resolve(), { timeout: 2000 })));
  await page.evaluate(() => new Promise(resolve => {
    let timer = null;
    const done = () => {
      chrome.storage.onChanged.removeListener(restart);
      resolve();
    };
    const restart = () => {
      clearTimeout(timer);
      timer = setTimeout(done, 500);
    };
    chrome.storage.onChanged.addListener(restart);
    restart();
  }));
}

/**
 * Record, from now until stop(), each request that leaves the extension, from any page or the
 * worker; the harness still refuses it
 */
async function recordRequests(extension) {
  const requests = [];
  const record = route => {
    const request = route.request();
    if (!request.url().startsWith('chrome-extension://')) requests.push(`${request.method()} ${request.url()}`);
    return route.fallback();
  };
  await extension.context.route('**/*', record);
  return {
    async stop() {
      await extension.context.unroute('**/*', record);
      return requests.slice();
    },
  };
}

/** The requests that went to the provider */
const toProvider = requests => requests.filter(line => line.includes('https://api.openai.com/'));

/**
 * Record, from now until stop(), each request that leaves the extension (the harness still
 * refuses it), each chrome.storage.local key written, and each IndexedDB write: the page's own
 * writes at the call, so a write that leaves a value as it was counts too, and every other
 * context's chrome.storage writes through chrome.storage.onChanged
 */
async function watchTraffic(extension, page) {
  const requests = [];
  const record = route => {
    const request = route.request();
    if (!request.url().startsWith('chrome-extension://')) requests.push(`${request.method()} ${request.url()}`);
    return route.fallback();
  };
  await extension.context.route('**/*', record);
  await page.evaluate(() => {
    window.__ntnWrites = [];
    const local = chrome.storage.local;
    for (const method of ['set', 'remove', 'clear']) {
      const write = local[method].bind(local);
      local[method] = (...args) => {
        const keys = method === 'set' ? Object.keys(args[0] || {}) : method === 'remove' ? [].concat(args[0]) : ['(clear)'];
        window.__ntnWrites.push(...keys);
        return write(...args);
      };
    }
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === 'local') window.__ntnWrites.push(...Object.keys(changes));
    });
    for (const method of ['put', 'add', 'delete', 'clear']) {
      const write = IDBObjectStore.prototype[method];
      IDBObjectStore.prototype[method] = function recorded(...args) {
        window.__ntnWrites.push(`IndexedDB ${this.name} ${method}`);
        return write.apply(this, args);
      };
    }
  });
  return {
    async stop() {
      await extension.context.unroute('**/*', record);
      return { requests: requests.slice(), writes: await page.evaluate(() => window.__ntnWrites) };
    },
  };
}

test('Settings shows the stored AI settings after a reload, and opening it sends and writes nothing', async ({ extension }) => {
  await extension.seedOnboarded();
  await storeSettings(extension, { ...CONFIGURED, ...CHOSEN_ON });
  const page = await driver.openNewTab(extension);
  await driver.reload(page);
  await startSettled(page);

  const traffic = await watchTraffic(extension, page);
  const settings = await driver.openSettings(page, 'AI Configuration');
  await expect(settings.locator('#llm-provider-select')).toHaveValue('openai');
  await expect(settings.locator('#llm-api-key')).toHaveValue(KEY);
  await expect(settings.locator('#llm-api-key')).toHaveAttribute('type', 'password');
  await expect(settings.locator('#llm-model-select')).toHaveValue('gpt-4o-mini');
  await expect(settings.locator('#auto-title-enabled')).toBeChecked();
  await expect(settings.locator('#auto-title-interval')).toHaveValue('30');
  await expect(settings.locator('#insights-enabled')).toBeChecked();
  await expect(settings.locator('#insights-interval')).toHaveValue('720');
  await expect(settings.locator('.setting-row.llm-api-key-row')).toBeVisible();
  await expect(settings.locator('.llm-model-row')).toBeVisible();
  await expect(settings.locator('.llm-ollama-url-row')).toBeHidden();
  await expect(settings.locator('.llm-auto-title-interval-row')).toBeVisible();
  await expect(settings.locator('.llm-insights-interval-row')).toBeVisible();
  expect(await traffic.stop(), 'what opening Settings sent and wrote').toEqual({ requests: [], writes: [] });
  await expectNoUncaught(extension, page);
});

test("Settings saves a background job's switch and interval as the user changes them", async ({ extension }) => {
  await extension.seedOnboarded();
  await storeSettings(extension, { ...CONFIGURED, ...CHOSEN_ON });
  const page = await driver.openNewTab(extension);
  const settings = await driver.openSettings(page, 'AI Configuration');

  await expect(settings.locator('.llm-auto-title-row'), 'the titles switch shows').toBeVisible();
  await settings.locator('.llm-auto-title-row .toggle-switch').click();
  await expect.poll(() => storedSettings(extension, ['autoTitleEnabled'])).toEqual({ autoTitleEnabled: false });
  await settings.locator('#insights-interval').selectOption('60');
  await expect.poll(() => storedSettings(extension, ['insightsInterval'])).toEqual({ insightsInterval: 60 });
  expect(await storedSettings(extension, ['insightsEnabled', 'autoTitleInterval'])).toEqual({ insightsEnabled: true, autoTitleInterval: 30 });
  await expectNoUncaught(extension, page);
});

test('a first run leaves both background jobs off, with their one-time switch-off marked as done', async ({ extension }) => {
  const page = await driver.openNewTab(extension, { wait: false });
  await driver.skipOnboarding(page);
  expect(await storedSettings(extension, ['autoTitleEnabled', 'insightsEnabled', 'backgroundJobsOffOnce']))
    .toEqual({ autoTitleEnabled: false, insightsEnabled: false, backgroundJobsOffOnce: true });
  await expectNoUncaught(extension, page);
});

test('an install that ran an earlier version has both background jobs turned off at its first start, with no request to the provider', async ({ extension }) => {
  await extension.seedOnboarded();
  await storeSettings(extension, EARLIER);
  await driver.seedNotes(extension, [UNTITLED_NOTE]);
  const requests = await recordRequests(extension);
  const page = await driver.openNewTab(extension);
  await startSettled(page);

  expect(await storedSettings(extension, ['autoTitleEnabled', 'insightsEnabled', 'backgroundJobsOffOnce']))
    .toEqual({ autoTitleEnabled: false, insightsEnabled: false, backgroundJobsOffOnce: true });
  expect(toProvider(await requests.stop()), 'requests to the provider').toEqual([]);
  const settings = await driver.openSettings(page, 'AI Configuration');
  await expect(settings.locator('#auto-title-enabled')).not.toBeChecked();
  await expect(settings.locator('#insights-enabled')).not.toBeChecked();
  await expectNoUncaught(extension, page);
});

test('an install that ran an earlier version, opened in three new tabs at once, sends nothing to the provider', async ({ extension }) => {
  await extension.seedOnboarded();
  await storeSettings(extension, EARLIER);
  await driver.seedNotes(extension, [UNTITLED_NOTE]);
  const requests = await recordRequests(extension);
  await driver.trackStartup(extension);
  const pages = await Promise.all([0, 1, 2].map(() => extension.openSurface('newtab')));
  await Promise.all(pages.map(page => driver.waitForApp(page)));
  for (const page of pages) await startSettled(page);

  expect(toProvider(await requests.stop()), 'requests to the provider from any tab').toEqual([]);
  expect(await storedSettings(extension, ['autoTitleEnabled', 'insightsEnabled', 'backgroundJobsOffOnce']))
    .toEqual({ autoTitleEnabled: false, insightsEnabled: false, backgroundJobsOffOnce: true });
  for (const page of pages) {
    expect(await page.evaluate(() => [app.notesManager.autoTitleIntervalId, app.notesManager.insightsIntervalId]), 'no job timer')
      .toEqual([null, null]);
    await expectNoUncaught(extension, page);
  }
});

test('a background job turned back on after the one-time switch-off stays on at later starts', async ({ extension }) => {
  await extension.seedOnboarded();
  await storeSettings(extension, EARLIER);
  const page = await driver.openNewTab(extension);
  await startSettled(page);
  expect(await storedSettings(extension, ['autoTitleEnabled', 'insightsEnabled'])).toEqual({ autoTitleEnabled: false, insightsEnabled: false });

  const settings = await driver.openSettings(page, 'AI Configuration');
  await settings.locator('.llm-auto-title-row .toggle-switch').click();
  await expect.poll(() => storedSettings(extension, ['autoTitleEnabled'])).toEqual({ autoTitleEnabled: true });
  for (const start of ['the next start', 'the start after']) {
    await driver.reload(page);
    await startSettled(page);
    expect(await storedSettings(extension, ['autoTitleEnabled', 'insightsEnabled']), start).toEqual({ autoTitleEnabled: true, insightsEnabled: false });
  }
  await expectNoUncaught(extension, page);
});

test('a profile whose one-time switch-off already ran keeps both background jobs as stored', async ({ extension }) => {
  await extension.seedOnboarded();
  // As 1.4.4 leaves a profile whose user turned titles back on after its switch-off
  await storeSettings(extension, { ...EARLIER, insightsEnabled: false, backgroundJobsOffOnce: true });
  const page = await driver.openNewTab(extension);
  await startSettled(page);

  expect(await storedSettings(extension, ['autoTitleEnabled', 'insightsEnabled', 'backgroundJobsOffOnce']))
    .toEqual({ autoTitleEnabled: true, insightsEnabled: false, backgroundJobsOffOnce: true });
  // Titles' catch-up runs first, then its timer starts; insights never does
  await expect.poll(() => page.evaluate(() => [app.notesManager.autoTitleIntervalId !== null, app.notesManager.insightsIntervalId !== null]))
    .toEqual([true, false]);
  await expectNoUncaught(extension, page);
});
