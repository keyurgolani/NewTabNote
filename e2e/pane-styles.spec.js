/**
 * #189 on the built extension, at 1440 by 900: split view's right pane and the pop-out show the
 * note's title, its column and its pane's padding as the main pane does. css/editor.css styled those
 * parts by the main pane's IDs, which the right pane and the pop-out don't have, so there the title
 * read as body text, the blocks sat against the pane's edge, and a block's handle sat outside the
 * pane, where a click landed in the left pane. The rules go by the classes all three editors carry.
 *
 * - In split view, the right pane's padding, its column's width and inset, its title's type and its
 *   outline with focus, its empty title's placeholder and its blocks' minimum height read as the main
 *   pane's, and a click on one of its blocks' handles opens that block's menu. In focus mode, its
 *   padding and its column read as the main pane's too.
 * - The pop-out reads as the main pane does, its padding included, once its copy of the page's
 *   stylesheet applies, and its pane has no transition to ease that padding in with.
 * - The main pane reads as it did, in single view and in focus mode, and its focused title shows no
 *   outline. The page's focus ring and the title's rule tie now, and the title's wins by coming later.
 * - #207: wherever the note's column fills its pane, a block's handle still lies inside the pane. That
 *   covers split view at 1440, both panes stacked at 500 by 600, and the pop-out at its 500 by 600,
 *   on touch devices too. The handle sits 28 px left of its block (44 px wide, 48 px out, on touch),
 *   past the pane's 24 px padding, so the column keeps the difference clear on each side.
 * Each test also fails on an uncaught exception that test/known-defects.json doesn't list.
 */

const { test, expect, expectNoUncaught } = require('./harness');
const driver = require('./characterization/driver');

const RIGHT_PANE = { name: 'Right pane', blocks: [{ type: 'text', content: 'The right pane first line' }, { type: 'text', content: 'A second line' }] };
const PANE_STYLES = {
  name: 'Pane styles',
  blocks: [
    { type: 'h1', content: 'A heading' },
    { type: 'text', content: 'A first line' },
    { type: 'text', content: 'A second line' },
    { type: 'todo', content: 'A task' },
    { type: 'code', content: 'const pane = 1;' },
    { type: 'table', content: '', tableData: [['a', 'b'], ['1', '2']], rows: 2, cols: 2 },
  ],
};
const MAIN = '#editor-container';
const RIGHT = '#secondary-editor-container';

/** A new tab at 1440 by 900 on "Pane styles", with "Right pane" the other note for split view */
async function openPaneStyles(extension) {
  await extension.seedOnboarded();
  // The note seeded last is the newest, and the new tab opens it
  await driver.seedNotes(extension, [RIGHT_PANE, PANE_STYLES]);
  const page = await driver.openNewTab(extension);
  await page.setViewportSize({ width: 1440, height: 900 });
  await expect(page.locator(`${MAIN} .page-title`)).toHaveText(PANE_STYLES.name);
  await expect(page.locator(`${MAIN} .blocks-container > .block`)).toHaveCount(PANE_STYLES.blocks.length);
  return page;
}

/**
 * How far the handle of the `index`th block in the pane `selector` finds reaches past the pane's
 * padding box, at its left, in px: 0 when the handle lies inside the pane. Runs in the page.
 * @param {[string, number]} args
 */
function handleOut([selector, index]) {
  const pane = document.querySelector(selector);
  const handle = pane.querySelectorAll('.blocks-container > .block')[index].querySelector('.block-handle').getBoundingClientRect();
  return Math.max(0, Math.round((pane.getBoundingClientRect().left + pane.clientLeft - handle.left) * 100) / 100);
}

/** Close the sidebar when it covers the workspace, as it does over the panes under 768 px */
async function closeSidebarOver(page) {
  const covered = () => page.evaluate(() => !document.elementFromPoint(innerWidth / 2, innerHeight / 2).closest('#workspace-container'));
  if (!(await covered())) return;
  await page.getByRole('button', { name: 'Toggle Sidebar' }).first().click();
  await expect.poll(covered, 'the sidebar no longer covers the panes').toBe(false);
}

