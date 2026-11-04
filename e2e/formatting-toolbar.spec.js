/**
 * The formatting toolbar, hidden and open, on a short note at 1440 by 900. Each editor builds
 * one in the body, absolutely placed, and a selection in a block of its own pane places it by
 * inline top and left and shows it. #14's shots found the hidden one moving the page.
 *
 * - Hidden, it adds no height: the page is as tall as the window, so a wheel over the header,
 *   or End in a text block whose caret is already at the end, leaves the page where it is.
 *   Before, it sat below the app, so the page was 42 px taller than the window, and either one
 *   moved the whole app by that much. That holds wherever it last opened, once its fade ends:
 *   below a long selection running past the window's bottom, or low in a window later made
 *   shorter. Before, it kept that place, and the page stayed taller.
 * - Hidden, it takes no focus and isn't in the accessibility tree, so Tab past the app's last
 *   control never stops on its buttons. Before, it hid by opacity alone, so Tab went through
 *   both toolbars' twelve buttons, and a screen reader found two "Text formatting" toolbars.
 * - It opens at once, in place, and once a selection ends it still shows where it was while
 *   it fades, for 0.12 s, then hides.
 * - A selection whose box is empty, in text that isn't drawn, opens no toolbar, since nothing on
 *   screen is there to point at. Before, one showed anyway: below the app, where the page grew
 *   by 42 px, or where it last opened, over words no longer selected.
 * - A selection shows its own pane's toolbar alone, in the main pane and in split view's right
 *   pane. Before, any selection showed both panes' toolbars, one over the other, so a screen
 *   reader found two "Text formatting" toolbars.
 * - A selected word still opens it 8 px above the word, centred on it. Bold by the mouse bolds
 *   the word. From the keyboard, the editor's shortcut does.
 */

const { test, expect, expectNoUncaught } = require('./harness');
const driver = require('./characterization/driver');

const NOTE = { name: 'Short', blocks: [{ type: 'text', content: 'Before the cards' }, { type: 'text', content: 'A second line' }] };
// A block far taller than the window, between two short ones
const LONG = { name: 'Long', blocks: [{ type: 'text', content: 'Top line' }, { type: 'text', content: Array.from({ length: 900 }, (_, i) => `word${i}`).join(' ') }, { type: 'text', content: 'After the long one' }] };
// More lines than the window shows
const MANY = { name: 'Many', blocks: Array.from({ length: 24 }, (_, i) => ({ type: 'text', content: `Line ${i} with a few words in it` })) };

/** A new tab at 1440 by 900 on `note`, a note of two short text blocks unless given */
async function shortNote(extension, note = NOTE) {
  await extension.seedOnboarded();
  await driver.seedNotes(extension, [note]);
  const page = await driver.openNewTab(extension);
  await page.setViewportSize({ width: 1440, height: 900 });
  await expect(page.locator('#blocks-container > .block')).toHaveCount(note.blocks.length);
  return page;
}

const blockContent = (page, index) => page.locator('#blocks-container > .block').nth(index).locator('.block-content');
const pageHeight = page => page.evaluate(() => document.scrollingElement.scrollHeight);

/** Select characters `from` to `to` of the block at `index` in one go, `to` -1 for its end, as a double-click or a triple-click does */
async function selectInOneGo(page, index, from, to) {
  await blockContent(page, index).evaluate((el, [a, b]) => {
    el.focus({ preventScroll: true });
    const node = el.firstChild;
    getSelection().setBaseAndExtent(node, a, node, b < 0 ? node.length : b);
  }, [from, to]);
  await expect(page.locator('.formatting-toolbar.visible').last()).toBeVisible();
}

/** End the selection, so the toolbars hide */
const unselect = page => page.evaluate(() => getSelection().collapseToEnd());

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

test('a toolbar that opened below a long selection, past the window, adds no height once its fade ends, so a wheel leaves the page where it is', async ({ extension }) => {
  const page = await shortNote(extension, LONG);
  // The long block's top scrolled up under the header, so the toolbar has no room above it
  await blockContent(page, 1).evaluate(el => {
    el.closest('.editor-pane').scrollTop += el.getBoundingClientRect().top - 30;
  });
  await selectInOneGo(page, 1, 0, -1);
  expect(await page.locator('.formatting-toolbar.visible').last().evaluate(el => el.getBoundingClientRect().top), 'it opens below the window').toBeGreaterThan(900);

  await unselect(page);
  await expect.poll(() => pageHeight(page), 'the page is as tall as the window once the fade ends').toBe(900);
  await page.mouse.move(720, 24);
  await page.mouse.wheel(0, 3000);
  await page.waitForTimeout(400);
  expect(await page.evaluate(() => document.scrollingElement.scrollTop), 'a wheel over the header').toBe(0);
  await expectNoUncaught(extension, page);
});

