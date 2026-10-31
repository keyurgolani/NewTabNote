/**
 * #12 slice 4b2b in the built extension, with a stub provider: version history (a snapshot,
 * the list, a preview, and a revert after a pin) and AI chat's inserts (append, insert at the
 * cursor, and a new note from a response), all through the new tab's kernel. The stub replaces
 * the LLM service's provider calls, so nothing leaves the machine.
 */

const { test, expect, expectNoUncaught } = require('./harness');
const driver = require('./characterization/driver');

/** Answer every provider call on the new tab without a network request */
function stubProvider(page) {
  return page.evaluate(() => {
    Object.assign(LLM, {
      isConfigured: () => true,
      generateTitle: async () => 'Bakery plan',
      extractInsights: async () => null,
      chat: async () => 'A reply',
    });
  });
}

/** The note as the new tab's kernel reads it */
function storedNote(page, noteId) {
  return page.evaluate(async id => {
    const state = await app.kernel.query({ type: 'getNote', noteId: id });
    return state.kind === 'ready' ? state.data.note : null;
  }, noteId);
}

/** A note's stored blocks' text, in note order, without markup: the editor shows a wiki link as a link */
function storedTexts(page, noteId) {
  return page.evaluate(async id => {
    const state = await app.kernel.query({ type: 'getNoteBlocks', noteId: id });
    return state.kind === 'ready' ? state.data.map(block => String(block.content).replace(/<[^>]*>/g, '')) : [];
  }, noteId);
}

/** Confirm the AI insert preview for `content`, as the chat's Append and New Note buttons open it */
async function confirmInsert(page, action, content) {
  await page.evaluate(([kind, text]) => app.aiChatController.openAIInsertPreview(kind, text), [action, content]);
  await expect(page.locator('#ai-insert-preview-modal')).not.toHaveClass(/hidden/);
  await page.locator('#ai-insert-preview-confirm').click();
}

test('version history saves, lists, previews, and reverts through the kernel, keeping a pin', async ({ extension }) => {
  await extension.seedOnboarded();
  await driver.seedNotes(extension, [{ name: 'Groceries', blocks: [{ type: 'text', content: 'Milk' }] }]);
  const page = await driver.openNewTab(extension);
  await driver.openNote(page, 'Groceries');
  const noteId = await page.evaluate(() => app.editor.noteId);

  // The 5-minute interval's snapshot, taken now
  await page.evaluate(async () => {
    app.editor._snapshotDirty = true;
    await app.editor._autoSnapshot();
  });
  // The note goes on: new text, saved, and a pin from the sidebar's path
  await page.locator('#blocks-container .block-content').first().click();
  await page.keyboard.press('End');
  await page.keyboard.type(' and oats');
  await expect.poll(() => driver.savedBlocks(page)).toEqual(['Milk and oats']);
  await page.locator('#page-title').fill('Shopping');
  await expect.poll(async () => (await storedNote(page, noteId)).name).toBe('Shopping');
  await expect.poll(() => driver.listedNoteNames(page)).toContain('Shopping');
  await page.evaluate(id => app.kernel.execute({ type: 'setPinned', commandId: 'pin-e2e', noteId: id, pinned: true }), noteId);

  // Version history lists the snapshot, and its preview shows what it holds
  await page.locator('#version-history-btn').click();
  const item = page.locator('#version-history-panel .version-history-item');
  await expect(item).toHaveCount(1);
  await expect(item.locator('.version-history-item-title')).toHaveText('Groceries');
  await item.getByRole('button', { name: 'Preview' }).click();
  await expect(page.locator('#snapshot-preview-modal .snapshot-preview-body')).toHaveText('Milk');
  await page.locator('#snapshot-preview-modal .close-btn').click();

  // Revert: the text comes back, the pin stays, and what it replaced is the newest snapshot
  await item.getByRole('button', { name: 'Revert' }).click();
  await page.locator('.confirm-dialog-confirm').click();
  await expect.poll(() => storedTexts(page, noteId)).toEqual(['Milk']);
  await expect.poll(() => driver.blocks(page)).toEqual([{ type: 'text', text: 'Milk' }]);
  expect((await storedNote(page, noteId)).pinned).toBe(true);
  await expect(page.locator('#version-history-panel')).toHaveCount(0);
  // The sidebar lists the restored title from the note list, with no reload
  await expect.poll(() => driver.listedNoteNames(page)).toContain('Groceries');
  expect(await driver.listedNoteNames(page)).not.toContain('Shopping');
  const titles = await page.evaluate(async id => {
    const state = await app.kernel.query({ type: 'listSnapshots', noteId: id });
    return state.data.length;
  }, noteId);
  expect(titles).toBe(2);
  await expectNoUncaught(extension, page);
});

test('AI chat appends, inserts at the cursor, and makes a new note through the kernel', async ({ extension }) => {
  await extension.seedOnboarded();
  await driver.seedNotes(extension, [
    { name: 'Plan', blocks: [{ type: 'text', content: 'First' }, { type: 'text', content: 'Last' }] },
    { name: 'Review', blocks: [{ type: 'text', content: 'Numbers' }] },
  ]);
  const page = await driver.openNewTab(extension);
  await stubProvider(page);
  await driver.openNote(page, 'Plan');
  const noteId = await page.evaluate(() => app.editor.noteId);

  // Append, with no block focused: after the last block
  await page.evaluate(() => {
    app.editor.activeBlock = null;
  });
  await confirmInsert(page, 'append', 'Appended by the chat');
  await expect.poll(() => storedTexts(page, noteId)).toEqual(['First', 'Last', 'Appended by the chat']);

  // Insert at the cursor: after the focused block
  await page.locator('#blocks-container .block-content').first().click();
  await confirmInsert(page, 'append', 'See [[Review]]');
  const atCursor = ['First', expect.stringMatching(/^See (\[\[)?Review(\]\])?$/), 'Last', 'Appended by the chat'];
  await expect.poll(() => storedTexts(page, noteId)).toEqual(atCursor);
  await expect.poll(() => driver.blocks(page).then(shown => shown.map(block => block.text))).toEqual(atCursor);
  // The chat's parser makes a [[link]] a link element, as in 1.4.x, so the insert stores no link
  // record for it; the unit tests cover the links an insert's text holds
  expect((await storedNote(page, noteId)).preview).toBe('First');

  // A new note from a response, which the stub names
  await confirmInsert(page, 'create', 'Call the bakery');
  await expect.poll(() => driver.noteTitle(page)).toBe('Bakery plan');
  const made = await page.evaluate(() => app.editor.noteId);
  expect(made).not.toBe(noteId);
  expect(await storedTexts(page, made)).toEqual(['Call the bakery']);
  expect((await storedNote(page, made)).preview).toBe('Call the bakery');
  // The sidebar shows the inserted text as the new note's preview, with no reload
  const listed = page.locator('#sidebar-notes-list .sidebar-note-item').filter({ has: page.getByText('Bakery plan', { exact: true }) });
  await expect(listed.locator('.sidebar-note-preview')).toHaveText('Call the bakery');
  await expectNoUncaught(extension, page);
});
