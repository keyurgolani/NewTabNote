/**
 * Characterization: switching between notes keeps each note's own blocks, and a new tab
 * reopens the note opened last.
 */

const { test, expect } = require('../harness');
const driver = require('./driver');

test('two notes keep their own blocks in order after a switch and a reload, which reopens the last one', async ({ extension }) => {
  await extension.seedOnboarded();
  const page = await driver.openNewTab(extension);

  await driver.writeNote(page, { title: 'Note A', lines: ['Alpha first', 'Alpha second'] });
  await driver.createNote(page);
  await driver.writeNote(page, { title: 'Note B', lines: ['Bravo first', 'Bravo second'] });
  await driver.openNote(page, 'Note A');

  await driver.reload(page);
  await expect(driver.noteTitle(page)).toHaveText('Note A');
  await expect.poll(() => driver.blocks(page)).toEqual([
    { type: 'text', text: 'Alpha first' },
    { type: 'text', text: 'Alpha second' },
  ]);

  await driver.openNote(page, 'Note B');
  await expect(driver.noteTitle(page)).toHaveText('Note B');
  await expect.poll(() => driver.blocks(page)).toEqual([
    { type: 'text', text: 'Bravo first' },
    { type: 'text', text: 'Bravo second' },
  ]);
});
