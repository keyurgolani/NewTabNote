/**
 * Text typed into a note just before its tab closes is kept even while another page's
 * transaction holds the notes' blocks (#33). The closing write waits behind that transaction and
 * is lost with the page, so at its pagehide the page writes a close-time draft to localStorage
 * first, and the next start applies it before it shows the note. Each round types a word inside
 * the save's 500 ms debounce, has the Popup hold the blocks (test/support/faults/store-hold.js),
 * closes the tab with its beforeunload and pagehide handlers run, as a user's close does, checks
 * that the hold still held once the tab had gone and ends it (#244), and opens a new tab on the
 * note. R0's spec (#138), on the stack's harness. The tests also fail on an uncaught exception
 * that test/known-defects.json doesn't list.
 */

const { test, expect, expectNoUncaught } = require('./harness');
const { profileStore } = require('./harness/profile-store');
const { holdStores } = require('../test/support/faults');
const driver = require('./characterization/driver');

const ROUNDS = 20;

/** A new tab on the note, with its second block on screen */
async function reopen(extension) {
  const page = await driver.openNewTab(extension);
  await driver.openNote(page, 'Closing');
  await page.locator('#blocks-container > .block').nth(1).waitFor();
  return page;
}

/** The close-time drafts the extension's pages hold now */
function draftsIn(page) {
  return page.evaluate(() => Object.keys(localStorage).filter(key => key.startsWith('ntn-close-draft:')).length);
}

/** Every stored note's name, the Trash's and Archive's included */
async function noteNames(page) {
  return (await profileStore(page).getAllNotes(true)).map(note => note.name);
}

/**
 * Put the caret after the second block's last character. End goes only to the end of a line,
 * and the block wraps once enough rounds have added their words.
 */
async function caretAtEnd(page) {
  await page.locator('#blocks-container > .block .block-content').nth(1).evaluate(content => {
    content.focus();
    const range = document.createRange();
    range.selectNodeContents(content);
    range.collapse(false);
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
  });
}

/** Type `word` at the end of the second block, inside the debounce, and close the tab while the Popup holds the blocks */
async function typeAndCloseHeld(page, popup, word) {
  await caretAtEnd(page);
  await page.keyboard.type(` ${word}`);
  expect(await page.evaluate(() => app.editor.saveTimeout !== null), 'the save is still in its debounce').toBe(true);
  const hold = await holdStores(popup, ['elements']);
  await Promise.all([page.waitForEvent('close'), page.close({ runBeforeUnload: true })]);
  // The tab went while the hold still held, so its closing write went with it. Then the case
  // ends the hold, before the next start reads
  await hold.stillHeld('once the tab has closed');
  expect(await hold.release(), 'the hold, released').toBe('complete');
}

test('text typed just before the tab closes is kept while another page holds the blocks', async ({ extension }) => {
  test.setTimeout(240_000);
  await extension.seedOnboarded();
  await driver.seedNotes(extension, [{ name: 'Closing', blocks: [{ type: 'text', content: 'first' }, { type: 'text', content: 'start' }] }]);
  const popup = await extension.openSurface('popup');
  let page = await reopen(extension);
  const lost = [];
  for (let round = 1; round <= ROUNDS; round++) {
    const word = `w${round}x`;
    await typeAndCloseHeld(page, popup, word);
    page = await reopen(extension);
    // A space typed last in a contenteditable can stay a no-break space
    const text = (await driver.blocks(page))[1].text;
    if (!text.split(/\s+/).includes(word)) lost.push(round);
  }
  expect(lost, `rounds whose edit was lost, of ${ROUNDS}`).toEqual([]);
  expect(await draftsIn(page), 'every draft applied and removed').toBe(0);
  expect((await noteNames(page)).filter(name => name.startsWith('Recovered:')), 'no recovered note: nothing else saved the note').toEqual([]);
  await expectNoUncaught(extension, page);
});

test('two new tabs that open at once on a profile with a draft apply it once, with no recovered note', async ({ extension }) => {
  test.setTimeout(60_000);
  await extension.seedOnboarded();
  await driver.seedNotes(extension, [{ name: 'Closing', blocks: [{ type: 'text', content: 'first' }, { type: 'text', content: 'start' }] }]);
  const popup = await extension.openSurface('popup');
  const page = await reopen(extension);
  await typeAndCloseHeld(page, popup, 'once');
  expect(await draftsIn(popup), 'the closing tab left its draft').toBe(1);

  await driver.trackStartup(extension);
  const [one, two] = await Promise.all([extension.openSurface('newtab'), extension.openSurface('newtab')]);
  await Promise.all([driver.waitForApp(one), driver.waitForApp(two)]);
  for (const tab of [one, two]) {
    await driver.openNote(tab, 'Closing');
    await expect.poll(async () => (await driver.blocks(tab))[1].text).toBe('start once');
  }
  expect((await noteNames(one)).filter(name => name === 'Closing' || name.startsWith('Recovered:'))).toEqual(['Closing']);
  expect(await draftsIn(one)).toBe(0);
  await expectNoUncaught(extension, one);
});

// #35 slice 4c: Side Panel's start sends its apply of a closing tab's edit to the worker over the
// port, and the next new tab shows the edit. The edit is written where a closing tab leaves one,
// with no block digests, as 1.4.3 left one, on the note's updatedAt, so its apply saves it, and the
// case waits on the drafts themselves, with no hold of fixed time (#244).
test("Side Panel's start has the worker apply a closing tab's edit, and the next new tab shows it", async ({ extension }) => {
  test.setTimeout(60_000);
  await extension.seedOnboarded();
  await driver.seedNotes(extension, [{ name: 'Closing', blocks: [{ type: 'text', content: 'first' }, { type: 'text', content: 'start' }] }]);
  const popup = await extension.openSurface('popup');
  const note = (await profileStore(popup).getAllNotes(true)).find(stored => stored.name === 'Closing');
  await popup.evaluate(({ noteId, updatedAt }) => {
    const content = 'from Side Panel';
    const draft = {
      v: 1, id: 'draft-side', page: 'page-gone', noteId, at: Date.now(),
      base: { updatedAt, issued: [], name: 'Closing' },
      blocks: [{ id: 'b-side-panel', canvasId: noteId, type: 'text', content, order: 2 }],
      deletedBlockIds: [], preview: 'first', todoProgress: null, linkedNames: [],
    };
    localStorage.setItem(`ntn-close-draft:${draft.id}`, JSON.stringify(draft));
  }, { noteId: note.id, updatedAt: note.updatedAt });
  expect(await draftsIn(popup), 'the edit waits where a closing tab leaves it').toBe(1);

  const panel = await extension.openSurface('sidepanel');
  await expect.poll(() => draftsIn(panel), { message: "Side Panel's start applied it, and it went" }).toBe(0);
  const page = await reopen(extension);
  await expect.poll(async () => (await driver.blocks(page)).map(block => block.text)).toEqual(['first', 'start', 'from Side Panel']);
  expect((await noteNames(page)).filter(name => name.startsWith('Recovered:')), 'no recovered note').toEqual([]);
  await expectNoUncaught(extension, page);
});
