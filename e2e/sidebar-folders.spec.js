/**
 * NTN-03 on the built extension: collapsing a folder in the sidebar hides its notes and turns
 * its arrow, and expanding shows them again. The saved state applies when the new tab starts.
 * The folder's header is the toggle: it takes focus, Enter or Space toggles it, and it says
 * whether the folder is expanded. A folder's state changes only when its header is toggled:
 * opening one of its notes or adding a note to it leaves it as it is. Search lists every match,
 * collapsed folders' notes included, and a collapsed folder hides its subfolders, which keep
 * their own state. Each test also fails on an uncaught exception that
 * test/known-defects.json doesn't list.
 */

const { test, expect, expectNoUncaught } = require('./harness');
const driver = require('./characterization/driver');

/**
 * Store a folder named `name` (inside `parent`, a folder ID, when given) holding the notes named
 * `notes`, before the first new tab opens; returns the folder's ID
 */
async function storeFolder(extension, name, notes, { collapsed = false, parent = null } = {}) {
  await driver.seedNotes(extension, notes.map(note => ({ name: note, blocks: [{ type: 'text', content: `${note}: the plan, the owners and the dates.` }] })));
  return extension.worker.evaluate(async ({ name, notes, collapsed, parent }) => {
    const folder = await self.Storage.createFolder(name, parent);
    if (collapsed) await self.Storage.updateFolder({ ...folder, collapsed: true });
    for (const note of (await self.Storage.getAllNotes()).filter(n => notes.includes(n.name))) {
      await self.Storage.moveNoteToFolder(note.id, folder.id);
    }
    return folder.id;
  }, { name, notes, collapsed, parent });
}

/** The folder named `name` as stored: whether it's collapsed */
async function storedCollapsed(extension, name) {
  return extension.worker.evaluate(async folderName => {
    const folder = (await self.Storage.getAllFolders()).find(f => f.name === folderName);
    return folder ? Boolean(folder.collapsed) : null;
  }, name);
}

/** The sidebar's folder named `name`: its element, header, arrow and the note rows directly in it */
function folderIn(page, name) {
  const folder = page.locator('#sidebar .sidebar-folder', { has: page.locator(':scope > .sidebar-folder-header .folder-name', { hasText: name }) });
  return {
    folder,
    header: folder.locator(':scope > .sidebar-folder-header'),
    arrow: folder.locator(':scope > .sidebar-folder-header .folder-arrow'),
    rows: folder.locator(':scope > .sidebar-folder-contents > .sidebar-note-item'),
  };
}

const transformOf = arrow => arrow.evaluate(el => getComputedStyle(el).transform);

/** A new tab opened on a note outside the folders */
async function openOnRootNote(extension) {
  await driver.seedNotes(extension, [{ name: 'Inbox', blocks: [{ type: 'text', content: 'Loose ends for the week.' }] }]);
  return driver.openNewTab(extension);
}

test('collapsing a folder hides its notes and turns its arrow, expanding shows them, and a reload keeps it collapsed', async ({ extension }) => {
  await extension.seedOnboarded();
  await storeFolder(extension, 'Projects', ['Alpha plan', 'Beta plan']);
  const page = await openOnRootNote(extension);
  const { header, arrow, rows } = folderIn(page, 'Projects');
  await expect(rows).toHaveCount(2);
  await expect(rows.nth(0)).toBeVisible();
  await expect(rows.nth(1)).toBeVisible();
  const expandedArrow = await transformOf(arrow);

  await header.click();
  await expect(rows.nth(0), 'a collapsed folder hides its notes').toBeHidden();
  await expect(rows.nth(1)).toBeHidden();
  await expect.poll(() => transformOf(arrow), 'the arrow turns').not.toBe(expandedArrow);
  await expect.poll(() => storedCollapsed(extension, 'Projects')).toBe(true);

  await header.click();
  await expect(rows.nth(0), 'expanding shows them again').toBeVisible();
  await expect(rows.nth(1)).toBeVisible();
  await expect.poll(() => transformOf(arrow)).toBe(expandedArrow);

  await header.click();
  await expect.poll(() => storedCollapsed(extension, 'Projects')).toBe(true);
  await driver.reload(page);
  await expect(rows).toHaveCount(2);
  await expect(rows.nth(0), 'still hidden after a reload').toBeHidden();
  await expect(rows.nth(1)).toBeHidden();
  await expectNoUncaught(extension, page);
});

