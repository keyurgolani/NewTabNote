/**
 * #12 slice 5 in the packaged extension: folders, filing, templates, bulk actions, and the
 * trash go through kernel commands, and every path that takes notes out of the active set
 * through removeNotes. Dragging a note onto a folder files it (a 1.4.x bug: no note's
 * dragstart set the id the folder's drop reads, so the drop filed nothing). Each test also
 * fails on an uncaught exception that test/known-defects.json doesn't list.
 */

const { test, expect, expectNoUncaught } = require('./harness');
const driver = require('./characterization/driver');

const DAY = 24 * 60 * 60 * 1000;

/** The sidebar's item for the note named `name` */
const noteItem = (page, name) =>
  page.locator('#sidebar-notes-list .sidebar-note-item').filter({ has: page.getByText(name, { exact: true }) });

/** The header of the sidebar's folder named `name` */
const folderHeader = (page, name) =>
  page.locator('#sidebar-notes-list .sidebar-folder-header').filter({ has: page.getByText(name, { exact: true }) });

/** The stored note named `name`, whatever list it's in */
const stored = (page, name) =>
  page.evaluate(async n => {
    const notes = [...(await Storage.getAllNotes(true)), ...(await Storage.getTrashedNotes()), ...(await Storage.getTemplates())];
    const found = notes.find(note => note.name === n);
    return found ? { id: found.id, folderId: found.folderId || null, updatedAt: found.updatedAt, isTemplate: Boolean(found.isTemplate), archived: Boolean(found.archived), trashed: Boolean(found.trashed) } : null;
  }, name);

const toasts = page => page.locator('.toast-container .toast').allTextContents();

/** Type `text` at the end of the open note's first block, and wait for the editor to store it */
async function typeAndSave(page, text) {
  await page.locator('#blocks-container .block-content').first().click();
  await page.keyboard.press('End');
  await page.keyboard.type(text);
  await page.evaluate(() => app.getEditor().flushSave());
}

/** Answer the prompt dialog `title` with `value` */
async function answerPrompt(page, title, value) {
  const dialog = page.getByRole('dialog', { name: title });
  await dialog.locator('input').fill(value);
  await dialog.getByRole('button', { name: 'OK' }).click();
}

/** Confirm the dialog `title` */
async function confirm(page, title) {
  await page.getByRole('dialog', { name: title }).locator('.confirm-dialog-confirm').click();
}

/** A new tab on an onboarded profile with notes Alpha and Beta and a folder Work, all listed */
async function withFolder(extension) {
  await extension.seedOnboarded();
  await driver.seedNotes(extension, [
    { name: 'Alpha', blocks: [{ type: 'text', content: 'Alpha body' }] },
    { name: 'Beta', blocks: [{ type: 'text', content: 'Beta body' }] },
  ]);
  const page = await driver.openNewTab(extension);
  await driver.showNotes(page);
  await page.locator('#sidebar-new-folder').click();
  await answerPrompt(page, 'New Folder', 'Work');
  await expect(folderHeader(page, 'Work')).toBeVisible();
  return page;
}

/** Drag Beta onto Work, and wait for it to be filed there */
async function dragBetaIntoWork(extension) {
  const page = await withFolder(extension);
  await noteItem(page, 'Beta').dragTo(folderHeader(page, 'Work'));
  const folderId = await page.evaluate(async () => (await Storage.getAllFolders()).find(f => f.name === 'Work').id);
  await expect.poll(async () => (await stored(page, 'Beta')).folderId).toBe(folderId);
  return { page, folderId };
}

test('dragging a note onto a folder files it there, and the folder lists it', async ({ extension }) => {
  const { page } = await dragBetaIntoWork(extension);
  await expect(page.locator('.sidebar-folder .sidebar-folder-contents .sidebar-note-name')).toHaveText(['Beta']);
  expect(await toasts(page)).toEqual([]);
  await expectNoUncaught(extension, page);
});

