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

test('letters typed with a header button focused reach the note every time, not only the first', async ({ extension }) => {
  await extension.seedOnboarded();
  await driver.seedNotes(extension, [{ name: 'Groceries', blocks: [{ type: 'text', content: 'eggs' }] }]);
  const page = await driver.openNewTab(extension);

  let expected = 'eggs';
  for (const letters of ['ab', 'cd', 'ef']) {
    await driver.focusHeaderButton(page, 'Settings');
    await page.keyboard.type(letters);
    expected += letters;
    await expect.poll(() => driver.blocks(page), `after typing "${letters}"`).toEqual([{ type: 'text', text: expected }]);
  }
  await expectNoUncaught(extension, page);
});

/** Two notes with two blocks each, a new tab on them, and split view open with the left pane active */
async function splitViewOnTwoNotes(extension) {
  await extension.seedOnboarded();
  await driver.seedNotes(extension, [
    { name: 'Groceries', blocks: [{ type: 'text', content: 'eggs' }, { type: 'text', content: 'milk' }] },
    { name: 'Packing', blocks: [{ type: 'text', content: 'socks' }, { type: 'text', content: 'boots' }] },
  ]);
  const page = await driver.openNewTab(extension);
  await driver.openSplitView(page);
  await driver.clickBlock(page, 0);
  return page;
}

/** The blocks with `letters` added to the last one's text */
const typedAtEnd = (blocks, letters) => blocks.map((block, index) => (
  index === blocks.length - 1 ? { ...block, text: block.text + letters } : block));

test('with split view open, letters typed from a header button or the notice go to the active left pane\'s note', async ({ extension }) => {
  const page = await splitViewOnTwoNotes(extension);
  const left = await driver.blocks(page);
  const right = await driver.rightPaneBlocks(page);

  await driver.focusHeaderButton(page, 'Settings');
  await page.keyboard.type('hello');
  await expect.poll(() => driver.blocks(page)).toEqual(typedAtEnd(left, 'hello'));

  // The notice's Not now, a Shift+Tab before the left note's first block
  await driver.clickBlock(page, 0);
  await page.keyboard.press('Shift+Tab');
  expect(await driver.focused(page)).toEqual({ kind: 'button', text: 'Not now' });
  await page.keyboard.type('world');
  await expect.poll(() => driver.blocks(page)).toEqual(typedAtEnd(left, 'helloworld'));
  expect(await driver.rightPaneBlocks(page)).toEqual(right);
  await expectNoUncaught(extension, page);
});

test('after split view opens and closes, letters typed from a header button still reach the note, every time', async ({ extension }) => {
  const page = await splitViewOnTwoNotes(extension);
  await driver.closeSplitView(page);
  const left = await driver.blocks(page);

  await driver.focusHeaderButton(page, 'Settings');
  await page.keyboard.type('hello');
  await expect.poll(() => driver.blocks(page)).toEqual(typedAtEnd(left, 'hello'));
  await driver.focusHeaderButton(page, 'Settings');
  await page.keyboard.type('world');
  await expect.poll(() => driver.blocks(page)).toEqual(typedAtEnd(left, 'helloworld'));
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
