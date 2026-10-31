/**
 * #12 slice 6 in the built extension: preferences, a custom theme, the workspace session, the
 * auto-title and insights switches, onboarding, and auto-backup go through the settings port,
 * under the chrome.storage.local keys 1.4.x used, and a setting still reaches the other open
 * new tabs. Each test also fails on an uncaught exception test/known-defects.json doesn't list.
 */

const { test, expect, expectNoUncaught } = require('./harness');
const driver = require('./characterization/driver');

/** What chrome.storage.local holds under `keys` */
function stored(page, keys) {
  return page.evaluate(names => chrome.storage.local.get(names), keys);
}

/** Drag the sidebar's resize handle `dx` pixels */
async function dragSidebar(page, dx) {
  const handle = page.locator('#sidebar-resize-handle');
  const box = await handle.boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + dx, box.y + box.height / 2, { steps: 5 });
  await page.mouse.up();
}

test('a font, a width, and a sidebar width persist across a reload, and a font reaches the other tab', async ({ extension }) => {
  await extension.seedOnboarded();
  const first = await driver.openNewTab(extension);
  const second = await driver.openNewTab(extension);
  await driver.markPage(second);
  await first.bringToFront();

  const settings = await driver.openSettings(first, 'Appearance');
  await settings.locator('#font-select').selectOption('serif');
  await settings.getByRole('navigation', { name: 'Settings categories' }).getByRole('button', { name: 'Editor' }).click();
  await settings.locator('#width-select').selectOption('wide');
  await driver.closeSettings(first);
  await dragSidebar(first, 60);

  await expect.poll(() => stored(first, ['setting_font', 'setting_width'])).toEqual({ setting_font: 'serif', setting_width: 'wide' });
  await expect.poll(async () => (await stored(first, ['setting_sidebarWidth'])).setting_sidebarWidth).toBeGreaterThan(260);
  const { setting_sidebarWidth: width } = await stored(first, ['setting_sidebarWidth']);
  await expect.poll(() => second.evaluate(() => document.documentElement.dataset.font)).toBe('serif');
  expect(await driver.wasReloaded(second), 'the other tab reloaded').toBe(false);

  await driver.reload(first);
  expect(await first.evaluate(() => [document.documentElement.dataset.font, document.documentElement.dataset.width]))
    .toEqual(['serif', 'wide']);
  expect(await first.evaluate(() => document.getElementById('sidebar').style.width)).toBe(`${width}px`);
  await expectNoUncaught(extension, first);
});

test('a theme saved in the Theme Builder applies, and comes back after a reload', async ({ extension }) => {
  await extension.seedOnboarded();
  const page = await driver.openNewTab(extension);
  const settings = await driver.openSettings(page, 'Appearance');
  await settings.locator('#open-theme-builder-btn').click();
  const builder = page.locator('#theme-builder-modal');
  await expect(builder).toBeVisible();
  await page.locator('#theme-builder-name').fill('Dusk');
  // The first color picker is --bg-primary's
  await builder.locator('input[type="color"]').first().evaluate(picker => {
    picker.value = '#102030';
    picker.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await page.locator('#theme-builder-save').click();

  await expect.poll(async () => (await stored(page, ['setting_theme'])).setting_theme).not.toBe('system');
  const themeId = (await stored(page, ['setting_theme'])).setting_theme;
  const saved = await page.evaluate(async id => (await Storage.getCustomThemes()).find(theme => theme.id === id), themeId);
  expect([saved.name, saved.properties['--bg-primary']]).toEqual(['Dusk', '#102030']);

  await driver.reload(page);
  await expect.poll(() => page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--bg-primary').trim()))
    .toBe('#102030');
  await expectNoUncaught(extension, page);
});

test('split view and its tabs come back after a reload, from one session write', async ({ extension }) => {
  await extension.seedOnboarded();
  const page = await driver.openNewTab(extension);
  await expect.poll(async () => (await stored(page, ['lastOpenedNoteId'])).lastOpenedNoteId || null).not.toBeNull();
  const { leftId, rightId } = await page.evaluate(async () => {
    const beta = await Storage.createNote('Beta');
    await app.refreshNotesList();
    await app.tabController.openNoteInNewTab(beta.id);
    await app.tabController.toggleSplitView();
    // As in 1.4.x, opening split view saves nothing by itself; the next tab change saves it
    await app.tabController.switchToTab(app.tabController.activeTabIndex);
    return { leftId: app.editor.noteId, rightId: app.secondaryEditor.noteId };
  });
  await expect.poll(() => stored(page, ['setting_splitViewEnabled', 'setting_secondaryNoteId', 'lastOpenedNoteId'])).toEqual({
    setting_splitViewEnabled: true,
    setting_secondaryNoteId: rightId,
    lastOpenedNoteId: leftId,
  });

  await driver.reload(page);
  await expect.poll(() => page.evaluate(() => [app.editor.noteId, app.tabController.splitViewEnabled, app.secondaryEditor.noteId]))
    .toEqual([leftId, true, rightId]);
  await expectNoUncaught(extension, page);
});

test('the auto-title and insights switches save, and switched off stay off in every tab', async ({ extension }) => {
  // A first run, as a new user has it: onboarding switches both on
  const first = await driver.openNewTab(extension, { wait: false });
  await driver.skipOnboarding(first);
  await expect.poll(() => stored(first, ['setting_autoTitleEnabled', 'setting_insightsEnabled', 'setting_hasCompletedOnboarding']))
    .toEqual({ setting_autoTitleEnabled: true, setting_insightsEnabled: true, setting_hasCompletedOnboarding: true });
  const second = await driver.openNewTab(extension);
  await first.bringToFront();

  // The rows show once a provider is set; the switches are wired either way
  await driver.openSettings(first, 'AI');
  for (const id of ['auto-title-enabled', 'insights-enabled']) {
    await first.locator(`#${id}`).evaluate(input => {
      input.checked = false;
      input.dispatchEvent(new Event('change', { bubbles: true }));
    });
  }
  await first.locator('#auto-title-interval').evaluate(select => {
    select.value = '60';
    select.dispatchEvent(new Event('change', { bubbles: true }));
  });
  const off = { setting_autoTitleEnabled: false, setting_autoTitleInterval: 60, setting_insightsEnabled: false };
  await expect.poll(() => stored(first, Object.keys(off))).toEqual(off);
  // The other tab has no job timer running
  await expect.poll(() => second.evaluate(() => [app.notesManager.autoTitleIntervalId, app.notesManager.insightsIntervalId]))
    .toEqual([null, null]);
  await expectNoUncaught(extension, first);
});

test('auto-backup runs at start when it is due, and keeps its time', async ({ extension }) => {
  await extension.seedOnboarded();
  await extension.worker.evaluate(() => chrome.storage.local.set({
    setting_autoBackupEnabled: true,
    setting_autoBackupFrequency: 1,
    setting_lastBackupAt: 0,
  }));
  const page = await driver.openNewTab(extension);
  await expect.poll(async () => Object.keys(await page.evaluate(() => chrome.storage.local.get(null)))
    .filter(key => key.startsWith('auto_backup_')).length).toBe(1);
  expect((await stored(page, ['setting_lastBackupAt'])).setting_lastBackupAt).toBeGreaterThan(0);
  await expectNoUncaught(extension, page);
});
