/**
 * A note's new title or insights show in each editor that holds it (#201). Split view's two panes
 * can hold one note, and the pop-out can too. A title or insights the kernel commits for
 * NotesManager or AI chat show in each of them, and a title names the note's tab once:
 *
 * - Generate title, the automatic title and AI chat's confirmed title. Before, only the active
 *   pane showed the new title, and the other kept the old one until the note loaded again.
 * - Extract insights, the insights job and AI chat's Extract insights. Before, only the active
 *   pane drew them.
 * - Each pane's insights section is its own. Before, a pane with no section of its own took the
 *   document's first one, the main pane's, so a load or a draw in the right pane removed the
 *   main pane's insights. "Extracting..." shows in each pane that holds the note and nowhere
 *   else, and Refresh marks the button of the pane it was clicked in. Before, both went to the
 *   main pane.
 *
 * Each case checks one pane first, then both panes on one note with the right pane active, then
 * the pop-out on it too. The provider is stubbed on the new tab, as e2e/ai-jobs.spec.js does, so
 * nothing leaves the machine.
 */

const { test, expect, expectNoUncaught } = require('./harness');
const driver = require('./characterization/driver');

const LIST = 'Milk, eggs, and bread for the week, and the bakery on Sunday morning before ten';
const REVIEW = 'Quarterly review notes: revenue is up, hiring is paused until spring, and the offsite moves';
const PANE = { main: '#editor-container', right: '#secondary-editor-container' };

/**
 * Answer the provider's calls on the new tab without a network request: a title with
 * `window.__title`, insights with the one to-do `window.__todo`. While `window.__hold` is set, a
 * call waits until the test answers it (release), so what shows meanwhile can be read.
 */
function stubProvider(page) {
  return page.evaluate(() => {
    Object.assign(window, { __title: '', __todo: '', __hold: false, __waiting: [] });
    const answer = value => (window.__hold ? new Promise(resolve => window.__waiting.push(() => resolve(value))) : value);
    Object.assign(LLM, {
      isConfigured: () => true,
      generateTitle: async () => answer(window.__title),
      extractInsights: async () => answer({ todos: [window.__todo], reminders: [], deadlines: [], highlights: [], tags: [] }),
    });
  });
}

/** A new tab at 1440 by 900 on the first of `notes`, with the provider stubbed */
async function open(extension, notes) {
  await extension.seedOnboarded();
  await driver.seedNotes(extension, notes);
  const page = await driver.openNewTab(extension);
  await page.setViewportSize({ width: 1440, height: 900 });
  await driver.openNote(page, notes[0].name);
  await stubProvider(page);
  return page;
}

/**
 * Split view on, with the right pane active and showing `name`, the main pane's note too. The
 * right pane opens `other` from the sidebar first, so `name` opens there as a tab switch: the
 * main pane's note has its tab
 */
async function bothPanesOn(page, name, other) {
  await driver.openSplitView(page);
  await page.locator(`${PANE.right} .page-title`).click();
  await driver.openNote(page, other);
  await driver.openNote(page, name);
  await expect.poll(() => page.evaluate(() => [app.editor.noteId === app.secondaryEditor.noteId, app.tabController.activeEditorSide])).toEqual([true, 'right']);
}

/** The pop-out, on the active pane's note, once its editor holds it */
async function openPopOut(extension, page) {
  const [pip] = await Promise.all([extension.context.waitForEvent('page'), page.locator('#pip-toggle').click()]);
  await expect.poll(() => page.evaluate(() => Boolean(app.tabController.pipEditor && app.tabController.pipEditor.noteId === app.tabController.getEditor().noteId))).toBe(true);
  await driver.afterEditorFocus(page);
  return pip;
}

/** The note as the new tab's kernel reads it */
function storedNote(page, noteId) {
  return page.evaluate(async id => {
    const state = await app.kernel.query({ type: 'getNote', noteId: id });
    return state.kind === 'ready' ? state.data.note : null;
  }, noteId);
}

/** Record each name TabController's showNoteName gives a tab, in window.__named */
function recordTabNames(page) {
  return page.evaluate(() => {
    const tabs = app.tabController;
    const show = tabs.showNoteName;
    window.__named = [];
    tabs.showNoteName = (...args) => {
      window.__named.push(args[1]);
      return show.apply(tabs, args);
    };
  });
}

/**
 * Each pane's title, the pop-out's, the tabs' names, and the names given a tab so far, or null
 * when they aren't recorded
 */
function titles(page) {
  return page.evaluate(() => {
    const pip = app.tabController.pipEditor;
    return {
      main: document.querySelector('#editor-container .page-title').textContent,
      right: document.querySelector('#secondary-editor-container .page-title').textContent,
      popOut: pip ? pip.titleEl.textContent : null,
      tabs: [...document.querySelectorAll('#note-tabs .note-tab-name')].map(name => name.textContent),
      named: window.__named ? window.__named.slice() : null,
    };
  });
}

/**
 * Read `read` until `done` holds of what it reads, for up to 3 s, since each editor draws once
 * its own read of the note has come back. Answers the last read, so a check that fails says what
 * showed
 */
