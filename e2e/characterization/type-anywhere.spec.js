/**
 * Type anywhere on 1.4.1 (#1 AC2's rule): with focus outside text controls and nothing
 * modal open, a printable key goes to the note, except Space (or Enter) on a button or
 * link, which presses it. Text typed in a note, in either pane of split view, stays where
 * it is typed, and undo, redo, and deleting a block selection act in one pane. Each test
 * ends with the uncaught-exception check.
 */

const { test, expect, expectNoUncaught } = require('../harness');
const driver = require('./driver');

test('Space on a header button presses it instead of typing into the note, and letters still go to the note', async ({ extension }) => {
  await extension.seedOnboarded();
  await driver.seedNotes(extension, [{ name: 'Groceries', blocks: [{ type: 'text', content: 'eggs' }] }]);
  const page = await driver.openNewTab(extension);

  await driver.focusHeaderButton(page, 'Settings');
  await page.keyboard.press('Space');
  await expect.poll(() => driver.settingsOpen(page)).toBe(true);
  expect(await driver.blocks(page)).toEqual([{ type: 'text', text: 'eggs' }]);
  await driver.closeSettings(page);

  // As right after clicking it
  await driver.focusHeaderButton(page, 'Settings');
  await page.keyboard.type('bacon');
  await expect.poll(() => driver.blocks(page)).toEqual([{ type: 'text', text: 'eggsbacon' }]);
  expect(await driver.settingsOpen(page)).toBe(false);
  await expectNoUncaught(extension, page);
});

test('letters typed with a header button focused reach the note every time, not only the first', async ({ extension }) => {
  await extension.seedOnboarded();
  await driver.seedNotes(extension, [{ name: 'Groceries', blocks: [{ type: 'text', content: 'eggs' }] }]);
  const page = await driver.openNewTab(extension);

  let expected = 'eggs';
  for (const letters of ['ab', 'cd', 'ef']) {
    await driver.focusHeaderButton(page, 'Settings');
    await page.keyboard.type(letters);
    expected += letters;
    await expect.poll(() => driver.blocks(page), `after typing "${letters}"`).toEqual([{ type: 'text', text: expected }]);
  }
  await expectNoUncaught(extension, page);
});

/** Two notes with two blocks each, a new tab on them, and split view open with the left pane active */
async function splitViewOnTwoNotes(extension) {
  await extension.seedOnboarded();
  await driver.seedNotes(extension, [
    { name: 'Groceries', blocks: [{ type: 'text', content: 'eggs' }, { type: 'text', content: 'milk' }] },
    { name: 'Packing', blocks: [{ type: 'text', content: 'socks' }, { type: 'text', content: 'boots' }] },
  ]);
  const page = await driver.openNewTab(extension);
  await driver.openSplitView(page);
  await driver.clickBlock(page, 0);
  return page;
}

/** The blocks with `letters` added to the last one's text */
const typedAtEnd = (blocks, letters) => blocks.map((block, index) => (
  index === blocks.length - 1 ? { ...block, text: block.text + letters } : block));

test('with split view open, letters typed from a header button or the notice go to the active left pane\'s note', async ({ extension }) => {
  const page = await splitViewOnTwoNotes(extension);
  const left = await driver.blocks(page);
  const right = await driver.rightPaneBlocks(page);

  await driver.focusHeaderButton(page, 'Settings');
  await page.keyboard.type('hello');
  await expect.poll(() => driver.blocks(page)).toEqual(typedAtEnd(left, 'hello'));

  // The notice's Not now, a Shift+Tab before the left note's first block
  await driver.clickBlock(page, 0);
  await page.keyboard.press('Shift+Tab');
  expect(await driver.focused(page)).toEqual({ kind: 'button', text: 'Not now' });
  await page.keyboard.type('world');
  await expect.poll(() => driver.blocks(page)).toEqual(typedAtEnd(left, 'helloworld'));
  expect(await driver.rightPaneBlocks(page)).toEqual(right);
  await expectNoUncaught(extension, page);
});

