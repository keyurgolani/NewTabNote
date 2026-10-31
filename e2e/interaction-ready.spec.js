/**
 * #27's interaction-ready mark (js/app.js): `performance.mark('ntn:interaction-ready')`, once,
 * when the first note on any App.init path has loaded, or, when there's no note to load (only
 * archived notes), once the start has updated its empty state. `npm run perf:probe` reads it. An init script records what the page
 * showed at the moment of the mark, since the mark itself carries nothing.
 */

const fs = require('fs');
const path = require('path');
const { test, expect, expectNoUncaught } = require('./harness');
const { fixtureHost } = require('./harness/fixture-host');

const MARK = 'ntn:interaction-ready';
const WELCOME = 'Welcome to NewTabNote 🚀';
const RECORDED = path.join(__dirname, '..', 'test', 'fixtures', 'storage', 'recorded', 'v8.v1.4.0.json');

/** What 1.4.0 wrote for a synthetic seed: eight notes, the welcome note last opened */
const recorded = () => JSON.parse(fs.readFileSync(RECORDED, 'utf8'));

/**
 * Runs in every page before its scripts: each call of performance.mark with the mark's name
 * records the note title, the rendered blocks, and whether the empty state shows
 */
function recordMarks(name) {
  const mark = performance.mark.bind(performance);
  window.__ntnMarks = [];
  performance.mark = (markName, options) => {
    if (markName === name) {
      const title = document.getElementById('page-title');
      const empty = document.getElementById('empty-state');
      window.__ntnMarks.push({
        title: title ? title.textContent : null,
        blocks: document.querySelectorAll('#blocks-container .block').length,
        emptyState: Boolean(empty && !empty.classList.contains('hidden')),
      });
    }
    return mark(markName, options);
  };
}

/**
 * The page's marks: what it showed at each call, and the entries performance holds
 */
async function marksOn(page) {
  return page.evaluate(name => ({
    seen: window.__ntnMarks,
    entries: performance.getEntriesByName(name, 'mark').length,
  }), MARK);
}

/**
 * Loads `fixture` into the extension before its first page opens, onboarded
 */
async function seed(extension, fixture) {
  await fixtureHost(extension.worker).loadFixture(fixture);
  await extension.seedOnboarded();
}

test.beforeEach(async ({ extension }) => {
  await extension.context.addInitScript(recordMarks, MARK);
});

test('first run: marks once the welcome note loads, while the walkthrough still shows', async ({ extension }) => {
  const page = await extension.openSurface('newtab');
  await expect(page.locator('#page-title')).toHaveText(WELCOME);
  await expect(page.getByRole('dialog', { name: 'Onboarding walkthrough' })).toBeVisible();
  await expect.poll(async () => (await marksOn(page)).entries).toBe(1);
  const { seen } = await marksOn(page);
  expect(seen).toHaveLength(1);
  expect(seen[0].title).toBe(WELCOME);
  expect(seen[0].blocks).toBeGreaterThan(0);
  await expectNoUncaught(extension, page);
});

test('onboarded with no notes: marks once its first note loads', async ({ extension }) => {
  await extension.seedOnboarded();
  const page = await extension.openSurface('newtab');
  await expect(page.locator('#page-title')).toHaveText('Untitled');
  await expect.poll(async () => (await marksOn(page)).entries).toBe(1);
  const { seen } = await marksOn(page);
  expect(seen).toEqual([{ title: 'Untitled', blocks: expect.any(Number), emptyState: false }]);
  expect(seen[0].blocks).toBeGreaterThan(0);
  await expectNoUncaught(extension, page);
});

test('a restored tab: marks once the last-opened note loads, and never again', async ({ extension }) => {
  await seed(extension, recorded());
  const page = await extension.openSurface('newtab');
  await expect(page.locator('#page-title')).toHaveText(WELCOME);
  await expect.poll(async () => (await marksOn(page)).entries).toBe(1);
  expect((await marksOn(page)).seen).toEqual([{ title: WELCOME, blocks: expect.any(Number), emptyState: false }]);
  // Another note opens from the sidebar, after the start
  const other = page.locator('.sidebar-note-item').filter({ hasNotText: WELCOME }).first();
  const name = (await other.innerText()).split('\n')[0].trim();
  await other.click();
  await expect(page.locator('#page-title')).not.toHaveText(WELCOME);
  expect(name).not.toBe('');
  expect(await marksOn(page)).toEqual({ seen: [expect.objectContaining({ title: WELCOME })], entries: 1 });
  await expectNoUncaught(extension, page);
});

test('no last-opened note: marks once the first listed note loads', async ({ extension }) => {
  const fixture = recorded();
  for (const key of ['lastOpenedNoteId', 'setting_openTabs', 'setting_activeTabIndex']) delete fixture.chromeStorageLocal[key];
  await seed(extension, fixture);
  const page = await extension.openSurface('newtab');
  await expect.poll(async () => (await marksOn(page)).entries).toBe(1);
  const shown = await page.locator('#page-title').textContent();
  const { seen } = await marksOn(page);
  expect(seen).toEqual([{ title: shown, blocks: expect.any(Number), emptyState: false }]);
  expect(seen[0].title).not.toBe('');
  await expectNoUncaught(extension, page);
});

test('only archived notes: marks after the start updates its empty state, with no note loaded', async ({ extension }) => {
  const fixture = recorded();
  const canvases = fixture.databases[0].stores.find(store => store.name === 'canvases');
  canvases.records = canvases.records.filter(record => record.value.archived === true && record.value.trashed !== true);
  expect(canvases.records).toHaveLength(1);
  for (const key of ['lastOpenedNoteId', 'setting_openTabs', 'setting_activeTabIndex']) delete fixture.chromeStorageLocal[key];
  await seed(extension, fixture);
  const page = await extension.openSurface('newtab');
  await expect(page.getByRole('tab', { name: 'Archive 1' })).toBeVisible();
  await expect.poll(async () => (await marksOn(page)).entries).toBe(1);
  const { seen } = await marksOn(page);
  expect(seen).toHaveLength(1);
  expect(seen[0].blocks).toBe(0);
  await expectNoUncaught(extension, page);
});
