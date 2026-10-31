/**
 * A keyword match names its note (a 1.4.x fix, #22), in the built extension. Search entries
 * carry the note's id as `noteId`, and every caller of SearchEngine.search reads a match's `id`;
 * until the fix a Fuse.js match had none. So the sidebar said "No matching notes" for a note it
 * lists, and the AI chat's All Notes said it couldn't find any notes. Here the sidebar finds a note
 * by its title, and All Notes answers from the note a word in its text finds, with a stub
 * provider, so nothing leaves the machine.
 */

const { test, expect, expectNoUncaught } = require('./harness');
const driver = require('./characterization/driver');

const NOTES = [
  // One block: the indexer joins a note's blocks in the order the store returns them, and Fuse.js
  // scores a word by how near the start of the text it sits
  { name: 'Camping trip', blocks: [{ type: 'text', content: 'Gear list: the tent and the stove' }] },
  { name: 'Groceries', blocks: [{ type: 'text', content: 'Milk and bread' }] },
];

/**
 * The text the search index holds for the note named `name`, or null without an entry
 */
function indexedContent(page, name) {
  return page.evaluate(async noteName => {
    const db = await new Promise((resolve, reject) => {
      const request = indexedDB.open('CanvasTabDB');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    try {
      const entries = await new Promise((resolve, reject) => {
        const request = db.transaction('search_index').objectStore('search_index').getAll();
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      const entry = entries.find(item => item.name === noteName);
      return entry ? entry.content : null;
    } finally {
      db.close();
    }
  }, name);
}

/** A provider for the AI chat that answers with the note titles it was given, on the page */
function stubProvider(page) {
  return page.evaluate(() => {
    window.__allNotesAsked = [];
    Object.assign(LLM, {
      isConfigured: () => true,
      chatStream: async function* chatStream(messages) {
        const context = messages[0].content;
        window.__allNotesAsked.push(context);
        yield `From ${[...context.matchAll(/^## (.+)$/gm)].map(match => match[1]).join(', ')}`;
      },
    });
  });
}

test('the sidebar finds a note by its title, and All Notes answers from the note a word in its text finds', async ({ extension }) => {
  await extension.seedOnboarded();
  await driver.seedNotes(extension, NOTES);
  const page = await driver.openNewTab(extension);
  // Only the indexer writes a note's text into its search entry
  await expect.poll(() => indexedContent(page, 'Camping trip'), { timeout: 15_000 }).toContain('tent');

  await driver.searchNotes(page, 'Camping');
  await expect.poll(() => driver.listedNoteNames(page)).toEqual(['Camping trip']);
  await expect(page.locator('#sidebar-notes-list .sidebar-empty')).toHaveCount(0);

  await stubProvider(page);
  await page.locator('#ai-floating-btn').click();
  await page.locator('#ai-tab-all').click();
  // A word in its text, at its start: All Notes keeps a match above 0.3, which Fuse.js gives a
  // word near the start
  await page.locator('#global-chat-input').fill('gear');
  await page.locator('#global-chat-input').press('Enter');
  await expect(page.locator('#global-chat-messages .ai-chat-message.assistant').last()).toContainText('From Camping trip');
  const asked = await page.evaluate(() => window.__allNotesAsked);
  expect(asked).toHaveLength(1);
  expect(asked[0]).toContain('## Camping trip\nGear list: the tent and the stove');
  expect(asked[0]).not.toContain('Groceries');
  await expectNoUncaught(extension, page);
});
