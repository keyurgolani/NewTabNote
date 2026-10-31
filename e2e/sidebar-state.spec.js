/**
 * Stats and Graph hide both sidebars while they show, and closing them puts the sidebars back as
 * the user left them; the palette's Show and Hide labels say what the sidebars show. 1.4.x read
 * both from App's copy of the sidebars' state. For the AI sidebar only App's own toggles (the
 * shortcut and the palette) kept that copy up, and for the sidebar another tab's toggle set it:
 * closing Stats or Graph left hidden the AI sidebar the user had opened with its floating
 * button, or this tab's sidebar after another tab closed its own, and the palette offered the
 * opposite of what was on screen. #12 slice 7b reads the sidebars' own state, a declared fix.
 * Another tab's sidebar toggle still leaves this tab's sidebar as it is, as in 1.4.x. Each test
 * also fails on an uncaught exception test/known-defects.json doesn't list.
 */

const { test, expect, expectNoUncaught } = require('./harness');
const driver = require('./characterization/driver');

/** Open the palette, and the titles of its two sidebar commands, the sidebar's first */
async function sidebarCommands(page) {
  await page.keyboard.press('ControlOrMeta+Shift+KeyA');
  await expect(page.locator('#command-palette-modal')).toBeVisible();
  return page.locator('#command-palette-results .command-palette-item-title').filter({ hasText: /^(Show|Hide) (AI )?Sidebar$/ });
}

/**
 * Two new tabs, `page` and `other`, with `other`'s sidebar closed by its own button once `page`
 * has heard of it: `page` hears of chrome.storage changes after its own listeners, App's among
 * them, have
 */
async function otherTabClosedItsSidebar(extension) {
  const page = await driver.openNewTab(extension);
  const other = await driver.openNewTab(extension);
  await page.evaluate(() => {
    window.__ntnHeard = [];
    chrome.storage.onChanged.addListener(changes => window.__ntnHeard.push(...Object.keys(changes)));
  });
  await other.locator('#sidebar-toggle').click();
  await expect(other.locator('#sidebar')).toHaveClass(/\bcollapsed\b/);
  await expect.poll(() => page.evaluate(() => window.__ntnHeard)).toContain('setting_sidebarOpen');
  await page.bringToFront();
  return page;
}

for (const [view, open, back] of [
  ['Stats', '#sidebar-stats', '#stats-close-btn'],
  ['Graph', '#sidebar-graph', '#graph-close-btn'],
]) {
  test(`closing ${view} puts back the sidebars as the user left them`, async ({ extension }) => {
    await extension.seedOnboarded();
    const page = await otherTabClosedItsSidebar(extension);
    // Stats and Graph start once the tab is idle, Graph last
    await expect.poll(() => page.evaluate(() => Boolean(app.graphView))).toBe(true);
    const sidebar = page.locator('#sidebar');
    const aiSidebar = page.locator('#ai-sidebar');
    // This tab's sidebar stays open, and its AI sidebar opens with the floating button
    await expect(sidebar).not.toHaveClass(/\bcollapsed\b/);
    await page.locator('#ai-floating-btn').click();
    await expect(aiSidebar).toBeVisible();

    await page.locator(open).click();
    await expect(sidebar).toBeHidden();
    await expect(aiSidebar).toBeHidden();
    await page.locator(back).click();
    await expect(page.locator('#editor-container')).toBeVisible();
    await expect(sidebar).toBeVisible();
    await expect(sidebar).not.toHaveClass(/\bcollapsed\b/);
    await expect(aiSidebar).toBeVisible();
    await expectNoUncaught(extension, page);
  });
}

test("the palette's Show and Hide labels say what the sidebars show, whichever button changed them", async ({ extension }) => {
  await extension.seedOnboarded();
  const page = await driver.openNewTab(extension);
  await expect(await sidebarCommands(page)).toHaveText(['Hide Sidebar', 'Show AI Sidebar']);
  await page.keyboard.press('Escape');

  // Each sidebar's own button: the sidebar closes and the AI sidebar opens
  await page.locator('#sidebar-toggle').click();
  await expect(page.locator('#sidebar')).toHaveClass(/\bcollapsed\b/);
  await page.locator('#ai-floating-btn').click();
  await expect(page.locator('#ai-sidebar')).toBeVisible();
  await expect(await sidebarCommands(page)).toHaveText(['Show Sidebar', 'Hide AI Sidebar']);
  await page.keyboard.press('Escape');
  await expectNoUncaught(extension, page);
});

test("another tab's sidebar toggle leaves this tab's sidebar, and its palette label, as they are", async ({ extension }) => {
  await extension.seedOnboarded();
  const page = await otherTabClosedItsSidebar(extension);
  await expect(page.locator('#sidebar')).not.toHaveClass(/\bcollapsed\b/);
  await expect(await sidebarCommands(page)).toHaveText(['Hide Sidebar', 'Show AI Sidebar']);
  await page.keyboard.press('Escape');
  await expectNoUncaught(extension, page);
});
