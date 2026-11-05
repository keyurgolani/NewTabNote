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
 * - After Link, focus moving elsewhere in the page, as a click on another word or a sidebar button
 *   moves it, closes the link field, and the toolbar shows for the selection there is now, or
 *   hides with none. Before, link mode ignored every selection until Enter, Escape or ✓, so its
 *   field stayed over the old words. Focus moving to ✓ keeps the field open, so ✓ by the mouse or
 *   from the keyboard and Enter still apply the link, and so does a switch to another window,
 *   which leaves the field focused. A press on the toolbar's own frame, or on ✓ until its release,
 *   keeps focus in the field.
 * - A double-click on ✓ applies the link once. Its second press, which lands where ✓ was, on the
 *   button that comes back there, does nothing, so the word keeps its formatting. Before, that
 *   button ran. A double-click on any format button acts once, so a double-clicked Bold bolds the
 *   word, and a right-click or a Control-click, the Mac's right-click, on one does nothing.
 * - Enter, in the link field or on ✓, applies the link once, on its release, so a held Enter's
 *   repeats don't reach the note. Before, they split its block on each repeat. It applies the URL
 *   as it was at the press, so a key pressed before the release, which the field takes, is dropped
 *   with the field and doesn't reach the note. An IME's Enter, whose release comes with no press
 *   before it, or whose press comes while composing, applies nothing, even after a press whose
 *   release was lost. A release after the row closed applies nothing to the next selection. Escape on
 *   ✓ closes the field and gives back the selection, as Escape in it does.
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

/** Press Link on the toolbar on top, the one a click reaches, as a user's does */
const pressLink = page => page.locator('.formatting-toolbar.visible').last().locator('.formatting-toolbar-btn[data-id="link"]').click();

/** Where the toolbar on top sits over the selection: the gap below it, and how far its centre is off the selection's */
const placed = page => page.evaluate(() => {
  const word = getSelection().getRangeAt(0).getBoundingClientRect();
  const bars = document.querySelectorAll('.formatting-toolbar.visible');
  const box = bars[bars.length - 1].getBoundingClientRect();
  return { gap: Math.round(word.top - box.bottom), offCentre: Math.round(Math.abs((box.left + box.right) / 2 - (word.left + word.right) / 2)) };
});

/** The links in the block at `index`, each as its href and its text */
const linksIn = (page, index) => blockContent(page, index).evaluate(el => [...el.querySelectorAll('a')].map(a => [a.getAttribute('href'), a.textContent]));

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

test("after Link, a selection of another word in the same pane closes the link field and shows that pane's toolbar alone, over the new word, in the main pane and in split view's right pane", async ({ extension }) => {
  await extension.seedOnboarded();
  await driver.seedNotes(extension, [NOTE, { name: 'Other', blocks: [{ type: 'text', content: 'A line in the other note' }, { type: 'text', content: 'A second line here' }] }]);
  const page = await driver.openNewTab(extension);
  await page.setViewportSize({ width: 1440, height: 900 });
  // For the main pane's toolbar and the right pane's: whether it shows, whether its link field is
  // open, and how far its centre is off the selection's, to the pixel
  const read = () => page.evaluate(() => {
    const sel = getSelection();
    const word = sel.rangeCount > 0 ? sel.getRangeAt(0).getBoundingClientRect() : null;
    return [app.editor, app.secondaryEditor].map(({ formattingToolbar: bar }) => {
      const box = bar.el.getBoundingClientRect();
      return {
        shows: bar.el.classList.contains('visible'),
        linkField: getComputedStyle(bar.linkInput).display !== 'none',
        offCentre: word ? Math.round(Math.abs((box.left + box.right) / 2 - (word.left + word.right) / 2)) : null,
      };
    });
  });
  /** Link pressed for the start of the pane's first block, then "second" in its second block double-clicked, as someone who changed their mind would */
  const linkThenWord = async (pane, own) => {
    const blocks = page.locator(`${pane} .block-content`);
    await blocks.first().click();
    await page.keyboard.press('Home');
    for (let i = 0; i < 4; i++) await page.keyboard.press('Shift+ArrowRight');
    await pressLink(page);
    await expect.poll(async () => (await read()).some(bar => bar.linkField), 'the link field is open').toBe(true);
    const at = await blocks.nth(1).evaluate(el => {
      const node = el.firstChild;
      const start = node.data.indexOf('second');
      const range = el.ownerDocument.createRange();
      range.setStart(node, start);
      range.setEnd(node, start + 'second'.length);
      const box = range.getBoundingClientRect();
      return { x: box.left + box.width / 2, y: box.top + box.height / 2 };
    });
    await page.mouse.dblclick(at.x, at.y);
    await expect.poll(async () => (await read()).map(bar => bar.linkField), 'the link field closes').toEqual([false, false]);
    await expect.poll(async () => (await read()).map(bar => bar.shows), "that pane's toolbar alone").toEqual(own === 0 ? [true, false] : [false, true]);
    await expect.poll(async () => (await read())[own].offCentre, 'over the new word').toBe(0);
  };

  await linkThenWord('#editor-container', 0);
  await driver.openSplitView(page);
  await linkThenWord('#secondary-editor-container', 1);
  await expectNoUncaught(extension, page);
});

