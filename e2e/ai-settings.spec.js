/**
 * NTN-21 on the built extension: the AI features run only when Settings and the AI sidebar
 * say they do. Settings shows the stored AI settings each time it opens, without a request or
 * a write, and saves each background job's switch and interval as the user changes them. A
 * first run leaves both jobs off, and a later start keeps them as stored. The sidebar's
 * Insights tab reads the note only while the sidebar is open. The key is a test value, and
 * the harness refuses every request that leaves the extension; the specs only record them.
 * Each test also fails on an uncaught exception that test/known-defects.json doesn't list.
 */

const { test, expect, expectNoUncaught } = require('./harness');
const driver = require('./characterization/driver');

const KEY = 'sk-test';
const CONFIGURED = { llmProvider: 'openai', llmApiKey: KEY, llmModel: 'gpt-4o-mini' };

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
 * Record, from now until stop(), each request that leaves the extension (the harness still
 * refuses it) and each chrome.storage.local key written
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
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === 'local') window.__ntnWrites.push(...Object.keys(changes));
    });
  });
  return {
    requests,
    async stop() {
      await extension.context.unroute('**/*', record);
      return { requests: requests.slice(), writes: await page.evaluate(() => window.__ntnWrites) };
    },
  };
}

test('Settings shows the stored AI settings after a reload, and opening it sends and writes nothing', async ({ extension }) => {
  await extension.seedOnboarded();
  await storeSettings(extension, {
    ...CONFIGURED, autoTitleEnabled: true, autoTitleInterval: 30, insightsEnabled: true, insightsInterval: 720,
  });
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
  await storeSettings(extension, {
    ...CONFIGURED, autoTitleEnabled: true, autoTitleInterval: 30, insightsEnabled: true, insightsInterval: 720,
  });
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

test('a first run leaves both background jobs off', async ({ extension }) => {
  const page = await driver.openNewTab(extension, { wait: false });
  await driver.skipOnboarding(page);
  expect(await storedSettings(extension, ['autoTitleEnabled', 'insightsEnabled'])).toEqual({ autoTitleEnabled: false, insightsEnabled: false });
  await expectNoUncaught(extension, page);
});

test('a later start keeps both background jobs as they were stored', async ({ extension }) => {
  await extension.seedOnboarded();
  await storeSettings(extension, { autoTitleEnabled: true, insightsEnabled: false });
  const page = await driver.openNewTab(extension);
  await driver.reload(page);
  await startSettled(page);
  expect(await storedSettings(extension, ['autoTitleEnabled', 'insightsEnabled'])).toEqual({ autoTitleEnabled: true, insightsEnabled: false });
  await expectNoUncaught(extension, page);
});

test("the AI sidebar's Insights tab reads the note only while the sidebar is open", async ({ extension }) => {
  test.setTimeout(60_000);
  await extension.seedOnboarded();
  await storeSettings(extension, CONFIGURED);
  await driver.seedNotes(extension, [{ name: 'Launch', blocks: [{ type: 'text', content: 'Ship the beta to testers on Friday, then read every reply.' }] }]);
  const page = await driver.openNewTab(extension);
  await driver.openNote(page, 'Launch');
  const toProvider = traffic => traffic.requests.filter(line => line.includes('https://api.openai.com/')).length;

  // Showing the tab reads the note at once
  let traffic = await watchTraffic(extension, page);
  await page.locator('#ai-floating-btn').click();
  await page.locator('#ai-tab-smart').click();
  await expect.poll(() => toProvider(traffic), 'showing the Insights tab reads the note').toBeGreaterThan(0);
  await traffic.stop();

  // With the sidebar closed, an edit sends nothing. Nothing marks a request that never
  // starts, so the test waits past the edit's 2-second delay before it looks
  await page.locator('#ai-sidebar-close').click();
  traffic = await watchTraffic(extension, page);
  await driver.clickBlock(page, 0);
  await page.keyboard.press('End');
  await page.keyboard.type(' Then plan the next one.');
  await page.waitForTimeout(3500);
  expect(toProvider(await traffic.stop()), 'requests to the provider after an edit with the sidebar closed').toBe(0);

  // Open again on the same tab, an edit reads the note
  traffic = await watchTraffic(extension, page);
  await page.locator('#ai-floating-btn').click();
  await driver.clickBlock(page, 0);
  await page.keyboard.press('End');
  await page.keyboard.type(' And thank the testers.');
  await expect.poll(() => toProvider(traffic), 'an edit with the sidebar open on the tab reads the note').toBeGreaterThan(0);
  await traffic.stop();
  await expectNoUncaught(extension, page);
});