test('after split view opens and closes, letters typed from a header button still reach the note, every time', async ({ extension }) => {
  const page = await splitViewOnTwoNotes(extension);
  await driver.closeSplitView(page);
  const left = await driver.blocks(page);

  await driver.focusHeaderButton(page, 'Settings');
  await page.keyboard.type('hello');
  await expect.poll(() => driver.blocks(page)).toEqual(typedAtEnd(left, 'hello'));
  await driver.focusHeaderButton(page, 'Settings');
  await page.keyboard.type('world');
  await expect.poll(() => driver.blocks(page)).toEqual(typedAtEnd(left, 'helloworld'));
  await expectNoUncaught(extension, page);
});

test('text typed in the right pane of split view stays in the block it is typed in', async ({ extension }) => {
  await extension.seedOnboarded();
  await driver.seedNotes(extension, [
    { name: 'Groceries', blocks: [{ type: 'text', content: 'eggs' }, { type: 'text', content: 'milk' }] },
    { name: 'Packing', blocks: [{ type: 'text', content: 'socks' }, { type: 'text', content: 'boots' }] },
  ]);
  const page = await driver.openNewTab(extension);
  await driver.openSplitView(page);
  const left = await driver.blocks(page);
  const [first, second] = await driver.rightPaneBlocks(page);

  await driver.clickRightPaneBlock(page, 0);
  await page.keyboard.type(' and more');
  await expect.poll(() => driver.rightPaneBlocks(page)).toEqual([{ ...first, text: `${first.text} and more` }, second]);
  expect(await driver.focused(page)).toEqual({ kind: 'block', pane: 'right', index: 0, text: `${first.text} and more` });
  expect(await driver.blocks(page)).toEqual(left);
  await expectNoUncaught(extension, page);
});

test('letters typed while a modal is open stay out of the note: Keyboard Shortcuts from the sidebar, Settings from the header or the AI panel', async ({ extension }) => {
  await extension.seedOnboarded();
  await driver.seedNotes(extension, [{ name: 'Groceries', blocks: [{ type: 'text', content: 'milk' }] }]);
  const page = await driver.openNewTab(extension);

  // Each opener keeps focus, so the letters are typed with it on the button that opened the modal
  await page.getByRole('button', { name: 'Open Keyboard Shortcuts helper' }).click();
  const shortcuts = page.getByRole('dialog', { name: 'Keyboard Shortcuts' });
  await expect(shortcuts).toBeVisible();
  await page.keyboard.type('zap');
  expect(await driver.savedBlocks(page), 'with Keyboard Shortcuts open').toEqual(['milk']);
  await shortcuts.getByRole('button', { name: 'Close modal' }).click();
  await expect(shortcuts).toBeHidden();

  await page.locator('#header').getByRole('button', { name: 'Settings', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'Settings' })).toBeVisible();
  await page.keyboard.type('zap');
  expect(await driver.savedBlocks(page), 'with Settings open from the header').toEqual(['milk']);
  await driver.closeSettings(page);

  await page.getByRole('button', { name: 'Open AI Chat' }).click();
  await page.locator('#ai-sidebar').getByRole('button', { name: 'Open Settings' }).click();
  await expect(page.getByRole('dialog', { name: 'Settings' })).toBeVisible();
  await page.keyboard.type('zap');
  expect(await driver.savedBlocks(page), 'with Settings open from the AI panel').toEqual(['milk']);
  await driver.closeSettings(page);

  // Nothing is open again, and a letter goes to the note
  await page.keyboard.type('y');
  await expect.poll(() => driver.savedBlocks(page)).toEqual(['milky']);
  await expectNoUncaught(extension, page);
});

test('letters typed while a note\'s menu is open stay out of the note', async ({ extension }) => {
  await extension.seedOnboarded();
  await driver.seedNotes(extension, [{ name: 'Groceries', blocks: [{ type: 'text', content: 'milk' }] }]);
  const page = await driver.openNewTab(extension);

  await driver.openNoteMenu(page, 'Groceries');
  await page.keyboard.type('zap');
  expect(await driver.savedBlocks(page)).toEqual(['milk']);
  await expectNoUncaught(extension, page);
});

