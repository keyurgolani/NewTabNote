/**
 * #14 slice 3 on the built extension: data safety in the editor, on a 1.4.x profile the
 * extension upgrades as an update does (test/fixtures/storage/synthesized/v8.opaque-blocks.json).
 *
 * - A block this build doesn't fully read (saved by a newer version, of a type it doesn't have,
 *   with stored data it can't read, or with no type) shows as a read-only card that says so,
 *   with nothing to type in.
 * - The blocks around the cards edit and save as usual, and each card's record, like a known
 *   block's field its type doesn't own, is written back as it was loaded.
 * - Turning a table into text asks first: Cancel keeps the table, a yes keeps its cells a row per
 *   line, and Undo brings the table back.
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
  for (const id of ['opaque-blocks-newer', 'opaque-blocks-unknown', 'opaque-blocks-invalid', 'opaque-blocks-typeless']) {
    expect(stored[id], id).toEqual(held[id]);
  }
  expect(stored['opaque-blocks-extra']).toEqual({ ...held['opaque-blocks-extra'], schemaVersion: 1 });
  await expectNoUncaught(extension, page);
});

test("turning a table into text asks first: Cancel keeps it, a yes keeps its cells a row per line, and Undo brings it back", async ({ extension }) => {
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
