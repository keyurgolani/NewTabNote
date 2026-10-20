/**
 * Every overlay the editor counts as open (OPEN_OVERLAYS in js/editor.js) closes, and stops
 * counting once it has. While one is open, keys from outside the note stay out of it, so an
 * overlay that never closes, or still counts as open once closed, would hold every key. For
 * each overlay the new tab opens: while it's open, keys from outside the note leave the
 * note and what is stored alone; Escape closes it; a click outside closes it where one
 * should; and once it's closed, letters typed with focus outside the note reach it again.
 * Each test ends with the uncaught-exception check.
 */

const { test, expect, expectNoUncaught } = require('../harness');
const driver = require('./driver');

const TABLE = { type: 'table', content: '', tableData: [['a', 'b'], ['1', '2']], rows: 2, cols: 2 };
const NOTES = [
  { name: 'Groceries', blocks: [{ type: 'text', content: 'eggs' }, { type: 'text', content: 'milk' }, TABLE, { type: 'text', content: '' }] },
  { name: 'Weekly plan', isTemplate: true, blocks: [{ type: 'text', content: 'plan' }] },
];

const headerButton = page => page.locator('#header').getByRole('button', { name: 'Settings', exact: true });
const block = (page, index) => page.locator('#blocks-container > .block').nth(index);
const dialog = name => page => page.getByRole('dialog', { name, exact: true });

/** A click on the modal's backdrop, outside its dialog box */
const onBackdrop = page => page.mouse.click(8, 8);
/** A click on the note's title, outside the menu */
const onTitle = page => page.locator('#page-title').click();

/** Click into a new empty block at the end of the note */
async function newBlockAtEnd(page) {
  await page.locator('#blocks-container > .block .block-content').last().click();
  await page.keyboard.press('End');
  await page.keyboard.press('Enter');
}

/** Open the block menu on milk, from its handle */
const openBlockMenu = page => block(page, 1).locator('.block-handle').click();

/** Right-click the sidebar's Work folder */
const openFolderMenu = page => page.locator('.sidebar-folder-header', { hasText: 'Work' }).click({ button: 'right' });
/** The folder's menu; Escape hides one, and the next mousedown elsewhere removes it */
const folderMenu = page => page.locator('body > .context-menu:not(.hidden)');

/**
 * Each overlay: how the new tab opens it, where it shows, and how a click outside closes
 * it, where one should (Theme Builder holds unsaved edits, so it doesn't). `inNote` ones
 * open from the note, with focus there, so keys from outside it are pressed from the
 * header's Settings button.
 */
