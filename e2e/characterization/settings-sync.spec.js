/**
 * Characterization: a setting changed in one new tab reaches the other open new tabs
 * without a reload (SettingsController.setupSettingsSync).
 */

const { test, expect } = require('../harness');
const driver = require('./driver');

test('switching the theme to dark in one new tab turns the other one dark without a reload', async ({ extension }) => {
  await extension.seedOnboarded();
  const first = await driver.openNewTab(extension);
  const second = await driver.openNewTab(extension);
  await expect(second.locator('html')).not.toHaveAttribute('data-theme', 'dark');
  // Gone if the page reloads
  await second.evaluate(() => { window.ntnBeforeThemeChange = true; });

  await first.bringToFront();
  await driver.setTheme(first, 'dark');
  await expect(first.locator('html')).toHaveAttribute('data-theme', 'dark');
  await expect(second.locator('html')).toHaveAttribute('data-theme', 'dark');
  expect(await second.evaluate(() => window.ntnBeforeThemeChange), 'the other tab was not reloaded').toBe(true);
});
