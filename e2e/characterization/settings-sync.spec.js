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
  await expect.poll(() => driver.theme(second)).not.toBe('dark');
  await driver.markPage(second);

  await first.bringToFront();
  await driver.setTheme(first, 'dark');
  await expect.poll(() => driver.theme(first)).toBe('dark');
  await expect.poll(() => driver.theme(second)).toBe('dark');
  expect(await driver.wasReloaded(second), 'the other tab reloaded').toBe(false);
});