const OVERLAYS = [
  { name: 'Settings', open: page => headerButton(page).click(), shown: dialog('Settings'), outside: onBackdrop },
  {
    name: 'Keyboard Shortcuts, opened with ? from the Notes tab',
    open: async page => {
      await page.getByRole('tab', { name: /^Notes/ }).focus();
      await page.keyboard.press('?');
    },
    shown: dialog('Keyboard Shortcuts'),
    outside: onBackdrop,
  },
  {
    name: 'Theme Builder',
    open: async page => {
      await headerButton(page).click();
      const settings = page.getByRole('dialog', { name: 'Settings' });
      await settings.locator('.settings-nav-item[data-category="appearance"]').click();
      await settings.locator('#open-theme-builder-btn').click();
    },
    shown: dialog('Theme Builder'),
  },
  { name: 'the command palette', open: page => page.keyboard.press('ControlOrMeta+Shift+KeyA'), shown: dialog('Command palette'), outside: onBackdrop },
  {
    name: 'the AI insert preview',
    open: page => page.evaluate(() => app.aiChatController.openAIInsertPreview('append', 'An idea worth keeping')),
    shown: dialog('AI insert preview'),
    outside: onBackdrop,
  },
  {
    name: "a snapshot's preview",
    open: page => page.evaluate(() => app.editor._previewSnapshot({ timestamp: Date.now(), blocks: [{ type: 'text', content: 'eggs' }] })),
    shown: page => page.locator('#snapshot-preview-modal'),
    outside: onBackdrop,
  },
  { name: "a note's menu", open: page => driver.openNoteMenu(page, 'Groceries'), shown: page => page.getByRole('menu', { name: 'Note actions' }), outside: onTitle },
  { name: "a folder's menu", open: openFolderMenu, shown: folderMenu, outside: onTitle },
  {
    name: 'the slash menu',
    inNote: true,
    open: async page => {
      await newBlockAtEnd(page);
      await page.keyboard.press('/');
    },
    shown: page => page.locator('#slash-menu'),
    outside: onTitle,
  },
  {
    name: 'the link menu',
    inNote: true,
    open: async page => {
      await driver.clickBlock(page, 1);
      await page.keyboard.type('[[');
    },
    shown: page => page.locator('#wiki-menu'),
    outside: onTitle,
  },
  {
    name: 'the template menu',
    inNote: true,
    // Nothing in 1.4.x opens it: checkMarkdownShortcuts, which looks for "/template", is
    // never called. So it opens as that would have opened it, under milk.
    open: page => page.evaluate(async () => {
      app.editor.templates = await Storage.getTemplates();
      app.editor.showTemplateMenu(document.querySelectorAll('#blocks-container > .block')[1]);
    }),
    shown: page => page.locator('#template-menu'),
    outside: onTitle,
  },
  { name: "a block's menu", inNote: true, open: openBlockMenu, shown: page => page.locator('.block-action-menu'), outside: onTitle },
  {
    name: "Turn into, from a block's menu",
    inNote: true,
    open: async page => {
      await openBlockMenu(page);
      await page.locator('.block-action-menu').getByText('Turn into...').click();
    },
    shown: page => page.locator('.turn-into-menu'),
    outside: onTitle,
  },
  {
    name: "a table's menu",
    inNote: true,
    open: page => block(page, 2).locator('td, th').first().click({ button: 'right' }),
    shown: page => page.locator('.table-context-menu'),
    outside: onTitle,
  },
  {
    name: "a confirm dialog, deleting a folder from its menu",
    open: async page => {
      await openFolderMenu(page);
      await folderMenu(page).getByText('Delete Folder').click();
    },
    shown: dialog('Delete Folder'),
    outside: onBackdrop,
  },
  {
    name: "a prompt dialog, renaming a folder from its menu",
    open: async page => {
      await openFolderMenu(page);
      await folderMenu(page).getByText('Rename').click();
    },
    shown: dialog('Rename Folder'),
    outside: onBackdrop,
  },
  {
    name: 'a choice dialog, as an import asks',
    open: page => page.evaluate(() => {
      window.__choice = choiceDialog({
        title: 'Import notes',
        message: 'Add them to your notes, or replace your notes with them?',
        choices: [{ id: 'merge', label: 'Merge', variant: 'primary' }, { id: 'replace', label: 'Replace all', variant: 'danger' }],
        cancelId: 'cancel',
      });
    }),
    shown: dialog('Import notes'),
    outside: onBackdrop,
  },
];

/** A new tab on Groceries, with a template and a folder, and an edit to milk it can undo */
async function newTab(extension) {
  await extension.seedOnboarded();
  await driver.seedNotes(extension, NOTES);
  await extension.worker.evaluate(() => self.Storage.createFolder('Work'));
  const page = await driver.openNewTab(extension);
  await driver.clickBlock(page, 1);
  await page.keyboard.type(' and bread');
  await expect.poll(() => page.evaluate(() => app.editor.undoStack.length)).toBeGreaterThan(0);
  // Focus leaves the note, as after a click on the header
  await headerButton(page).focus();
  return page;
}

/** Whether the editor counts anything as open */
const overlayCounted = page => page.evaluate(() => app.editor._overlayOpen());

