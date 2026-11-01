/**
 * Text typed into a block, with the tab closed before the save's 500 ms debounce fires, is
 * there when the note opens again (#142). The editor's pagehide flush writes what's pending,
 * and a page that goes runs no more callbacks: Chrome aborts a transaction the page hasn't
 * committed, so the flush commits its block puts at once. Each round closes the tab with its
 * beforeunload and pagehide handlers run, as a user's close does. The test also fails on an
 * uncaught exception that test/known-defects.json doesn't list.
 */

const { test, expect, expectNoUncaught } = require('./harness');
const driver = require('./characterization/driver');

// A trace records every step, which slows the close enough that the read and the note's put
// sometimes finish before the page goes, so the build without the fix could pass
test.use({ trace: 'off' });

const ROUNDS = 5;

/** A new tab on the note, and the text of its second block as the tab shows it */
async function reopen(extension) {
  const page = await driver.openNewTab(extension);
  await driver.openNote(page, 'Closing');
  await page.locator('#blocks-container > .block').nth(1).waitFor();
  return page;
}

test('text typed just before the tab closes is there when the note opens again', async ({ extension }) => {
  await extension.seedOnboarded();
  await driver.seedNotes(extension, [{ name: 'Closing', blocks: [{ type: 'text', content: 'first' }, { type: 'text', content: 'start' }] }]);
  let page = await reopen(extension);
  let expected = 'start';
  for (let round = 1; round <= ROUNDS; round++) {
    await driver.clickBlock(page, 1);
    await page.keyboard.type(` w${round}`);
    expected += ` w${round}`;
    expect(await page.evaluate(() => app.editor.saveTimeout !== null), 'the save is still in its debounce').toBe(true);
    await Promise.all([page.waitForEvent('close'), page.close({ runBeforeUnload: true })]);
    page = await reopen(extension);
    await expect.poll(async () => (await driver.blocks(page))[1].text, `round ${round}`).toBe(expected);
  }
  await expectNoUncaught(extension, page);
});
