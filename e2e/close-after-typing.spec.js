/**
 * Text typed into a block, with the tab closed before the save's 500 ms debounce fires, is
 * there when the note opens again (#33). At its own pagehide the page writes a close-time draft
 * of each edit its editors haven't seen commit, then each editor's closing write. Each round
 * closes the tab with its beforeunload and pagehide handlers run, as a user's close does, and
 * the next start applies whatever the closing write didn't commit. The same holds for an edit in
 * the pop-out (Document Picture-in-Picture), which the tab's close takes with it, title included.
 * R0's spec (#133, #144), on the stack's harness. The tests also fail on an uncaught exception
 * that test/known-defects.json doesn't list.
 */

const { test, expect, expectNoUncaught } = require('./harness');
const { profileStore } = require('./harness/profile-store');
const driver = require('./characterization/driver');

// A trace records every step, which slows the close enough that the closing write sometimes
// commits before the page goes, so a round could pass on that write alone
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
    const store = profileStore(next);
    const stored = async () => {
      const note = await store.getNote(noteId);
      const blocks = (await store.getElementsByNote(noteId)).sort((a, b) => a.order - b.order);
      return `${note ? note.name : '(no note)'} | ${blocks.map(block => block.content).join(' / ')}`;
    };
    await expect.poll(stored, `round ${round}`).toBe(`${title} | ${expected}`);
    await next.close();
  }
  const page = await driver.openNewTab(extension);
  await driver.openNote(page, title);
  expect(await driver.noteTitle(page)).toBe(title);
  expect((await driver.blocks(page)).map(block => block.text).join(' / ')).toBe(expected);
  await expectNoUncaught(extension, page);
});
