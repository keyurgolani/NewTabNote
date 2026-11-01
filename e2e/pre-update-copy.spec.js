/**
 * Settings > Data & Backup's "Copy From Before the Update" (#17 PR 1b, Q8) in Chromium, where the
 * stylesheet applies (R88's read of the rebase onto #129). Its Export row is a .setting-row,
 * whose display: flex would show it whatever `hidden` says, so .pre-update-copy-row[hidden]
 * hides it until there's a copy to export. And the section reads its state only when Settings
 * opens, through App's onOpened, so the row shows once a copy exists. Each test ends with the
 * uncaught-exception check.
 */

const { test, expect, expectNoUncaught } = require('./harness');
const driver = require('./characterization/driver');

const NONE = 'This device has no copy from before the update. NewTabNote saves one only when an update changes '
  + 'how notes are stored and there are notes to copy. To save your notes now, use Export JSON above.';

test('with no copy on this device, the section says so, and its Export row stays hidden', async ({ extension }) => {
  await extension.seedOnboarded();
  const page = await driver.openNewTab(extension);
  const settings = await driver.openSettings(page, 'Data & Backup');
  const section = settings.locator('#pre-update-copy');
  await expect(section.locator('.pre-update-copy-guidance')).toHaveText(NONE);
  await expect(section).toHaveAttribute('data-state', 'none');
  await expect(section.locator('.pre-update-copy-row')).toBeHidden();
  await expect(section.getByRole('button', { name: 'Export Pre-Update Copy' })).toBeHidden();
  await expectNoUncaught(extension);
});

test('on a profile the worker upgraded after a copy, opening Settings reads it, and the Export row shows', async ({ extension }) => {
  await extension.seedOnboarded();
  await driver.upgradedAfterACopy(extension);
  const page = await driver.openNewTab(extension);
  const settings = await driver.openSettings(page, 'Data & Backup');
  const section = settings.locator('#pre-update-copy');
  await expect(section).toHaveAttribute('data-state', 'available');
  await expect(section.locator('.pre-update-copy-row')).toBeVisible();
  await expect(section.getByRole('button', { name: 'Export Pre-Update Copy' })).toBeVisible();
  await expect(section.locator('.pre-update-copy-guidance')).toContainText('NewTabNote saved this copy of your notes on');
  await expectNoUncaught(extension);
});
