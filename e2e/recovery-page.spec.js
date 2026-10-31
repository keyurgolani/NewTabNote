/**
 * recovery.html in Chromium, on the shipped bundle (#20 slice 4b). The Trust Center and the
 * Recovery Center run on the page's own root, which serves the trust operations in the page
 * and runs the open check there, through Chrome's own chrome.permissions, chrome.storage, and
 * IndexedDB; the worker serves none of them. Settings' Trust Center section is the way in.
 * Each test also fails on an uncaught exception that test/known-defects.json doesn't list.
 */

const { test, expect, expectNoUncaught } = require('./harness');
const driver = require('./characterization/driver');

/** recovery.html at `hash`, in a page of its own */
async function openRecovery(extension, hash = '') {
  const page = await extension.context.newPage();
  await page.goto(extension.url(`recovery.html${hash}`));
  return page;
}

test('opens on the shipped bundle, runs its open check in the page, and draws the Trust Center, then the Recovery Center', async ({ extension }) => {
  await extension.seedOnboarded();
  await driver.seedNotes(extension, [{ name: 'Alpha', blocks: [{ type: 'text', content: 'Alpha body' }] }]);
  const page = await openRecovery(extension);
  const heading = page.locator('#trust-h1');
  await expect(heading).toHaveText('Trust Center: Your notes are saving normally');
  await expect(page.locator('#trust-main h2')).toHaveText([
    'Where your notes live',
    'What protects them',
    'What can leave this device',
    'What runs on your notes',
  ]);
  // Every check the page ran on open has answered
  await expect(page.locator('#trust-main .trust-tone-checking')).toHaveCount(0);
  await expect(page).toHaveTitle('Trust Center - NewTabNote');

  await page.getByRole('navigation', { name: 'Trust and recovery' }).getByRole('link', { name: 'Recovery Center' }).click();
  await expect(page).toHaveURL(/\/recovery\.html#recovery$/);
  await expect(heading).toHaveText('Recovery Center: Nothing needs recovering');
  await expect(page.locator('#trust-h1')).toBeFocused();
  await expectNoUncaught(extension, page);
});

test("is where Settings' Trust Center section leads, and its way back is the new tab", async ({ extension }) => {
  await extension.seedOnboarded();
  const page = await driver.openNewTab(extension);
  const settings = await driver.openSettings(page, 'Data & Backup');
  await settings.getByRole('link', { name: 'Open Trust Center' }).click();
  await expect(page).toHaveURL(/\/recovery\.html#trust$/);
  await expect(page.locator('#trust-h1')).toHaveText(/^Trust Center: /);
  await expect(page.getByRole('link', { name: 'Back to your notes' })).toHaveAttribute('href', extension.url('newtab.html'));
  await expectNoUncaught(extension, page);
});
