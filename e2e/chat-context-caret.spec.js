/**
 * #279 in the built extension, with a stub provider: the AI chat's context for a long note centers on
 * the block that held the person's caret, placed with a real click, and the question goes with real
 * clicks and keys. The stub keeps the system prompt it's given, so each case reads which of the
 * note's blocks it holds, and nothing leaves the machine.
 */

const { test, expect, expectNoUncaught } = require('./harness');
const driver = require('./characterization/driver');

/** The block numbers from `from` to `to`, as a person counts them */
const range = (from, to) => Array.from({ length: to - from + 1 }, (_, i) => from + i);

// 60 text blocks of 500 characters each, 30,000 in all, over the context's 24,000, written top to
// bottom, so the last ten are the most recent edits. Each block's text starts with its number, as [07]
const LONG_NOTE = {
  name: 'Long note',
  blocks: range(1, 60).map(n => ({ type: 'text', content: `[${String(n).padStart(2, '0')}]${'x'.repeat(496)}`, updatedAt: 1700000000000 + n * 60000 })),
};

/** A provider for the note chat that keeps the system prompt it's given and answers, on the page */
function stubProvider(page) {
  return page.evaluate(() => {
    window.__noteChatAsked = [];
    Object.assign(LLM, {
      isConfigured: () => true,
      chatStream: async function* chatStream(messages) {
        window.__noteChatAsked.push(messages[0].content);
        yield 'An answer';
      },
    });
  });
}

/**
 * Ask the open note's chat `question` as a person does, with real clicks and keys: the chat's
 * button, its note tab, the question typed into its input, and Send. Waits for the stub's answer.
 */
async function askTheChat(page, question) {
  await page.locator('#ai-floating-btn').click();
  await page.locator('#ai-tab-note').click();
  await page.locator('#ai-chat-input').click();
  await page.keyboard.type(question);
  await page.locator('#ai-chat-send').click();
  await expect(page.locator('#ai-chat-messages .ai-chat-message.assistant').last()).toContainText('An answer');
}

/** The blocks of the note the last question's context held, by their numbers, in the order it holds them */
async function sentBlocks(page) {
  const asked = await page.evaluate(() => window.__noteChatAsked);
  expect(asked.length, 'the provider got the question').toBeGreaterThan(0);
  return [...asked.at(-1).matchAll(/\[(\d\d)\]/g)].map(match => Number(match[1]));
}

/** A new tab on the long note, with the stub provider */
async function openLongNote(extension) {
  await extension.seedOnboarded();
  await driver.seedNotes(extension, [LONG_NOTE]);
  const page = await driver.openNewTab(extension);
  await stubProvider(page);
  await driver.openNote(page, 'Long note');
  return page;
}

test("AI chat's context for a long note centers on the block a person clicked into, once the chat's input has the focus (#279)", async ({ extension }) => {
  const page = await openLongNote(extension);
  await page.locator('#blocks-container .block-content').nth(44).click();
  await askTheChat(page, 'What comes next?');
  // Block 45 and the five on each side go, in place of blocks 28 to 38, and the share stays
  expect(await sentBlocks(page)).toEqual([...range(1, 27), ...range(40, 60)]);
  await expect(page.locator('#ai-chat-messages .ai-context-indicator')).toHaveText('Using 80% of note content');
  await expectNoUncaught(extension, page);
});

test("AI chat's context for a long note ranks as before when the person placed no caret in it (#279)", async ({ extension }) => {
  const page = await openLongNote(extension);
  await askTheChat(page, 'What comes next?');
  // The recent ten, then the note from its start: the load's own focus of the first block doesn't count
  expect(await sentBlocks(page)).toEqual([...range(1, 38), ...range(51, 60)]);
  await expect(page.locator('#ai-chat-messages .ai-context-indicator')).toHaveText('Using 80% of note content');
  await expectNoUncaught(extension, page);
});
