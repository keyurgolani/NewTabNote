/**
 * #12 slice 4b2a in the built extension, with a stub provider: auto-title, insights, AI
 * chat's title and insights actions, and the Picture-in-Picture editor's AI actions, all
 * through the kernel and the AI port the new tab's root builds. The stub replaces the LLM
 * service's provider calls on the new tab, which the port reads when a call is made, so
 * nothing leaves the machine.
 */

const { test, expect, expectNoUncaught } = require('./harness');
const driver = require('./characterization/driver');

const LIST = 'Milk, eggs, and bread for the week, and the bakery on Sunday morning before ten';
const REVIEW = 'Quarterly review notes: revenue is up, hiring is paused until spring, and the offsite moves';

/** Answer every provider call on the new tab, and count them, without a network request */
function stubProvider(page) {
  return page.evaluate(() => {
    window.__aiCalls = [];
    Object.assign(LLM, {
      isConfigured: () => true,
      generateTitle: async () => {
        window.__aiCalls.push('generateTitle');
        return 'Groceries';
      },
      extractInsights: async () => {
        window.__aiCalls.push('extractInsights');
        return { todos: ['Buy milk'], reminders: [], deadlines: [], highlights: [], tags: ['errands'] };
      },
      chat: async () => {
        window.__aiCalls.push('chat');
        return 'Rewritten line about the weekly groceries list';
      },
    });
  });
}

/** The note as the new tab's kernel reads it */
function storedNote(page, noteId) {
  return page.evaluate(async id => {
    const state = await app.kernel.query({ type: 'getNote', noteId: id });
    return state.kind === 'ready' ? state.data.note : null;
  }, noteId);
}

test('auto-title, insights, and AI chat title and insights land through the kernel, with a stub provider', async ({ extension }) => {
  await extension.seedOnboarded();
  await driver.seedNotes(extension, [
    { name: 'Untitled', blocks: [{ type: 'text', content: LIST }] },
    { name: 'Review', blocks: [{ type: 'text', content: REVIEW }] },
  ]);
  const page = await driver.openNewTab(extension);
  await stubProvider(page);
  await driver.openNote(page, 'Untitled');
  const noteId = await page.evaluate(() => app.editor.noteId);
  await page.evaluate(() => app.kernel.execute({ type: 'setPinned', commandId: 'pin-e2e', noteId: app.editor.noteId, pinned: true }));

  // The auto-title job names the untitled note, and the editor and its tab show it
  await page.evaluate(() => app.notesManager.runAutoTitle());
  await expect.poll(async () => (await storedNote(page, noteId)).name).toBe('Groceries');
  await expect.poll(() => driver.noteTitle(page)).toBe('Groceries');
  await expect(page.locator('#note-tabs .note-tab.active .note-tab-name')).toHaveText('Groceries');
  let stored = await storedNote(page, noteId);
  expect([stored.titleManuallySet, stored.pinned]).toEqual([false, true]);

  // Extract insights from the note menu's path: the editor draws them, not "Extracting..."
  await page.evaluate(id => app.notesManager.extractInsightsForNote(id), noteId);
  await expect(page.locator('#note-insights')).toContainText('Buy milk');
  await expect(page.locator('#note-insights .insights-loading-indicator')).toHaveCount(0);
  stored = await storedNote(page, noteId);
  expect(stored.insights.todos).toEqual(['Buy milk']);
  expect(stored.pinned).toBe(true);

  // The insights job runs over both notes
  await page.evaluate(() => app.notesManager.runInsightsExtraction());
  const review = await page.evaluate(async () => {
    const state = await app.kernel.query({ type: 'listNotes', view: 'active' });
    return state.data.find(note => note.name === 'Review');
  });
  expect(review.insights.tags).toEqual(['errands']);

  // AI chat's Extract insights and a title it generated, confirmed
  await page.evaluate(() => app.aiChatController.extractInsightsFromChat());
  await page.evaluate(id => app.aiChatController.applyGeneratedTitle('Weekly shop', id), noteId);
  await expect.poll(async () => (await storedNote(page, noteId)).name).toBe('Weekly shop');
  await expect.poll(() => driver.noteTitle(page)).toBe('Weekly shop');
  stored = await storedNote(page, noteId);
  expect([stored.pinned, stored.titleManuallySet, stored.insights.todos]).toEqual([true, false, ['Buy milk']]);

  // A typed title stays: the next auto-title run leaves it
  await page.locator('#page-title').fill('Typed by hand');
  await page.evaluate(() => app.editor.flushSave());
  await page.evaluate(() => app.notesManager.runAutoTitle());
  expect((await storedNote(page, noteId)).name).toBe('Typed by hand');

  expect(await page.evaluate(() => window.__aiCalls.length)).toBeGreaterThan(0);
  await expectNoUncaught(extension, page);
});

test("the Picture-in-Picture editor calls the provider through the new tab's AI port", async ({ extension }) => {
  await extension.seedOnboarded();
  await driver.seedNotes(extension, [{ name: 'Groceries', blocks: [{ type: 'text', content: LIST }] }]);
  const page = await driver.openNewTab(extension);
  await stubProvider(page);
  const [pip] = await Promise.all([extension.context.waitForEvent('page'), page.locator('#pip-toggle').click()]);
  await expect.poll(() => page.evaluate(() => Boolean(app.tabController.pipEditor && app.tabController.pipEditor.noteId))).toBe(true);

  // Every editor has App's port, and the PiP window has no LLM of its own to look up
  expect(await page.evaluate(() => [app.editor.ai === app.ai, app.tabController.pipEditor.ai === app.ai])).toEqual([true, true]);
  expect(await pip.evaluate(() => 'LLM' in window)).toBe(false);

  // An inline AI action and Refresh insights in the PiP window
  const result = await page.evaluate(async () => {
    const editor = app.tabController.pipEditor;
    await editor.handleInlineAIAction(editor.blocks[0].id, 'rewrite');
    await editor.flushSave();
    await editor.refreshInsights();
    const blocks = await Storage.getElementsByNote(editor.noteId);
    const state = await app.kernel.query({ type: 'getNote', noteId: editor.noteId });
    return { blocks: blocks.map(block => block.content), insights: state.data.note.insights, calls: window.__aiCalls };
  });
  expect(result.blocks).toEqual(['Rewritten line about the weekly groceries list']);
  expect(result.insights.todos).toEqual(['Buy milk']);
  expect(result.calls).toEqual(['chat', 'extractInsights']);
  await expect(pip.locator('#note-insights')).toContainText('Buy milk');
  await expectNoUncaught(extension, page);
});
