/**
 * 1.4.3 items 2 and 3 (#33) on the built extension: a note whose tab closed inside the save's
 * debounce has its blocks saved without its record. At the next new tab's start, right after
 * the close-time drafts, the record's preview catches up with the blocks, and its name stays
 * as stored. The test also fails on an uncaught exception that
 * test/known-defects.json doesn't list.
 */

const { test, expect, expectNoUncaught } = require('./harness');
const driver = require('./characterization/driver');

// A trace slows the close enough that the record's own save can land before the page goes
test.use({ trace: 'off' });

/** The stored record of the note named `name` */
function storedNote(page, name) {
  return page.evaluate(async noteName => {
    const notes = await Storage.getAllNotes(true);
    const found = notes.find(n => n.name === noteName);
    return found ? { preview: found.preview, name: found.name } : null;
  }, name);
}

test("a note's preview catches up with text typed just before its tab closed", async ({ extension }) => {
  test.setTimeout(90_000);
  await extension.seedOnboarded();
  await driver.seedNotes(extension, [{ name: 'Closing', blocks: [{ type: 'text', content: 'first' }, { type: 'text', content: 'second' }] }]);
  let page = await driver.openNewTab(extension);
  await driver.openNote(page, 'Closing');
  await driver.clickBlock(page, 0);
  await page.keyboard.press('End');
  await page.keyboard.type(' fresh');
  expect(await page.evaluate(() => app.editor.saveTimeout !== null), 'the save is still in its debounce').toBe(true);
  await Promise.all([page.waitForEvent('close'), page.close({ runBeforeUnload: true })]);

  page = await driver.openNewTab(extension);
  await expect.poll(async () => (await storedNote(page, 'Closing')).preview).toBe('first fresh');
  expect((await storedNote(page, 'Closing')).name).toBe('Closing');
  await expectNoUncaught(extension, page);
});
