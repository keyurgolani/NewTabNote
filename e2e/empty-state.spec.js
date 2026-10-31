/**
 * The empty state follows the note list (#12 slice 7c): once no active or archived note is
 * left it shows, and once one is back it goes, whichever action took the notes out or brought
 * them back. Before, only App's refresh and one note's actions (trash, restore, and the like)
 * updated it, so a bulk trash that left no note kept the editor up. In the first two tests the
 * editor is on a template, so no pane has to move off the note that leaves, and no new note is
 * made for it. In the last two it's on the note that leaves, the only one, so the editor gets a
 * new note, and the empty state never shows in between. Each test also fails on an uncaught
 * exception that test/known-defects.json doesn't list.
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

/**
 * A new tab on an onboarded profile with one note, Alpha, open in the editor. From then on the
 * page counts each time the empty state shows, as window.__ntnEmptyStateShown: each class the
 * element takes, read back from its mutation records, so a show that's undone before the
 * observer runs still counts.
 */
async function onOnlyNote(extension) {
  await extension.seedOnboarded();
  await driver.seedNotes(extension, [{ name: 'Alpha', blocks: [{ type: 'text', content: 'Alpha body' }] }]);
  const page = await driver.openNewTab(extension);
  await driver.showNotes(page);
  await driver.openNote(page, 'Alpha');
  await expect(page.locator('#page-title')).toHaveText('Alpha');
  await expect(page.locator('#empty-state')).toBeHidden();
  await page.evaluate(() => {
    const emptyState = document.getElementById('empty-state');
    window.__ntnEmptyStateShown = 0;
    new MutationObserver((records) => {
      // A record holds the class before its change, so the class after it is the next record's
      // old value, or the element's own for the last one
      const classes = records.slice(1).map((record) => record.oldValue).concat(emptyState.className);
      window.__ntnEmptyStateShown += classes.filter((value) => !String(value).split(/\s+/).includes('hidden')).length;
    }).observe(emptyState, { attributes: true, attributeFilter: ['class'], attributeOldValue: true });
  });
  return page;
}

/** The editor has the new note, listed in the sidebar, and the empty state never showed */
async function expectNewNoteWithNoEmptyState(page) {
  await expect(page.locator('#sidebar-notes-list .sidebar-note-item')
    .filter({ has: page.getByText('Untitled', { exact: true }) })).toHaveCount(1);
  await expectEmptyState(page, false);
  expect(await page.evaluate(() => window.__ntnEmptyStateShown)).toBe(0);
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

test('moving the only note to trash while the editor shows it gives the editor a new note, with no empty state in between', async ({ extension }) => {
  const page = await onOnlyNote(extension);
  await driver.openNoteMenu(page, 'Alpha');
  await page.locator('#ctx-delete-note').click();
  await expect(page.locator('.toast.success').last()).toHaveText('Note moved to trash');
  await expectNewNoteWithNoEmptyState(page);
  await expectNoUncaught(extension, page);
});

test('a bulk trash of the only note while the editor shows it gives the editor a new note, with no empty state in between', async ({ extension }) => {
  const page = await onOnlyNote(extension);
  await page.evaluate(() => {
    const alpha = app.sidebarController.notes.find(note => note.name === 'Alpha');
    app.sidebarController.enterSelectionMode();
    app.sidebarController.selectedNoteIds.add(alpha.id);
    app.sidebarController.updateSelectionUI();
  });
  await page.locator('#bulk-delete-btn').click();
  await page.getByRole('dialog', { name: 'Confirm' }).locator('.confirm-dialog-confirm').click();
  await expect(page.locator('.toast.success').last()).toHaveText('1 note moved to Trash');
  await expectNewNoteWithNoEmptyState(page);
  await expectNoUncaught(extension, page);
});
