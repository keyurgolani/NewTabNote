/**
 * When split view closes onto the right pane's note, the left pane takes that note and the
 * hidden right pane keeps no copy of it, so an undo or a late save there can't write an
 * older version over the left pane's edits. The test also fails on an uncaught exception
 * that test/known-defects.json doesn't list.
 */

const { test, expect, expectNoUncaught } = require('./harness');
const { generateId, profileStore } = require('./harness/profile-store');

/** The note body as the left pane shows it, and as storage has it */
async function bodies(page, noteId) {
  const shown = await page.evaluate(() => app.editor.blocks.map(block => block.content).join('\n'));
  const stored = (await profileStore(page).getElementsByNote(noteId)).sort((a, b) => a.order - b.order).map(el => el.content).join('\n');
  return { shown, stored };
}

test("split view closing onto the right pane's note keeps the left pane's edits through an undo", async ({ extension }) => {
  await extension.seedOnboarded();
  const page = await extension.openSurface('newtab');
  await expect(page.locator('#page-title')).toHaveText('Untitled');
  // Startup is done once it has cached the note it opened and focused its first block
  await expect.poll(() => page.evaluate(async () => (await chrome.storage.local.get('lastOpenedNoteId')).lastOpenedNoteId || null))
    .not.toBeNull();
  await expect(page.locator('#editor-container .block-content').first()).toBeFocused();

  // Two active notes: the first one on the left, Beta on the right
  const store = profileStore(page);
  const beta = await store.createNote('Beta');
  await store.saveElement({ id: generateId(), canvasId: beta.id, type: 'text', content: 'beta body', order: 0 });
  const { alphaId, betaId } = await page.evaluate(async () => {
    await app.sidebarController.reloadLists();
    await app.tabController.toggleSplitView();
    return { alphaId: app.editor.noteId, betaId: app.secondaryEditor.noteId };
  });
  expect(await page.evaluate(id => app.secondaryEditor.noteId === id, betaId)).toBe(true);

  // Edit Beta in the right pane, then trash the left pane's note
  await page.locator('#secondary-editor-container .block-content').first().click();
  await page.keyboard.press('End');
  await page.keyboard.type(' edited on the right');
  await page.waitForTimeout(800);
  await page.evaluate(id => app.trashNoteById(id), alphaId);
  await expect(page.locator('#secondary-editor-container')).toBeHidden();
  await expect.poll(() => page.evaluate(() => app.editor.noteId)).toBe(betaId);

  // Type on the left, then undo once
  await page.locator('#editor-container .block-content').first().click();
  await page.keyboard.press('End');
  await page.keyboard.type(' plus the left');
  await page.waitForTimeout(800);
  await page.keyboard.press('ControlOrMeta+z');
  await page.waitForTimeout(800);

  const before = await bodies(page, betaId);
  expect(before.stored).toBe(before.shown);
  await page.reload();
  await expect.poll(() => page.evaluate(() => window.app && app.editor && app.editor.noteId)).toBe(betaId);
  expect((await bodies(page, betaId)).shown).toBe(before.shown);
  await expectNoUncaught(extension, page);
});
