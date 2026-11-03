/**
 * #14 slice 3 on the built extension: data safety in the editor, on a 1.4.x profile the
 * extension upgrades as an update does (test/fixtures/storage/synthesized/v8.opaque-blocks.json).
 *
 * - A block this build doesn't fully read (saved by a newer version, of a type it doesn't have,
 *   with stored data it can't read, or with no type) shows as a read-only card that says so,
 *   with nothing to type in.
 * - Each card is a group a keyboard reaches by Tab, named by its title and described by its
 *   detail. A key typed on one does nothing, and the app's own shortcuts still hear it (#14).
 *   A selected card with the focus ring shows the ring without the selection's outline, and the
 *   outline comes back once focus moves on.
 * - The blocks around the cards edit and save as usual, and each card's record, like a known
 *   block's field its type doesn't own, is written back as it was loaded. A save writes only
 *   the blocks it changed, each at schemaVersion 1, so a block it leaves alone stays as stored.
 * - Turning a table into text asks first: Cancel keeps the table and puts focus in its first cell,
 *   a yes keeps its cells a row per line, and Undo brings the table back.
 * - Deleting a selection that holds cards asks first: Cancel keeps the selection and puts focus
 *   in its first block that takes it, a yes deletes them all, and one Undo brings each back as
 *   it was loaded.
 */

const fs = require('fs');
const path = require('path');
const { test, expect, expectNoUncaught } = require('./harness');
const { fixtureHost } = require('./harness/fixture-host');
const { profileStore } = require('./harness/profile-store');
const driver = require('./characterization/driver');

const FIXTURE = path.join(__dirname, '..', 'test', 'fixtures', 'storage', 'synthesized', 'v8.opaque-blocks.json');
const NOTE = 'opaque-blocks-note';

/** The fixture, and its note's blocks as it holds them, by id */
function opaqueBlocks() {
  const fixture = JSON.parse(fs.readFileSync(FIXTURE, 'utf8'));
  const elements = fixture.databases[0].stores.find(store => store.name === 'elements').records.map(record => record.value);
  return { fixture, held: Object.fromEntries(elements.filter(block => block.canvasId === NOTE).map(block => [block.id, block])) };
}

/** The note's blocks as stored, by id, once the editor has written what it has pending */
async function storedBlocks(page) {
  await page.evaluate(() => app.editor.flushSave());
  const elements = await profileStore(page).getElementsByNote(NOTE);
  return Object.fromEntries(elements.map(block => [block.id, block]));
}

/** Choose Turn into, then `label`, from the block menu of `block` */
async function turnInto(page, block, label) {
  await block.hover();
  await block.locator('.block-handle').click();
  await page.locator('.block-action-menu').getByText('Turn into...').click();
  await page.locator('.turn-into-menu').getByText(label, { exact: true }).click();
}

test('a block this build reads in a safe state shows read-only, and edits around it keep it as loaded', async ({ extension }) => {
  const { fixture, held } = opaqueBlocks();
  await fixtureHost(extension.worker).loadFixture(fixture);
  await extension.seedOnboarded();
  const page = await driver.openNewTab(extension);
  await driver.openNote(page, 'Kept as it is');

  const cards = page.locator('#blocks-container > .block.block-safe');
  await expect(cards).toHaveCount(4);
  expect(await cards.evaluateAll(list => list.map(card => [
    card.dataset.id,
    card.querySelector('.block-safe-title').textContent,
    card.querySelector('.block-safe-detail').textContent,
    card.hasAttribute('data-type'),
    card.querySelectorAll('[contenteditable="true"]').length,
  ]))).toEqual([
    ['opaque-blocks-newer', "This text block can't be shown", 'It was saved by a newer version of NewTabNote. Its content is kept as it is.', false, 0],
    ['opaque-blocks-unknown', 'This “kanban” block can\'t be shown', "This version of NewTabNote doesn't have this kind of block. Its content is kept as it is.", false, 0],
    ['opaque-blocks-invalid', "This table block can't be shown", "Its saved data isn't in a form this version can read. Its content is kept as it is.", false, 0],
    ['opaque-blocks-typeless', "This block can't be shown", "Its saved data isn't in a form this version can read. Its content is kept as it is.", false, 0],
  ]);

  // The block before the cards takes typing, and the note saves
  const before = page.locator('#blocks-container > .block[data-id="opaque-blocks-before"] .block-content');
  await before.click();
  await page.keyboard.press('End');
  await page.keyboard.type(', edited');
  const stored = await storedBlocks(page);
  expect(stored['opaque-blocks-before'].content).toBe('Before the cards, edited');
  expect(stored['opaque-blocks-before'].schemaVersion, 'the block the save writes says its version').toBe(1);
  for (const id of ['opaque-blocks-newer', 'opaque-blocks-unknown', 'opaque-blocks-invalid', 'opaque-blocks-typeless']) {
    expect(stored[id], id).toEqual(held[id]);
  }
  // A save writes only the blocks its pane changed (#17, the per-pane save), so a known block
  // left alone, with a field its type doesn't own, stays as stored, with no version
  expect(stored['opaque-blocks-extra']).toEqual(held['opaque-blocks-extra']);
  await expectNoUncaught(extension, page);
});

