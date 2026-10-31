/**
 * A note that leaves the active set in one new tab leaves the other new tabs' panes and tabs
 * where they are, as 1.4.0 did; they only refresh their lists. A pane on that note keeps it:
 * its saves keep the note in trash or the archive, and on a note deleted for good it shows
 * the notice and keeps the text. Clicking the tab of a note deleted elsewhere closes that tab
 * with a toast. Each test also fails on an uncaught exception that test/known-defects.json
 * doesn't list.
 */

const { test, expect, expectNoUncaught } = require('./harness');
const driver = require('./characterization/driver');

/**
 * Alpha and Beta, a new tab on `shown`, and a second new tab, the one in use, on Beta. The
 * driver waits until each tab's app has started and its first focus has moved.
 */
async function twoTabs(extension, shown = 'Alpha') {
  await extension.seedOnboarded();
  await driver.seedNotes(extension, [
    { name: 'Alpha', blocks: [{ type: 'text', content: 'Alpha body' }] },
    { name: 'Beta', blocks: [{ type: 'text', content: 'Beta body' }] },
  ]);
  const other = await driver.openNewTab(extension);
  await driver.openNote(other, shown);
  const used = await driver.openNewTab(extension);
  await driver.openNote(used, 'Beta');
  const ids = await used.evaluate(async () => Object.fromEntries((await Storage.getAllNotes()).map(note => [note.name, note.id])));
  const otherTabs = await other.locator('#note-tabs .note-tab-name').allTextContents();
  return { used, other, ids, otherTabs };
}

/** A note as stored: its trash and archive state and its blocks' text, or null when it's gone */
function stored(page, noteId) {
  return page.evaluate(async id => {
    const note = await Storage.getNote(id);
    if (!note) return null;
    const blocks = (await Storage.getElementsByNote(id)).sort((a, b) => a.order - b.order).map(block => block.content);
    return { trashed: Boolean(note.trashed), archived: Boolean(note.archived), blocks };
  }, noteId);
}

/** Type at the end of the first block of `page`'s note, and let the editor write it */
async function typeAtEnd(page, text) {
  await page.bringToFront();
  await page.locator('#blocks-container > .block .block-content').first().click();
  await page.keyboard.press('End');
  await page.keyboard.type(text);
  await page.evaluate(() => app.editor.flushSave());
}

/** Confirm the dialog `title` that `pending` (a page.evaluate) is waiting on */
async function confirmIn(page, title, pending) {
  await page.getByRole('dialog', { name: title }).getByRole('button', { name: 'Delete', exact: true }).click();
  await pending;
}

/** The other tab still shows Alpha, with the tabs it had, once its notes list no longer lists Alpha */
async function staysOnAlpha(other, otherTabs) {
  await expect(other.locator('#sidebar-notes-list'), 'its list refreshed').not.toContainText('Alpha');
  await expect(other.locator('#page-title')).toHaveText('Alpha');
  await expect(other.locator('#note-tabs .note-tab-name')).toHaveText(otherTabs);
}

for (const [what, flag, act] of [
  ['trashed', 'trashed', (used, ids) => used.evaluate(id => app.trashNoteById(id), ids.Alpha)],
  ['archived', 'archived', (used, ids) => used.evaluate(id => app.archiveNote(id), ids.Alpha)],
]) {
  test(`a note ${what} in another new tab stays on screen in this one, and typing there keeps it ${flag}`, async ({ extension }) => {
    const { used, other, ids, otherTabs } = await twoTabs(extension);
    await act(used, ids);
    await staysOnAlpha(other, otherTabs);

    await typeAtEnd(other, ' and more');
    expect(await stored(used, ids.Alpha)).toEqual({ trashed: flag === 'trashed', archived: flag === 'archived', blocks: ['Alpha body and more'] });
    await expectNoUncaught(extension, other);
  });
}

test('after Replace all in another new tab, this one stays on its note, and typing there keeps it in trash', async ({ extension }) => {
  const { used, other, ids, otherTabs } = await twoTabs(extension);
  const at = 1760000000000;
  await used.locator('#import-input').setInputFiles({
    name: 'backup.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify({
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
    })),
  });
  await used.getByRole('dialog', { name: 'Import backup' }).getByRole('button', { name: 'Replace all' }).click();
  await used.getByRole('dialog', { name: 'Replace all notes?' }).getByRole('button', { name: 'Replace all' }).click();
  await expect(used.locator('#page-title')).toHaveText('Imported note');
  await staysOnAlpha(other, otherTabs);

  await typeAtEnd(other, ' and more');
  expect(await stored(used, ids.Alpha)).toEqual({ trashed: true, archived: false, blocks: ['Alpha body and more'] });
  await expectNoUncaught(extension, other);
});

