/**
 * #27 slice 3's lazy boundaries on the packaged build. The new tab starts with its boot root, the
 * loader, and the workspace chunk, and loads each vendored library at its first use: Chart.js at
 * the first Stats, Fuse.js at the first search, JSZip at the first Markdown export, and
 * transformers.js at the embedding model's first load. With a library's file gone, as a damaged
 * install or an update under an open page leaves it, each lands where a failure there landed
 * before (R1): Stats and search on "An unexpected error occurred", through App's path and never
 * an unhandled rejection; the export on "Export failed"; the model on its load failure. The
 * loader logs a line with the build, the library, and the reason, and typing still saves. A
 * build-info.json of another build reads as build-mismatch, and a workspace chunk that's gone
 * leaves the shell the page shows today, with the boot guard's line.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { test, expect, expectNoUncaught, resolveDist, chunkFile } = require('./harness');
const driver = require('./characterization/driver');

const LIBRARIES = ['js/lib/chart.js', 'js/lib/fuse.js', 'js/lib/jszip.min.js', 'js/lib/transformers.js'];

/**
 * Run `body` with a session on a copy of the build with `remove` taken out and `edit` applied, by
 * path in the build
 */
async function withChangedBuild(fixtures, testInfo, { remove = [], edit = {} }, body) {
  const dist = fs.mkdtempSync(path.join(os.tmpdir(), 'ntn-e2e-lazy-'));
  try {
    fs.cpSync(resolveDist(), dist, { recursive: true });
    for (const file of remove) {
      if (!fs.existsSync(path.join(dist, file))) throw new Error(`The build has no ${file} to take out; update the spec`);
      fs.rmSync(path.join(dist, file));
    }
    for (const [file, change] of Object.entries(edit)) {
      const target = path.join(dist, file);
      const before = fs.readFileSync(target, 'utf8');
      const after = change(before);
      if (after === before) throw new Error(`The edit to ${file} changed nothing; update the spec`);
      fs.writeFileSync(target, after);
    }
    await driver.withFreshProfile(fixtures, testInfo, (extension) => body(extension, dist), { dist });
  } finally {
    fs.rmSync(dist, { recursive: true, force: true });
  }
}

/** Every console line of the session's pages that starts with `prefix`, with its detail object */
function consoleLines(extension, prefix) {
  const lines = [];
  extension.context.on('console', async (message) => {
    if (!message.text().startsWith(prefix)) return;
    const values = await Promise.all(message.args().map((arg) => arg.jsonValue().catch(() => null)));
    lines.push({ text: values[0], detail: values[1] });
  });
  return lines;
}

/** The vendored library files the session's pages ask for, in order, each with its query */
function libraryRequests(extension) {
  const asked = [];
  extension.context.on('request', (request) => {
    const url = new URL(request.url());
    if (url.protocol === 'chrome-extension:' && url.pathname.startsWith('/js/lib/')) asked.push(`${url.pathname.slice(1)}${url.search}`);
  });
  return asked;
}

/** Wait until the start's deferred work has run: Stats bound, and the search's vectors read */
async function untilIdleWorkRan(page) {
  await expect.poll(() => page.evaluate(() => Boolean(app.graphView) && Array.isArray(app.searchEngine.vectors))).toBe(true);
}

async function openStats(page) {
  await page.locator('#sidebar-stats').click();
  await expect(page.locator('#stats-dashboard')).toBeVisible();
}

async function closeStats(page) {
  await page.locator('#stats-close-btn').click();
  await expect(page.locator('#editor-container')).toBeVisible();
}

/** Settings > Data & Backup > Export All (ZIP/MD) */
async function exportMarkdown(page) {
  const settings = await driver.openSettings(page, 'Data & Backup');
  await settings.getByRole('button', { name: 'Export All (ZIP/MD)' }).click();
}

/** Type into the first note, which is new and empty, and answer what its saved blocks hold */
async function typedAndSaved(page, line) {
  await driver.writeNote(page, { title: 'Typed after', lines: [line] });
  return driver.savedBlocks(page);
}

