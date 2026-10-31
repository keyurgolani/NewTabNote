/**
 * Moving the last active note to trash, alone or in a bulk trash, opens a new Untitled note in
 * the editor and in its tab, and the sidebar marks that note's item active, as 1.4.x does.
 * Since #76 a single trash left the item unmarked (the walkthrough's a11 and a12): the sidebar
 * list draws the new note from its commit before the editor has opened it, and App.leaveNotes
 * no longer draws it again after. A bulk trash draws the list again as it leaves selection
 * mode, so its test guards the same rule. Each test also fails on an uncaught exception that
 * test/known-defects.json doesn't list.
 */

const { test, expect, expectNoUncaught } = require('./harness');
const driver = require('./characterization/driver');

/** A new tab on an onboarded profile with the notes `names`, listed */
async function withNotes(extension, names) {
  await extension.seedOnboarded();
  await driver.seedNotes(extension, names.map(name => ({ name, blocks: [{ type: 'text', content: `${name} body` }] })));
  const page = await driver.openNewTab(extension);
  await driver.showNotes(page);
  return page;
}

/** The new note is open in the editor and its tab, it's the one note listed, and its item is active */
async function expectNewNoteMarked(page) {
  await expect(page.locator('#page-title')).toHaveText('Untitled');
  await expect(page.locator('#note-tabs .note-tab-name')).toHaveText(['Untitled']);
  const items = page.locator('#sidebar-notes-list .sidebar-note-item');
  await expect(items).toHaveCount(1);
  const shown = await page.evaluate(() => app.getEditor().noteId);
  await expect(items.first()).toHaveAttribute('data-id', shown);
  await expect(items.first()).toHaveClass(/(^|\s)active(\s|$)/);
}

test('moving the only note to trash opens a new note, and the sidebar marks it active', async ({ extension }) => {
  const page = await withNotes(extension, ['Alpha']);
  await driver.openNote(page, 'Alpha');
  await driver.openNoteMenu(page, 'Alpha');
  await page.locator('#ctx-delete-note').click();
  await expect(page.locator('.toast.success').last()).toHaveText('Note moved to trash');
  await expectNewNoteMarked(page);
  await expectNoUncaught(extension, page);
});

test('a bulk trash of every note opens a new note, and the sidebar marks it active', async ({ extension }) => {
  const page = await withNotes(extension, ['Alpha', 'Beta']);
  await driver.openNote(page, 'Beta');
  await page.evaluate(async () => {
    const ids = (await Storage.getAllNotes()).map(note => note.id);
    app.sidebarController.enterSelectionMode();
    for (const id of ids) app.sidebarController.selectedNoteIds.add(id);
    app.sidebarController.updateSelectionUI();
  });
  await page.locator('#bulk-delete-btn').click();
  await page.getByRole('dialog', { name: 'Confirm' }).locator('.confirm-dialog-confirm').click();
  await expect(page.locator('.toast.success').last()).toHaveText('2 notes moved to Trash');
  await expectNewNoteMarked(page);
  await expectNoUncaught(extension, page);
});