test('in link mode, ✓ from the keyboard or by the mouse, and Enter in the field, still apply the link, and focus moving from the field to ✓ leaves the field open', async ({ extension }) => {
  const page = await shortNote(extension, { name: 'Links', blocks: ['Before the cards', 'A second line', 'A third line', 'A fourth line'].map(content => ({ type: 'text', content })) });
  const field = page.locator('.formatting-toolbar-url:visible');
  const ok = page.locator('.formatting-toolbar-link-ok:visible');
  /** Link pressed for the first `length` characters of the block at `index`, and `url` typed in the field */
  const linkFor = async (index, length, url) => {
    await selectStart(page, index, length);
    await pressLink(page);
    await expect(field).toBeFocused();
    await page.keyboard.type(url);
  };

  // ✓ from the keyboard: Tab to it, then Enter, and in the next block Space
  await linkFor(0, 'Before'.length, 'https://example.test/a');
  await page.keyboard.press('Tab');
  await expect(ok, 'the field stays open, with focus on ✓').toBeFocused();
  await page.keyboard.press('Enter');
  await expect.poll(() => linksIn(page, 0), 'Enter on ✓ applies it').toEqual([['https://example.test/a', 'Before']]);
  await linkFor(1, 'A second'.length, 'https://example.test/b');
  await page.keyboard.press('Tab');
  await page.keyboard.press(' ');
  await expect.poll(() => linksIn(page, 1), 'Space on ✓ applies it').toEqual([['https://example.test/b', 'A second']]);

  // ✓ by the mouse, and Enter in the field
  await linkFor(2, 'A third'.length, 'https://example.test/c');
  await ok.click();
  await expect.poll(() => linksIn(page, 2), 'a click on ✓ applies it').toEqual([['https://example.test/c', 'A third']]);
  await linkFor(3, 'A fourth'.length, 'https://example.test/d');
  await page.keyboard.press('Enter');
  await expect.poll(() => linksIn(page, 3), 'Enter in the field applies it').toEqual([['https://example.test/d', 'A fourth']]);
  await expectNoUncaught(extension, page);
});

test('in link mode, a switch to another window leaves the link field open with its selection, for a URL copied there', async ({ extension }) => {
  const page = await shortNote(extension);
  const field = page.locator('.formatting-toolbar-url:visible');
  await selectStart(page, 0, 'Before'.length);
  await pressLink(page);
  await expect(field).toBeFocused();

  // A switch to another window takes focus from the field with no new target, and leaves the
  // field the page's active element. Headless Chromium can't switch windows, so the field gets
  // that focusout as one would come
  await field.evaluate(el => el.dispatchEvent(new FocusEvent('focusout', { bubbles: true, relatedTarget: null })));
  await page.waitForTimeout(200);
  await expect(field, 'the link field stays open').toBeFocused();
  await page.keyboard.type('https://example.test/c');
  await page.keyboard.press('Enter');
  await expect.poll(() => linksIn(page, 0), 'its selection gets the link').toEqual([['https://example.test/c', 'Before']]);
  await expectNoUncaught(extension, page);
});

