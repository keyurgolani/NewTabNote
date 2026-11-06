/**
 * Split view's right pane, and four actions that found their note's parts by the main pane's
 * IDs (#197). Each acts on the pane that holds its note:
 *
 * - A note loading in a pane puts that pane at its top, and leaves the other pane's scroll
 *   where it was. Before, every load reset the main pane's scroll.
 * - The tab bar's + leaves focus in the title of the pane the new note opened in, so a typed
 *   name goes to that note, with one pane or two. Before, + focused the main pane's title, and
 *   the load's own deferred focus of the first block ran after it, so focus never stayed in a
 *   title.
 *   That's in the harness's timing. A slower load left the main pane's title focused, so a name
 *   typed with the right pane active renamed the main pane's note. Every path that makes a note
 *   through + does the same: the tab bar's + and its middle-click, the sidebar's Create New
 *   Note, Cmd/Ctrl+Shift+N and Alt+N, the palette's New Note, and Cmd/Ctrl+T in AI chat's
 *   input. + leaves the title alone if, once the load's focus has run, its pane no longer holds
 *   the new note: a click in the other pane, or a note opened from the sidebar, came first.
 * - The AI title's spinner turns on the title of each editor that holds the note, the
 *   pop-out's too, for a title asked for and for the automatic one. Before, it turned on the
 *   main pane's title whenever the active pane held the note.
 * - Extract insights sends its own note's text. Before, it sent the main pane's.
 *
 * Each case also checks one pane, where the main pane is the active one. The provider is
 * stubbed on the new tab, as e2e/ai-jobs.spec.js does, so nothing leaves the machine.
 * The + race case runs in split view alone, with the tabs' next save held so + waits.
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

  // The load's focus of its first block scrolls its pane there too, so with that focus skipped,
  // as an open menu skips it, only the pane's own reset can put it at its top
  await scrollTo(page, 'right', 300);
  await page.evaluate(() => { app.secondaryEditor._focusInOverlay = () => true; });
  await driver.openNote(page, 'Right note');
  expect.soft(await scrollOf(page, 'right'), "with the load's focus skipped, the right pane's own reset puts it at its top").toBe(0);
  await page.evaluate(() => { delete app.secondaryEditor._focusInOverlay; });

  // The pop-out's pane is its wrapper, which scrolls, and its load puts it at its top the same way
  await page.locator('#pip-toggle').click();
  await expect.poll(() => page.evaluate(() => Boolean(app.tabController.pipEditor && app.tabController.pipEditor.noteId === app.secondaryEditor.noteId))).toBe(true);
  const thirdId = await page.locator('#sidebar-notes-list .sidebar-note-item').filter({ has: page.getByText('Third note', { exact: true }) }).getAttribute('data-id');
  await page.evaluate(async id => {
    const pip = app.tabController.pipEditor;
    pip.root.scrollTop = 300;
    pip._focusInOverlay = () => true;
    await pip.loadNote(id);
  }, thirdId);
  await driver.afterEditorFocus(page);
  expect.soft(await page.evaluate(() => Math.round(app.tabController.pipEditor.root.scrollTop)), "with the load's focus skipped, the pop-out's own reset puts it at its top").toBe(0);
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

  // Cmd/Ctrl+Shift+N makes its note through + too: focus in the title with "Untitled" selected,
  // up to 3 s after the load's own focus, and no formatting toolbar over the selected title
  const beforeKeys = await page.evaluate(() => app.tabController.getEditor().noteId);
  await page.keyboard.press('ControlOrMeta+Shift+KeyN');
  await expect.poll(() => page.evaluate(() => app.tabController.getEditor().noteId)).not.toBe(beforeKeys);
  await driver.afterEditorFocus(page);
  let selected = await page.evaluate(() => getSelection().toString());
  for (let i = 0; i < 30 && selected !== 'Untitled'; i++) {
    await page.waitForTimeout(100);
    selected = await page.evaluate(() => getSelection().toString());
  }
  expect.soft(await focusedTitle(), "with one pane, Cmd/Ctrl+Shift+N leaves focus in the main pane's title").toBe('editor-container');
  expect.soft(selected, 'with "Untitled" selected').toBe('Untitled');
  expect.soft(await page.locator('.formatting-toolbar.visible').count(), 'and no formatting toolbar over it').toBe(0);

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
  /** The provider's next title call waits, and fails once the test makes it fail */
  const failNextTitle = () => page.evaluate(() => {
    window.__titleFailures = [];
    window.__answers = LLM.generateTitle;
    LLM.generateTitle = () => new Promise((resolve, reject) => window.__titleFailures.push(reject));
  });
  /** With that call pending, read the spinner, make the call fail, and check the spinner comes off */
  const spinnerUntilFail = async gone => {
    await expect.poll(() => page.evaluate(() => window.__titleFailures.length)).toBe(1);
    const pending = await spinning();
    await page.evaluate(() => {
      LLM.generateTitle = window.__answers;
      window.__titleFailures.shift()(new Error('The stub fails'));
    });
    await expect.poll(spinning, gone).toEqual([]);
    return pending;
  };

  expect.soft(await spinnerFor(askForTitle), "with one pane, a title asked for spins on the main pane's title").toEqual(['editor-container']);
  await page.evaluate(() => window.__asked);

  await rightPaneOn(page, 'Untitled');
  // Turning the automatic title on starts a pass at once, and that pass's call fails. An automatic
  // title that fails leaves the note untitled, so the next pass titles it, once this one has ended
  await failNextTitle();
  await page.evaluate(() => chrome.storage.local.set({ setting_autoTitleEnabled: true }));
  expect.soft(await spinnerUntilFail('no spinner once the automatic title fails'), "an automatic title that fails spins on the right pane's title alone").toEqual(['secondary-editor-container']);
  await expect.poll(() => page.evaluate(() => app.notesManager.autoTitleRunning), 'the pass the switch started ends').toBe(false);
  expect.soft(await spinnerFor(() => { window.__auto = app.notesManager.runAutoTitle(); }), "the automatic title spins on the right pane's title alone").toEqual(['secondary-editor-container']);
  await page.evaluate(() => window.__auto);
  expect.soft(await spinnerFor(askForTitle), "a title asked for spins on the right pane's title alone").toEqual(['secondary-editor-container']);
  await page.evaluate(() => window.__asked);
  await failNextTitle();
  await page.evaluate(askForTitle);
  expect.soft(await spinnerUntilFail('no spinner once a title asked for fails'), "a title asked for that fails spins on the right pane's title alone").toEqual(['secondary-editor-container']);
  await page.evaluate(() => window.__asked);

  // The pop-out opens the active pane's note, so its title and the right pane's both spin
  await page.locator('#pip-toggle').click();
  await expect.poll(() => page.evaluate(() => Boolean(app.tabController.pipEditor && app.tabController.pipEditor.noteId === app.secondaryEditor.noteId))).toBe(true);
  expect.soft(await spinnerFor(askForTitle), 'with the note in the pop-out too, its title spins as well').toEqual(['secondary-editor-container', 'pop-out']);
  await page.evaluate(() => window.__asked);

  // The automatic title with one pane, for a new note in the main pane with text enough for it.
  // It's off while the note gets its first words, so the editor's own title for a new note's
  // first words makes no call, and turning it on starts the pass
  await driver.closeSplitView(page);
  await page.evaluate(() => chrome.storage.local.set({ setting_autoTitleEnabled: false }));
  await expect.poll(() => page.evaluate(() => app.notesManager.autoTitleIntervalId), 'the automatic title is off').toBe(null);
  const beforeNew = await page.evaluate(() => app.editor.noteId);
  await page.locator('#new-tab-btn').click();
  await expect.poll(() => page.evaluate(() => app.editor.noteId)).not.toBe(beforeNew);
  await driver.afterEditorFocus(page);
  await page.locator(`${PANE.main} .block-content`).first().click();
  await page.keyboard.type('Words enough for the automatic title');
  await page.evaluate(() => app.editor.flushSave());
  expect.soft(await spinnerFor(() => chrome.storage.local.set({ setting_autoTitleEnabled: true })), "with one pane, the automatic title spins on the main pane's title").toEqual(['editor-container']);
  await expect.poll(() => page.evaluate(() => app.notesManager.autoTitleRunning), 'the pass the switch started ends').toBe(false);
  await expectNoUncaught(extension, page);
});

