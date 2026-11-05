/**
 * Split view's right pane, and actions that found their note's parts by the main pane's IDs
 * (#197). Each acts on the pane that holds its note:
 *
 * - A note loading in a pane puts that pane at its top, and leaves the other pane's scroll
 *   where it was. Before, every load reset the main pane's scroll.
 *
 * Each also holds with one pane, where the main pane is the active one.
 */

const { test, expect, expectNoUncaught } = require('./harness');
const driver = require('./characterization/driver');

/** `count` short text blocks, so a pane can scroll */
const lines = (label, count = 60) => Array.from({ length: count }, (_, i) => ({ type: 'text', content: `${label} line ${i} with a few words in it` }));
const PANE = { main: '#editor-container', right: '#secondary-editor-container' };

/** A new tab at 1440 by 900 on the first of `notes` */
async function open(extension, notes) {
  await extension.seedOnboarded();
  await driver.seedNotes(extension, notes);
  const page = await driver.openNewTab(extension);
  await page.setViewportSize({ width: 1440, height: 900 });
  await driver.openNote(page, notes[0].name);
  return page;
}

/** Split view on, with the right pane active, as a click in it makes it, and showing `name` */
async function rightPaneOn(page, name) {
  await driver.openSplitView(page);
  await page.locator(`${PANE.right} .page-title`).click();
  await driver.openNote(page, name);
}

const scrollOf = (page, pane) => page.locator(PANE[pane]).evaluate(el => Math.round(el.scrollTop));
const scrollTo = (page, pane, top) => page.locator(PANE[pane]).evaluate((el, y) => { el.scrollTop = y; }, top);

test("a note loading in a pane puts that pane at its top, and leaves the other pane's scroll where it was", async ({ extension }) => {
  const page = await open(extension, [{ name: 'Main note', blocks: lines('Main') }, { name: 'Right note', blocks: lines('Right') }, { name: 'Third note', blocks: lines('Third') }]);
  await scrollTo(page, 'main', 400);
  await driver.openNote(page, 'Third note');
  expect.soft(await scrollOf(page, 'main'), 'with one pane, a load puts the main pane at its top').toBe(0);

  await driver.openNote(page, 'Main note');
  await rightPaneOn(page, 'Right note');
  await scrollTo(page, 'main', 400);
  await scrollTo(page, 'right', 300);
  await driver.openNote(page, 'Third note');
  expect.soft(await scrollOf(page, 'main'), 'the main pane stays where it was').toBe(400);
  expect.soft(await scrollOf(page, 'right'), 'the right pane is at its top').toBe(0);
  await expectNoUncaught(extension, page);
});
