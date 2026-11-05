/**
 * Split view's right pane, and actions that found their note's parts by the main pane's IDs
 * (#197). Each acts on the pane that holds its note:
 *
 * - A note loading in a pane puts that pane at its top, and leaves the other pane's scroll
 *   where it was. Before, every load reset the main pane's scroll.
 * - The tab bar's + leaves focus in the title of the pane the new note opened in, so a typed
 *   name goes to that note, with one pane or two. Before, + focused the main pane's title, and
 *   the load's own deferred focus of the first block ran after it, so focus never stayed in a
 *   title.
 *
 * Each case also checks one pane, where the main pane is the active one.
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

/** The note as the new tab's kernel reads it */
async function storedNote(page, noteId) {
  return page.evaluate(async id => {
    const state = await app.kernel.query({ type: 'getNote', noteId: id });
    return state.kind === 'ready' ? state.data.note : null;
  }, noteId);
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

test("the tab bar's + leaves focus in the title of the pane the new note opened in, so a typed name goes to that note", async ({ extension }) => {
  const page = await open(extension, [{ name: 'Main note', blocks: lines('Main', 3) }, { name: 'Right note', blocks: lines('Right', 3) }]);
  const mainId = await page.evaluate(() => app.editor.noteId);
  /** The pane whose title has focus, or null */
  const focusedTitle = () => page.evaluate(() => {
    const focused = document.activeElement;
    return focused && focused.classList.contains('page-title') ? focused.closest('.editor-pane').id : null;
  });
  /**
   * Press the tab bar's +, wait until the new note is open in the active pane and the load's own
   * deferred focus has run, then up to 3 s more for focus to settle in `want`'s title, and type
   * a name
   */
  const newNoteNamed = async (name, want) => {
    const before = await page.evaluate(() => app.tabController.getEditor().noteId);
    await page.locator('#new-tab-btn').click();
    await expect.poll(() => page.evaluate(() => app.tabController.getEditor().noteId)).not.toBe(before);
    await driver.afterEditorFocus(page);
    let where = await focusedTitle();
    for (let i = 0; i < 30 && where !== want; i++) {
      await page.waitForTimeout(100);
      where = await focusedTitle();
    }
    await page.keyboard.type(name);
    await page.evaluate(() => Promise.all([app.editor.flushSave(), app.secondaryEditor.flushSave()]));
    return { where, noteId: await page.evaluate(() => app.tabController.getEditor().noteId) };
  };

  let made = await newNoteNamed('Named with one pane', 'editor-container');
  expect.soft(made.where, "with one pane, focus is in the main pane's title").toBe('editor-container');
  expect.soft((await storedNote(page, made.noteId)).name, 'the new note takes the name').toBe('Named with one pane');

  await driver.openNote(page, 'Main note');
  await rightPaneOn(page, 'Right note');
  made = await newNoteNamed('Named in the right pane', 'secondary-editor-container');
  expect.soft(made.where, "focus is in the right pane's title").toBe('secondary-editor-container');
  expect.soft((await storedNote(page, made.noteId)).name, 'the new note takes the name').toBe('Named in the right pane');
  expect.soft((await storedNote(page, mainId)).name, "the main pane's note keeps its name").toBe('Main note');
  await expectNoUncaught(extension, page);
});
