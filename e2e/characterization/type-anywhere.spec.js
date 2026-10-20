/**
 * Type anywhere on 1.4.1 (#1 AC2's rule): with focus outside text controls and anything
 * modal, a printable key goes to the note, except Space (or Enter) on a button or link,
 * which presses it. Text typed in a note, in either pane of split view, stays where it is
 * typed. Each test ends with the uncaught-exception check.
 */

const { test, expect, expectNoUncaught } = require('../harness');
const driver = require('./driver');

test('Space on a header button presses it instead of typing into the note, and letters still go to the note', async ({ extension }) => {
  await extension.seedOnboarded();
  await driver.seedNotes(extension, [{ name: 'Groceries', blocks: [{ type: 'text', content: 'eggs' }] }]);
  const page = await driver.openNewTab(extension);

  await driver.focusHeaderButton(page, 'Settings');
  await page.keyboard.press('Space');
  await expect.poll(() => driver.settingsOpen(page)).toBe(true);
  expect(await driver.blocks(page)).toEqual([{ type: 'text', text: 'eggs' }]);
  await driver.closeSettings(page);

  // As right after clicking it
  await driver.focusHeaderButton(page, 'Settings');
  await page.keyboard.type('bacon');
  await expect.poll(() => driver.blocks(page)).toEqual([{ type: 'text', text: 'eggsbacon' }]);
  expect(await driver.settingsOpen(page)).toBe(false);
  await expectNoUncaught(extension, page);
});

test('text typed in the right pane of split view stays in the block it is typed in', async ({ extension }) => {
  await extension.seedOnboarded();
  await driver.seedNotes(extension, [
    { name: 'Groceries', blocks: [{ type: 'text', content: 'eggs' }, { type: 'text', content: 'milk' }] },
    { name: 'Packing', blocks: [{ type: 'text', content: 'socks' }, { type: 'text', content: 'boots' }] },
  ]);
  const page = await driver.openNewTab(extension);
  await driver.openSplitView(page);
  const left = await driver.blocks(page);
  const [first, second] = await driver.rightPaneBlocks(page);

  await driver.clickRightPaneBlock(page, 0);
  await page.keyboard.type(' and more');
  await expect.poll(() => driver.rightPaneBlocks(page)).toEqual([{ ...first, text: `${first.text} and more` }, second]);
  expect(await driver.focused(page)).toEqual({ kind: 'block', pane: 'right', index: 0, text: `${first.text} and more` });
  expect(await driver.blocks(page)).toEqual(left);
  await expectNoUncaught(extension, page);
});
