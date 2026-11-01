/**
 * 1.4.3 item 1 (#33): text typed into a note just before its tab closes is kept even while
 * another page's transaction holds the notes' blocks. The close's own commit (#142) waits
 * behind that transaction and is lost with the page, so the editor also writes a close-time
 * draft to localStorage at pagehide, and the next start applies it before it shows the note.
 * Each round types a word inside the save's 500 ms debounce, has the Popup hold the blocks in
 * a readwrite transaction for 150 ms, closes the tab with its beforeunload and pagehide handlers
 * run, as a user's close does, and opens a new tab on the note. The test also fails on an
 * uncaught exception that test/known-defects.json doesn't list.
 */

const { test, expect, expectNoUncaught } = require('./harness');
const driver = require('./characterization/driver');

// A trace records every step, which slows the close enough that the build without the drafts
// could keep an edit now and then
test.use({ trace: 'off' });

const ROUNDS = 20;
const HOLD_MS = 150;

/** In `page`: a readwrite transaction over the blocks, kept busy for `ms` */
function holdBlocks(page, ms) {
  return page.evaluate(holdMs => new Promise((resolve, reject) => {
    const open = indexedDB.open('CanvasTabDB');
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const db = open.result;
      const tx = db.transaction(['elements'], 'readwrite');
      const until = performance.now() + holdMs;
      const spin = () => {
        if (performance.now() < until) tx.objectStore('elements').get('ntn-hold').onsuccess = spin;
      };
      spin();
      tx.oncomplete = () => db.close();
      resolve();
    };
  }), ms);
}

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
  await holdBlocks(popup, HOLD_MS);
  await Promise.all([page.waitForEvent('close'), page.close({ runBeforeUnload: true })]);
  // The hold ends before the next start reads
  await popup.waitForTimeout(HOLD_MS + 100);
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
  const names = await page.evaluate(async () => (await Storage.getAllNotes()).map(note => note.name));
  expect(names.filter(name => name.startsWith('Recovered:')), 'no recovered note: nothing else saved the note').toEqual([]);
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
  const names = await one.evaluate(async () => (await Storage.getAllNotes()).map(note => note.name));
  expect(names.filter(name => name === 'Closing' || name.startsWith('Recovered:'))).toEqual(['Closing']);
  expect(await draftsIn(one)).toBe(0);
  await expectNoUncaught(extension, one);
});
