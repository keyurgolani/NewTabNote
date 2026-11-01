/**
 * 1.4.3 item 3 (#33) on the built extension: a note deleted for good in one tab while another
 * tab has it open with an edit inside the save's debounce. That tab closes, and its closing write
 * leaves blocks that name a note that's gone. At the next new tab's start the close-time drafts
 * name the note gone, and the catch-up removes those blocks, and nothing of another note. The
 * test also fails on an uncaught exception that test/known-defects.json doesn't list.
 */

const { test, expect, expectNoUncaught } = require('./harness');
const driver = require('./characterization/driver');

// A trace slows the close enough that the closing write can land after the next start
test.use({ trace: 'off' });

/** How many blocks the store holds for the note `noteId` */
function blocksOf(page, noteId) {
  return page.evaluate((id) => Storage.getElementsByNote(id).then((blocks) => blocks.length), noteId);
}

test('a note deleted for good while another tab typed in it leaves no blocks after the next start', async ({ extension }) => {
  test.setTimeout(90_000);
  await extension.seedOnboarded();
  await driver.seedNotes(extension, [
    { name: 'Keeper', blocks: [{ type: 'text', content: 'kept' }] },
    { name: 'Doomed', blocks: [{ type: 'text', content: 'one' }, { type: 'text', content: 'two' }] },
  ]);
  const a = await driver.openNewTab(extension);
  // The first start's idle pass, done before the race, so only the start after it can remove the blocks
  if (await a.evaluate(() => typeof StartCatchUp !== 'undefined')) {
    await expect.poll(() => a.evaluate(() => Storage.getSetting('recordsCheckedAt', null)), { timeout: 30_000 }).toEqual(expect.any(Number));
  }
  await driver.openNote(a, 'Doomed');
  const noteId = await a.evaluate(() => app.editor.noteId);

  const b = await driver.openNewTab(extension);
  await b.evaluate(async (id) => {
    await Storage.trashNote(id);
    await Storage.permanentlyDeleteNote(id);
  }, noteId);
  await driver.clickBlock(a, 1);
  await a.keyboard.type(' late');
  expect(await a.evaluate(() => app.editor.saveTimeout !== null), 'the save is still in its debounce').toBe(true);
  await Promise.all([a.waitForEvent('close'), a.close({ runBeforeUnload: true })]);
  await expect.poll(() => blocksOf(b, noteId), { message: "the closing write left the deleted note's blocks" }).toBeGreaterThan(0);
  await b.close();

  const c = await driver.openNewTab(extension);
  await expect.poll(() => blocksOf(c, noteId)).toBe(0);
  const keeper = await c.evaluate(async () => {
    const found = (await Storage.getAllNotes(true)).find((n) => n.name === 'Keeper');
    return found ? (await Storage.getElementsByNote(found.id)).length : -1;
  });
  expect(keeper, "the other note's block stays").toBe(1);
  await expectNoUncaught(extension, c);
});
