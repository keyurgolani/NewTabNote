/**
 * NTN-14 on the built extension: the item the arrow keys pick in the slash menu and the link menu
 * shows it. The pick has the same highlight as an `.active` item while the others don't, and it's
 * the one option the menu's listbox marks `aria-selected`. The link menu, whose ten items are
 * taller than the part of its list that shows, keeps the pick inside that part. Focus stays in the
 * block, so a polite live region says the pick's label and place, such as "Heading 1, 2 of 18",
 * and it's cleared when the menu closes. Each test also fails on an uncaught exception that
 * test/known-defects.json doesn't list.
 */

const { test, expect, expectNoUncaught } = require('./harness');
const driver = require('./characterization/driver');

const NOTES = [
  { name: 'Long note', blocks: Array.from({ length: 40 }, (_, i) => ({ type: 'text', content: `Line ${i + 1} of the long note` })) },
  ...Array.from({ length: 12 }, (_, i) => ({ name: `Project ${String.fromCharCode(65 + i)}`, blocks: [{ type: 'text', content: 'notes' }] })),
];

/** A new tab at 1460x635 on the long note, with the caret at the end of a block near the top of the note */
async function atBlockEnd(extension) {
  await extension.seedOnboarded();
  await driver.seedNotes(extension, NOTES);
  const page = await driver.openNewTab(extension);
  await page.setViewportSize({ width: 1460, height: 635 });
  await driver.openNote(page, 'Long note');
  await page.locator('#editor-container').evaluate(pane => { pane.scrollTop = 400; });
  const index = await page.locator('#editor-container .blocks-container > .block').evaluateAll(blocks => blocks.findIndex(block => {
    const box = block.getBoundingClientRect();
    return box.top >= 45 && box.bottom <= 255;
  }));
  expect(index, 'a block near the top of the note is in view').toBeGreaterThanOrEqual(0);
  await page.locator('#editor-container .blocks-container > .block .block-content').nth(index).click();
  // With a range, since End with the caret already at the line's end scrolls the note to its end
  await page.evaluate(() => {
    const range = document.createRange();
    range.selectNodeContents(document.activeElement);
    range.collapse(false);
    getSelection().removeAllRanges();
    getSelection().addRange(range);
  });
  // Off the menus, so no item is hovered
  await page.mouse.move(1000, 610);
  return page;
}

/**
 * Poll `read` (a function of the menu's picks) until it equals `expected`: an item's background
 * eases to its highlight, so a read right after a key can catch it on the way
 */
function expectPicks(page, selector, read, message) {
  return expect.poll(async () => read(await picks(page, selector)), { message });
}

/**
 * The menu `selector`'s items as primitives: which have `aria-selected="true"`, which have the
 * highlight an `.active` item has, and which sit wholly inside the menu's box. Also the roles a
 * screen reader reads: the list's and its items'.
 */
function picks(page, selector) {
  return page.evaluate(selector => {
    const menu = document.querySelector(selector);
    const list = menu.querySelector('.slash-menu-items');
    const items = [...list.querySelectorAll('.slash-menu-item')];
    // Items styled as `.active` and as neither, for the highlight to compare with
    const styled = className => {
      const probe = list.appendChild(document.createElement('div'));
      probe.className = className;
      const color = getComputedStyle(probe).backgroundColor;
      probe.remove();
      return color;
    };
    const highlight = styled('slash-menu-item active');
    const plain = styled('slash-menu-item');
    const box = menu.getBoundingClientRect();
    const indexes = test => items.flatMap((item, index) => (test(item) ? [index] : []));
    return {
      count: items.length,
      listRole: list.getAttribute('role'),
      itemRoles: [...new Set(items.map(item => item.getAttribute('role')))],
      ariaSelected: indexes(item => item.getAttribute('aria-selected') === 'true'),
      highlighted: highlight === plain ? 'no .active highlight' : indexes(item => getComputedStyle(item).backgroundColor === highlight),
      inView: indexes(item => {
        const at = item.getBoundingClientRect();
        return at.top >= box.top - 0.5 && at.bottom <= box.bottom + 0.5;
      }),
    };
  }, selector);
}

