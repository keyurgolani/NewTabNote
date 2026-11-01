/**
 * Text typed into a block, with the tab closed before the save's 500 ms debounce fires, is
 * there when the note opens again (#33). The editor's pagehide flush writes what's pending,
 * and a page that goes runs no more callbacks: Chrome aborts a transaction the page hasn't
 * committed, so the flush commits its block puts at once. Each round closes the tab with its
 * beforeunload and pagehide handlers run, as a user's close does. The same holds for an edit
 * in the pop-out (Document Picture-in-Picture), which the tab's close takes with it (#33). The
 * tests also fail on an uncaught exception that test/known-defects.json doesn't list.
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

/** Put the caret after the last character of `content`, in its own window */
function caretAtEnd(content) {
  return content.evaluate(element => {
    element.focus();
    const range = element.ownerDocument.createRange();
    range.selectNodeContents(element);
    range.collapse(false);
    const selection = element.ownerDocument.defaultView.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
  });
}

test('an edit typed in the pop-out just before the tab closes is there when the note opens again, title included', async ({ extension }) => {
  test.setTimeout(120_000);
  await extension.seedOnboarded();
  await driver.seedNotes(extension, [{ name: 'Popped', blocks: [{ type: 'text', content: 'start' }] }]);
  let title = 'Popped';
  let expected = 'start';
  for (let round = 1; round <= ROUNDS; round++) {
    const page = await driver.openNewTab(extension);
    await driver.openNote(page, title);
    const [pip] = await Promise.all([extension.context.waitForEvent('page'), page.locator('#pip-toggle').click()]);
    await expect.poll(() => page.evaluate(() => Boolean(app.tabController.pipEditor && app.tabController.pipEditor.blocks.length > 0))).toBe(true);
    // The pop-out's editor moves focus to its note shortly after it loads, so nothing types before that
    await driver.afterEditorFocus(page);
    const noteId = await page.evaluate(() => app.tabController.pipEditor.noteId);
    title = `Popped ${round}`;
    const titleEl = pip.locator('.page-title');
    await caretAtEnd(titleEl);
    await pip.keyboard.press('ControlOrMeta+a');
    await pip.keyboard.type(title);
    await caretAtEnd(pip.locator('.blocks-container .block-content').first());
    await pip.keyboard.type(` p${round}`);
    expected += ` p${round}`;
    expect(await page.evaluate(() => app.tabController.pipEditor.saveTimeout !== null), "the pop-out's save is still in its debounce").toBe(true);
    await Promise.all([page.waitForEvent('close'), page.close({ runBeforeUnload: true })]);
    const next = await driver.openNewTab(extension);
    const stored = () => next.evaluate(async id => {
      const note = await Storage.getNote(id);
      const blocks = await Storage.getElementsByNote(id);
      return `${note ? note.name : '(no note)'} | ${blocks.map(block => block.content).join(' / ')}`;
    }, noteId);
    await expect.poll(stored, `round ${round}`).toBe(`${title} | ${expected}`);
    await next.close();
  }
  const page = await driver.openNewTab(extension);
  await driver.openNote(page, title);
  expect(await driver.noteTitle(page)).toBe(title);
  expect((await driver.blocks(page)).map(block => block.text).join(' / ')).toBe(expected);
  await expectNoUncaught(extension, page);
});