test('each card is a group a keyboard reaches: Tab stops on each in turn, named by its title and described by its detail, and a key typed on one does nothing, while ? still opens the shortcuts', async ({ extension }) => {
  const { fixture, held } = opaqueBlocks();
  await fixtureHost(extension.worker).loadFixture(fixture);
  await extension.seedOnboarded();
  const page = await driver.openNewTab(extension);
  await driver.openNote(page, 'Kept as it is');
  const cardOf = id => page.locator(`#blocks-container > .block[data-id="${id}"] .block-safe-card`);
  const cards = [
    ['opaque-blocks-newer', "This text block can't be shown", 'It was saved by a newer version of NewTabNote. Its content is kept as it is.'],
    ['opaque-blocks-unknown', 'This “kanban” block can\'t be shown', "This version of NewTabNote doesn't have this kind of block. Its content is kept as it is."],
    ['opaque-blocks-invalid', "This table block can't be shown", "Its saved data isn't in a form this version can read. Its content is kept as it is."],
    ['opaque-blocks-typeless', "This block can't be shown", "Its saved data isn't in a form this version can read. Its content is kept as it is."],
  ];

  // Tab from the block before the cards stops on each card in note order: three cards, the known
  // block after them, then the fourth card, then the table after it
  const extra = page.locator('#blocks-container > .block[data-id="opaque-blocks-extra"] .block-content');
  await page.locator('#blocks-container > .block[data-id="opaque-blocks-before"] .block-content').click();
  await page.keyboard.press('End');
  for (const [id, name, description] of cards) {
    if (id === 'opaque-blocks-typeless') {
      await page.keyboard.press('Tab');
      await expect(extra).toBeFocused();
    }
    await page.keyboard.press('Tab');
    await expect(cardOf(id), id).toBeFocused();
    await expect(cardOf(id)).toHaveRole('group');
    await expect(cardOf(id)).toHaveAccessibleName(name);
    await expect(cardOf(id)).toHaveAccessibleDescription(description);
  }

  // On the last card, a letter, Space, Enter, Backspace and Delete change nothing, and focus stays
  const shown = await driver.blocks(page);
  for (const key of ['x', 'Space', 'Enter', 'Backspace', 'Delete']) await page.keyboard.press(key);
  await expect(cardOf('opaque-blocks-typeless')).toBeFocused();
  expect(await driver.blocks(page)).toEqual(shown);
  const stored = await storedBlocks(page);
  for (const [id] of cards) expect(stored[id], id).toEqual(held[id]);

  // The app's own shortcuts still hear a key typed there
  await page.keyboard.press('Shift+Slash');
  await expect(page.getByRole('dialog', { name: 'Keyboard Shortcuts' })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog', { name: 'Keyboard Shortcuts' })).toBeHidden();

  await cardOf('opaque-blocks-typeless').focus();
  await page.keyboard.press('Tab');
  await expect(page.locator('#blocks-container > .block[data-id="opaque-blocks-table"] th').first()).toBeFocused();
  await expectNoUncaught(extension, page);
});

test("a selected card with the focus ring shows the ring without the selection's outline, and the outline comes back once focus moves on", async ({ extension }) => {
  const { fixture } = opaqueBlocks();
  await fixtureHost(extension.worker).loadFixture(fixture);
  await extension.seedOnboarded();
  const page = await driver.openNewTab(extension);
  await driver.openNote(page, 'Kept as it is');
  const kanban = page.locator('#blocks-container > .block[data-id="opaque-blocks-unknown"]');
  const card = kanban.locator('.block-safe-card');
  const tint = 'rgba(45, 140, 255, 0.08)';

  // Selected by Cmd/Ctrl+click, the block shows the selection's outline and tint
  const mod = process.platform === 'darwin' ? 'Meta' : 'Control';
  await card.click({ modifiers: [mod] });
  await expect(kanban).toHaveClass(/block-selected/);
  await expect(kanban).toHaveCSS('outline-style', 'solid');
  await expect(kanban).toHaveCSS('background-color', tint);

  // Back a card and forward again, so the focus is the keyboard's: the card's ring shows, the
  // block's outline doesn't, and the block stays selected, in its tint
  await page.keyboard.press('Shift+Tab');
  await page.keyboard.press('Tab');
  await expect(card).toBeFocused();
  await expect(card).toHaveCSS('outline-style', 'solid');
  await expect(kanban).toHaveClass(/block-selected/);
  await expect(kanban).toHaveCSS('outline-style', 'none');
  await expect(kanban).toHaveCSS('background-color', tint);

  // Once focus moves on to the next card, the outline comes back
  await page.keyboard.press('Tab');
  await expect(page.locator('#blocks-container > .block[data-id="opaque-blocks-invalid"] .block-safe-card')).toBeFocused();
  await expect(kanban).toHaveClass(/block-selected/);
  await expect(kanban).toHaveCSS('outline-style', 'solid');
  await expectNoUncaught(extension, page);
});

test("a card whose record is a list item takes Tab as every card does: Tab goes on from it, Shift+Tab goes back, and its record stays as loaded", async ({ extension }) => {
  const { fixture, held } = opaqueBlocks();
  // The newer block's record made a to-do, a list type the block shortcuts would read
  held['opaque-blocks-newer'].type = 'todo';
  await fixtureHost(extension.worker).loadFixture(fixture);
  await extension.seedOnboarded();
  const page = await driver.openNewTab(extension);
  await driver.openNote(page, 'Kept as it is');
  const cardOf = id => page.locator(`#blocks-container > .block[data-id="${id}"] .block-safe-card`);
  const before = page.locator('#blocks-container > .block[data-id="opaque-blocks-before"] .block-content');
  await expect(cardOf('opaque-blocks-newer')).toHaveAccessibleName("This to-do block can't be shown");

  await before.click();
  await page.keyboard.press('End');
  await page.keyboard.press('Tab');
  await expect(cardOf('opaque-blocks-newer')).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(cardOf('opaque-blocks-unknown')).toBeFocused();
  await page.keyboard.press('Shift+Tab');
  await expect(cardOf('opaque-blocks-newer')).toBeFocused();
  await page.keyboard.press('Shift+Tab');
  await expect(before).toBeFocused();
  expect((await storedBlocks(page))['opaque-blocks-newer']).toEqual(held['opaque-blocks-newer']);
  await expectNoUncaught(extension, page);
});

test("turning a table into text asks first: Cancel keeps it and puts focus in it, a yes keeps its cells a row per line, and Undo brings it back", async ({ extension }) => {
  const { fixture, held } = opaqueBlocks();
  await fixtureHost(extension.worker).loadFixture(fixture);
  await extension.seedOnboarded();
  const page = await driver.openNewTab(extension);
  await driver.openNote(page, 'Kept as it is');
  const table = page.locator('#blocks-container > .block[data-id="opaque-blocks-table"]');
  await expect(table).toHaveAttribute('data-type', 'table');

  await turnInto(page, table, 'Text');
  const question = page.getByRole('dialog', { name: 'Turn into Text?' });
  await expect(question.locator('.confirm-dialog-message')).toHaveText("The table's grid is removed. Its cells are kept as text, one row per line.");
  await expect(question.locator('.confirm-dialog-cancel')).toBeFocused();
  await question.locator('.confirm-dialog-cancel').click();
  await expect(question).toHaveCount(0);
  await expect(table).toHaveAttribute('data-type', 'table');
  // The block menu took focus from the note, so it goes to the table's first cell
  await expect(table.locator('th, td').first()).toBeFocused();

  await turnInto(page, table, 'Text');
  await question.locator('.confirm-dialog-confirm').click();
  await expect(table).toHaveAttribute('data-type', 'text');
  await expect(table.locator('.block-content')).toHaveJSProperty('innerHTML', 'Item Cost<br>Tiles $640');
  expect((await storedBlocks(page))['opaque-blocks-table'].tableData).toBeUndefined();

  await page.keyboard.press('ControlOrMeta+z');
  await expect(table).toHaveAttribute('data-type', 'table');
  const back = (await storedBlocks(page))['opaque-blocks-table'];
  expect(back).toEqual({ ...held['opaque-blocks-table'], schemaVersion: 1 });
  await expectNoUncaught(extension, page);
});

test('deleting a selection that holds cards asks first: Cancel keeps it and puts focus in it, a yes deletes them all, and one Undo brings each back', async ({ extension }) => {
  const { fixture, held } = opaqueBlocks();
  await fixtureHost(extension.worker).loadFixture(fixture);
  await extension.seedOnboarded();
  const page = await driver.openNewTab(extension);
  await driver.openNote(page, 'Kept as it is');
  const blockOf = id => page.locator(`#blocks-container > .block[data-id="${id}"]`);
  const order = Object.keys(held).sort((a, b) => held[a].order - held[b].order);

  // Two cards and the block after them, each by Cmd/Ctrl+click, then Backspace
  const mod = process.platform === 'darwin' ? 'Meta' : 'Control';
  await blockOf('opaque-blocks-unknown').locator('.block-safe-card').click({ modifiers: [mod] });
  await blockOf('opaque-blocks-invalid').locator('.block-safe-card').click({ modifiers: [mod] });
  await blockOf('opaque-blocks-extra').locator('.block-content').click({ modifiers: [mod] });
  const selected = page.locator('#blocks-container > .block.block-selected');
  await expect(selected).toHaveCount(3);
  await page.keyboard.press('Backspace');
  const question = page.getByRole('dialog', { name: 'Delete 3 blocks?' });
  await expect(question.locator('.confirm-dialog-cancel')).toBeFocused();
  await question.locator('.confirm-dialog-cancel').click();
  await expect(question).toHaveCount(0);
  await expect(selected).toHaveCount(3);
  // The last Cmd/Ctrl+click left focus in the 'extra' block, so Cancel puts it back there. A
  // Cancel with focus outside the note, which goes to the first selected block that takes focus,
  // is test/editor-safe-card.test.js's
  await expect(blockOf('opaque-blocks-extra').locator('.block-content')).toBeFocused();

  // Asked again from there, a yes deletes all three, and one Undo brings each back
  await page.keyboard.press('Backspace');
  await question.locator('.confirm-dialog-confirm').click();
  await expect(page.locator('#blocks-container > .block')).toHaveCount(order.length - 3);
  await blockOf('opaque-blocks-before').locator('.block-content').click();
  await page.keyboard.press('ControlOrMeta+z');
  await expect(page.locator('#blocks-container > .block')).toHaveCount(order.length);
  expect(await page.locator('#blocks-container > .block').evaluateAll(list => list.map(el => el.dataset.id))).toEqual(order);
  const stored = await storedBlocks(page);
  for (const id of ['opaque-blocks-unknown', 'opaque-blocks-invalid']) expect(stored[id], id).toEqual(held[id]);
  expect(stored['opaque-blocks-extra']).toEqual({ ...held['opaque-blocks-extra'], schemaVersion: 1 });
  await expectNoUncaught(extension, page);
});