test('dropping a note on the folder it is in writes nothing and says nothing', async ({ extension }) => {
  const { page } = await dragBetaIntoWork(extension);
  const before = await stored(page, 'Beta');
  const inFolder = page.locator('.sidebar-folder .sidebar-folder-contents .sidebar-note-item');
  await inFolder.dragTo(folderHeader(page, 'Work'));
  await page.waitForTimeout(500);
  expect(await stored(page, 'Beta')).toEqual(before);
  expect(await toasts(page)).toEqual([]);
  await expectNoUncaught(extension, page);
});

test('dropping a note on a folder another tab deleted is refused, and the note stays where it was', async ({ extension }) => {
  const page = await withFolder(extension);
  // Deleted behind this tab's back, so its sidebar still shows it
  await page.evaluate(async () => Storage.deleteFolder((await Storage.getAllFolders()).find(f => f.name === 'Work').id));
  await noteItem(page, 'Alpha').dragTo(folderHeader(page, 'Work'));
  await expect(page.locator('.toast.error')).toHaveText(['Failed to move note: that folder no longer exists.']);
  expect((await stored(page, 'Alpha')).folderId).toBeNull();
  await expectNoUncaught(extension, page);
});

test('the drag check fails on a build whose note dragstart sets no note id, as 1.4.x', async ({ playwright, headless }, testInfo) => {
  const edits = {
    'js/controllers/sidebar-controller.js': text => text.replace('setData("noteId",', 'setData("ntnSelfTestNoNoteId",'),
  };
  await driver.withEditedBuild({ playwright, headless }, testInfo, edits, async extension => {
    const error = await dragBetaIntoWork(extension).then(() => null, thrown => thrown);
    expect(error, 'the drag filed the note on the edited build').not.toBeNull();
  });
});

