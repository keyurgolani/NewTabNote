/**
 * Characterization: the popup's quick note creates a note named after the text.
 */

const { test, expect } = require('../harness');
const driver = require('./driver');

test('a quick note from the popup shows in its recent list and in a reloaded new tab', async ({ extension }) => {
  await extension.seedOnboarded();
  const newTab = await driver.openNewTab(extension);
  const popup = await driver.openPopup(extension);

  await driver.addQuickNote(popup, 'Call the plumber');
  await expect.poll(async () => (await driver.recentNoteNames(popup))[0]).toBe('Call the plumber');

  await driver.reload(newTab);
  await driver.showNotes(newTab);
  await expect.poll(() => driver.listedNoteNames(newTab)).toContain('Call the plumber');
});