/**
 * What #189 moves, for the editor whose pane is `pane`, in the pane's own window: the pane's
 * padding; the column's max-width, its margins, its inset from the pane's inner edge, and its width;
 * the title's type, and its outline with focus; the placeholder an empty title shows; and the blocks'
 * minimum height. Focus goes to the title by script, which leaves the active pane as it is, and goes
 * back where it was. The title's text is cleared and put back with no input event, so nothing saves.
 * Runs in the page.
 * @param {HTMLElement} pane
 */
function readPane(pane) {
  const doc = pane.ownerDocument;
  const view = doc.defaultView;
  const column = pane.querySelector('.editor');
  const title = pane.querySelector('.page-title');
  const blocks = pane.querySelector('.blocks-container');
  const styles = (el, names, pseudo = null) => Object.fromEntries(names.map(name => [name, view.getComputedStyle(el, pseudo).getPropertyValue(name)]));
  const box = pane.getBoundingClientRect();
  const col = column.getBoundingClientRect();

  const before = doc.activeElement;
  title.focus({ preventScroll: true });
  const outlineWithFocus = view.getComputedStyle(title).getPropertyValue('outline-style');
  if (before && before !== title && before !== doc.body && typeof before.focus === 'function') before.focus({ preventScroll: true });
  else title.blur();

  const text = title.textContent;
  title.textContent = '';
  const placeholder = styles(title, ['content', 'color'], '::before');
  title.textContent = text;

  return {
    pane: styles(pane, ['padding-top', 'padding-right', 'padding-bottom', 'padding-left']),
    column: {
      ...styles(column, ['max-width', 'margin-left', 'margin-right']),
      inset: Math.round(col.left - box.left - pane.clientLeft),
      width: Math.round(col.width),
    },
    title: { ...styles(title, ['font-size', 'font-weight', 'line-height', 'margin-bottom', 'color']), 'outline-style with focus': outlineWithFocus },
    placeholder,
    blocks: styles(blocks, ['min-height']),
  };
}

test("split view's right pane shows the note's title, its column and its padding as the main pane does, and its blocks' handles take a click", async ({ extension }) => {
  test.setTimeout(60_000);
  const page = await openPaneStyles(extension);
  await driver.openSplitView(page);
  await expect(page.locator(`${RIGHT} .page-title`)).toHaveText(RIGHT_PANE.name);
  await expect(page.locator(`${RIGHT} .blocks-container > .block`)).toHaveCount(RIGHT_PANE.blocks.length);
  // Both panes half the workspace wide, as split view lays them out
  const widths = () => page.evaluate(([main, right]) => {
    const half = Math.round(document.getElementById('workspace-container').getBoundingClientRect().width / 2);
    return [main, right].map(id => Math.round(document.querySelector(id).getBoundingClientRect().width) === half);
  }, [MAIN, RIGHT]);
  await expect.poll(widths, 'both panes are half the workspace wide').toEqual([true, true]);
  // Both notes are short enough that no pane scrolls, so no scrollbar takes width from a column
  const fit = await page.evaluate(panes => panes.map(id => document.querySelector(id).scrollHeight <= document.querySelector(id).clientHeight), [MAIN, RIGHT]);
  expect(fit, 'neither pane scrolls').toEqual([true, true]);

  const main = await page.locator(MAIN).evaluate(readPane);
  const right = await page.locator(RIGHT).evaluate(readPane);
  expect.soft(right.pane, "the right pane's padding").toEqual(main.pane);
  expect.soft(right.column['max-width'], "the right pane's column's max-width").toBe(main.column['max-width']);
  expect.soft(right.column.inset, "the right pane's column's inset from the pane's edge").toBe(main.column.inset);
  // The right pane has a 1 px left border, at the divider, that the main pane doesn't
  expect.soft(Math.abs(right.column.width - main.column.width), "the right pane's column's width, within its left border").toBeLessThanOrEqual(1);
  expect.soft(right.title, "the right pane's title").toEqual(main.title);
  expect.soft(right.placeholder, "the right pane's empty title's placeholder").toEqual(main.placeholder);
  expect.soft(right.blocks, "the right pane's blocks' minimum height").toEqual(main.blocks);

  // A click where the right pane's second block's handle is drawn, as the pointer gives it
  const handle = page.locator(`${RIGHT} .blocks-container > .block`).nth(1).locator('.block-handle');
  const at = await handle.boundingBox();
  await page.mouse.click(at.x + at.width / 2, at.y + at.height / 2);
  await expect(page.locator('.block-action-menu'), "a click on the right pane's block handle opens the block's menu").toBeVisible();
  await expect(page.locator(RIGHT), 'and makes the right pane the active one').toHaveClass(/\bactive\b/);

  // Focus mode reaches the right pane too. Both panes' padding moves over their 0.3 s transition,
  // so the main pane's is read once it ends, and the right pane's until it matches
  await page.locator('#header').getByRole('button', { name: 'Toggle Focus Mode', exact: true }).click();
  await expect(page.locator('body')).toHaveClass(/\bfocus-mode\b/);
  await expect.poll(() => page.locator(MAIN).evaluate(pane => getComputedStyle(pane).paddingBottom), "the main pane's padding in focus mode").toBe('140px');
  const focusedMain = await page.locator(MAIN).evaluate(readPane);
  await expect.poll(async () => (await page.locator(RIGHT).evaluate(readPane)).pane, "the right pane's padding in focus mode").toEqual(focusedMain.pane);
  const focusedRight = await page.locator(RIGHT).evaluate(readPane);
  expect.soft(focusedRight.column['max-width'], "the right pane's column's max-width in focus mode").toBe(focusedMain.column['max-width']);
  expect.soft(Math.abs(focusedRight.column.width - focusedMain.column.width), "the right pane's column's width in focus mode, within its left border").toBeLessThanOrEqual(1);
  await expectNoUncaught(extension, page);
});