/**
 * Press letters, Backspace, Delete, undo, and redo with focus outside the note, and check
 * that the note and what is stored are as they were
 */
async function keysStayOut(page, overlay) {
  if (overlay.inNote) {
    await headerButton(page).focus();
  } else {
    const at = await driver.focused(page);
    expect(['block', 'title'], `with ${overlay.name} open, focus is outside the note`).not.toContain(at.kind);
  }
  const note = await driver.blocks(page);
  const stored = await driver.savedBlocks(page);
  await page.keyboard.type('zap');
  for (const key of ['Backspace', 'Delete', 'ControlOrMeta+z', 'ControlOrMeta+Shift+KeyZ']) await page.keyboard.press(key);
  expect(await driver.blocks(page), `the note, with ${overlay.name} open`).toEqual(note);
  expect(await driver.savedBlocks(page), `what is stored, with ${overlay.name} open`).toEqual(stored);
}

/** Once it's closed, nothing counts as open, and letters typed from the header reach the note */
async function typingReachesNote(page, overlay, how) {
  await expect(overlay.shown(page), `${how} closes ${overlay.name}`).toBeHidden();
  expect(await overlayCounted(page), `nothing counts as open after ${how}`).toBe(false);
  await headerButton(page).focus();
  await page.keyboard.type('xyz');
  await expect.poll(async () => (await driver.blocks(page)).at(-1).text, `letters typed after ${how} reach the note`).toMatch(/xyz$/);
  expect((await driver.savedBlocks(page)).at(-1)).toMatch(/xyz$/);
}

for (const overlay of OVERLAYS) {
  test(`${overlay.name}: keys from outside the note stay out of it while it's open, Escape${overlay.outside ? ' and a click outside close' : ' closes'} it, and typing reaches the note after`, async ({ extension }) => {
    const page = await newTab(extension);

    await overlay.open(page);
    await expect(overlay.shown(page)).toBeVisible();
    await keysStayOut(page, overlay);
    await page.keyboard.press('Escape');
    await typingReachesNote(page, overlay, 'Escape');

    if (overlay.outside) {
      await headerButton(page).focus();
      await overlay.open(page);
      await expect(overlay.shown(page)).toBeVisible();
      await overlay.outside(page);
      await typingReachesNote(page, overlay, 'a click outside');
    }
    await expectNoUncaught(extension, page);
  });
}

/** On a first run, the walkthrough and then the quick-start choice open over the welcome note */
for (const [how, close] of [
  ['Escape', page => page.keyboard.press('Escape')],
  ['a click outside', page => page.mouse.click(1000, 60)],
]) {
  test(`onboarding: keys stay out of the welcome note while the walkthrough and the quick-start choice are open, ${how} closes each, and typing reaches the note after`, async ({ extension }) => {
    const page = await driver.openNewTab(extension, { wait: false });
    const walkthrough = page.getByRole('dialog', { name: 'Onboarding walkthrough' });
    await expect(walkthrough).toBeVisible();
    await expect(page.locator('#page-title')).toHaveText('Welcome to NewTabNote 🚀');
    // After the welcome note's own focus, which would land in its first block
    await driver.afterEditorFocus(page);
    for (const [name, shown] of [['the walkthrough', walkthrough], ['the quick-start choice', page.getByRole('dialog', { name: 'Quick start' })]]) {
      await expect(shown).toBeVisible();
      await keysStayOut(page, { name });
      await close(page);
      await expect(shown, `${how} closes ${name}`).toBeHidden();
    }
    await driver.waitForApp(page);
    expect(await overlayCounted(page)).toBe(false);
    await headerButton(page).focus();
    await page.keyboard.type('xyz');
    await expect.poll(async () => (await driver.blocks(page)).at(-1).text, 'letters typed after onboarding reach the note').toMatch(/xyz$/);
    await expectNoUncaught(extension, page);
  });
}
