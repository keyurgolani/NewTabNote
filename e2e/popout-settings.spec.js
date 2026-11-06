/**
 * #198 on the built extension: the pop-out takes the page's width, font and theme settings. They
 * live on the page's <html>: data-width, data-font and data-theme, which the stylesheet reads, with
 * the theme's variables inline. The pop-out copied only that element's inline style and class, once,
 * as it opened, so its column took the default 720 px, its text the default font, and rules keyed to
 * the dark theme, as a highlight's color, didn't apply. Now its <html> takes every attribute the
 * page's has, as it opens and whenever one changes while it's open.
 *
 * - With Wide, Serif and the dark theme set before it opens, the pop-out's column, its title's font
 *   and a highlight's color read as the main pane's, and its <html> has the page's lang.
 * - While it's open, a width picked from the header's buttons reaches it, and so does a switch to
 *   the dark theme and back to light, which takes data-theme off the page's <html>.
 * The pop-out stays at the harness's 1280 by 800, so Wide has room.
 * Each test also fails on an uncaught exception that test/known-defects.json doesn't list.
 */

const { test, expect, expectNoUncaught } = require('./harness');
const driver = require('./characterization/driver');

// A highlight's background in each theme (css/editor.css's .block-content mark)
const LIGHT_MARK = 'rgb(255, 243, 176)';
const DARK_MARK = 'rgb(74, 64, 0)';
const NOTE = { name: 'Pop-out settings', blocks: [{ type: 'text', content: 'A <mark>marked</mark> word' }, { type: 'text', content: 'A second line' }] };

/** A new tab at 1440 by 900 on NOTE */
async function openNote(extension) {
  await extension.seedOnboarded();
  await driver.seedNotes(extension, [NOTE]);
  const page = await driver.openNewTab(extension);
  await page.setViewportSize({ width: 1440, height: 900 });
  await expect(page.locator('#editor-container .page-title')).toHaveText(NOTE.name);
  return page;
}

/** Open the pop-out on the note, and wait until its copy of the page's stylesheet applies */
async function openPopOut(extension, page) {
  const [pip] = await Promise.all([extension.context.waitForEvent('page'), page.locator('#pip-toggle').click()]);
  await expect(pip.locator('.page-title')).toHaveText(NOTE.name);
  await expect.poll(() => pip.locator('.page-timestamp').evaluate(el => getComputedStyle(el).fontSize), "the pop-out's copy of the page's stylesheet applies").toBe('13px');
  return pip;
}

/** What the settings decide in a pane, `root` its editor's pane: the column's max-width, the title's font, and a highlight's background */
const look = root => ({
  column: getComputedStyle(root.querySelector('.editor')).maxWidth,
  titleFont: getComputedStyle(root.querySelector('.page-title')).fontFamily,
  highlight: getComputedStyle(root.querySelector('.block-content mark')).backgroundColor,
});
const mainLook = page => page.locator('#editor-container').evaluate(look);
const popLook = pip => pip.locator('.pip-editor-wrapper').evaluate(look);

/** Pick `width` from the header's width buttons */
async function pickWidth(page, width) {
  await page.locator(`#width-selector-header .width-option[data-width="${width}"]`).click();
  await expect.poll(() => page.evaluate(() => document.documentElement.dataset.width)).toBe(width);
}

test('the pop-out takes the width, the font and the theme set before it opens, and the page\'s lang', async ({ extension }) => {
  test.setTimeout(60_000);
  const page = await openNote(extension);
  await pickWidth(page, 'wide');
  const settings = await driver.openSettings(page, 'Appearance');
  await settings.locator('#font-select').selectOption('serif');
  await settings.locator('#theme-select').selectOption('dark');
  await driver.closeSettings(page);
  await expect.poll(() => page.evaluate(() => [document.documentElement.dataset.font, document.documentElement.dataset.theme])).toEqual(['serif', 'dark']);
  const main = await mainLook(page);
  expect(main.column, "the main pane's column is Wide's").toBe('900px');
  expect(main.titleFont, "the main pane's title is in Serif's font").toContain('Georgia');
  expect(main.highlight, "the main pane's highlight is the dark theme's").toBe(DARK_MARK);

  const pip = await openPopOut(extension, page);
  const pop = await popLook(pip);
  expect.soft(pop.column, "the pop-out's column, as wide as the main pane's").toBe(main.column);
  expect.soft(pop.titleFont, "the pop-out's title, in the main pane's font").toBe(main.titleFont);
  expect.soft(pop.highlight, "the pop-out's highlight, in the main pane's dark color").toBe(main.highlight);
  const lang = await page.evaluate(() => document.documentElement.lang);
  expect.soft(await pip.evaluate(() => document.documentElement.lang), "the pop-out's <html>, in the page's lang").toBe(lang);
  await expectNoUncaught(extension, page);
  await pip.close().catch(() => {});
});

test("while the pop-out is open, a width from the header's buttons reaches it, and so does a switch to dark and back to light", async ({ extension }) => {
  test.setTimeout(60_000);
  const page = await openNote(extension);
  const pip = await openPopOut(extension, page);

  await pickWidth(page, 'wide');
  expect((await mainLook(page)).column, "the main pane's column is Wide's").toBe('900px');
  await expect.soft.poll(async () => (await popLook(pip)).column, "the pop-out's column follows the width picked while it's open").toBe('900px');

  await driver.setTheme(page, 'dark');
  await driver.closeSettings(page);
  await expect.poll(() => driver.theme(page)).toBe('dark');
  expect((await mainLook(page)).highlight, "the main pane's highlight is the dark theme's").toBe(DARK_MARK);
  await expect.soft.poll(async () => (await popLook(pip)).highlight, "the pop-out's highlight follows a switch to dark while it's open").toBe(DARK_MARK);

  // The light theme takes data-theme off the page's <html>
  await driver.setTheme(page, 'light');
  await driver.closeSettings(page);
  await expect.poll(() => driver.theme(page)).toBe('light');
  expect((await mainLook(page)).highlight, "the main pane's highlight is the light theme's").toBe(LIGHT_MARK);
  await expect.soft.poll(async () => (await popLook(pip)).highlight, "the pop-out's highlight follows the switch back to light").toBe(LIGHT_MARK);
  await expectNoUncaught(extension, page);
  await pip.close().catch(() => {});
});