for (const [what, act] of [
  ['when another new tab empties trash', (used) => confirmIn(used, 'Empty Trash', used.evaluate(() => app.sidebarController.emptyTrash()))],
  ['when another new tab deletes it for good', (used, ids) => confirmIn(used, 'Delete Permanently', used.evaluate(id => app.permanentlyDeleteNoteById(id), ids.Alpha))],
]) {
  test(`a note deleted ${what} stays on screen in this one, and typing there shows the notice and keeps the text`, async ({ extension }) => {
    const { used, other, ids, otherTabs } = await twoTabs(extension);
    await used.evaluate(id => app.trashNoteById(id), ids.Alpha);
    await act(used, ids);
    expect(await stored(used, ids.Alpha), 'deleted').toBeNull();
    await expect(other.locator('#page-title')).toHaveText('Alpha');

    await typeAtEnd(other, ' and more');
    await expect(other.locator('#editor-container .note-gone-notice')).toContainText("This note was deleted, so these changes aren't saved.");
    expect(await driver.blocks(other)).toEqual([{ type: 'text', text: 'Alpha body and more' }]);
    await expect(other.locator('#note-tabs .note-tab-name')).toHaveText(otherTabs);
    expect(await stored(used, ids.Alpha), 'still deleted').toBeNull();
    await expectNoUncaught(extension, other);
  });
}

test('trash retention at a new tab\'s start leaves another new tab on the note it deletes, and typing there shows the notice', async ({ extension }) => {
  await extension.seedOnboarded();
  const other = await driver.openNewTab(extension);
  // A note trashed 40 days ago, past the 30-day retention, open from the Trash view
  const oldId = await other.evaluate(async () => {
    const note = await Storage.createNote('Old trashed');
    await Storage.saveElement({ id: Utils.generateId(), canvasId: note.id, type: 'text', content: 'old body', order: 0 });
    await Storage.updateNote({ ...(await Storage.getNote(note.id)), trashed: true, trashedAt: Date.now() - 40 * 24 * 60 * 60 * 1000 });
    await app.sidebarController.reloadLists();
    await app.openNoteInNewTab(note.id);
    return note.id;
  });
  await expect(other.locator('#page-title')).toHaveText('Old trashed');

  // A new tab starts, and its retention deletes the note
  const used = await driver.openNewTab(extension);
  await expect.poll(() => stored(used, oldId)).toBeNull();
  await expect.poll(() => other.evaluate(id => app.sidebarController.trashedNotes.some(note => note.id === id), oldId), 'its lists refreshed')
    .toBe(false);
  expect(await other.evaluate(() => app.editor.noteId)).toBe(oldId);
  await expect(other.locator('#page-title')).toHaveText('Old trashed');

  await typeAtEnd(other, ' and more');
  await expect(other.locator('#editor-container .note-gone-notice')).toBeVisible();
  expect(await driver.blocks(other)).toEqual([{ type: 'text', text: 'old body and more' }]);
  await expectNoUncaught(extension, other);
});

test('clicking the tab of a note deleted in another new tab closes that tab with a toast, and the note on screen stays', async ({ extension }) => {
  const { used, other, ids, otherTabs } = await twoTabs(extension, 'Beta');
  // Beta, seeded last, is the newest note, so the first new tab started on it alone
  expect(otherTabs, 'the other new tab has one tab, Beta').toEqual(['Beta']);
  await other.evaluate(id => app.openNoteInNewTab(id), ids.Alpha);
  await other.locator('#note-tabs .note-tab').filter({ hasText: 'Beta' }).click();
  await expect(other.locator('#page-title')).toHaveText('Beta');
  await expect(other.locator('#note-tabs .note-tab-name')).toHaveText(['Beta', 'Alpha']);

  await used.evaluate(id => app.trashNoteById(id), ids.Alpha);
  await confirmIn(used, 'Delete Permanently', used.evaluate(id => app.permanentlyDeleteNoteById(id), ids.Alpha));

  await other.bringToFront();
  await other.locator('#note-tabs .note-tab').filter({ hasText: 'Alpha' }).click();
  await expect(other.locator('.toast').filter({ hasText: 'That note was deleted, so its tab closed.' })).toBeVisible();
  await expect(other.locator('#note-tabs .note-tab-name')).toHaveText(['Beta']);
  await expect(other.locator('#page-title')).toHaveText('Beta');
  expect(await driver.blocks(other)).toEqual([{ type: 'text', text: 'Beta body' }]);
  await expectNoUncaught(extension, other);
});
