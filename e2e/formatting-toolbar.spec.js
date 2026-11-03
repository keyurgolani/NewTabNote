/**
 * The formatting toolbar, hidden and open, on a short note at 1440 by 900. Each editor builds
 * one in the body, absolutely placed, and a selection in a block places it by inline top and
 * left and shows it. #14's shots found the hidden one moving the page.
 *
 * - Hidden, it adds no height: the page is as tall as the window, so a wheel over the header,
 *   or End in a text block whose caret is already at the end, leaves the page where it is.
 *   Before, it sat below the app, so the page was 42 px taller than the window, and either one
 *   moved the whole app by that much.
 * - Hidden, it takes no focus and isn't in the accessibility tree, so Tab past the app's last
 *   control never stops on its buttons. Before, it hid by opacity alone, so Tab went through
 *   both toolbars' twelve buttons, and a screen reader found two "Text formatting" toolbars.
 * - A selected word still opens it 8 px above the word, centred on it. Bold by the mouse bolds
 *   the word. From the keyboard, the editor's shortcut does.
 */

const { test, expect, expectNoUncaught } = require('./harness');
const driver = require('./characterization/driver');

const NOTE = { name: 'Short', blocks: [{ type: 'text', content: 'Before the cards' }, { type: 'text', content: 'A second line' }] };

/** A new tab at 1440 by 900 on a note of two short text blocks, which fits in the window */
async function shortNote(extension) {
  await extension.seedOnboarded();
  await driver.seedNotes(extension, [NOTE]);
  const page = await driver.openNewTab(extension);
  await page.setViewportSize({ width: 1440, height: 900 });
  await expect(page.locator('#blocks-container > .block')).toHaveCount(2);
  return page;
}

const blockContent = (page, index) => page.locator('#blocks-container > .block').nth(index).locator('.block-content');

/** Select the first `length` characters of the block at `index`, from the keyboard */
async function selectStart(page, index, length) {
  await blockContent(page, index).click();
  await page.keyboard.press('Home');
  for (let i = 0; i < length; i++) await page.keyboard.press('Shift+ArrowRight');
}

test('hidden, it adds no height: the page is as tall as the window, and a wheel over the header or End in a text block leaves the page where it is', async ({ extension }) => {
  const page = await shortNote(extension);
  const pageTop = () => page.evaluate(() => document.scrollingElement.scrollTop);
  expect.soft(await page.evaluate(() => document.scrollingElement.scrollHeight), 'the page is as tall as the window').toBe(900);

  await page.mouse.move(720, 24);
  await page.mouse.wheel(0, 300);
  await page.waitForTimeout(400);
  expect.soft(await pageTop(), 'a wheel over the header').toBe(0);

  // End with the caret already at the end of its line, from the page's top
  await page.evaluate(() => { document.scrollingElement.scrollTop = 0; });
  await blockContent(page, 0).click();
  await page.keyboard.press('End');
  await page.keyboard.press('End');
  await page.waitForTimeout(400);
  expect.soft(await pageTop(), 'End at the end of a line').toBe(0);
  await expectNoUncaught(extension, page);
});

test("hidden, it takes no focus and isn't in the accessibility tree, so Tab past the app's last control never stops on its buttons", async ({ extension }) => {
  const page = await shortNote(extension);
  await expect(page.locator('.formatting-toolbar').first()).toBeAttached();
  await expect.soft(page.getByRole('toolbar', { name: 'Text formatting' })).toHaveCount(0);
  await expect.soft(page.getByRole('button', { name: 'Bold', exact: true })).toHaveCount(0);

  // The AI chat button is the app's last control
  await page.getByRole('button', { name: 'Open AI Chat' }).focus();
  for (let i = 1; i <= 3; i++) {
    await page.keyboard.press('Tab');
    expect.soft(await page.evaluate(() => !!document.activeElement.closest('.formatting-toolbar')), `Tab ${i}`).toBe(false);
  }
  await expectNoUncaught(extension, page);
});

test("a selected word still opens it 8 px above the word, centred on it, and Bold by the mouse or the editor's Cmd/Ctrl+B bolds a word", async ({ extension }) => {
  const page = await shortNote(extension);
  await selectStart(page, 0, 'Before'.length);
  // Each editor has its own toolbar, and both open at the same place, so this reads the one on top
  const bar = page.locator('.formatting-toolbar.visible').last();
  await expect(bar).toBeVisible();
  // It moves on each selectionchange, which can come after the last key, so this waits for its place
  // over the whole word: the gap below it and how far its centre is off the word's, to the pixel
  await expect.poll(() => page.evaluate(() => {
    const word = getSelection().getRangeAt(0).getBoundingClientRect();
    const bars = document.querySelectorAll('.formatting-toolbar.visible');
    const box = bars[bars.length - 1].getBoundingClientRect();
    return { gap: Math.round(word.top - box.bottom), offCentre: Math.round(Math.abs((box.left + box.right) / 2 - (word.left + word.right) / 2)) };
  })).toEqual({ gap: 8, offCentre: 0 });

  // A click at Bold's centre reaches the toolbar on top, as a user's does
  const bold = await bar.locator('.formatting-toolbar-btn[data-id="bold"]').boundingBox();
  await page.mouse.click(bold.x + bold.width / 2, bold.y + bold.height / 2);
  await expect(blockContent(page, 0)).toHaveJSProperty('innerHTML', '<b>Before</b> the cards');

  await selectStart(page, 1, 'A second'.length);
  await page.keyboard.press('ControlOrMeta+b');
  await expect(blockContent(page, 1)).toHaveJSProperty('innerHTML', '<b>A second</b> line');
  await expectNoUncaught(extension, page);
});
