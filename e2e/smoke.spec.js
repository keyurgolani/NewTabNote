/**
 * Smoke: each extension page loads on a fresh profile and its root renders. Each test
 * fails on an uncaught exception, in a page or the service worker, that no entry in
 * test/known-defects.json lists under `uncaught`, and the last test fails when a listed
 * message never occurred.
 */

const { test, expect } = require('./harness');
const { toleratedUncaught } = require('./harness/known-defects');

// Message -> ids of the ledger entries that list it
const TOLERATED = toleratedUncaught();
const SMOKE_TITLES = [];
const passed = new Set();
const observed = new Set();

// One worker runs these in order, so the last test sees what the others observed, and a
// retry reruns all of them
test.describe.configure({ mode: 'serial' });

/**
 * A smoke test: `body` opens a surface, checks its root, and returns its page
 */
function smoke(title, body) {
  SMOKE_TITLES.push(title);
  test(title, async ({ extension }) => {
    const page = await body(extension);
    // Startup work the page deferred to an idle callback runs before errors are read
    await page.evaluate(() => new Promise(resolve => requestIdleCallback(() => resolve(), { timeout: 2000 })));

    const uncaught = extension.uncaught();
    uncaught.forEach(({ message }) => observed.add(message));
    const unexpected = uncaught.filter(({ message }) => !TOLERATED.has(message));
    expect(
      unexpected.map(({ source, message, stack }) => `${source}: ${stack || message}`),
      'uncaught exceptions that no test/known-defects.json entry lists under `uncaught`',
    ).toEqual([]);
    passed.add(title);
  });
}

smoke('new tab, first run: shows the welcome note and the walkthrough', async extension => {
  const page = await extension.openSurface('newtab');
  await expect(page.locator('#page-title')).toHaveText('Welcome to NewTabNote 🚀');
  await expect(page.getByRole('dialog', { name: 'Onboarding walkthrough' })).toBeVisible();
  return page;
});

smoke('new tab, onboarded: opens an untitled note', async extension => {
  await extension.seedOnboarded();
  const page = await extension.openSurface('newtab');
  await expect(page.locator('#page-title')).toHaveText('Untitled');
  await expect(page.locator('#blocks-container .block').first()).toBeVisible();
  await expect(page.getByRole('dialog', { name: 'Onboarding walkthrough' })).toHaveCount(0);
  return page;
});

smoke('popup: shows the quick note input and an empty recent list', async extension => {
  await extension.seedOnboarded();
  const page = await extension.openSurface('popup');
  await expect(page.getByRole('textbox', { name: 'Quick note input' })).toBeVisible();
  await expect(page.locator('#page-list')).toHaveText('No notes yet');
  return page;
});

smoke('side panel: shows its empty state', async extension => {
  await extension.seedOnboarded();
  const page = await extension.openSurface('sidepanel');
  await expect(page.getByRole('heading', { name: 'No intelligence yet' })).toBeVisible();
  return page;
});

test('every uncaught message the ledger tolerates occurred', () => {
  const notRun = SMOKE_TITLES.filter(title => !passed.has(title));
  test.skip(notRun.length > 0, `checks only after every smoke test passed in this run; missing: ${notRun.join('; ')}`);

  const missing = [...TOLERATED].filter(([message]) => !observed.has(message)).map(([message, ids]) => `${ids.join(', ')}: ${message}`);
  expect(missing, 'listed under `uncaught` in test/known-defects.json but not thrown during smoke; remove them').toEqual([]);
});