async function settled(page, read, done) {
  let got = await read(page);
  for (let i = 0; i < 30 && !done(got); i++) {
    await page.waitForTimeout(100);
    got = await read(page);
  }
  return got;
}

test("a title from Generate title or the automatic title shows in each editor that holds the note, and names its tab once", async ({ extension }) => {
  test.setTimeout(90_000);
  const page = await open(extension, [{ name: 'Untitled', blocks: [{ type: 'text', content: LIST }] }, { name: 'Other note', blocks: [{ type: 'text', content: REVIEW }] }]);
  const noteId = await page.evaluate(() => app.editor.noteId);
  await recordTabNames(page);

  // With one pane, on the other note, so this one stays untitled for the automatic title
  await driver.openNote(page, 'Other note');
  const otherId = await page.evaluate(() => app.editor.noteId);
  await page.evaluate(() => { window.__title = 'Review notes'; });
  await page.evaluate(id => app.notesManager.generateTitleForNote(id), otherId);
  let shown = await settled(page, titles, got => got.main === 'Review notes');
  expect.soft(shown.main, 'with one pane, Generate title shows in the main pane').toBe('Review notes');
  await driver.openNote(page, 'Untitled');

  // Both panes on the untitled note. Turning the automatic title on starts a pass at once
  await bothPanesOn(page, 'Untitled', 'Review notes');
  await page.evaluate(() => { window.__title = 'Groceries'; window.__named.length = 0; });
  await page.evaluate(() => chrome.storage.local.set({ setting_autoTitleEnabled: true }));
  await expect.poll(async () => (await storedNote(page, noteId)).name).toBe('Groceries');
  await expect.poll(() => page.evaluate(() => app.notesManager.autoTitleRunning), 'the pass the switch started ends').toBe(false);
  shown = await settled(page, titles, got => got.main === 'Groceries' && got.right === 'Groceries');
  expect.soft(shown.right, 'the automatic title shows in the right pane, the active one').toBe('Groceries');
  expect.soft(shown.main, 'the automatic title shows in the main pane too, which holds the note').toBe('Groceries');
  expect.soft(shown.named, "the automatic title names the note's tab once").toEqual(['Groceries']);

  // Generate title, with the right pane active
  await page.evaluate(() => { window.__title = 'Weekly shop'; window.__named.length = 0; });
  await page.evaluate(id => app.notesManager.generateTitleForNote(id), noteId);
  shown = await settled(page, titles, got => got.main === 'Weekly shop' && got.right === 'Weekly shop');
  expect.soft(shown.right, 'Generate title shows in the right pane').toBe('Weekly shop');
  expect.soft(shown.main, 'Generate title shows in the main pane too').toBe('Weekly shop');
  expect.soft([shown.named, shown.tabs.filter(name => name === 'Weekly shop').length], "Generate title names the note's tab once").toEqual([['Weekly shop'], 1]);

  // The pop-out opens the active pane's note, so it holds the note too
  await openPopOut(extension, page);
  await page.evaluate(() => { window.__title = 'Errands'; });
  await page.evaluate(id => app.notesManager.generateTitleForNote(id), noteId);
  shown = await settled(page, titles, got => [got.main, got.right, got.popOut].every(title => title === 'Errands'));
  expect.soft(shown.popOut, 'with the note in the pop-out too, the title shows there as well').toBe('Errands');
  expect.soft([shown.main, shown.right], 'and in both panes').toEqual(['Errands', 'Errands']);
  await expectNoUncaught(extension, page);
});

test("AI chat's confirmed title shows in each editor that holds the note", async ({ extension }) => {
  test.setTimeout(90_000);
  const page = await open(extension, [{ name: 'Main note', blocks: [{ type: 'text', content: LIST }] }, { name: 'Other note', blocks: [{ type: 'text', content: REVIEW }] }]);
  const noteId = await page.evaluate(() => app.editor.noteId);

  await page.evaluate(id => app.aiChatController.applyGeneratedTitle('Shopping list', id), noteId);
  let shown = await settled(page, titles, got => got.main === 'Shopping list');
  expect.soft(shown.main, "with one pane, AI chat's title shows in the main pane").toBe('Shopping list');

  await bothPanesOn(page, 'Shopping list', 'Other note');
  await page.evaluate(id => app.aiChatController.applyGeneratedTitle('Weekly shop', id), noteId);
  shown = await settled(page, titles, got => got.main === 'Weekly shop' && got.right === 'Weekly shop');
  expect.soft(shown.right, "AI chat's title shows in the right pane, the active one").toBe('Weekly shop');
  expect.soft(shown.main, "AI chat's title shows in the main pane too").toBe('Weekly shop');
  expect.soft(shown.tabs.filter(name => name === 'Weekly shop').length, "and names the note's tab").toBe(1);

  await openPopOut(extension, page);
  await page.evaluate(id => app.aiChatController.applyGeneratedTitle('Errands', id), noteId);
  shown = await settled(page, titles, got => [got.main, got.right, got.popOut].every(title => title === 'Errands'));
  expect.soft(shown.popOut, "with the note in the pop-out too, AI chat's title shows there as well").toBe('Errands');
  expect.soft([shown.main, shown.right], 'and in both panes').toEqual(['Errands', 'Errands']);
  await expectNoUncaught(extension, page);
});