test("in link mode, a press on the toolbar's own frame, in the gap between the field and ✓, or on ✓ keeps focus in the field with the URL typed in it, and ✓'s release applies it", async ({ extension }) => {
  const page = await shortNote(extension);
  const field = page.locator('.formatting-toolbar-url:visible');
  await selectStart(page, 0, 'Before'.length);
  await pressLink(page);
  await expect(field).toBeFocused();
  await page.keyboard.type('https://example.test/typed');
  // Inside its 4 px padding, halfway down its left edge, halfway between the field and ✓, and ✓'s centre
  const { presses, ok } = await page.evaluate(() => {
    const bar = app.editor.formattingToolbar;
    const [frame, input, button] = [bar.el, bar._linkField, bar._linkConfirm].map(el => el.getBoundingClientRect());
    return {
      presses: {
        'frame': { x: frame.left + 2, y: (frame.top + frame.bottom) / 2 },
        'gap between the field and ✓': { x: (input.right + button.left) / 2, y: (input.top + input.bottom) / 2 },
      },
      ok: { x: (button.left + button.right) / 2, y: (button.top + button.bottom) / 2 },
    };
  });
  for (const [where, point] of Object.entries(presses)) {
    await page.mouse.click(point.x, point.y);
    await page.waitForTimeout(200);
    await expect(field, `the field stays open after a press on the ${where}`).toBeFocused();
    await expect(field, `the URL stays in it after a press on the ${where}`).toHaveValue('https://example.test/typed');
  }

  // Read while ✓ is held down, before its release
  await page.mouse.move(ok.x, ok.y);
  await page.mouse.down();
  const held = await page.evaluate(() => document.activeElement === app.editor.formattingToolbar._linkField);
  expect(held, 'focus stays in the field during a press on ✓').toBe(true);
  await page.mouse.up();
  await expect.poll(() => linksIn(page, 0), "✓'s release applies it").toEqual([['https://example.test/typed', 'Before']]);
  await expectNoUncaught(extension, page);
});

test('in link mode, a press on a sidebar button, which selects nothing, closes the link field and leaves no toolbar over the words', async ({ extension }) => {
  const page = await shortNote(extension);
  await selectStart(page, 0, 'Before'.length);
  await pressLink(page);
  await expect(page.locator('.formatting-toolbar-url:visible')).toBeFocused();
  await page.locator('#calendar-next').click();
  const toolbars = () => page.evaluate(() => [app.editor, app.secondaryEditor].map(({ formattingToolbar: bar }) => ({
    shows: bar.el.classList.contains('visible'),
    linkField: getComputedStyle(bar.linkInput).display !== 'none',
  })));
  await expect.poll(toolbars, 'the link field closes, and no toolbar shows').toEqual([{ shows: false, linkField: false }, { shows: false, linkField: false }]);
  await expectNoUncaught(extension, page);
});