test('a toolbar that opened low in the window adds no height once the window is made shorter', async ({ extension }) => {
  const page = await shortNote(extension, MANY);
  // The last line wholly in the window, well above its bottom
  const low = await page.evaluate(() => {
    const lines = [...document.querySelectorAll('#blocks-container > .block .block-content')];
    return lines.reduce((best, el, i) => (el.getBoundingClientRect().bottom < innerHeight - 20 ? i : best), 0);
  });
  await selectInOneGo(page, low, 0, 4);
  // It opened low, its bottom past the shorter window's height, so the resize has a low place to test
  expect(await page.locator('.formatting-toolbar.visible').last().evaluate(el => el.getBoundingClientRect().bottom + scrollY), 'it opens low').toBeGreaterThan(700);
  await unselect(page);
  await expect.poll(() => pageHeight(page)).toBe(900);

  await page.setViewportSize({ width: 1440, height: 700 });
  await expect.poll(() => pageHeight(page), 'the page is as tall as the shorter window').toBe(700);
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

test('it opens at once, in place, and once the selection ends it still shows where it was while it fades, then hides', async ({ extension }) => {
  const page = await shortNote(extension);
  // The main pane's toolbar right after the toolbars handle a select or an unselect in its first
  // block. Each reading is in the same task as their own selectionchange handlers, which run
  // first, so no frame passes and no timing enters
  const after = change => page.evaluate(async change => {
    const node = document.querySelector('#blocks-container > .block .block-content').firstChild;
    const handled = new Promise(resolve => document.addEventListener('selectionchange', resolve, { once: true }));
    if (change === 'select') getSelection().setBaseAndExtent(node, 0, node, 6);
    else getSelection().collapseToEnd();
    await handled;
    const bar = app.editor.formattingToolbar.el;
    const hide = bar.getAnimations().find(animation => animation.transitionProperty === 'visibility');
    const reading = { visibility: getComputedStyle(bar).visibility, hidesAfter: hide ? hide.effect.getTiming().delay : null };
    // While it fades, it stays where it was, at its inline top, and moves to the page's top only after
    if (change !== 'select') return { ...reading, inPlace: getComputedStyle(bar).top === bar.style.top };
    // A selection made in one go, as a double-click makes one, is placed from the toolbar's first measure
    const word = getSelection().getRangeAt(0).getBoundingClientRect();
    const box = bar.getBoundingClientRect();
    return { ...reading, gap: Math.round(word.top - box.bottom), offCentre: Math.round(Math.abs((box.left + box.right) / 2 - (word.left + word.right) / 2)) };
  }, change);
  await blockContent(page, 0).click();
  await page.waitForTimeout(200);
  expect(await after('select'), 'open at once, in place').toEqual({ visibility: 'visible', hidesAfter: null, gap: 8, offCentre: 0 });
  expect(await after('unselect'), 'still showing where it was while it fades').toEqual({ visibility: 'visible', hidesAfter: 120, inPlace: true });
  await expect.poll(() => page.evaluate(() => getComputedStyle(app.editor.formattingToolbar.el).visibility), 'then hidden').toBe('hidden');
  await expectNoUncaught(extension, page);
});

test('a selection whose box is empty opens no toolbar, and the page stays as tall as the window', async ({ extension }) => {
  const page = await shortNote(extension);
  // Text that isn't drawn, here a hidden span in the first block, gives a selection an empty box,
  // so nothing on screen is there for a toolbar to point at. Read after the toolbars' own handlers.
  const selectUnseen = () => blockContent(page, 0).evaluate(async el => {
    let span = el.querySelector('span[hidden]');
    if (!span) {
      span = el.ownerDocument.createElement('span');
      span.hidden = true;
      span.textContent = 'unseen';
      el.append(span);
    }
    const handled = new Promise(resolve => document.addEventListener('selectionchange', resolve, { once: true }));
    getSelection().setBaseAndExtent(span.firstChild, 0, span.firstChild, 6);
    await handled;
  });
  const shown = () => page.locator('.formatting-toolbar.visible').count();

  // With no toolbar placed yet, one would show at its place below the app
  await selectUnseen();
  expect.soft(await shown(), 'no toolbar shows, with none placed yet').toBe(0);
  expect.soft(await pageHeight(page), 'the page is as tall as the window').toBe(900);

  // With one placed over a word, it would show there, over words no longer selected
  await selectInOneGo(page, 1, 0, 6);
  await selectUnseen();
  expect.soft(await shown(), 'no toolbar shows, after one was placed').toBe(0);
  await expectNoUncaught(extension, page);
});

test("a selection in one pane shows that pane's toolbar alone, in the main pane and in split view's right pane", async ({ extension }) => {
  await extension.seedOnboarded();
  await driver.seedNotes(extension, [NOTE, { name: 'Other', blocks: [{ type: 'text', content: 'A line in the other note' }] }]);
  const page = await driver.openNewTab(extension);
  await page.setViewportSize({ width: 1440, height: 900 });
  const toolbars = page.getByRole('toolbar', { name: 'Text formatting' });
  // Whether the main pane's toolbar and the right pane's show
  const shown = () => page.evaluate(() => [app.editor, app.secondaryEditor].map(editor => editor.formattingToolbar.el.classList.contains('visible')));
  /** Select the first four characters of the pane's first block, from the keyboard */
  const selectIn = async pane => {
    await page.locator(`${pane} .block-content`).first().click();
    await page.keyboard.press('Home');
    for (let i = 0; i < 4; i++) await page.keyboard.press('Shift+ArrowRight');
  };

  // The toolbars move on each selectionchange, which can come after the last key, and a hidden one
  // stays in the tree through its 0.12 s fade. So this waits until the selection's pane's toolbar
  // shows and the other's doesn't, then for the tree to hold one
  await selectIn('#editor-container');
  await expect.poll(shown, "the main pane's").toEqual([true, false]);
  await expect(toolbars, 'one toolbar for a selection in the main pane').toHaveCount(1);

  await driver.openSplitView(page);
  await selectIn('#secondary-editor-container');
  await expect.poll(shown, "the right pane's").toEqual([false, true]);
  await expect(toolbars, 'one toolbar for a selection in the right pane').toHaveCount(1);
  await expectNoUncaught(extension, page);
});

test("a selected word still opens it 8 px above the word, centred on it, and Bold by the mouse or the editor's Cmd/Ctrl+B bolds a word", async ({ extension }) => {
  const page = await shortNote(extension);
  await selectStart(page, 0, 'Before'.length);
  // Each editor has its own toolbar, and the open one is the selection's pane's
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
