/**
 * NTN-14 on the built extension: the slash menu opens at its block. Its left edge is at the
 * block's left, its top is just under the block (or near the window's bottom edge, its bottom
 * just above the block), and all of it is inside the window. That holds with the sidebar open or
 * closed and the note scrolled or at its top, at 1460 and 800 px wide, and in split view's right
 * pane. With room under the block, it opens under it. Opening the menu, and moving through it
 * with the arrow keys, leave the note where it was. The link menu ("[[") opens the same way under
 * the caret, and the template menu under its block. Each test also fails on an uncaught exception
 * that test/known-defects.json doesn't list.
 */

const { test, expect, expectNoUncaught } = require('./harness');
const driver = require('./characterization/driver');

const NOTES = [
  { name: 'Long note', blocks: Array.from({ length: 40 }, (_, i) => ({ type: 'text', content: `Line ${i + 1} of the long note` })) },
  { name: 'Packing', blocks: Array.from({ length: 30 }, (_, i) => ({ type: 'text', content: `Item ${i + 1} to pack` })) },
  { name: 'Weekly plan', isTemplate: true, blocks: [{ type: 'text', content: 'plan' }] },
];
const SIZES = [{ width: 1460, height: 635 }, { width: 800, height: 635 }];
const PANES = { left: '#editor-container', right: '#secondary-editor-container' };
const SLASH_MENU = { left: '#slash-menu', right: `${PANES.right} .slash-menu:not(.wiki-menu):not(.template-menu)` };
/** How far a scrolled note is scrolled, and the room a block needs under it for a new block and the menu under that */
const SCROLL = 400;
const ROOM = 380;

/** A new tab at `size` on the long note, with the sidebar open, as it starts */
async function openLongNote(extension, size) {
  await extension.seedOnboarded();
  await driver.seedNotes(extension, NOTES);
  const page = await driver.openNewTab(extension);
  await page.setViewportSize(size);
  await driver.openNote(page, 'Long note');
  return page;
}

const scrollTopOf = (page, side = 'left') => page.locator(PANES[side]).evaluate(pane => pane.scrollTop);

/** Scroll a pane's note to `top` */
async function scrollNote(page, top, side = 'left') {
  await page.locator(PANES[side]).evaluate((pane, to) => { pane.scrollTop = to; }, top);
  await expect.poll(() => scrollTopOf(page, side), 'the note scrolls').toBe(top);
}

/** Close the sidebar with its toggle, and wait until the note's pane starts at the window's left */
async function closeSidebar(page) {
  await page.locator('#sidebar-toggle').click();
  await expect(page.locator('#sidebar')).toHaveClass(/collapsed/);
  await expect.poll(() => page.locator(PANES.left).evaluate(pane => Math.round(pane.getBoundingClientRect().left))).toBe(0);
}

/**
 * The index of the first block whole in a pane's view with `room` px of the window under it, or
 * with `nearBottom`, of the last block whole in view
 */
function pickBlock(page, side, { room = 0, nearBottom = false } = {}) {
  return page.locator(`${PANES[side]} .blocks-container > .block`).evaluateAll((blocks, [room, nearBottom]) => {
    const pane = blocks[0].closest('.editor-pane').getBoundingClientRect();
    const whole = blocks.map((block, index) => ({ index, box: block.getBoundingClientRect() }))
      .filter(({ box }) => box.top >= pane.top && box.bottom <= Math.min(pane.bottom, innerHeight));
    const chosen = nearBottom ? whole[whole.length - 1] : whole.find(({ box }) => box.bottom <= innerHeight - room);
    return chosen ? chosen.index : -1;
  }, [room, nearBottom]);
}

/**
 * Click into a pane's block at `index` and put the caret at the end of its text. That's done with
 * a range, since End with the caret already at the line's end scrolls the note to its end.
 */
async function clickBlockEnd(page, index, side = 'left') {
  expect(index, 'a block to click is in view').toBeGreaterThanOrEqual(0);
  await page.locator(`${PANES[side]} .blocks-container > .block .block-content`).nth(index).click();
  await page.evaluate(() => {
    const range = document.createRange();
    range.selectNodeContents(document.activeElement);
    range.collapse(false);
    getSelection().removeAllRanges();
    getSelection().addRange(range);
  });
}

/**
 * From the end of a pane's block at `index`, a new empty block under it, with "/" typed in it.
 * Returns how far the pane's note was scrolled just before the "/".
 */
async function openSlashMenuUnder(page, index, side = 'left') {
  await clickBlockEnd(page, index, side);
  await page.keyboard.press('Enter');
  await expect.poll(() => page.evaluate(() => document.activeElement.classList.contains('block-content') && document.activeElement.textContent))
    .toBe('');
  const before = await scrollTopOf(page, side);
  await page.keyboard.press('/');
  await expect(page.locator(SLASH_MENU[side])).toBeVisible();
  return before;
}

/**
 * Where the menu `selector` is against the block the caret is in (with `caret`, the caret
 * itself): its left less the anchor's left, its top less the anchor's bottom, the anchor's top
 * less its bottom, and whether all of it is inside the window
 */
function placement(page, selector, { caret = false } = {}) {
  return page.evaluate(([selector, caret]) => {
    const round = n => Math.round(n * 10) / 10;
    const box = document.querySelector(selector).getBoundingClientRect();
    const anchor = caret ? getSelection().getRangeAt(0).getBoundingClientRect() : document.activeElement.closest('.block').getBoundingClientRect();
    return {
      dx: round(box.left - anchor.left),
      under: round(box.top - anchor.bottom),
      above: round(anchor.top - box.bottom),
      inside: box.left >= 0 && box.top >= 0 && box.right <= innerWidth && box.bottom <= innerHeight,
    };
  }, [selector, caret]);
}