test('the new tab starts without the four vendored libraries, and loads each at its first use', async ({ extension }) => {
  const asked = libraryRequests(extension);
  await extension.seedOnboarded();
  const page = await driver.openNewTab(extension);
  await untilIdleWorkRan(page);
  expect(asked).toEqual([]);
  expect(await page.evaluate(() => [typeof Chart, typeof Fuse, typeof JSZip, typeof transformers])).toEqual(['undefined', 'undefined', 'undefined', 'undefined']);

  // Stats draws its four charts with Chart.js
  await openStats(page);
  await expect.poll(() => page.evaluate(() => Object.keys(app.analyticsController.charts).length)).toBe(4);
  await closeStats(page);
  expect(asked).toEqual(['js/lib/chart.js']);

  // A search builds its index with Fuse.js
  await driver.searchNotes(page, 'Untitled');
  await expect.poll(() => page.evaluate(() => typeof Fuse)).toBe('function');
  await expect.poll(() => page.evaluate(() => Boolean(app.searchEngine.fuse))).toBe(true);
  await driver.searchNotes(page, '');

  // The Markdown export zips with JSZip
  const download = page.waitForEvent('download');
  await exportMarkdown(page);
  expect((await download).suggestedFilename()).toMatch(/^new-tab-note-markdown-.*\.zip$/);
  await driver.closeSettings(page);

  expect(asked).toEqual(['js/lib/chart.js', 'js/lib/fuse.js', 'js/lib/jszip.min.js']);
  // Each loaded once: a second Stats asks for nothing
  await openStats(page);
  await closeStats(page);
  expect(asked).toHaveLength(3);
  await expectNoUncaught(extension, page);
});

test("the embedding model's first load loads transformers.js", async ({ extension }) => {
  const asked = libraryRequests(extension);
  await extension.seedOnboarded();
  const page = await driver.openNewTab(extension);
  await untilIdleWorkRan(page);
  expect(await page.evaluate(() => typeof transformers)).toBe('undefined');
  // The model itself can't load here, with the network off
  await page.evaluate(() => Embeddings.init());
  expect(await page.evaluate(() => typeof transformers)).toBe('object');
  expect(asked).toEqual(['js/lib/transformers.js']);
});

for (const { label, file, chunk, act, toast } of [
  { label: 'Stats', file: 'js/lib/chart.js', chunk: 'chart', act: openStats, toast: 'An unexpected error occurred' },
  { label: 'search', file: 'js/lib/fuse.js', chunk: 'fuse', act: (page) => driver.searchNotes(page, 'Untitled'), toast: 'An unexpected error occurred' },
  { label: 'the Markdown export', file: 'js/lib/jszip.min.js', chunk: 'jszip', act: exportMarkdown, toast: 'Export failed' },
]) {
  test(`${label} with ${file} gone shows "${toast}" as before, the loader logs why, and typing still saves`, async ({ playwright, headless }, testInfo) => {
    await withChangedBuild({ playwright, headless }, testInfo, { remove: [file] }, async (extension, dist) => {
      const { buildId } = JSON.parse(fs.readFileSync(path.join(dist, 'build-info.json'), 'utf8'));
      const lines = consoleLines(extension, 'NewTabNote loader:');
      const asked = libraryRequests(extension);
      await extension.seedOnboarded();
      const page = await driver.openNewTab(extension);
      await untilIdleWorkRan(page);
      await driver.recordToasts(page);
      await act(page);
      await expect.poll(() => page.evaluate(() => window.__ntnToasts.map(({ text }) => text))).toContain(toast);
      await expect.poll(() => lines.map(({ detail }) => detail)).toContainEqual({ buildId, chunk, reason: 'chunk-missing' });
      // The file, and the one retry, which the module map hasn't cached as failed
      expect(asked).toEqual([file, `${file}?r=1`]);
      // What the page shows is back where it was before the failure
      if (act === openStats) await closeStats(page);
      if (act === exportMarkdown) await driver.closeSettings(page);
      if (chunk === 'fuse') await driver.searchNotes(page, '');
      expect(await typedAndSaved(page, 'still typing')).toEqual(['still typing']);
      // Routed on purpose: no unhandled rejection reached the page
      await expectNoUncaught(extension, page);
    });
  });
}

