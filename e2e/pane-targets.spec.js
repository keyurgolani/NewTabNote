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
 * - The AI title's spinner turns on the title of each editor that holds the note, the
 *   pop-out's too, for a title asked for and for the automatic one. Before, it turned on the
 *   main pane's title whenever the active pane held the note.
 *
 * Each case also checks one pane, where the main pane is the active one. The provider is
 * stubbed on the new tab, as e2e/ai-jobs.spec.js does, so nothing leaves the machine.
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

test("the AI title's spinner turns on the title of each editor that holds the note, the pop-out's too, for a title asked for and the automatic one", async ({ extension }) => {
  const page = await open(extension, [{ name: 'Main note', blocks: lines('Main', 3) }, { name: 'Untitled', blocks: lines('Right', 3) }]);
  // Each title call waits until the test answers it, so the spinner can be read while it's pending
  await page.evaluate(() => {
    window.__titleAnswers = [];
    Object.assign(LLM, {
      isConfigured: () => true,
      generateTitle: () => new Promise(resolve => window.__titleAnswers.push(resolve)),
    });
  });
  /** Where a spinner shows: each pane's title, and the pop-out's */
  const spinning = () => page.evaluate(() => {
    const titles = [...document.querySelectorAll('.page-title')].filter(title => title.classList.contains('title-generating')).map(title => title.closest('.editor-pane').id);
    const pip = app.tabController.pipEditor;
    if (pip && pip.titleEl.classList.contains('title-generating')) titles.push('pop-out');
    return titles;
  });
  /** Start a title, read the spinner while the provider's answer is pending, answer, and check it's gone */
  const spinnerFor = async start => {
    await page.evaluate(start);
    await expect.poll(() => page.evaluate(() => window.__titleAnswers.length)).toBe(1);
    const pending = await spinning();
    await page.evaluate(() => window.__titleAnswers.shift()('Named by the stub'));
    await expect.poll(spinning, 'no spinner once it answers').toEqual([]);
    return pending;
  };
  const askForTitle = () => { window.__asked = app.notesManager.generateTitleForNote(app.tabController.getEditor().noteId); };

  expect.soft(await spinnerFor(askForTitle), "with one pane, a title asked for spins on the main pane's title").toEqual(['editor-container']);
  await page.evaluate(() => window.__asked);

  await rightPaneOn(page, 'Untitled');
  await page.evaluate(() => chrome.storage.local.set({ setting_autoTitleEnabled: true }));
  expect.soft(await spinnerFor(() => { window.__auto = app.notesManager.runAutoTitle(); }), "the automatic title spins on the right pane's title alone").toEqual(['secondary-editor-container']);
  await page.evaluate(() => window.__auto);
  expect.soft(await spinnerFor(askForTitle), "a title asked for spins on the right pane's title alone").toEqual(['secondary-editor-container']);
  await page.evaluate(() => window.__asked);

  // The pop-out opens the active pane's note, so its title and the right pane's both spin
  await page.locator('#pip-toggle').click();
  await expect.poll(() => page.evaluate(() => Boolean(app.tabController.pipEditor && app.tabController.pipEditor.noteId === app.secondaryEditor.noteId))).toBe(true);
  expect.soft(await spinnerFor(askForTitle), 'with the note in the pop-out too, its title spins as well').toEqual(['secondary-editor-container', 'pop-out']);
  await page.evaluate(() => window.__asked);
  await expectNoUncaught(extension, page);
});