/**
 * The menu is at its anchor: its left edge within 2 px of the anchor's left, and its top 0 to 8 px
 * under the anchor (`where` 'under') or its bottom 0 to 8 px above it ('above'), and all of it
 * inside the window. Without `where`, either side passes.
 */
function expectAtAnchor(at, label, where = at.under >= -0.5 ? 'under' : 'above') {
  const gap = at[where];
  expect({ left: Math.abs(at.dx) <= 2, [where]: gap >= -0.5 && gap <= 8, inside: at.inside }, `${label} at ${JSON.stringify(at)}`)
    .toEqual({ left: true, [where]: true, inside: true });
}

for (const size of SIZES) {
  const at = `${size.width}x${size.height}`;

  for (const sidebarOpen of [true, false]) {
    for (const scrolled of [true, false]) {
      const state = `with the sidebar ${sidebarOpen ? 'open' : 'closed'} and the note ${scrolled ? 'scrolled' : 'at its top'}, at ${at}`;

      test(`the slash menu opens at its block ${state}`, async ({ extension }) => {
        const page = await openLongNote(extension, size);
        await expect(page.locator('#sidebar'), 'the sidebar starts open').not.toHaveClass(/collapsed/);
        if (!sidebarOpen) await closeSidebar(page);
        if (scrolled) await scrollNote(page, SCROLL);
        else expect(await scrollTopOf(page), 'the note is at its top').toBe(0);
        // Scrolled, the block has room under it for the menu. At the top it's the note's first block, under the title and the export notice.
        const before = await openSlashMenuUnder(page, await pickBlock(page, 'left', { room: scrolled ? ROOM : 0 }));
        expect(await scrollTopOf(page), 'opening the menu leaves the note where it was').toBe(before);
        expectAtAnchor(await placement(page, SLASH_MENU.left), 'the slash menu', scrolled ? 'under' : undefined);
        await expectNoUncaught(extension, page);
      });
    }
  }

  test(`in split view, the right pane's slash menu opens at its block, at ${at}`, async ({ extension }) => {
    const page = await openLongNote(extension, size);
    await driver.openSplitView(page);
    await scrollNote(page, 100, 'right');
    const before = await openSlashMenuUnder(page, await pickBlock(page, 'right'), 'right');
    expect(await scrollTopOf(page, 'right'), 'opening the menu leaves the note where it was').toBe(before);
    expectAtAnchor(await placement(page, SLASH_MENU.right), "the right pane's slash menu");
    await expectNoUncaught(extension, page);
  });
}

test("near the window's bottom edge, the slash menu opens above its block, inside the window", async ({ extension }) => {
  const page = await openLongNote(extension, SIZES[0]);
  const before = await openSlashMenuUnder(page, await pickBlock(page, 'left', { nearBottom: true }));
  expect(await scrollTopOf(page), 'opening the menu leaves the note where it was').toBe(before);
  expectAtAnchor(await placement(page, SLASH_MENU.left), 'the slash menu', 'above');
  await expectNoUncaught(extension, page);
});

test('moving through the slash menu with the arrow keys keeps it at its block, and the note stays where it was', async ({ extension }) => {
  const page = await openLongNote(extension, SIZES[0]);
  await scrollNote(page, SCROLL);
  const before = await openSlashMenuUnder(page, await pickBlock(page, 'left', { room: ROOM }));
  const items = page.locator('#slash-menu .slash-menu-item');
  const count = await items.count();
  for (let i = 1; i < count; i++) await page.keyboard.press('ArrowDown');
  const last = await items.last().evaluate(item => {
    const menu = item.closest('.slash-menu').getBoundingClientRect();
    const box = item.getBoundingClientRect();
    return { selected: item.classList.contains('selected'), inMenu: box.top >= menu.top - 0.5 && box.bottom <= menu.bottom + 0.5 };
  });
  expect(last, 'the last item is selected and shown in the menu').toEqual({ selected: true, inMenu: true });
  expect(await scrollTopOf(page), 'the note stays where it was').toBe(before);
  expectAtAnchor(await placement(page, SLASH_MENU.left), 'the slash menu', 'under');
  await expectNoUncaught(extension, page);
});

test('the link menu opens under the caret, with the sidebar open and the note scrolled', async ({ extension }) => {
  const page = await openLongNote(extension, SIZES[0]);
  await scrollNote(page, SCROLL);
  await clickBlockEnd(page, await pickBlock(page, 'left', { room: ROOM }));
  await page.keyboard.type(' [[');
  await expect(page.locator('#wiki-menu')).toBeVisible();
  expectAtAnchor(await placement(page, '#wiki-menu', { caret: true }), 'the link menu', 'under');
  await expectNoUncaught(extension, page);
});

test('the template menu opens under its block, with the sidebar open and the note scrolled', async ({ extension }) => {
  const page = await openLongNote(extension, SIZES[0]);
  await scrollNote(page, SCROLL);
  await clickBlockEnd(page, await pickBlock(page, 'left', { room: ROOM }));
  // Nothing in 1.4.x opens the template menu by typing (e2e/characterization/overlays.spec.js), so it opens as the editor would open it
  await page.evaluate(async () => {
    app.editor.templates = await Storage.getTemplates();
    app.editor.showTemplateMenu(document.activeElement.closest('.block'));
  });
  await expect(page.locator('#template-menu')).toBeVisible();
  expectAtAnchor(await placement(page, '#template-menu'), 'the template menu', 'under');
  await expectNoUncaught(extension, page);
});
