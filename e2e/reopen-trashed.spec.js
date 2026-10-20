/**
 * A note in trash never reopens by itself: not after Import > Replace all and a reload,
 * not from saved tabs a 1.4.0 profile left pointing at a note in trash, and not in
 * another new tab that showed it when it was trashed. Each test also fails on an
 * uncaught exception that test/known-defects.json doesn't list.
 */

const { test, expect, expectNoUncaught } = require('./harness');

/** Export JSON with one note and one block, as 1.4.1 writes it */
function backup() {
  const at = 1760000000000;
  return {
    version: 1,
    exportedAt: at,
    canvases: [{
      id: 'pkg-note', name: 'Imported note', createdAt: at, updatedAt: at, archived: false, archivedAt: null,
      titleManuallySet: true, preview: '', pinned: false, todoProgress: null, isDaily: false, dateStr: null,
      isTemplate: false, folderId: null,
    }],
    elements: [{
      id: 'pkg-block', type: 'text', content: 'From the backup', indentLevel: 0, checked: false,
      createdAt: at, updatedAt: at, canvasId: 'pkg-note', order: 0,
    }],
    media: [],
    folders: [],
  };
}

/**
 * A new tab on an onboarded profile, once it has opened its first note: caching the
 * last-opened note is the last thing it writes, and the editor moves the focus to the
 * first block a moment after it loads the note.
 */
async function openFirstNewTab(extension) {
  const page = await extension.openSurface('newtab');
  await expect(page.locator('#page-title')).toHaveText('Untitled');
  await expect.poll(() => page.evaluate(async () => (await chrome.storage.local.get('lastOpenedNoteId')).lastOpenedNoteId || null))
    .not.toBeNull();
  await expect(page.locator('#editor-container .block-content').first()).toBeFocused();
  return page;
}

test('after Replace all and a reload, the new tab opens the imported note, not the one moved to trash', async ({ extension }) => {
  await extension.seedOnboarded();
  const page = await openFirstNewTab(extension);
  await page.locator('#page-title').fill('Old note');
  await expect(page.locator('#note-tabs .note-tab-name')).toHaveText(['Old note']);

  await page.locator('#import-input').setInputFiles({
    name: 'backup.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(backup())),
  });
  await page.getByRole('dialog', { name: 'Import backup' }).getByRole('button', { name: 'Replace all' }).click();
  await page.getByRole('dialog', { name: 'Replace all notes?' }).getByRole('button', { name: 'Replace all' }).click();
  await expect(page.locator('.toast.success').filter({ hasText: 'Imported 1 note and 1 block.' })).toBeVisible();

  await expect(page.locator('#page-title')).toHaveText('Imported note');
  await expect(page.locator('#note-tabs .note-tab-name')).toHaveText(['Imported note']);
  expect(await page.evaluate(async () => (await Storage.getTrashedNotes()).map(note => note.name))).toEqual(['Old note']);

  await page.reload();
  await expect(page.locator('#page-title')).toHaveText('Imported note');
  await expect(page.locator('#note-tabs .note-tab-name')).toHaveText(['Imported note']);
  await expect(page.locator('#blocks-container .block').first()).toContainText('From the backup');
  await expectNoUncaught(extension, page);
});

test('at startup, a saved tab and last-opened note in trash stay closed', async ({ extension }) => {
  await extension.seedOnboarded();
  const page = await openFirstNewTab(extension);

  // What 1.4.0 leaves behind after Replace all, or after trashing the note in the last tab
  await page.evaluate(async () => {
    const keep = await Storage.createNote('Keep me');
    const gone = await Storage.createNote('In trash');
    await Storage.trashNote(gone.id);
    await chrome.storage.local.set({
      setting_openTabs: [{ noteId: gone.id, name: 'In trash' }, { noteId: keep.id, name: 'Keep me' }],
      setting_activeTabIndex: 0,
      lastOpenedNoteId: gone.id,
    });
  });

  await page.reload();
  await expect(page.locator('#page-title')).toHaveText('Keep me');
  await expect(page.locator('#note-tabs .note-tab-name')).toHaveText(['Keep me']);
  await expectNoUncaught(extension, page);
});

test('a note trashed in one new tab leaves the other new tab that shows it', async ({ extension }) => {
  await extension.seedOnboarded();
  const first = await openFirstNewTab(extension);
  const leavingId = await first.evaluate(async () => {
    const note = await Storage.createNote('Leaving');
    await app.refreshNotesList();
    return note.id;
  });

  const second = await extension.openSurface('newtab');
  await expect(second.locator('#page-title')).not.toHaveText('');
  await second.evaluate(id => app.openNoteInNewTab(id), leavingId);
  await expect(second.locator('#page-title')).toHaveText('Leaving');
  await expect(second.locator('#note-tabs .note-tab-name')).toContainText(['Leaving']);

  await first.evaluate(id => app.trashNoteById(id), leavingId);

  await expect(second.locator('#page-title')).not.toHaveText('Leaving');
  await expect(second.locator('#note-tabs .note-tab-name')).not.toContainText(['Leaving']);
  expect(await second.evaluate(() => app.tabController.openTabs.map(tab => tab.name))).not.toContain('Leaving');
  await expectNoUncaught(extension, second);
});
