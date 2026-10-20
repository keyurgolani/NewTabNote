/**
 * A note that leaves the active set in one new tab reaches the other new tabs, which move
 * off it. A tab in the background waits until it's in front again, so it moves onto the
 * notes as they are then and never saves a stale copy over edits made elsewhere. Trash
 * retention at a new tab's start tells the other tabs too. Each test also fails on an
 * uncaught exception that test/known-defects.json doesn't list.
 */

const { test, expect, expectNoUncaught } = require('./harness');

/** A new tab that has finished starting: it cached the note it opened and focused its first block */
async function openStartedNewTab(extension, title = null) {
  const page = await extension.openSurface('newtab');
  if (title) await expect(page.locator('#page-title')).toHaveText(title);
  await expect.poll(() => page.evaluate(async () => (await chrome.storage.local.get('lastOpenedNoteId')).lastOpenedNoteId || null))
    .not.toBeNull();
  await expect(page.locator('#editor-container .block-content').first()).toBeFocused();
  return page;
}

/** Note what this page hears on the notes channel, in window.__ntnHeard */
async function listenForNotesLeft(page) {
  await page.evaluate(() => {
    window.__ntnHeard = [];
    const channel = new BroadcastChannel('ntn-notes');
    channel.onmessage = event => window.__ntnHeard.push(event.data);
    window.__ntnChannel = channel;
  });
}

/**
 * Headless Chromium has every page visible and focused, so a page goes to the background
 * here the way a background tab looks to its own scripts: hidden and out of focus
 */
async function sendToBackground(page) {
  await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
    Object.defineProperty(document, 'hasFocus', { configurable: true, value: () => false });
    document.dispatchEvent(new Event('visibilitychange'));
  });
}

/** The user comes back to a page sent to the background */
async function bringBack(page) {
  await page.bringToFront();
  await page.evaluate(() => {
    delete document.visibilityState;
    delete document.hasFocus;
    document.dispatchEvent(new Event('visibilitychange'));
    window.dispatchEvent(new Event('focus'));
  });
}

const heard = page => page.evaluate(() => window.__ntnHeard.length);
const shownName = page => page.evaluate(() => app.editor.noteData && app.editor.noteData.name);
const blocksOf = (page, id) => page.evaluate(async noteId => (await Storage.getElementsByNote(noteId))
  .sort((a, b) => a.order - b.order).map(element => element.content), id);

test('a background tab stays on a note trashed elsewhere until it is in front, then moves onto it as it is', async ({ extension }) => {
  await extension.seedOnboarded();
  const first = await openStartedNewTab(extension, 'Untitled');
  const { betaId, alphaId } = await first.evaluate(async () => {
    const beta = await Storage.createNote('Beta');
    await Storage.saveElement({ id: Utils.generateId(), canvasId: beta.id, type: 'text', content: 'Beta first', order: 0 });
    await Storage.saveElement({ id: Utils.generateId(), canvasId: beta.id, type: 'text', content: 'Beta second', order: 1 });
    const alpha = await Storage.createNote('Alpha');
    await Storage.saveElement({ id: Utils.generateId(), canvasId: alpha.id, type: 'text', content: 'Alpha body', order: 0 });
    await app.refreshNotesList();
    return { betaId: beta.id, alphaId: alpha.id };
  });
  await first.evaluate(id => app.openNoteWithModifier(id, null), betaId);
  await expect(first.locator('#page-title')).toHaveText('Beta');

  // A second new tab with Beta and Alpha open, Alpha on screen, left in the background
  const second = await openStartedNewTab(extension);
  await second.evaluate(async ({ betaId, alphaId }) => {
    await app.openNoteInNewTab(betaId);
    await app.openNoteInNewTab(alphaId);
  }, { betaId, alphaId });
  await expect(second.locator('#page-title')).toHaveText('Alpha');
  await listenForNotesLeft(second);
  await sendToBackground(second);

  // In the first tab: trash Alpha, then keep editing Beta's first block
  await first.bringToFront();
  await first.evaluate(id => app.trashNoteById(id), alphaId);
  await expect.poll(() => heard(second)).toBe(1);
  await first.locator('#editor-container .block-content').first().click();
  await first.keyboard.press('End');
  await first.keyboard.type(', edited in the first tab');
  await expect.poll(() => blocksOf(first, betaId)).toEqual(['Beta first, edited in the first tab', 'Beta second']);
  expect(await shownName(second), 'the background tab stays put meanwhile').toBe('Alpha');

  // Back in the second tab, which moves onto Beta as the first tab left it, and type there
  await bringBack(second);
  await expect.poll(() => shownName(second)).toBe('Beta');
  const firstBlock = second.locator('#editor-container .block-content').first();
  await expect(firstBlock).toHaveText('Beta first, edited in the first tab');
  // The load focuses the note's first block a moment later; click only after that
  await expect(firstBlock).toBeFocused();
  await second.locator('#editor-container .block-content').nth(1).click();
  await second.keyboard.press('End');
  await second.keyboard.type(', typed in the second tab');
  await expect.poll(() => blocksOf(first, betaId))
    .toEqual(['Beta first, edited in the first tab', 'Beta second, typed in the second tab']);
  await expectNoUncaught(extension, second);
});

test('trash retention at a new tab\'s start tells the other tabs, which move off the deleted note', async ({ extension }) => {
  await extension.seedOnboarded();
  const first = await openStartedNewTab(extension, 'Untitled');
  // A note trashed 40 days ago, past the 30-day retention, open from the Trash view
  const oldId = await first.evaluate(async () => {
    const note = await Storage.createNote('Old trashed');
    await Storage.saveElement({ id: Utils.generateId(), canvasId: note.id, type: 'text', content: 'old body', order: 0 });
    await Storage.updateNote({ ...(await Storage.getNote(note.id)), trashed: true, trashedAt: Date.now() - 40 * 24 * 60 * 60 * 1000 });
    await app.refreshNotesList();
    await app.openNoteInNewTab(note.id);
    return note.id;
  });
  await expect(first.locator('#page-title')).toHaveText('Old trashed');
  await listenForNotesLeft(first);
  await sendToBackground(first);

  // A second new tab starts, and its retention deletes the note
  const second = await openStartedNewTab(extension);
  await expect.poll(() => second.evaluate(async id => Boolean(await Storage.getNote(id)), oldId)).toBe(false);
  await expect.poll(() => heard(first), 'the second tab told the first').toBe(1);
  expect(await first.evaluate(() => app.editor.noteId), 'the first tab waits while in the background').toBe(oldId);

  await bringBack(first);
  await expect.poll(() => first.evaluate(() => app.editor.noteId)).not.toBe(oldId);
  expect(await first.evaluate(id => app.tabController.openTabs.some(tab => tab.noteId === id), oldId)).toBe(false);
  await expectNoUncaught(extension, first);
});
