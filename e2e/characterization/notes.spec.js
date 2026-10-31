/**
 * Characterization: switching between notes keeps each note's own blocks, and a new tab
 * reopens the note opened last.
 */

const { test, expect } = require('../harness');
const driver = require('./driver');

/**
 * Type two notes, switch back and forth, and reload after each switch. Note A is also the
 * first tab, so the last reload, after switching to Note B, is what tells "reopens the last
 * note" from "opens the first tab".
 */
async function twoNotesAcrossReloads(extension) {
  await extension.seedOnboarded();
  const page = await driver.openNewTab(extension);

  await driver.writeNote(page, { title: 'Note A', lines: ['Alpha first', 'Alpha second'] });
  await driver.createNote(page);
  await driver.writeNote(page, { title: 'Note B', lines: ['Bravo first', 'Bravo second'] });
  await driver.openNote(page, 'Note A');

  await driver.reload(page);
  await expect.poll(() => driver.noteTitle(page)).toBe('Note A');
  await expect.poll(() => driver.blocks(page)).toEqual([
    { type: 'text', text: 'Alpha first' },
    { type: 'text', text: 'Alpha second' },
  ]);

  await driver.openNote(page, 'Note B');
  await expect.poll(() => driver.noteTitle(page)).toBe('Note B');
  await expect.poll(() => driver.blocks(page)).toEqual([
    { type: 'text', text: 'Bravo first' },
    { type: 'text', text: 'Bravo second' },
  ]);

  await driver.reload(page);
  await expect.poll(() => driver.noteTitle(page)).toBe('Note B');
}

test('two notes keep their own blocks in order after a switch and a reload, which reopens the last one', async ({ extension }) => {
  await twoNotesAcrossReloads(extension);
});

test('the reopen check fails on a build whose saved tabs always reopen the first tab', async ({ playwright, headless }, testInfo) => {
  // TabController.loadSavedTabs takes the saved activeTabIndex from the session it read, or 0
  // when none is saved; reading it as never saved gives 0, the tab of Note A
  const edits = {
    'js/controllers/tab-controller.js': text => {
      const edited = text.replace(/void 0!==(\w+)\.activeTabIndex\?\1\.activeTabIndex:0/, '0');
      if (edited === text) throw new Error("the self-test's edit didn't match the build of tab-controller.js");
      return edited;
    },
  };
  await driver.withEditedBuild({ playwright, headless }, testInfo, edits, async extension => {
    const error = await twoNotesAcrossReloads(extension).then(() => null, thrown => thrown);
    expect(error, 'the flow passed on the edited build').not.toBeNull();
    // Without the color codes Playwright's message may carry
    expect(error.message.replace(/\u001b\[[0-9;]*m/g, '')).toMatch(/Expected: "Note B"\s+Received: "Note A"/);
  });
});

test('a new tab opens the newest of notes seeded one after another, and the sidebar lists them newest first', async ({ extension }) => {
  // Notes without blocks write fastest, so several can land in one millisecond, and notes
  // that share an updatedAt sort by their random IDs
  const names = ['One', 'Two', 'Three', 'Four', 'Five', 'Six'];
  await extension.seedOnboarded();
  await driver.seedNotes(extension, names.map(name => ({ name })));
  const page = await driver.openNewTab(extension);
  expect(await driver.noteTitle(page)).toBe('Six');
  await driver.showNotes(page);
  // Choosing Notes renders the list after the click
  await expect.poll(() => driver.listedNoteNames(page)).toEqual([...names].reverse());
});