/** Wait until the edit just typed in `side`'s pane is an entry that pane can undo */
async function untilUndoable(page, side) {
  await expect.poll(() => page.evaluate(which => (which === 'left' ? app.editor : app.secondaryEditor).undoStack.length, side))
    .toBeGreaterThan(0);
}

test('with split view open, undo and redo in the left pane leave the right pane\'s edit alone', async ({ extension }) => {
  const page = await splitViewOnTwoNotes(extension);
  const [firstRight, secondRight] = await driver.rightPaneBlocks(page);
  await driver.clickRightPaneBlock(page, 0);
  await page.keyboard.type(' and more');
  await untilUndoable(page, 'right');
  const right = [{ ...firstRight, text: `${firstRight.text} and more` }, secondRight];
  await expect.poll(() => driver.rightPaneBlocks(page)).toEqual(right);

  await driver.clickBlock(page, 0);
  const left = await driver.blocks(page);
  await page.keyboard.type(' too');
  await untilUndoable(page, 'left');
  await page.keyboard.press('ControlOrMeta+z');
  await expect.poll(() => driver.blocks(page)).toEqual(left);
  expect(await driver.rightPaneBlocks(page), 'the right pane keeps its edit').toEqual(right);

  // KeyZ with Shift held, so the key is "Z", as the editor's redo check reads it
  await page.keyboard.press('ControlOrMeta+Shift+KeyZ');
  await expect.poll(() => driver.blocks(page)).toEqual([{ ...left[0], text: `${left[0].text} too` }, ...left.slice(1)]);
  expect(await driver.rightPaneBlocks(page)).toEqual(right);
  await expectNoUncaught(extension, page);
});

test('with split view open, Backspace in a left block edits it and leaves a block selected in the right pane', async ({ extension }) => {
  const page = await splitViewOnTwoNotes(extension);
  const left = await driver.blocks(page);
  const right = await driver.rightPaneBlocks(page);
  await page.locator('#secondary-editor-container .blocks-container > .block .block-content').first()
    .click({ modifiers: ['ControlOrMeta'] });
  await expect(page.locator('#secondary-editor-container .blocks-container > .block').first()).toHaveClass(/block-selected/);

  await driver.clickBlock(page, 1);
  await page.keyboard.press('Backspace');
  await expect.poll(() => driver.blocks(page)).toEqual([left[0], { ...left[1], text: left[1].text.slice(0, -1) }]);
  expect(await driver.rightPaneBlocks(page), 'the selected block is still there').toEqual(right);
  const stored = await page.evaluate(async () => {
    await app.secondaryEditor.flushSave();
    return (await Storage.getElementsByNote(app.secondaryEditor.noteId)).length;
  });
  expect(stored, 'and still stored').toBe(right.length);
  await expectNoUncaught(extension, page);
});

test('in the sidebar search box with a block selected, Backspace and undo edit the search and leave the note alone', async ({ extension }) => {
  await extension.seedOnboarded();
  await driver.seedNotes(extension, [{ name: 'Groceries', blocks: [{ type: 'text', content: 'eggs' }, { type: 'text', content: 'milk' }] }]);
  const page = await driver.openNewTab(extension);
  // An edit the note could undo, and a selected block
  await driver.clickBlock(page, 1);
  await page.keyboard.type(' and bread');
  await untilUndoable(page, 'left');
  const firstBlock = page.locator('#blocks-container > .block').first();
  await firstBlock.locator('.block-content').click({ modifiers: ['ControlOrMeta'] });
  await expect(firstBlock).toHaveClass(/block-selected/);
  const note = [{ type: 'text', text: 'eggs' }, { type: 'text', text: 'milk and bread' }];

  const search = page.getByPlaceholder('Search notes...');
  await search.click();
  await page.keyboard.type('milk');
  await page.keyboard.press('Backspace');
  await expect(search).toHaveValue('mil');
  await page.keyboard.press('ControlOrMeta+z');
  await expect(search, "the search box's own undo").toHaveValue('milk');

  expect(await driver.blocks(page)).toEqual(note);
  await expect(firstBlock, 'still selected').toHaveClass(/block-selected/);
  expect(await driver.savedBlocks(page)).toEqual(note.map(block => block.text));
  await expectNoUncaught(extension, page);
});