test('the slash menu highlights the item the arrow keys pick and marks it selected for screen readers', async ({ extension }) => {
  const page = await atBlockEnd(extension);
  await page.keyboard.press('Enter');
  await page.keyboard.press('/');
  await expect(page.locator('#slash-menu')).toBeVisible();
  const menu = '#slash-menu';
  const pick = at => ({ highlighted: at.highlighted, ariaSelected: at.ariaSelected });

  await expectPicks(page, menu, pick, 'the first item is picked when the menu opens').toEqual({ highlighted: [0], ariaSelected: [0] });

  for (let i = 0; i < 3; i++) await page.keyboard.press('ArrowDown');
  await expectPicks(page, menu, pick, 'ArrowDown three times picks the fourth').toEqual({ highlighted: [3], ariaSelected: [3] });

  const at = await picks(page, menu);
  const last = at.count - 1;
  for (let i = 3; i < last; i++) await page.keyboard.press('ArrowDown');
  await expectPicks(page, menu, read => ({ ...pick(read), lastInView: read.inView.includes(last) }), 'the last item, picked, is in view')
    .toEqual({ highlighted: [last], ariaSelected: [last], lastInView: true });

  expect({ listRole: at.listRole, itemRoles: at.itemRoles }, 'a listbox of options').toEqual({ listRole: 'listbox', itemRoles: ['option'] });
  await expectNoUncaught(extension, page);
});

test('the link menu keeps the item the arrow keys pick inside the part of its list that shows', async ({ extension }) => {
  const page = await atBlockEnd(extension);
  await page.keyboard.type(' [[');
  await expect(page.locator('#wiki-menu')).toBeVisible();
  const menu = '#wiki-menu';
  const pickShown = index => read => ({ shown: read.inView.includes(index), highlighted: read.highlighted, ariaSelected: read.ariaSelected });

  const at = await picks(page, menu);
  expect(at.count, 'the link menu lists ten notes').toBe(10);
  expect(at.inView.length, 'fewer than ten items show at once').toBeLessThan(10);

  for (let i = 0; i < 9; i++) await page.keyboard.press('ArrowDown');
  await expectPicks(page, menu, pickShown(9), 'the tenth item is picked and shows').toEqual({ shown: true, highlighted: [9], ariaSelected: [9] });

  // ArrowDown from the last goes round to the first
  await page.keyboard.press('ArrowDown');
  await expectPicks(page, menu, pickShown(0), 'the first item is picked again and shows').toEqual({ shown: true, highlighted: [0], ariaSelected: [0] });

  expect({ listRole: at.listRole, itemRoles: at.itemRoles }, 'a listbox of options').toEqual({ listRole: 'listbox', itemRoles: ['option'] });
  await expectNoUncaught(extension, page);
});

/** What the live region says, whether it's polite, and whether it's out of sight; null when there's none */
function said(page) {
  return page.evaluate(() => {
    const live = document.getElementById('menu-pick-live');
    if (!live) return null;
    const box = live.getBoundingClientRect();
    return { text: live.textContent, polite: live.getAttribute('aria-live') === 'polite', unseen: box.width <= 1 && box.height <= 1 };
  });
}

/** The label of the menu's item at `index`, and its place, as the live region should say them */
function placeOf(page, selector, index) {
  return page.evaluate(([selector, index]) => {
    const items = document.querySelectorAll(`${selector} .slash-menu-item`);
    return `${items[index].querySelector('.slash-menu-item-title').textContent}, ${index + 1} of ${items.length}`;
  }, [selector, index]);
}

test("a live region reads out the arrow keys' pick in either menu, and is cleared when the menu closes", async ({ extension }) => {
  const page = await atBlockEnd(extension);
  await page.keyboard.press('Enter');
  await page.keyboard.press('/');
  await expect(page.locator('#slash-menu')).toBeVisible();
  for (let i = 0; i < 3; i++) await page.keyboard.press('ArrowDown');
  expect(await said(page), 'after ArrowDown in the slash menu').toEqual({ text: await placeOf(page, '#slash-menu', 3), polite: true, unseen: true });
  await page.keyboard.press('Escape');
  await expect(page.locator('#slash-menu')).toBeHidden();
  expect(await said(page), 'once the slash menu closes').toEqual({ text: '', polite: true, unseen: true });

  await page.keyboard.type('[[');
  await expect(page.locator('#wiki-menu')).toBeVisible();
  for (let i = 0; i < 2; i++) await page.keyboard.press('ArrowDown');
  expect(await said(page), 'after ArrowDown in the link menu').toEqual({ text: await placeOf(page, '#wiki-menu', 2), polite: true, unseen: true });
  await page.keyboard.press('Escape');
  await expect(page.locator('#wiki-menu')).toBeHidden();
  expect(await said(page), 'once the link menu closes').toEqual({ text: '', polite: true, unseen: true });
  await expectNoUncaught(extension, page);
});
