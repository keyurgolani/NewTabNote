/**
 * The new tab's status line (#20 slice 4c) in the packaged extension, by the keyboard. The line
 * sits just above the sidebar's footer, after the notes and the bulk bar in the page's order.
 * While nothing is selected the bar has slid below the sidebar's edge, so it stays out of the
 * Tab order: Tab from the last note reaches the line, and the sidebar, which clips with
 * `overflow: hidden` and so can't be scrolled back by the wheel, stays where it was. While notes
 * are selected the bar owns the sidebar's bottom edge and the line steps aside for it, keeping
 * its place. The test also fails on an uncaught exception test/known-defects.json doesn't list.
 */

const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { test, expect, expectNoUncaught } = require('./harness');
const driver = require('./characterization/driver');

const NOTES = ['Groceries', 'Meeting notes', 'Project plan', 'Weekly review', 'Reading list'].map(name => ({
  name,
  blocks: [{ type: 'text', content: `${name}: a few lines of text` }],
}));

/**
 * NewTabNoteTrust one version past this build's, made in the worker, so the line reads that
 * NewTabNote can't confirm notes are saving: two lines in the sidebar's 260px
 */
async function pastThisBuild(extension) {
  const trust = pathToFileURL(path.join(__dirname, '..', 'js', 'kernel', 'adapters', 'indexeddb', 'trust.js'));
  const { TRUST_DB_NAME, TRUST_DB_VERSION } = await import(trust.href);
  await extension.worker.evaluate(
    ({ name, version }) =>
      new Promise((resolve, reject) => {
        const request = indexedDB.open(name, version + 1);
        request.onupgradeneeded = () => request.result.createObjectStore('probe-newer');
        request.onsuccess = () => {
          request.result.close();
          resolve();
        };
        request.onerror = () => reject(request.error);
      }),
    { name: TRUST_DB_NAME, version: TRUST_DB_VERSION },
  );
}

/** The line's box, hidden or not */
const boxOf = line =>
  line.evaluate(element => {
    const { top, left, width, height } = element.getBoundingClientRect();
    return { top, left, width, height };
  });

test('Tab from the last note reaches the status line with the sidebar unscrolled, and the line steps aside while notes are selected (#20 slice 4c)', async ({ extension }) => {
  await extension.seedOnboarded();
  await driver.seedNotes(extension, NOTES);
  await pastThisBuild(extension);
  const page = await driver.openNewTab(extension);
  const line = page.locator('#sidebar .trust-sidebar-line');
  await expect(line).toHaveText(/^NewTabNote can't confirm your notes are saving/);
  const sidebar = page.locator('#sidebar');

  // One Tab from the last note's last control, its pin, reaches the line: the hidden bar takes
  // none of it, so nothing scrolls the sidebar to show the bar's buttons
  await page.locator('#sidebar-notes-list .sidebar-note-item').last().locator('button').last().focus();
  await page.keyboard.press('Tab');
  await expect(line).toBeFocused();
  expect(await sidebar.evaluate(element => element.scrollTop)).toBe(0);
  await page.keyboard.press('Shift+Tab');
  await expect(line).not.toBeFocused();

  // Notes selected: the bar's buttons show and take Tab, and the line is hidden in its place
  const box = await boxOf(line);
  await page.evaluate(() => app.sidebarController.enterSelectionMode());
  await expect(page.locator('#bulk-cancel-btn')).toBeVisible();
  await expect(line).toBeHidden();
  expect(await boxOf(line)).toEqual(box);
  // The selection ended: the line is back, and the bar leaves the Tab order once it slides away
  await page.locator('#bulk-cancel-btn').click();
  await expect(line).toBeVisible();
  await expect(page.locator('#bulk-cancel-btn')).toBeHidden();
  await page.locator('#sidebar-notes-list .sidebar-note-item').last().locator('button').last().focus();
  await page.keyboard.press('Tab');
  await expect(line).toBeFocused();
  expect(await sidebar.evaluate(element => element.scrollTop)).toBe(0);
  await expectNoUncaught(extension, page);
});