test("the pop-out shows the note's title, its column and its padding as the main pane does", async ({ extension }) => {
  test.setTimeout(60_000);
  const page = await openPaneStyles(extension);
  const main = await page.locator(MAIN).evaluate(readPane);

  const [pip] = await Promise.all([extension.context.waitForEvent('page'), page.locator('#pip-toggle').click()]);
  await expect.poll(() => page.evaluate(() => Boolean(app.tabController.pipEditor && app.tabController.pipEditor.blocks.length > 0))).toBe(true);
  await expect(pip.locator('.page-title')).toHaveText(PANE_STYLES.name);
  // The pop-out links the page's stylesheet again, so its rules apply once that link loads. The
  // timestamp's size is a class rule on every build
  await expect.poll(() => pip.locator('.page-timestamp').evaluate(el => getComputedStyle(el).fontSize), "the pop-out's copy of the page's stylesheet applies").toBe('13px');

  const popout = await pip.locator('.pip-editor-wrapper').evaluate(readPane);
  // Its pane is in the window before the stylesheet applies, so a transition would ease its padding in
  expect.soft(await pip.locator('.pip-editor-wrapper').evaluate(pane => getComputedStyle(pane).transitionDuration), "the pop-out's pane eases nothing in").toBe('0s');
  expect.soft(popout.pane, "the pop-out's padding").toEqual(main.pane);
  expect.soft(popout.column['max-width'], "the pop-out's column's max-width").toBe(main.column['max-width']);
  expect.soft(popout.title, "the pop-out's title").toEqual(main.title);
  expect.soft(popout.placeholder, "the pop-out's empty title's placeholder").toEqual(main.placeholder);
  expect.soft(popout.blocks, "the pop-out's blocks' minimum height").toEqual(main.blocks);
  await expectNoUncaught(extension, page);
  await pip.close().catch(() => {});
});

