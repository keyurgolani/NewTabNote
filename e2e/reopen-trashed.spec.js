/**
 * A note in trash never reopens by itself: not after Import > Replace all and a reload,
 * and not from saved tabs a 1.4.0 profile left pointing at a note in trash. (Another new
 * tab that shows a note when it's trashed keeps it, as 1.4.0 did: see
 * notes-leave-across-tabs.spec.js.) Each test also fails on an uncaught exception that
 * test/known-defects.json doesn't list.
 */

const { test, expect, expectNoUncaught } = require('./harness');
const { profileStore } = require('./harness/profile-store');
const driver = require('./characterization/driver');

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
 * A new tab on an onboarded profile, once it has opened its first note: its app has
 * started and the focus moves it makes after loading a note have run (the driver waits
 * for those), and it has cached the last-opened note, the last thing it writes.
 */
async function openFirstNewTab(extension) {
  const page = await driver.openNewTab(extension);
  await expect(page.locator('#page-title')).toHaveText('Untitled');
  await expect.poll(() => page.evaluate(async () => (await chrome.storage.local.get('lastOpenedNoteId')).lastOpenedNoteId || null))
    .not.toBeNull();
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
  expect((await profileStore(page).getTrashedNotes()).map(note => note.name)).toEqual(['Old note']);

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
  const store = profileStore(page);
  const keep = await store.createNote('Keep me');
  const gone = await store.createNote('In trash');
  await store.trashNote(gone.id);
  await page.evaluate(async ({ keepId, goneId }) => {
    await chrome.storage.local.set({
      setting_openTabs: [{ noteId: goneId, name: 'In trash' }, { noteId: keepId, name: 'Keep me' }],
      setting_activeTabIndex: 0,
      lastOpenedNoteId: goneId,
    });
  }, { keepId: keep.id, goneId: gone.id });

  await page.reload();
  await expect(page.locator('#page-title')).toHaveText('Keep me');
  await expect(page.locator('#note-tabs .note-tab-name')).toHaveText(['Keep me']);
  await expectNoUncaught(extension, page);
});
