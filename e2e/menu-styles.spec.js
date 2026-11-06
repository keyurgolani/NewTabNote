/**
 * #203 on the built extension, at 1440 by 900: the block menu's AI items (Rewrite, Expand,
 * Summarize, Translate) look and hover as its other items do, and the AI insights' action list
 * keeps its cards. Both build their items with the class ai-action-item and their icons with
 * ai-action-icon. The list's rules for the two came later in css/editor.css than the menu's, at the
 * same weight, so they reached the menu too: there the four AI items sat on grey chips, and the
 * menu's hover barely showed on them. The list's rules now name the list.
 *
 * - In the block menu, Rewrite reads as Turn into... does, at rest and hovered: its background,
 *   padding, corners, alignment and line height. Its icon sits on the item's centre line, in the
 *   item's color.
 * - In the insights' action list, an item keeps its card: the secondary background, its padding
 *   and its 6 px corners, with its icon 2 px down.
 * Each test also fails on an uncaught exception that test/known-defects.json doesn't list.
 */

const { test, expect, expectNoUncaught } = require('./harness');
const driver = require('./characterization/driver');

const NOTE = { name: 'Menu styles', blocks: [{ type: 'text', content: 'A first line' }, { type: 'text', content: 'A second line' }] };
// What the list's card set on the menu's AI items, and what the menu's items share
const LOOK = ['background-color', 'padding-top', 'padding-right', 'padding-bottom', 'padding-left', 'border-top-left-radius', 'border-bottom-right-radius', 'align-items', 'line-height', 'font-size'];

/**
 * The computed values of `names` for the element the locator finds. Runs in the page.
 * @param {import('@playwright/test').Locator} locator
 * @param {string[]} names
 */
const look = (locator, names = LOOK) => locator.evaluate((el, list) => Object.fromEntries(list.map(name => [name, getComputedStyle(el).getPropertyValue(name)])), names);

/** A new tab at 1440 by 900 on "Menu styles" */
async function openMenuStyles(extension) {
  await extension.seedOnboarded();
  await driver.seedNotes(extension, [NOTE]);
  const page = await driver.openNewTab(extension);
  await page.setViewportSize({ width: 1440, height: 900 });
  await expect(page.locator('#editor-container .page-title')).toHaveText(NOTE.name);
  return page;
}

test("the block menu's AI items look and hover as its other items do", async ({ extension }) => {
  test.setTimeout(60_000);
  const page = await openMenuStyles(extension);
  // A text block's menu, which has the AI items, opened with a click on its handle
  await page.locator('#editor-container .blocks-container > .block').first().locator('.block-handle').click();
  const menu = page.locator('.block-action-menu');
  await expect(menu).toBeVisible();
  const turnInto = menu.locator('.context-menu-item', { hasText: 'Turn into...' });
  const rewrite = menu.locator('.context-menu-item', { hasText: 'Rewrite' });
  await expect(rewrite).toBeVisible();

  // At rest, with the pointer off the menu: a hover fades in over the items' 0.2 s transition
  await page.mouse.move(1430, 890);
  await expect.poll(() => look(rewrite), "Rewrite at rest reads as Turn into... does").toEqual(await look(turnInto));
  const icon = await rewrite.locator('.ai-action-icon').evaluate(el => ({ marginTop: getComputedStyle(el).marginTop, color: getComputedStyle(el).color, item: getComputedStyle(el.parentElement).color }));
  expect.soft(icon.marginTop, "Rewrite's icon sits on the item's centre line").toBe('0px');
  expect.soft(icon.color, "Rewrite's icon is in the item's color").toBe(icon.item);

  // Hovered: Turn into... is read once its background's transition ends, and Rewrite until it matches
  await turnInto.hover();
  await expect.poll(() => turnInto.evaluate(el => el.getAnimations().length), "Turn into...'s hover color settles").toBe(0);
  const hovered = await look(turnInto);
  expect(hovered['background-color'], 'Turn into... hovered takes the hover color').not.toBe('rgba(0, 0, 0, 0)');
  await rewrite.hover();
  await expect.poll(() => look(rewrite), 'Rewrite hovered reads as Turn into... hovered').toEqual(hovered);
  await expectNoUncaught(extension, page);
});

test("the AI insights' action items keep their cards", async ({ extension }) => {
  test.setTimeout(60_000);
  const page = await openMenuStyles(extension);
  await page.evaluate(() => app.aiChatController.renderSmartInsights({ todos: ['Call Sam'] }));
  const item = page.locator('#ai-extracted-actions .ai-action-item');
  await expect(item).toHaveCount(1);
  const card = await look(item, ['background-color', 'padding-top', 'padding-right', 'padding-bottom', 'padding-left', 'border-top-left-radius', 'align-items']);
  const secondary = await page.evaluate(() => {
    const probe = document.body.appendChild(document.createElement('div'));
    probe.style.background = 'var(--bg-secondary)';
    const color = getComputedStyle(probe).backgroundColor;
    probe.remove();
    return color;
  });
  expect.soft(card, 'an action item is a card').toEqual({
    'background-color': secondary,
    'padding-top': '8px',
    'padding-right': '12px',
    'padding-bottom': '8px',
    'padding-left': '12px',
    'border-top-left-radius': '6px',
    'align-items': 'flex-start',
  });
  const icon = await item.locator('.ai-action-icon').evaluate(el => ({ marginTop: getComputedStyle(el).marginTop }));
  expect.soft(icon.marginTop, "an action item's icon sits 2 px down, beside the text's first line").toBe('2px');
  await expectNoUncaught(extension, page);
});
