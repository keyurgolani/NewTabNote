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

// Insights: each pane draws its own section, "Extracting..." goes to each pane that holds the note, and
// Refresh marks the button it was clicked on

const TRIP = 'Trip planning: book the train, pack the warm coat, and water the plants before leaving';

/** Hold the provider's next call, and wait until it's waiting */
async function held(page) {
  await expect.poll(() => page.evaluate(() => window.__waiting.length)).toBe(1);
}

/** Answer the held call */
function release(page) {
  return page.evaluate(() => {
    window.__hold = false;
    window.__waiting.shift()();
  });
}

/**
 * Each pane's insights and the pop-out's: the text of the sections drawn, and how many
 * "Extracting..." placeholders it shows
 */
function insights(page) {
  return page.evaluate(() => {
    const of = root => ({
      text: [...root.querySelectorAll('.note-insights:not(.insights-loading)')].map(section => section.textContent).join(' | '),
      extracting: root.querySelectorAll('.insights-loading').length,
    });
    const pip = app.tabController.pipEditor;
    return { main: of(document.getElementById('editor-container')), right: of(document.getElementById('secondary-editor-container')), popOut: pip ? of(pip.root) : null };
  });
}

test('insights from Extract insights or the insights job show in each editor that holds the note, with no "Extracting..." left', async ({ extension }) => {
  test.setTimeout(90_000);
  const page = await open(extension, [{ name: 'Main note', blocks: [{ type: 'text', content: LIST }] }, { name: 'Other note', blocks: [{ type: 'text', content: REVIEW }] }]);
  const noteId = await page.evaluate(() => app.editor.noteId);
  const shows = (got, todo) => [got.main, got.right, got.popOut].filter(Boolean).every(pane => pane.text.includes(todo) && pane.extracting === 0);

  // With one pane, on the other note, so the insights job finds this note's insights still to do
  await driver.openNote(page, 'Other note');
  const otherId = await page.evaluate(() => app.editor.noteId);
  await page.evaluate(() => { window.__todo = 'Buy milk'; });
  await page.evaluate(id => app.notesManager.extractInsightsForNote(id), otherId);
  let shown = await settled(page, insights, got => got.main.text.includes('Buy milk') && got.main.extracting === 0);
  expect.soft(shown.main.text, 'with one pane, Extract insights shows in the main pane').toContain('Buy milk');
  expect.soft(shown.main.extracting, 'with no "Extracting..." left').toBe(0);
  await driver.openNote(page, 'Main note');

  // Both panes on the note. The insights job, switched on, which starts a run over every note
  await bothPanesOn(page, 'Main note', 'Other note');
  await page.evaluate(() => { window.__todo = 'Call the bakery'; });
  await page.evaluate(() => chrome.storage.local.set({ setting_insightsEnabled: true }));
  await expect.poll(async () => ((await storedNote(page, noteId)).insights || {}).todos).toEqual(['Call the bakery']);
  await expect.poll(() => page.evaluate(() => app.notesManager.insightsRunning), 'the run the switch started ends').toBe(false);
  shown = await settled(page, insights, got => shows(got, 'Call the bakery'));
  expect.soft(shown.right.text, "the insights job's insights show in the right pane, the active one").toContain('Call the bakery');
  expect.soft(shown.main.text, "the insights job's insights show in the main pane too").toContain('Call the bakery');

  // Extract insights, with the right pane active
  await page.evaluate(() => { window.__todo = 'Plan the week'; });
  await page.evaluate(id => app.notesManager.extractInsightsForNote(id), noteId);
  shown = await settled(page, insights, got => shows(got, 'Plan the week'));
  expect.soft(shown.right.text, 'Extract insights shows in the right pane').toContain('Plan the week');
  expect.soft(shown.main.text, 'Extract insights shows in the main pane too').toContain('Plan the week');
  expect.soft([shown.main.extracting, shown.right.extracting], 'with no "Extracting..." left in either pane').toEqual([0, 0]);

  // The pop-out on the note too
  await openPopOut(extension, page);
  await page.evaluate(() => { window.__todo = 'Book the offsite'; });
  await page.evaluate(id => app.notesManager.extractInsightsForNote(id), noteId);
  shown = await settled(page, insights, got => shows(got, 'Book the offsite'));
  expect.soft(shown.popOut.text, 'with the note in the pop-out too, Extract insights shows there as well').toContain('Book the offsite');
  expect.soft([shown.main.text.includes('Book the offsite'), shown.right.text.includes('Book the offsite')], 'and in both panes').toEqual([true, true]);
  expect.soft([shown.main.extracting, shown.right.extracting, shown.popOut.extracting], 'with no "Extracting..." left in any of them').toEqual([0, 0, 0]);
  await expectNoUncaught(extension, page);
});