test("the main pane's title, column, padding and blocks read as before, in single view and in focus mode", async ({ extension }) => {
  test.setTimeout(60_000);
  const page = await openPaneStyles(extension);
  const single = await page.locator(MAIN).evaluate(readPane);
  expect.soft(single.pane, "the main pane's padding").toEqual({ 'padding-top': '48px', 'padding-right': '24px', 'padding-bottom': '100px', 'padding-left': '24px' });
  expect.soft(single.column['max-width'], "the main column's max-width").toBe('720px');
  expect.soft(single.column.width, "the main column's width").toBe(720);
  expect.soft(single.column['margin-left'], 'the main column is centred').toBe(single.column['margin-right']);
  expect.soft(parseFloat(single.column['margin-left']), 'the main column is centred, with room each side').toBeGreaterThan(0);
  const type = Object.fromEntries(['font-size', 'font-weight', 'line-height', 'margin-bottom'].map(name => [name, single.title[name]]));
  expect.soft(type, "the main title's type").toEqual({ 'font-size': '40px', 'font-weight': '700', 'line-height': '48px', 'margin-bottom': '8px' });
  expect.soft(single.title['outline-style with focus'], 'the main title shows no outline with focus').toBe('none');
  expect.soft(single.placeholder.content, "the main title's placeholder").toBe('"Untitled"');
  expect.soft(single.blocks, "the main pane's blocks' minimum height").toEqual({ 'min-height': '200px' });

  await page.locator('#header').getByRole('button', { name: 'Toggle Focus Mode', exact: true }).click();
  await expect(page.locator('body')).toHaveClass(/\bfocus-mode\b/);
  // A pane's padding moves over its 0.3 s transition, so this waits for where it ends
  const focused = () => page.locator(MAIN).evaluate(readPane);
  await expect.poll(async () => (await focused()).pane, "the main pane's padding in focus mode").toEqual({ 'padding-top': '72px', 'padding-right': '24px', 'padding-bottom': '140px', 'padding-left': '24px' });
  const inFocus = await focused();
  expect.soft(inFocus.column['max-width'], "the main column's max-width in focus mode").toBe('min(760px, 100%)');
  expect.soft(inFocus.column.width, "the main column's width in focus mode").toBe(760);
  await expectNoUncaught(extension, page);
});

test("a block's handle lies inside its pane wherever the note's column fills the pane, on touch devices too", async ({ extension }) => {
  test.setTimeout(90_000);
  const page = await openPaneStyles(extension);
  const out = (pane, index = 1) => page.evaluate(handleOut, [pane, index]);
  const hover = (pane, index = 1) => page.locator(`${pane} .blocks-container > .block`).nth(index).locator('.block-content').hover();
  // A touch device's handle is 44 px wide, 48 px left of its block (js/editor.js sets the class)
  const touch = (target, on) => target.evaluate(value => document.body.classList.toggle('touch-device', value), on);

  // Split view at 1440 by 900: each pane is half the workspace, so the column fills it
  await driver.openSplitView(page);
  await expect(page.locator(`${RIGHT} .blocks-container > .block`)).toHaveCount(RIGHT_PANE.blocks.length);
  await hover(MAIN);
  expect.soft(await out(MAIN), "the main pane's handle in split view at 1440").toBe(0);
  await hover(RIGHT);
  expect.soft(await out(RIGHT), "the right pane's handle in split view at 1440").toBe(0);

  // At 500 by 600 split view stacks its panes, each the window's width
  await page.setViewportSize({ width: 500, height: 600 });
  await closeSidebarOver(page);
  await hover(MAIN);
  expect.soft(await out(MAIN), "the main pane's handle at 500 by 600").toBe(0);
  await hover(RIGHT);
  expect.soft(await out(RIGHT), "the right pane's handle at 500 by 600").toBe(0);
  await touch(page, true);
  expect.soft(await out(MAIN), "the main pane's touch handle at 500 by 600").toBe(0);
  expect.soft(await out(RIGHT), "the right pane's touch handle at 500 by 600").toBe(0);
  await touch(page, false);
  await driver.closeSplitView(page);

  // The pop-out at the 500 by 600 the product asks for (js/controllers/tab-controller.js)
  const [pip] = await Promise.all([extension.context.waitForEvent('page'), page.locator('#pip-toggle').click()]);
  await expect.poll(() => page.evaluate(() => Boolean(app.tabController.pipEditor && app.tabController.pipEditor.blocks.length > 0))).toBe(true);
  await expect.poll(() => pip.locator('.page-timestamp').evaluate(el => getComputedStyle(el).fontSize), "the pop-out's copy of the page's stylesheet applies").toBe('13px');
  await pip.setViewportSize({ width: 500, height: 600 });
  await pip.locator('.pip-editor-wrapper .blocks-container > .block').nth(1).locator('.block-content').hover();
  expect.soft(await pip.evaluate(handleOut, ['.pip-editor-wrapper', 1]), "the pop-out's handle at 500 by 600").toBe(0);
  await touch(pip, true);
  expect.soft(await pip.evaluate(handleOut, ['.pip-editor-wrapper', 1]), "the pop-out's touch handle at 500 by 600").toBe(0);
  await expectNoUncaught(extension, page);
  await pip.close().catch(() => {});
});
