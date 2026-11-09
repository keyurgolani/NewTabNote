/**
 * The new tab's status line (#20 slice 4c) in the packaged extension, by the keyboard. The line
 * sits just above the sidebar's footer, after the notes and the bulk bar in the page's order.
 * While nothing is selected the bar has slid below the sidebar's edge, so it stays out of the
 * Tab order: Tab from the last note reaches the line, and the sidebar, which clips with
 * `overflow: hidden` and so can't be scrolled back by the wheel, stays where it was. While notes
 * are selected the bar owns the sidebar's bottom edge and the line steps aside for it, keeping
 * its place. Once the selection ends, the bar's buttons leave the Tab order at once, while the
 * bar still slides away and before it hides (#282). The test also fails on an uncaught exception
 * test/known-defects.json doesn't list.
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

/** The element with focus, by its id or else its class, so a miss names what took the Tab */
const focusedIn = page =>
  page.evaluate(() => {
    const element = document.activeElement;
    return element.id ? `#${element.id}` : `.${element.className}`;
  });

test('Tab from the last note reaches the status line with the sidebar unscrolled, also while the bulk bar slides away after a selection, and the line steps aside while notes are selected (#20 slice 4c, #282)', async ({ extension }) => {
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
  // The selection ended: the line is back, and the bar's buttons leave the Tab order at once, not
  // once the bar has hidden. Cancel ends it, and in the same task the bar's slide is finished and
  // its hide held, so the bar sits below the sidebar's edge still showing, as at the end of its
  // slide away: no frame passes and no timing enters (#282)
  const held = await page.evaluate(() => {
    document.getElementById('bulk-cancel-btn').click();
    const bar = document.getElementById('sidebar-bulk-actions');
    for (const animation of bar.getAnimations()) {
      if (animation.transitionProperty === 'transform') animation.finish();
      else animation.pause();
    }
    const edge = document.getElementById('sidebar').getBoundingClientRect().bottom;
    const paused = bar.getAnimations().filter(animation => animation.playState === 'paused');
    return {
      held: paused.map(animation => animation.transitionProperty),
      visibility: getComputedStyle(bar).visibility,
      belowTheEdge: Math.round(bar.getBoundingClientRect().top - edge),
    };
  });
  expect(held, 'the bar has slid away, and its hide is held').toEqual({
    held: ['visibility'],
    visibility: 'visible',
    belowTheEdge: 0,
  });
  await expect(line).toBeVisible();
  await page.locator('#sidebar-notes-list .sidebar-note-item').last().locator('button').last().focus();
  await page.keyboard.press('Tab');
  expect(await focusedIn(page), "the line takes the Tab, and none of the bar's buttons").toBe('.trust-sidebar-line');
  expect(await sidebar.evaluate(element => element.scrollTop)).toBe(0);
  await expectNoUncaught(extension, page);
});
