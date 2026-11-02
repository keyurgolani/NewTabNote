/**
 * Every save puts only what its own pane changed (#17, the per-pane save), on the built
 * extension, five rounds each, every edit kept:
 * - two panes of one note, the main pane and the pop-out, each with its own block: the pop-out
 *   saves its block, then the main pane types into the other one inside its debounce, with its
 *   copy of the pop-out's block stale, and its own debounced save runs;
 * - two tabs on one note: tab B saves the second block, then tab A, whose copy of it is stale,
 *   types into the first one, and its debounced save runs.
 * Each round's stored note is read once its blocks settle, so a test names every round that lost
 * an edit. The same block edited in two panes stays the later save's, until #35's conflict
 * records. The tests also fail on an uncaught exception that test/known-defects.json doesn't list.
 */

const { test, expect, expectNoUncaught } = require('./harness');
const { profileStore } = require('./harness/profile-store');
const driver = require('./characterization/driver');

test.use({ trace: 'off' });

const ROUNDS = 5;

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

/** Note `noteId`'s blocks as stored, in note order, by their text */
async function contentsOf(page, noteId) {
  return (await profileStore(page).getElementsByNote(noteId)).sort((a, b) => a.order - b.order).map(block => block.content);
}

/** Note `noteId`'s blocks as stored once they read `expected`, or as they read after 5 s */
async function settledContents(page, noteId, expected) {
  try {
    await expect.poll(() => contentsOf(page, noteId), { timeout: 5000 }).toEqual(expected);
    return expected;
  } catch {
    return contentsOf(page, noteId);
  }
}

/** A new tab on note `name`, with its second block on screen */
async function openOn(extension, name) {
  const page = await driver.openNewTab(extension);
  await driver.openNote(page, name);
  await page.locator('#blocks-container > .block').nth(1).waitFor();
  return page;
}

/** `ROUNDS` notes of two blocks each, named `<prefix> <n>`, by round */
async function seedPairs(extension, prefix) {
  await extension.seedOnboarded();
  const notes = Array.from({ length: ROUNDS }, (_, index) => ({
    name: `${prefix} ${index + 1}`,
    blocks: [{ type: 'text', content: 'one' }, { type: 'text', content: 'two' }],
  }));
  const seeded = await driver.seedNotes(extension, notes);
  return Array.from({ length: ROUNDS }, (_, index) => seeded.find(note => note.name === `${prefix} ${index + 1}`));
}

test("two panes on one note: the main pane's debounce save keeps the pop-out's newer save of the other block", async ({ extension }) => {
  test.setTimeout(60_000 + ROUNDS * 30_000);
  const pairs = await seedPairs(extension, 'Pair');
  const lost = [];
  for (const [index, { id, name }] of pairs.entries()) {
    const n = index + 1;
    const page = await openOn(extension, name);
    const [pip] = await Promise.all([extension.context.waitForEvent('page'), page.locator('#pip-toggle').click()]);
    await expect.poll(() => page.evaluate(() => Boolean(app.tabController.pipEditor && app.tabController.pipEditor.blocks.length > 1))).toBe(true);
    await driver.afterEditorFocus(page);
    await caretAtEnd(pip.locator('.blocks-container .block-content').nth(1));
    await pip.keyboard.type(` p${n}`);
    expect(await page.evaluate(() => app.tabController.pipEditor.flushSave()), "the pop-out's save is stored").toBe(true);
    await caretAtEnd(page.locator('#blocks-container > .block .block-content').nth(0));
    await page.keyboard.type(` m${n}`);
    expect(await page.evaluate(() => app.editor.saveTimeout !== null), "the main pane's save is still in its debounce").toBe(true);
    const expected = [`one m${n}`, `two p${n}`];
    const stored = await settledContents(page, id, expected);
    if (JSON.stringify(stored) !== JSON.stringify(expected)) lost.push(`round ${n}: ${JSON.stringify(stored)}`);
    await expectNoUncaught(extension, page);
    await pip.close().catch(() => {});
    await page.close();
  }
  expect(lost, 'the rounds whose stored note lost an edit').toEqual([]);
});

test("two tabs on one note: the stale tab's debounce save keeps the other tab's newer save of the other block", async ({ extension }) => {
  test.setTimeout(60_000 + ROUNDS * 30_000);
  const pairs = await seedPairs(extension, 'Two tabs');
  const lost = [];
  for (const [index, { id, name }] of pairs.entries()) {
    const n = index + 1;
    const tabA = await openOn(extension, name);
    const tabB = await openOn(extension, name);
    await caretAtEnd(tabB.locator('#blocks-container > .block .block-content').nth(1));
    await tabB.keyboard.type(` b${n}`);
    expect(await tabB.evaluate(() => app.editor.flushSave()), "tab B's save is stored").toBe(true);
    await caretAtEnd(tabA.locator('#blocks-container > .block .block-content').nth(0));
    await tabA.keyboard.type(` a${n}`);
    expect(await tabA.evaluate(() => app.editor.saveTimeout !== null), "tab A's save is still in its debounce").toBe(true);
    const expected = [`one a${n}`, `two b${n}`];
    const stored = await settledContents(tabA, id, expected);
    if (JSON.stringify(stored) !== JSON.stringify(expected)) lost.push(`round ${n}: ${JSON.stringify(stored)}`);
    await expectNoUncaught(extension, tabA);
    await tabB.close();
    await tabA.close();
  }
  expect(lost, 'the rounds whose stored note lost an edit').toEqual([]);
});
