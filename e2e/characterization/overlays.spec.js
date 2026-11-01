/**
 * Every overlay the editor counts as open (OPEN_OVERLAYS in js/editor.js) closes, and stops
 * counting once it has. While one is open, keys from outside the note stay out of it, so an
 * overlay that never closes, or still counts as open once closed, would hold every key. For
 * each overlay the new tab opens, in either pane: while it's open, keys and pastes from
 * outside the note leave the notes and what is stored alone; Escape closes it; a click
 * outside closes it where one should; and once it's closed, letters typed with focus outside
 * the note reach it again. The pastes are real ones, from the clipboard. Each test ends with
 * the uncaught-exception check.
 */

const { test, expect, expectNoUncaught } = require('../harness');
const driver = require('./driver');

const TABLE = { type: 'table', content: '', tableData: [['a', 'b'], ['1', '2']], rows: 2, cols: 2 };
const NOTES = [
  { name: 'Groceries', blocks: [{ type: 'text', content: 'eggs' }, { type: 'text', content: 'milk' }, TABLE, { type: 'text', content: '' }] },
  { name: 'Weekly plan', isTemplate: true, blocks: [{ type: 'text', content: 'plan' }] },
];
/** Split view's second note */
const PACKING = { name: 'Packing', blocks: [{ type: 'text', content: 'socks' }, { type: 'text', content: 'boots' }, { type: 'text', content: '' }] };

const PANES = { left: '#editor-container', right: '#secondary-editor-container' };
const headerButton = page => page.locator('#header').getByRole('button', { name: 'Settings', exact: true });
const dailyNoteButton = page => page.locator('#sidebar').getByRole('button', { name: "Today's Daily Note" });
const block = (page, index, side = 'left') => page.locator(`${PANES[side]} .blocks-container > .block`).nth(index);
const dialog = name => page => page.getByRole('dialog', { name, exact: true });

/** A pane's blocks on screen, and as stored once its editor has written what it has pending */
const blocksIn = (page, side) => (side === 'right' ? driver.rightPaneBlocks(page) : driver.blocks(page));
const storedIn = (page, side) => page.evaluate(async which => {
  const editor = which === 'right' ? app.secondaryEditor : app.editor;
  await editor.flushSave();
  const elements = await Storage.getElementsByNote(editor.noteId);
  return elements.sort((a, b) => a.order - b.order).map(element => element.content);
}, side);

/** A click on the modal's backdrop, outside its dialog box */
const onBackdrop = page => page.mouse.click(8, 8);
/** A click on a pane's note title, outside the menu */
const onTitle = (side = 'left') => page => page.locator(`${PANES[side]} .page-title`).click();

/** Click into a new empty block at the end of a pane's note */
async function newBlockAtEnd(page, side = 'left') {
  await page.locator(`${PANES[side]} .blocks-container > .block .block-content`).last().click();
  await page.keyboard.press('End');
  await page.keyboard.press('Enter');
}

/**
 * Open the block menu on a pane's second block, from its handle. The right pane's handles
 * sit under the left pane, which takes a click there, so the click goes to the handle itself.
 */
const openBlockMenu = (page, side = 'left') => {
  const handle = block(page, 1, side).locator('.block-handle');
  return side === 'right' ? handle.dispatchEvent('click') : handle.click();
};

/** The template menu under a pane's second block. Nothing in 1.4.x opens it: checkMarkdownShortcuts, which looks for "/template", is never called */
const openTemplateMenu = side => page => page.evaluate(async ([which, selector]) => {
  const editor = which === 'right' ? app.secondaryEditor : app.editor;
  editor.templates = await Storage.getTemplates();
  editor.showTemplateMenu(document.querySelectorAll(selector)[1]);
}, [side, `${PANES[side]} .blocks-container > .block`]);

/** Right-click the sidebar's Work folder */
const openFolderMenu = page => page.locator('.sidebar-folder-header', { hasText: 'Work' }).click({ button: 'right' });
/** The folder's menu; Escape hides one, and the next mousedown elsewhere removes it */
const folderMenu = page => page.locator('body > .context-menu:not(.hidden)');

