/**
 * What a close-time draft comes to at the next start, and what the new tab says of it (#33, the
 * stack's close-time PR). A second new tab, open from before the close, is the other writer,
 * since any tab that starts after the close applies the draft before it shows anything.
 * - The other tab saves the block the closing tab edited: the next start keeps the original as
 *   the other tab saved it, makes one recovered note with the closing tab's edit, and tells it.
 * - The other tab moves the note to the Trash: the next start saves the edit into it there, with
 *   no recovered note, and says so (V3).
 * - The main pane and the pop-out on one note, each with its own block: both are kept.
 * The closing write waits behind the Popup's hold on the blocks and goes with the page, so the
 * edit reaches the next start through its draft alone. The tests also fail on an uncaught
 * exception that test/known-defects.json doesn't list.
 */

const { test, expect, expectNoUncaught } = require('./harness');
const { profileStore } = require('./harness/profile-store');
const driver = require('./characterization/driver');

test.use({ trace: 'off' });

const HOLD_MS = 1000;

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

/** A new tab on 'Shared', with its second block on screen */
async function openShared(extension) {
  const page = await driver.openNewTab(extension);
  await driver.openNote(page, 'Shared');
  await page.locator('#blocks-container > .block').nth(1).waitFor();
  return page;
}

/** Put the caret after the last character of the `index`th block in `page` */
async function caretAtEnd(page, index) {
  await page.locator('#blocks-container > .block .block-content').nth(index).evaluate(content => {
    content.focus();
    const range = document.createRange();
    range.selectNodeContents(content);
    range.collapse(false);
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
  });
}

/** Type `text` at the end of `page`'s `index`th block, inside the save's debounce */
async function typeAt(page, index, text) {
  await caretAtEnd(page, index);
  await page.keyboard.type(text);
}

/** Type into the closing tab's second block and close it while the Popup holds the blocks */
async function editAndCloseHeld(closing, popup, text) {
  await typeAt(closing, 1, text);
  expect(await closing.evaluate(() => app.editor.saveTimeout !== null), 'the save is still in its debounce').toBe(true);
  await holdBlocks(popup, HOLD_MS);
  await Promise.all([closing.waitForEvent('close'), closing.close({ runBeforeUnload: true })]);
  await popup.waitForTimeout(HOLD_MS + 200);
  expect(await popup.evaluate(() => Object.keys(localStorage).filter(key => key.startsWith('ntn-close-draft:')).length),
    'the closing tab left its draft').toBe(1);
}

/** The toasts `page` shows, in order */
function toastsOf(page) {
  return page.locator('.toast-container .toast').allTextContents();
}

/** Every stored note, the Trash's and Archive's included, by name */
async function notesByName(page) {
  const store = profileStore(page);
  const notes = [...(await store.getAllNotes(true)), ...(await store.getTrashedNotes())];
  return Object.fromEntries(notes.map(note => [note.name, note]));
}

/** Note `noteId`'s blocks as stored, in note order, by their text */
async function contentsOf(page, noteId) {
  return (await profileStore(page).getElementsByNote(noteId)).sort((a, b) => a.order - b.order).map(block => block.content);
}

test.beforeEach(async ({ extension }) => {
  await extension.seedOnboarded();
  await driver.seedNotes(extension, [{ name: 'Shared', blocks: [{ type: 'text', content: 'first' }, { type: 'text', content: 'start' }] }]);
});

test('an edit to a block another tab saved since comes back as one recovered note, and the next new tab says so', async ({ extension }) => {
  test.setTimeout(90_000);
  const popup = await extension.openSurface('popup');
  const closing = await openShared(extension);
  const other = await openShared(extension);
  await editAndCloseHeld(closing, popup, ' closing');
  await typeAt(other, 1, ' other');
  expect(await other.evaluate(() => app.editor.flushSave()), "the other tab's save is stored").toBe(true);

  const next = await driver.openNewTab(extension);
  await expect.poll(() => toastsOf(next)).toEqual(['Kept your changes to “Shared” from a closed tab in a recovered note.']);
  const notes = await notesByName(next);
  const recovered = Object.keys(notes).filter(name => name.startsWith('Recovered: Shared'));
  expect(recovered, 'one recovered note').toHaveLength(1);
  expect(await contentsOf(next, notes.Shared.id), 'the original as the other tab saved it').toEqual(['first', 'start other']);
  const kept = await contentsOf(next, notes[recovered[0]].id);
  expect(kept.some(content => /start closing/.test(content)), "the closing tab's edit is in the recovered note").toBe(true);
  await expectNoUncaught(extension, next);
});

test('an edit to a note another tab moved to the Trash is saved into it there, and the next new tab says where it went', async ({ extension }) => {
  test.setTimeout(90_000);
  const popup = await extension.openSurface('popup');
  const closing = await openShared(extension);
  const other = await openShared(extension);
  const noteId = await other.evaluate(() => app.editor.noteId);
  await editAndCloseHeld(closing, popup, ' closing');
  await profileStore(other).trashNote(noteId);

  const next = await driver.openNewTab(extension);
  await expect.poll(() => toastsOf(next)).toEqual(["Saved your changes to “Shared” from a closed tab. It's in the Trash."]);
  const notes = await notesByName(next);
  expect(Object.keys(notes).filter(name => name.startsWith('Recovered:')), 'no recovered note, in Notes, Archive or the Trash').toEqual([]);
  expect(notes.Shared.trashed, 'still in the Trash').toBe(true);
  expect(await contentsOf(next, noteId)).toEqual(['first', 'start closing']);
  await expectNoUncaught(extension, next);
});

test('the main pane and the pop-out on one note, each with an edit to its own block at the close, both kept', async ({ extension }) => {
  test.setTimeout(90_000);
  const page = await openShared(extension);
  const [pip] = await Promise.all([extension.context.waitForEvent('page'), page.locator('#pip-toggle').click()]);
  await expect.poll(() => page.evaluate(() => Boolean(app.tabController.pipEditor && app.tabController.pipEditor.blocks.length > 0))).toBe(true);
  await driver.afterEditorFocus(page);
  const noteId = await page.evaluate(() => app.editor.noteId);
  await typeAt(page, 0, ' main');
  await pip.locator('.blocks-container .block-content').nth(1).evaluate(content => {
    content.focus();
    const range = content.ownerDocument.createRange();
    range.selectNodeContents(content);
    range.collapse(false);
    const selection = content.ownerDocument.defaultView.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
  });
  await pip.keyboard.type(' pop-out');
  await Promise.all([page.waitForEvent('close'), page.close({ runBeforeUnload: true })]);

  const next = await driver.openNewTab(extension);
  await expect.poll(() => contentsOf(next, noteId)).toEqual(['first main', 'start pop-out']);
  expect(Object.keys(await notesByName(next)).filter(name => name.startsWith('Recovered:'))).toEqual([]);
  await expectNoUncaught(extension, next);
});