test('harness pass: folders, filing and templates with the note open, bulk actions, the trash, and a failed trash', async ({ extension }) => {
  test.setTimeout(120_000);
  const page = await withFolder(extension);
  await driver.seedNotes(extension, [
    { name: 'Gamma', blocks: [{ type: 'text', content: 'Gamma body' }] },
    { name: 'Delta', blocks: [{ type: 'text', content: 'Delta body' }] },
  ]);
  await driver.reload(page);
  await driver.showNotes(page);

  // Folders: create, rename, move inside another, and back to the root
  await page.locator('#sidebar-new-folder').click();
  await answerPrompt(page, 'New Folder', 'Projects');
  await folderHeader(page, 'Projects').click({ button: 'right' });
  await page.locator('.context-menu-item', { hasText: 'Rename' }).click();
  await answerPrompt(page, 'Rename Folder', 'Plans');
  await expect(folderHeader(page, 'Plans')).toBeVisible();
  await folderHeader(page, 'Plans').dragTo(folderHeader(page, 'Work'));
  const parentOf = name => page.evaluate(async n => {
    const folders = await Storage.getAllFolders();
    const folder = folders.find(f => f.name === n);
    const parent = folders.find(f => f.id === folder.parentId);
    return parent ? parent.name : null;
  }, name);
  await expect.poll(() => parentOf('Plans')).toBe('Work');
  // A move into its own folder, from this view, is refused by the sidebar and by the kernel
  await page.evaluate(async () => {
    const folders = await Storage.getAllFolders();
    await app.sidebarController.moveFolder(folders.find(f => f.name === 'Work').id, folders.find(f => f.name === 'Plans').id);
  });
  await expect(page.locator('.toast.error').last()).toHaveText("Failed to move folder: it can't go inside itself.");
  expect(await parentOf('Work')).toBeNull();

  // A folder move with the note open: the editor's next save keeps it filed
  await driver.openNote(page, 'Alpha');
  await typeAndSave(page, ' typed before the move');
  await noteItem(page, 'Alpha').dragTo(folderHeader(page, 'Work'));
  await expect.poll(async () => (await stored(page, 'Alpha')).folderId).not.toBeNull();
  await typeAndSave(page, ', and after');
  await driver.reload(page);
  expect((await stored(page, 'Alpha')).folderId).not.toBeNull();
  expect(await driver.savedBlocks(page)).toEqual(['Alpha body typed before the move, and after']);

  // Convert to a template and back with the note open: the next saves keep each
  await driver.openNoteMenu(page, 'Alpha');
  await page.locator('#ctx-convert-template').click();
  await expect.poll(async () => (await stored(page, 'Alpha')).isTemplate).toBe(true);
  expect((await stored(page, 'Alpha')).folderId).toBeNull();
  await typeAndSave(page, ' T');
  expect((await stored(page, 'Alpha')).isTemplate).toBe(true);
  await page.locator('#sidebar-tab-templates').click();
  await noteItem(page, 'Alpha').click({ button: 'right' });
  await page.locator('#ctx-back-to-note').click();
  await expect.poll(async () => (await stored(page, 'Alpha')).isTemplate).toBe(false);
  await typeAndSave(page, ' N');
  expect((await stored(page, 'Alpha')).isTemplate).toBe(false);
  expect(await driver.savedBlocks(page)).toEqual(['Alpha body typed before the move, and after T N']);

  // Delete a folder: Plans goes with Work, and their notes go to the root
  await driver.showNotes(page);
  await driver.openNote(page, 'Gamma');
  await noteItem(page, 'Gamma').dragTo(folderHeader(page, 'Work'));
  await expect.poll(async () => (await stored(page, 'Gamma')).folderId).not.toBeNull();
  await folderHeader(page, 'Work').click({ button: 'right' });
  await page.locator('.context-menu-item', { hasText: 'Delete Folder' }).click();
  await confirm(page, 'Delete Folder');
  await expect.poll(() => page.evaluate(async () => (await Storage.getAllFolders()).length)).toBe(0);
  expect((await stored(page, 'Gamma')).folderId).toBeNull();
  await expect(noteItem(page, 'Gamma')).toBeVisible();

  // Bulk archive and trash from the bar, restore and delete as the bar's action runs them,
  // with the palette open after each
  const paletteNames = async () => {
    await page.evaluate(() => app.shortcutsManager.toggleCommandPalette(true));
    const names = await page.locator('#command-palette-results').innerText();
    await page.evaluate(() => app.shortcutsManager.toggleCommandPalette(false));
    return names;
  };
  const select = names => page.evaluate(async list => {
    const ids = [...(await Storage.getAllNotes(true)), ...(await Storage.getTrashedNotes())]
      .filter(note => list.includes(note.name)).map(note => note.id);
    app.sidebarController.enterSelectionMode();
    for (const id of ids) app.sidebarController.selectedNoteIds.add(id);
    app.sidebarController.updateSelectionUI();
  }, names);
  await select(['Beta', 'Delta']);
  await page.locator('#bulk-archive-btn').click();
  await confirm(page, 'Confirm');
  await expect(page.locator('.toast.success').last()).toHaveText('2 notes archived');
  expect([(await stored(page, 'Beta')).archived, (await stored(page, 'Delta')).archived]).toEqual([true, true]);
  expect(await paletteNames()).toContain('Beta');
  await select(['Gamma']);
  await page.locator('#bulk-delete-btn').click();
  await confirm(page, 'Confirm');
  await expect(page.locator('.toast.success').last()).toHaveText('1 note moved to Trash');
  expect(await paletteNames()).not.toContain('Gamma');
  await select(['Gamma']);
  await page.evaluate(() => app.sidebarController.performBulkAction('restore'));
  await expect(page.locator('.toast.success').last()).toHaveText('1 note restored from Trash');
  expect(await paletteNames()).toContain('Gamma');
  await page.evaluate(async () => Storage.trashNote((await Storage.getAllNotes()).find(note => note.name === 'Gamma').id));
  await page.evaluate(() => app.sidebarController.reloadLists());
  await select(['Gamma']);
  const deleting = page.evaluate(() => app.sidebarController.performBulkAction('delete'));
  await confirm(page, 'Confirm');
  await deleting;
  await expect(page.locator('.toast.success').last()).toHaveText('1 note permanently deleted');
  expect(await stored(page, 'Gamma')).toBeNull();
  expect(await paletteNames()).not.toContain('Gamma');

  // Empty trash
  await driver.openNoteMenu(page, 'Alpha');
  await page.locator('#ctx-delete-note').click();
  await expect.poll(async () => (await stored(page, 'Alpha')).trashed).toBe(true);
  await page.locator('#sidebar-tab-trash').click();
  await page.locator('#empty-trash-btn').click();
  await confirm(page, 'Empty Trash');
  await expect(page.locator('.toast.success').last()).toHaveText('Trash emptied');
  expect(await stored(page, 'Alpha')).toBeNull();

  // A trash that fails to store leaves the panes and tabs as they were, and says so
  await page.evaluate(async () => Storage.unarchiveNote((await Storage.getAllNotes(true)).find(note => note.name === 'Beta').id));
  await page.evaluate(() => app.sidebarController.reloadLists());
  await driver.openNote(page, 'Beta');
  const panes = () => page.evaluate(() => ({
    note: app.editor.noteId,
    tabs: app.tabController.openTabs.map(tab => tab.noteId),
    active: app.tabController.activeTabIndex,
  }));
  const before = await panes();
  await page.evaluate(() => {
    // Fault injection: every write that would trash a note fails, as a broken database's do, on
    // the page's every connection: the tab's kernel is on #17's adapter since #17 PR 4a, which
    // runs a transaction an UnknownError aborted once more, and that fails too
    const transaction = IDBDatabase.prototype.transaction;
    IDBDatabase.prototype.transaction = function failingTrash(names, mode, options) {
      const tx = transaction.call(this, names, mode, options);
      const objectStore = tx.objectStore.bind(tx);
      tx.objectStore = name => {
        const store = objectStore(name);
        if (name !== 'canvases') return store;
        const put = store.put.bind(store);
        store.put = (record, key) => {
          if (record && record.trashed === true) throw new DOMException('A write the test made fail', 'UnknownError');
          return key === undefined ? put(record) : put(record, key);
        };
        return store;
      };
      return tx;
    };
  });
  await driver.openNoteMenu(page, 'Beta');
  await page.locator('#ctx-delete-note').click();
  await expect(page.locator('.toast.error').last()).toHaveText('Failed to move note to trash. Please try again.');
  expect(await panes()).toEqual(before);
  expect((await stored(page, 'Beta')).trashed).toBe(false);
  await expectNoUncaught(extension, page);
});

test('trash retention at startup deletes a note trashed long ago, once the tab has its workspace', async ({ extension }) => {
  await extension.seedOnboarded();
  await driver.seedNotes(extension, [
    { name: 'Kept', blocks: [{ type: 'text', content: 'kept' }] },
    { name: 'Expired', blocks: [{ type: 'text', content: 'old' }] },
    { name: 'Recent', blocks: [{ type: 'text', content: 'new' }] },
  ]);
  const page = await driver.openNewTab(extension);
  await page.evaluate(async day => {
    const notes = await Storage.getAllNotes();
    const expired = notes.find(note => note.name === 'Expired');
    const recent = notes.find(note => note.name === 'Recent');
    await Storage.trashNote(expired.id);
    await Storage.trashNote(recent.id);
    await Storage.updateNote({ ...(await Storage.getNote(expired.id)), trashedAt: Date.now() - 40 * day });
  }, DAY);
  await driver.reload(page);
  await expect.poll(() => stored(page, 'Expired')).toBeNull();
  expect((await stored(page, 'Recent')).trashed).toBe(true);
  expect(await driver.noteTitle(page)).toBe('Kept');
  await expectNoUncaught(extension, page);
});