test("a double-click on ✓ applies the link once and leaves the word's other formatting as it was, a double-click on Bold bolds once, and a right-click or a Control-click on a format button does nothing", async ({ extension }) => {
  const page = await shortNote(extension);
  await selectStart(page, 0, 'Before'.length);
  await pressLink(page);
  await expect(page.locator('.formatting-toolbar-url:visible')).toBeFocused();
  await page.keyboard.type('https://example.test/a');
  // The second press lands where ✓ was, on whichever button comes back there
  const ok = await page.locator('.formatting-toolbar-link-ok:visible').boundingBox();
  await page.mouse.dblclick(ok.x + ok.width / 2, ok.y + ok.height / 2);
  await expect.poll(() => linksIn(page, 0), '✓ applies it once').toEqual([['https://example.test/a', 'Before']]);
  await page.waitForTimeout(200);
  const tags = await blockContent(page, 0).evaluate(el => [...new Set([...el.querySelectorAll('*')].map(child => child.tagName.toLowerCase()))].sort());
  expect(tags, "the word's other formatting is as it was").toEqual(['a']);

  // A double-click at Bold's centre, once the toolbar is over the new word, bolds it once
  await selectStart(page, 1, 'A second'.length);
  await expect.poll(() => placed(page)).toEqual({ gap: 8, offCentre: 0 });
  const bar = page.locator('.formatting-toolbar.visible').last();
  const bold = await bar.locator('.formatting-toolbar-btn[data-id="bold"]').boundingBox();
  await page.mouse.dblclick(bold.x + bold.width / 2, bold.y + bold.height / 2);
  await page.waitForTimeout(200);
  expect(await blockContent(page, 1).evaluate(el => el.innerHTML), 'a double-click on Bold bolds the word once').toBe('<b>A second</b> line');

  // A right-click on Italic leaves the word as it was
  const italic = await bar.locator('.formatting-toolbar-btn[data-id="italic"]').boundingBox();
  await page.mouse.click(italic.x + italic.width / 2, italic.y + italic.height / 2, { button: 'right' });
  await page.waitForTimeout(200);
  expect(await blockContent(page, 1).evaluate(el => el.innerHTML), 'a right-click on a format button does nothing').toBe('<b>A second</b> line');

  // A Control-click on Bold, the Mac's right-click, leaves the word as it was. On the Mac the
  // right-click above moves the selection, so the word is selected again first
  await selectStart(page, 1, 'A second'.length);
  await expect.poll(() => placed(page)).toEqual({ gap: 8, offCentre: 0 });
  const boldNow = await bar.locator('.formatting-toolbar-btn[data-id="bold"]').boundingBox();
  await page.keyboard.down('Control');
  await page.mouse.click(boldNow.x + boldNow.width / 2, boldNow.y + boldNow.height / 2);
  await page.keyboard.up('Control');
  await page.waitForTimeout(200);
  expect(await blockContent(page, 1).evaluate(el => el.innerHTML), 'a Control-click on a format button does nothing').toBe('<b>A second</b> line');
  await expectNoUncaught(extension, page);
});

test('Enter held in the link field, and on ✓, applies the link once and the note keeps its blocks, and Escape on ✓ closes the field and gives back the selection', async ({ extension }) => {
  const page = await shortNote(extension);
  const field = page.locator('.formatting-toolbar-url:visible');
  const ok = page.locator('.formatting-toolbar-link-ok:visible');
  const blocks = () => page.locator('#blocks-container > .block').count();
  /** Enter held: a press, two repeats, then the release, as a held key gives them */
  const holdEnter = async () => {
    for (let i = 0; i < 3; i++) await page.keyboard.down('Enter');
    await page.keyboard.up('Enter');
  };

  // In the field
  await selectStart(page, 0, 'Before'.length);
  await pressLink(page);
  await expect(field).toBeFocused();
  await page.keyboard.type('https://example.test/a');
  await holdEnter();
  await expect.poll(() => linksIn(page, 0), 'the link applies once from the field').toEqual([['https://example.test/a', 'Before']]);
  await page.waitForTimeout(200);
  expect(await blocks(), 'the note keeps its blocks after Enter held in the field').toBe(2);

  // On ✓, reached with Tab
  await selectStart(page, 1, 'A second'.length);
  await pressLink(page);
  await expect(field).toBeFocused();
  await page.keyboard.type('https://example.test/b');
  await page.keyboard.press('Tab');
  await expect(ok).toBeFocused();
  await holdEnter();
  await expect.poll(() => linksIn(page, 1), 'the link applies once from ✓').toEqual([['https://example.test/b', 'A second']]);
  await page.waitForTimeout(200);
  expect(await blocks(), 'the note keeps its blocks after Enter held on ✓').toBe(2);

  // Escape on ✓ closes the field and gives back the selection, as Escape in it does
  await selectStart(page, 1, 'A second'.length);
  await pressLink(page);
  await expect(field).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(ok).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(page.locator('.formatting-toolbar-url:visible'), 'Escape on ✓ closes the field').toHaveCount(0);
  expect(await page.evaluate(() => getSelection().toString()), 'Escape on ✓ gives back the selection').toBe('A second');
  await expect(blockContent(page, 1), "Escape on ✓ puts focus back in the selection's block").toBeFocused();
  await expectNoUncaught(extension, page);
});

