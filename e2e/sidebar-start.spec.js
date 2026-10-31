/**
 * The sidebar lists the notes on a start that restores no saved tab. 1.4.x left the Notes
 * list empty on such a start, with the badge counting the notes, until something refreshed
 * it (the characterization driver's showNotes worked around it). #12's note list fixes it.
 */

const { test, expect } = require('./harness');
const driver = require('./characterization/driver');

const NAMES = ['Epsilon', 'Delta', 'Gamma', 'Beta', 'Alpha'];

test('a start with notes and no saved tab lists them in the sidebar, with no refresh', async ({ extension }) => {
  await extension.seedOnboarded();
  await driver.seedNotes(extension, NAMES.map(name => ({ name, blocks: [{ type: 'text', content: `${name} text` }] })));
  // No saved tab and no last-opened note, as on a profile whose tabs were never saved
  const saved = await extension.worker.evaluate(() =>
    chrome.storage.local.get(['setting_openTabs', 'lastOpenedNoteId']));
  expect(saved).toEqual({});

  const page = await driver.openNewTab(extension);
  await expect(page.locator('#notes-count')).toHaveText('5');
  // Nothing clicked: the list shows what the badge counts, newest first
  await expect(page.locator('#sidebar-notes-list .sidebar-note-item')).toHaveCount(5);
  expect(await driver.listedNoteNames(page)).toEqual([...NAMES].reverse());
});
