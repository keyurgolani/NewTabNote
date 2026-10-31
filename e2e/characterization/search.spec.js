/**
 * Characterization: sidebar search. Its ledgered defect, a keyword match with no note id, is fixed
 * (#22), so this is a plain test now.
 */

const { test, expect } = require('../harness');
const driver = require('./driver');

test("sidebar search for a word only in a block's text finds the note", async ({ extension }) => {
  await extension.seedOnboarded();
  const page = await driver.openNewTab(extension);
  await driver.writeNote(page, { title: 'Groceries', lines: ['Buy saffron and limes'] });
  await driver.createNote(page);
  await driver.writeNote(page, { title: 'Errands', lines: ['Return the library books'] });

  await driver.searchNotes(page, 'saffron');
  await expect.poll(() => driver.listedNoteNames(page)).toEqual(['Groceries']);
});