test("an IME's Enter in the link field applies nothing: a release with no press before it, a composing press, a commit after a lost release, and a release after the row closed", async ({ extension }) => {
  const page = await shortNote(extension);
  const field = page.locator('.formatting-toolbar-url:visible');
  await selectStart(page, 0, 'Before'.length);
  await pressLink(page);
  await expect(field).toBeFocused();
  await page.keyboard.type('https://example.test/a');

  // An IME's commit sends its press while composing, and only its release as a plain Enter
  await field.evaluate(el => el.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', code: 'Enter', bubbles: true, cancelable: true })));
  await page.waitForTimeout(200);
  expect(await linksIn(page, 0), 'no link applies after a lone release').toEqual([]);
  await expect(field, 'the field stays open after a lone release').toBeFocused();

  await field.evaluate(el => {
    el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', isComposing: true, bubbles: true, cancelable: true }));
    el.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', code: 'Enter', bubbles: true, cancelable: true }));
  });
  await page.waitForTimeout(200);
  expect(await linksIn(page, 0), 'no link applies after a composing press').toEqual([]);
  await expect(field, 'the field stays open after a composing press').toBeFocused();

  // A press whose release is lost, as one held through a window switch, then an IME's commit: the
  // commit's composing press drops the URL that press kept, so the commit's release applies nothing
  await field.evaluate(el => {
    el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true, cancelable: true }));
    el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Process', code: 'Enter', isComposing: true, bubbles: true, cancelable: true }));
    el.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', code: 'Enter', bubbles: true, cancelable: true }));
  });
  await page.waitForTimeout(200);
  expect(await linksIn(page, 0), "no link applies on an IME's commit after a press whose release was lost").toEqual([]);
  await expect(field, "the field stays open after an IME's commit").toBeFocused();

  // A link applied by Enter, then Link on the next block and a release with no press of its own: the
  // URL Enter's press kept went with the row that closed, so nothing applies to the new selection
  await page.keyboard.press('Enter');
  await expect.poll(() => linksIn(page, 0), 'Enter applies the link').toEqual([['https://example.test/a', 'Before']]);
  await selectStart(page, 1, 'A second'.length);
  await pressLink(page);
  await expect(field).toBeFocused();
  await field.evaluate(el => el.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', code: 'Enter', bubbles: true, cancelable: true })));
  await page.waitForTimeout(200);
  expect(await linksIn(page, 1), 'a release after the row closed applies nothing to the next selection').toEqual([]);
  await expectNoUncaught(extension, page);
});

test("a key pressed while Enter is held in the link field leaves the link as the URL was at Enter's press, and doesn't reach the note", async ({ extension }) => {
  const page = await shortNote(extension);
  await selectStart(page, 0, 'Before'.length);
  await pressLink(page);
  await expect(page.locator('.formatting-toolbar-url:visible')).toBeFocused();
  await page.keyboard.type('https://example.test/a');
  // A key pressed before Enter's release, as in fast typing, goes to the field and is dropped with it
  await page.keyboard.down('Enter');
  await page.keyboard.press('x');
  await page.keyboard.up('Enter');
  await expect.poll(() => linksIn(page, 0), "the link applies the URL as it was at Enter's press").toEqual([['https://example.test/a', 'Before']]);
  await page.waitForTimeout(200);
  expect(await blockContent(page, 0).evaluate(el => el.textContent), "the key pressed during the hold doesn't reach the note").toBe('Before the cards');
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