/**
 * Each overlay: how the new tab opens it, where it shows, and how a click outside closes
 * it, where one should (Theme Builder holds unsaved edits, so it doesn't). `inNote` ones
 * open from the note, with focus there, so keys from outside it are pressed from the
 * header's Settings button. `side: 'right'` ones open in split view's right pane.
 */
const OVERLAYS = [
  { name: 'Settings', open: page => headerButton(page).click(), shown: dialog('Settings'), outside: onBackdrop },
  {
    name: 'Keyboard Shortcuts, opened with ? from a sidebar button',
    open: async page => {
      await dailyNoteButton(page).focus();
      await page.keyboard.press('?');
    },
    shown: dialog('Keyboard Shortcuts'),
    outside: onBackdrop,
    // The ? stayed out of the note, so closing gives focus back to the button it was pressed on
    afterEscape: page => expect(dailyNoteButton(page)).toBeFocused(),
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
  { name: "a note's menu", open: page => driver.openNoteMenu(page, 'Groceries'), shown: page => page.getByRole('menu', { name: 'Note actions' }), outside: onTitle() },
  { name: "a folder's menu", open: openFolderMenu, shown: folderMenu, outside: onTitle() },
  {
    name: 'the slash menu',
    inNote: true,
    open: async page => {
      await newBlockAtEnd(page);
      await page.keyboard.press('/');
    },
    shown: page => page.locator('#slash-menu'),
    outside: onTitle(),
  },
  {
    name: 'the link menu',
    inNote: true,
    open: async page => {
      await driver.clickBlock(page, 1);
      await page.keyboard.type('[[');
    },
    shown: page => page.locator('#wiki-menu'),
    outside: onTitle(),
  },
  { name: 'the template menu', inNote: true, open: openTemplateMenu('left'), shown: page => page.locator('#template-menu'), outside: onTitle() },
  { name: "a block's menu", inNote: true, open: page => openBlockMenu(page), shown: page => page.locator('.block-action-menu'), outside: onTitle() },
  {
    name: "Turn into, from a block's menu",
    inNote: true,
    open: async page => {
      await openBlockMenu(page);
      await page.locator('.block-action-menu').getByText('Turn into...').click();
    },
    shown: page => page.locator('.turn-into-menu'),
    outside: onTitle(),
  },
  {
    name: 'Turn into, for blocks selected together',
    open: async page => {
      const bar = page.locator('.selection-action-bar');
      if (!(await bar.isVisible())) {
        for (const index of [0, 1]) await block(page, index).locator('.block-content').click({ modifiers: ['ControlOrMeta'] });
      }
      await bar.getByRole('button', { name: 'Turn into...' }).click();
    },
    shown: page => page.locator('.turn-into-menu'),
    outside: onTitle(),
  },
  {
    name: "a table's menu",
    inNote: true,
    open: page => block(page, 2).locator('td, th').first().click({ button: 'right' }),
    shown: page => page.locator('.table-context-menu'),
    outside: onTitle(),
  },
  {
    name: "the right pane's slash menu",
    side: 'right',
    inNote: true,
    open: async page => {
      await newBlockAtEnd(page, 'right');
      await page.keyboard.press('/');
    },
    shown: page => page.locator(`${PANES.right} .slash-menu:not(.wiki-menu):not(.template-menu)`),
    outside: onTitle('right'),
  },
  {
    name: "the right pane's link menu",
    side: 'right',
    inNote: true,
    open: async page => {
      await driver.clickRightPaneBlock(page, 1);
      await page.keyboard.type('[[');
    },
    shown: page => page.locator(`${PANES.right} .wiki-menu`),
    outside: onTitle('right'),
  },
  { name: "the right pane's template menu", side: 'right', inNote: true, open: openTemplateMenu('right'), shown: page => page.locator(`${PANES.right} .template-menu`), outside: onTitle('right') },
  { name: "a block's menu in the right pane", side: 'right', inNote: true, open: page => openBlockMenu(page, 'right'), shown: page => page.locator('.block-action-menu'), outside: onTitle('right') },
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

/**
 * A new tab on Groceries, with a template and a folder, and an edit it can undo in the pane
 * an overlay is for: milk on the left, or in split view, the right pane's second block
 */
async function newTab(extension, side) {
  await extension.seedOnboarded();
  await driver.seedNotes(extension, side === 'right' ? [...NOTES, PACKING] : NOTES);
  await driver.seedFolder(extension, 'Work');
  const page = await driver.openNewTab(extension);
  await extension.context.grantPermissions(['clipboard-read', 'clipboard-write']);
  if (side === 'right') {
    await driver.openSplitView(page);
    await driver.clickRightPaneBlock(page, 1);
  } else {
    await driver.clickBlock(page, 1);
  }
  await page.keyboard.type(' and bread');
  await expect.poll(() => page.evaluate(which => (which === 'right' ? app.secondaryEditor : app.editor).undoStack.length, side))
    .toBeGreaterThan(0);
  // Focus leaves the note, as after a click on the header
  await headerButton(page).focus();
  return page;
}

/** Whether the editor counts anything as open */
const overlayCounted = page => page.evaluate(() => app.editor._overlayOpen());

/** Both panes' notes on screen and as stored, or the left one's without split view */
async function notesNow(page, overlay) {
  const sides = overlay.side === 'right' ? ['left', 'right'] : ['left'];
  const now = {};
  for (const side of sides) now[side] = { shown: await blocksIn(page, side), stored: await storedIn(page, side) };
  return now;
}

/** Plain text, and fenced code, which the editor turns into a block */
const PASTES = [' and cheese', '```\nconst a = 1;\n```'];

/**
 * Press letters, Backspace, Delete, undo, and redo, and paste, with focus outside the note,
 * and check that the notes and what is stored are as they were
 */
async function keysStayOut(page, overlay) {
  if (overlay.inNote) {
    await headerButton(page).focus();
  } else {
    const at = await driver.focused(page);
    expect(['block', 'title'], `with ${overlay.name} open, focus is outside the note`).not.toContain(at.kind);
  }
  const before = await notesNow(page, overlay);
  await page.keyboard.type('zap');
  for (const key of ['Backspace', 'Delete', 'ControlOrMeta+z', 'ControlOrMeta+Shift+KeyZ']) await page.keyboard.press(key);
  for (const text of PASTES) {
    await page.evaluate(value => navigator.clipboard.writeText(value), text);
    await page.keyboard.press('ControlOrMeta+KeyV');
  }
  expect(await notesNow(page, overlay), `the notes and what is stored, with ${overlay.name} open`).toEqual(before);
}

/** Once it's closed, nothing counts as open, and letters typed from the header reach the pane's note */
async function typingReachesNote(page, overlay, how) {
  const side = overlay.side || 'left';
  await expect(overlay.shown(page), `${how} closes ${overlay.name}`).toBeHidden();
  expect(await overlayCounted(page), `nothing counts as open after ${how}`).toBe(false);
  await headerButton(page).focus();
  await page.keyboard.type('xyz');
  await expect.poll(async () => (await blocksIn(page, side)).at(-1).text, `letters typed after ${how} reach the note`).toMatch(/xyz$/);
  expect((await storedIn(page, side)).at(-1)).toMatch(/xyz$/);
}

for (const overlay of OVERLAYS) {
  test(`${overlay.name}: keys and pastes from outside the note stay out of it while it's open, Escape${overlay.outside ? ' and a click outside close' : ' closes'} it, and typing reaches the note after`, async ({ extension }) => {
    const page = await newTab(extension, overlay.side);

    await overlay.open(page);
    await expect(overlay.shown(page)).toBeVisible();
    await keysStayOut(page, overlay);
    await page.keyboard.press('Escape');
    await expect(overlay.shown(page), `Escape closes ${overlay.name}`).toBeHidden();
    if (overlay.afterEscape) await overlay.afterEscape(page);
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
  test(`onboarding: keys and pastes stay out of the welcome note while the walkthrough and the quick-start choice are open, ${how} closes each, and typing reaches the note after`, async ({ extension }) => {
    const page = await driver.openNewTab(extension, { wait: false });
    await extension.context.grantPermissions(['clipboard-read', 'clipboard-write']);
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