test("AI chat's Extract insights shows in each editor that holds the note", async ({ extension }) => {
  test.setTimeout(90_000);
  const page = await open(extension, [{ name: 'Main note', blocks: [{ type: 'text', content: LIST }] }, { name: 'Other note', blocks: [{ type: 'text', content: REVIEW }] }]);
  const shows = (got, todo) => [got.main, got.right, got.popOut].filter(Boolean).every(pane => pane.text.includes(todo));

  await page.evaluate(() => { window.__todo = 'Buy milk'; });
  await page.evaluate(() => app.aiChatController.extractInsightsFromChat());
  let shown = await settled(page, insights, got => got.main.text.includes('Buy milk'));
  expect.soft(shown.main.text, "with one pane, AI chat's Extract insights shows in the main pane").toContain('Buy milk');

  await bothPanesOn(page, 'Main note', 'Other note');
  await page.evaluate(() => { window.__todo = 'Call the bakery'; });
  await page.evaluate(() => app.aiChatController.extractInsightsFromChat());
  shown = await settled(page, insights, got => shows(got, 'Call the bakery'));
  expect.soft(shown.right.text, "AI chat's Extract insights shows in the right pane, the active one").toContain('Call the bakery');
  expect.soft(shown.main.text, "AI chat's Extract insights shows in the main pane too").toContain('Call the bakery');

  await openPopOut(extension, page);
  await page.evaluate(() => { window.__todo = 'Plan the week'; });
  await page.evaluate(() => app.aiChatController.extractInsightsFromChat());
  shown = await settled(page, insights, got => shows(got, 'Plan the week'));
  expect.soft(shown.popOut.text, "with the note in the pop-out too, AI chat's Extract insights shows there as well").toContain('Plan the week');
  expect.soft([shown.main.text.includes('Plan the week'), shown.right.text.includes('Plan the week')], 'and in both panes').toEqual([true, true]);
  await expectNoUncaught(extension, page);
});

test('"Extracting..." shows in each pane that holds the note and nowhere else, each pane keeps its own insights, and Refresh marks its own pane\'s button', async ({ extension }) => {
  test.setTimeout(90_000);
  const page = await open(extension, [
    { name: 'Main note', blocks: [{ type: 'text', content: LIST }] },
    { name: 'Insights note', blocks: [{ type: 'text', content: REVIEW }] },
    { name: 'Other note', blocks: [{ type: 'text', content: TRIP }] },
  ]);
  const noteId = await page.evaluate(() => app.editor.noteId);
  const insightsId = await page.locator('#sidebar-notes-list .sidebar-note-item').filter({ has: page.getByText('Insights note', { exact: true }) }).getAttribute('data-id');
  // The other note's own insights, as stored, which a pane draws when it loads that note
  const attached = await page.evaluate(id => app.kernel.execute({
    type: 'attachInsights', commandId: 'pane-shows-insights', noteId: id,
    insights: { todos: ['Book the offsite'], reminders: [], deadlines: [], highlights: [], tags: [] },
  }), insightsId);
  expect(attached.kind).toBe('committed');
  /** Start Extract insights for the note with its provider call held, and wait until it waits */
  const extractHeld = async todo => {
    await page.evaluate(t => { window.__todo = t; window.__hold = true; }, todo);
    await page.evaluate(id => { window.__extracting = app.notesManager.extractInsightsForNote(id); }, noteId);
    await held(page);
  };
  const answered = async () => {
    await release(page);
    await page.evaluate(() => window.__extracting);
  };

  // With one pane
  await extractHeld('Buy milk');
  let shown = await insights(page);
  expect.soft(shown.main.extracting, 'with one pane, "Extracting..." shows in the main pane').toBe(1);
  await answered();

  // Both panes on the note
  await bothPanesOn(page, 'Main note', 'Other note');
  await extractHeld('Call the bakery');
  shown = await insights(page);
  expect.soft(shown.right.extracting, 'with both panes on the note, "Extracting..." shows in the right pane, the active one').toBe(1);
  expect.soft(shown.main.extracting, 'and once in the main pane, which holds the note too').toBe(1);
  await answered();

  // The main pane on the note with insights of its own, the right pane active on another
  await page.locator(`${PANE.main} .page-title`).click();
  await driver.openNote(page, 'Insights note');
  await page.locator(`${PANE.right} .page-title`).click();
  await driver.openNote(page, 'Other note');
  shown = await settled(page, insights, got => got.main.text.includes('Book the offsite'));
  expect.soft(shown.main.text, "a load in the right pane leaves the main pane's insights").toContain('Book the offsite');
  await driver.openNote(page, 'Main note');
  shown = await settled(page, insights, got => got.right.text.includes('Call the bakery') && got.main.text.includes('Book the offsite'));
  expect.soft(shown.right.text, "the right pane draws its note's insights").toContain('Call the bakery');
  expect.soft(shown.main.text, 'and the main pane keeps its own').toContain('Book the offsite');

  // Extract insights for the right pane's note
  await extractHeld('Plan the week');
  shown = await insights(page);
  expect.soft(shown.right.extracting, '"Extracting..." shows in the right pane, which holds the note').toBe(1);
  expect.soft(shown.main.extracting, 'and not in the main pane, which holds another').toBe(0);
  expect.soft(shown.main.text, "the main pane keeps its own note's insights meanwhile").toContain('Book the offsite');
  await answered();
  shown = await settled(page, insights, got => got.right.text.includes('Plan the week') && got.right.extracting === 0);
  expect.soft(shown.right.text, 'the right pane shows the new insights').toContain('Plan the week');
  expect.soft([shown.main.text.includes('Book the offsite'), shown.main.extracting, shown.right.extracting], 'the main pane keeps its own, and no "Extracting..." is left in either pane').toEqual([true, 0, 0]);

  // Refresh in the right pane, with its provider call held
  await page.evaluate(() => { window.__todo = 'Water the plants'; window.__hold = true; });
  await page.locator(`${PANE.right} .note-insights-refresh`).click();
  await held(page);
  const buttons = () => page.evaluate(() => ['#editor-container', '#secondary-editor-container'].map(pane => {
    const button = document.querySelector(`${pane} .note-insights-refresh`);
    return button ? button.textContent : null;
  }));
  const marked = await buttons();
  expect.soft(marked[1], "Refresh marks the right pane's button, the one clicked").toBe('Extracting...');
  expect.soft(marked[0], "and leaves the main pane's").toBe('Refresh');
  await release(page);
  await expect.poll(buttons, 'once Refresh has its answer, both buttons read Refresh').toEqual(['Refresh', 'Refresh']);
  await expectNoUncaught(extension, page);
});
