/**
 * The empty state follows the note list (#12 slice 7c): once no active or archived note is
 * left it shows, and once one is back it goes, whichever action took the notes out or brought
 * them back. Before, only App's refresh and one note's actions (trash, restore, and the like)
 * updated it, so a bulk trash that left no note kept the editor up. The editor is on a
 * template here, so no pane has to move off the note that leaves, and no new note is made for
 * it. Each test also fails on an uncaught exception that test/known-defects.json doesn't list.
 */

const { test, expect, expectNoUncaught } = require('./harness');
const driver = require('./characterization/driver');

/** A new tab on an onboarded profile with one note, Alpha, and one template, Recipe, open in the editor */
async function onTemplate(extension) {
  await extension.seedOnboarded();
  await driver.seedNotes(extension, [
    { name: 'Recipe', blocks: [{ type: 'text', content: 'Recipe body' }], isTemplate: true },
    { name: 'Alpha', blocks: [{ type: 'text', content: 'Alpha body' }] },
  ]);
  const page = await driver.openNewTab(extension);
  await page.locator('#sidebar-tab-templates').click();
  await page.locator('#sidebar-notes-list .sidebar-note-item').filter({ has: page.getByText('Recipe', { exact: true }) }).click();
  await expect(page.locator('#page-title')).toHaveText('Recipe');
  await driver.showNotes(page);
  await expect(page.locator('#empty-state')).toBeHidden();
  return page;
}

/** The empty state is up, over the editor and the tabs, or gone */
async function expectEmptyState(page, shown) {
  if (shown) {
    await expect(page.locator('#empty-state')).toBeVisible();
    await expect(page.locator('#editor-container')).toBeHidden();
    await expect(page.locator('#note-tabs .note-tab')).toHaveCount(0);
  } else {
    await expect(page.locator('#empty-state')).toBeHidden();
    await expect(page.locator('#editor-container')).toBeVisible();
  }
}

/** Restore Alpha from its menu in the trash */
async function restoreAlpha(page) {
  await page.locator('#sidebar-tab-trash').click();
  await page.locator('#sidebar-notes-list .sidebar-note-item')
    .filter({ has: page.getByText('Alpha', { exact: true }) })
    .click({ button: 'right' });
  await page.locator('#ctx-restore-note').click();
  await expect(page.locator('.toast.success').last()).toHaveText('Note restored from trash');
}

test("moving the last note to trash from its menu shows the empty state, and restoring it takes it away", async ({ extension }) => {
  const page = await onTemplate(extension);
  await driver.openNoteMenu(page, 'Alpha');
  await page.locator('#ctx-delete-note').click();
  await expect(page.locator('.toast.success').last()).toHaveText('Note moved to trash');
  await expectEmptyState(page, true);

  await restoreAlpha(page);
  await expectEmptyState(page, false);
  await expectNoUncaught(extension, page);
});

test('a bulk trash of the last note shows the empty state too, and restoring it takes it away', async ({ extension }) => {
  const page = await onTemplate(extension);
  await page.evaluate(() => {
    const alpha = app.sidebarController.notes.find(note => note.name === 'Alpha');
    app.sidebarController.enterSelectionMode();
    app.sidebarController.selectedNoteIds.add(alpha.id);
    app.sidebarController.updateSelectionUI();
  });
  await page.locator('#bulk-delete-btn').click();
  await page.getByRole('dialog', { name: 'Confirm' }).locator('.confirm-dialog-confirm').click();
  await expect(page.locator('.toast.success').last()).toHaveText('1 note moved to Trash');
  await expectEmptyState(page, true);

  await restoreAlpha(page);
  await expectEmptyState(page, false);
  await expectNoUncaught(extension, page);
});