test("Extract insights sends the text of the note it extracts for, the right pane's when that pane is active", async ({ extension }) => {
  const page = await open(extension, [{ name: 'Main note', blocks: lines('Main', 3) }, { name: 'Right note', blocks: lines('Right', 3) }]);
  await page.evaluate(() => {
    window.__insightsSent = [];
    Object.assign(LLM, {
      isConfigured: () => true,
      extractInsights: async text => {
        window.__insightsSent.push(text);
        return { todos: ['Buy milk'], reminders: [], deadlines: [], highlights: [], tags: [] };
      },
    });
  });
  /** What Extract insights sent the provider, for the active pane's note */
  const sent = async () => {
    await page.evaluate(() => app.aiChatController.extractInsightsFromChat());
    return page.evaluate(() => window.__insightsSent.pop());
  };

  const withOnePane = await sent();
  expect.soft(withOnePane.includes('Main line 0'), "with one pane, the main pane's note's text").toBe(true);

  await rightPaneOn(page, 'Right note');
  const fromRight = await sent();
  expect.soft(fromRight.includes('Right line 0'), "the right pane's note's text").toBe(true);
  expect.soft(fromRight.includes('Main line'), "none of the main pane's").toBe(false);
  await expectNoUncaught(extension, page);
});

test("+ leaves the title alone when, once the load's focus has run, its pane no longer holds the new note, after a click in the other pane or a note opened from the sidebar", async ({ extension }) => {
  const page = await open(extension, [{ name: 'Main note', blocks: lines('Main', 3) }, { name: 'Right note', blocks: lines('Right', 3) }, { name: 'Third note', blocks: lines('Third', 3) }]);
  const mainId = await page.evaluate(() => app.editor.noteId);
  const third = page.locator('#sidebar-notes-list .sidebar-note-item').filter({ has: page.getByText('Third note', { exact: true }) });
  const thirdId = await third.getAttribute('data-id');
  /**
   * Press + with the tabs' next save taking 800 ms, as a slow write would, which holds + between
   * the new note's load and its title, and wait until the active pane holds the new note
   */
  const pressPlusHeld = async () => {
    const before = await page.evaluate(() => app.tabController.getEditor().noteId);
    await page.evaluate(() => {
      const tabs = app.tabController;
      const save = tabs.saveTabs;
      tabs.saveTabs = async (...args) => {
        tabs.saveTabs = save;
        await new Promise(resolve => setTimeout(resolve, 800));
        return save.apply(tabs, args);
      };
    });
    await page.locator('#new-tab-btn').click();
    await expect.poll(() => page.evaluate(() => app.tabController.getEditor().noteId)).not.toBe(before);
  };
  /** After + has had time to finish, type and save */
  const typeAfterPlus = async text => {
    await page.waitForTimeout(1500);
    await page.keyboard.type(text);
    await page.evaluate(() => Promise.all([app.editor.flushSave(), app.secondaryEditor.flushSave()]));
  };

  await rightPaneOn(page, 'Right note');
  await pressPlusHeld();
  await page.locator(`${PANE.main} .block-content`).first().click();
  await typeAfterPlus('Oops');
  expect.soft((await storedNote(page, mainId)).name, "after a click in the main pane while + waits, the main pane's note keeps its name").toBe('Main note');

  await page.locator(`${PANE.right} .page-title`).click();
  await pressPlusHeld();
  await third.click();
  await expect.poll(() => page.evaluate(() => app.secondaryEditor.noteId)).toBe(thirdId);
  await typeAfterPlus('Oops');
  expect.soft((await storedNote(page, thirdId)).name, 'a note opened from the sidebar while + waits keeps its name').toBe('Third note');
  expect.soft((await storedNote(page, mainId)).name, "and the main pane's note keeps its name").toBe('Main note');
  await expectNoUncaught(extension, page);
});