test("a folder's header toggles it from the keyboard and says whether it's expanded", async ({ extension }) => {
  await extension.seedOnboarded();
  await storeFolder(extension, 'Projects', ['Alpha plan']);
  const page = await openOnRootNote(extension);
  const { header, rows } = folderIn(page, 'Projects');
  await expect(header).toHaveAttribute('role', 'button');
  await expect(header).toHaveAttribute('aria-expanded', 'true');

  await header.focus();
  await expect(header).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(rows.nth(0)).toBeHidden();
  await expect(header).toHaveAttribute('aria-expanded', 'false');
  await page.keyboard.press(' ');
  await expect(rows.nth(0)).toBeVisible();
  await expect(header).toHaveAttribute('aria-expanded', 'true');
  await expect(header, 'the header keeps focus').toBeFocused();
  await expectNoUncaught(extension, page);
});

test('a folder saved collapsed starts collapsed', async ({ extension }) => {
  await extension.seedOnboarded();
  await storeFolder(extension, 'Projects', ['Alpha plan', 'Beta plan'], { collapsed: true });
  const page = await openOnRootNote(extension);
  const { header, rows } = folderIn(page, 'Projects');
  await expect(rows).toHaveCount(2);
  await expect(rows.nth(0)).toBeHidden();
  await expect(rows.nth(1)).toBeHidden();
  await expect(header).toHaveAttribute('aria-expanded', 'false');
  await expectNoUncaught(extension, page);
});

test('a collapsed folder stays collapsed when one of its notes is opened or a note is added to it', async ({ extension }) => {
  await extension.seedOnboarded();
  await storeFolder(extension, 'Projects', ['Alpha plan'], { collapsed: true });
  const page = await openOnRootNote(extension);
  const { header, rows } = folderIn(page, 'Projects');

  // Opened from search: the folder keeps its state once the search clears
  await driver.searchNotes(page, 'Alpha plan');
  await page.locator('#sidebar-notes-list .sidebar-note-item', { hasText: 'Alpha plan' }).first().click();
  await expect.poll(() => driver.noteTitle(page)).toBe('Alpha plan');
  await driver.searchNotes(page, '');
  await expect(rows).toHaveCount(1);
  await expect(rows.nth(0)).toBeHidden();
  await expect(header).toHaveAttribute('aria-expanded', 'false');

  // Add Note to Folder opens the new note, and the folder stays collapsed
  await header.click({ button: 'right' });
  await page.locator('.context-menu-item', { hasText: 'Add Note to Folder' }).click();
  await expect(rows).toHaveCount(2);
  await expect(rows.nth(0)).toBeHidden();
  await expect(rows.nth(1)).toBeHidden();
  expect(await storedCollapsed(extension, 'Projects')).toBe(true);

  // Expanding shows both, the open note marked active
  await header.click();
  await expect(rows.nth(0)).toBeVisible();
  await expect(rows.nth(1)).toBeVisible();
  await expect(folderIn(page, 'Projects').folder.locator('.sidebar-note-item.active')).toHaveCount(1);
  await expectNoUncaught(extension, page);
});

test("search lists every match, a collapsed folder's notes included", async ({ extension }) => {
  await extension.seedOnboarded();
  await storeFolder(extension, 'Projects', ['Alpha plan', 'Beta plan'], { collapsed: true });
  const page = await openOnRootNote(extension);
  await driver.searchNotes(page, 'plan');
  const results = page.locator('#sidebar-notes-list .sidebar-note-item');
  await expect(results.filter({ hasText: 'Alpha plan' })).toBeVisible();
  await expect(results.filter({ hasText: 'Beta plan' })).toBeVisible();
  await expectNoUncaught(extension, page);
});

test('a collapsed folder hides its subfolders, and each subfolder keeps its own state', async ({ extension }) => {
  await extension.seedOnboarded();
  const parent = await storeFolder(extension, 'Work', ['Team notes']);
  await storeFolder(extension, 'Clients', ['Acme brief'], { parent });
  await storeFolder(extension, 'Archive old', ['Old brief'], { parent, collapsed: true });
  const page = await openOnRootNote(extension);
  const work = folderIn(page, 'Work');
  const clients = folderIn(page, 'Clients');
  const old = folderIn(page, 'Archive old');
  await expect(clients.rows.nth(0)).toBeVisible();
  await expect(old.header).toBeVisible();
  await expect(old.rows.nth(0)).toBeHidden();

  await work.header.click();
  await expect(work.rows.nth(0)).toBeHidden();
  await expect(clients.header, 'a subfolder hides with its parent').toBeHidden();
  await expect(clients.rows.nth(0)).toBeHidden();
  await expect(old.header).toBeHidden();

  await work.header.click();
  await expect(clients.rows.nth(0), 'an expanded subfolder shows its notes again').toBeVisible();
  await expect(old.header).toBeVisible();
  await expect(old.rows.nth(0), 'a collapsed subfolder stays collapsed').toBeHidden();
  await expectNoUncaught(extension, page);
});
