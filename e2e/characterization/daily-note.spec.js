/**
 * Characterization: what the service worker's captureToDailyNote saves (the context menus
 * and keyboard commands call it) shows up in today's Daily Note on the new tab. The node
 * tier, test/characterization-background.test.js, covers the menus and commands.
 */

const { test, expect } = require('../harness');
const driver = require('./driver');

test("captures land in today's Daily Note: text with its source, a bookmark, and a later capture in the same note", async ({ extension }) => {
  await extension.seedOnboarded();
  await driver.captureToDailyNote(extension, { type: 'text', content: 'Captured sentence', source: 'https://example.test/article' });
  await driver.captureToDailyNote(extension, { type: 'bookmark', url: 'https://example.test/bookmarked', title: 'Bookmarked page' });

  const page = await driver.openNewTab(extension);
  await driver.openTodaysDailyNote(page);
  await expect(driver.noteTitle(page)).toHaveText(driver.todaysDailyNoteTitle());
  const captured = [
    { type: 'text', text: 'Captured sentence (Source: https://example.test/article)' },
    { type: 'bookmark', title: 'Bookmarked page', url: 'https://example.test/bookmarked' },
  ];
  await expect.poll(() => driver.blocks(page)).toEqual(captured);

  await driver.captureToDailyNote(extension, { type: 'text', content: 'Second capture', source: 'https://example.test/second' });
  await driver.reload(page);
  await driver.openTodaysDailyNote(page);
  await expect(driver.noteTitle(page)).toHaveText(driver.todaysDailyNoteTitle());
  await expect.poll(() => driver.blocks(page)).toEqual([
    ...captured,
    { type: 'text', text: 'Second capture (Source: https://example.test/second)' },
  ]);
  await driver.showNotes(page);
  await expect.poll(() => driver.listedNoteNames(page)).toEqual([driver.todaysDailyNoteTitle()]);
});