test("the embedding model with js/lib/transformers.js gone fails its load as before, the loader logs why, and typing still saves", async ({ playwright, headless }, testInfo) => {
  await withChangedBuild({ playwright, headless }, testInfo, { remove: ['js/lib/transformers.js'] }, async (extension, dist) => {
    const { buildId } = JSON.parse(fs.readFileSync(path.join(dist, 'build-info.json'), 'utf8'));
    const lines = consoleLines(extension, 'NewTabNote loader:');
    const asked = libraryRequests(extension);
    const failures = consoleLines(extension, 'Embeddings: Failed to load model:');
    await extension.seedOnboarded();
    const page = await driver.openNewTab(extension);
    await untilIdleWorkRan(page);
    await driver.recordToasts(page);
    await page.evaluate(() => Embeddings.init());
    expect(await page.evaluate(() => [Embeddings.pipeline, Embeddings.isReady])).toEqual([null, false]);
    await expect.poll(() => lines.map(({ detail }) => detail)).toContainEqual({ buildId, chunk: 'transformers', reason: 'chunk-missing' });
    await expect.poll(() => failures.length).toBe(1);
    expect(asked).toEqual(['js/lib/transformers.js', 'js/lib/transformers.js?r=1']);
    expect(await page.evaluate(() => window.__ntnToasts)).toEqual([]);
    expect(await typedAndSaved(page, 'still typing')).toEqual(['still typing']);
    await expectNoUncaught(extension, page);
  });
});

test("a library gone under another build's build-info.json reads as build-mismatch, which still lands on Stats' toast", async ({ playwright, headless }, testInfo) => {
  const changes = {
    remove: ['js/lib/chart.js'],
    edit: { 'build-info.json': (text) => text.replace(/"buildId": "[^"]+"/, '"buildId": "an-update-under-the-page"') },
  };
  await withChangedBuild({ playwright, headless }, testInfo, changes, async (extension) => {
    const { buildId } = JSON.parse(fs.readFileSync(path.join(resolveDist(), 'build-info.json'), 'utf8'));
    const lines = consoleLines(extension, 'NewTabNote loader:');
    const asked = libraryRequests(extension);
    await extension.seedOnboarded();
    const page = await driver.openNewTab(extension);
    await untilIdleWorkRan(page);
    await driver.recordToasts(page);
    await openStats(page);
    await expect.poll(() => page.evaluate(() => window.__ntnToasts.map(({ text }) => text))).toContain('An unexpected error occurred');
    // The page's own build, which the build wrote into the loader, against the one on disk
    await expect.poll(() => lines.map(({ detail }) => detail)).toContainEqual({ buildId, chunk: 'chart', reason: 'build-mismatch' });
    // Under another build, the loader doesn't retry
    expect(asked).toEqual(['js/lib/chart.js']);
    await closeStats(page);
    expect(await typedAndSaved(page, 'still typing')).toEqual(['still typing']);
    await expectNoUncaught(extension, page);
  });
});

test('a new tab whose workspace chunk is gone keeps the shell it shows today, and the boot guard logs why', async ({ playwright, headless }, testInfo) => {
  const workspace = chunkFile(resolveDist(), 'workspace');
  await withChangedBuild({ playwright, headless }, testInfo, { remove: [workspace] }, async (extension, dist) => {
    const { buildId } = JSON.parse(fs.readFileSync(path.join(dist, 'build-info.json'), 'utf8'));
    const guard = consoleLines(extension, 'NewTabNote: the new tab did not start');
    const lines = consoleLines(extension, 'NewTabNote loader:');
    await extension.seedOnboarded();
    const page = await driver.openNewTab(extension, { wait: false });
    await expect.poll(() => guard.map(({ detail }) => detail)).toEqual([{ buildId, chunk: 'workspace', reason: 'chunk-missing' }]);
    await expect.poll(() => lines.map(({ detail }) => detail)).toEqual([{ buildId, chunk: 'workspace', reason: 'chunk-missing' }]);
    // No app, and no copy or element slice 3b adds: the page is the static shell
    expect(await page.evaluate(() => typeof window.app)).toBe('undefined');
    await expect(page.locator('#editor-container')).toBeAttached();
    await expect(page.getByText('Failed to initialize')).toHaveCount(0);
    await expect(page.getByText(/reinstall/i)).toHaveCount(0);
    await expectNoUncaught(extension, page);
  });
});

test('ships each vendored library at its own path, which the loader names, and no page loads one with a script tag', async () => {
  const dist = resolveDist();
  for (const file of LIBRARIES) expect(fs.existsSync(path.join(dist, file)), file).toBe(true);
  const loader = fs.readFileSync(path.join(dist, 'js/runtime/lazy.js'), 'utf8');
  for (const file of LIBRARIES) expect(loader).toContain(file);
  const newtab = fs.readFileSync(path.join(dist, 'newtab.html'), 'utf8');
  for (const file of LIBRARIES) expect(newtab).not.toContain(file);
  const { buildId } = JSON.parse(fs.readFileSync(path.join(dist, 'build-info.json'), 'utf8'));
  expect(loader).toContain(buildId);
});
