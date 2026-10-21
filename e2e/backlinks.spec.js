/**
 * A note's backlinks panel lists the notes whose [[wiki links]] point at it, and clicking one
 * opens that note. Until #12 slice 4b the click threw "app.openNote is not a function" and
 * opened nothing, on next and 1.4.x: the editor called an App method that never existed. The
 * test also fails on an uncaught exception that test/known-defects.json doesn't list.
 */

const { test, expect, expectNoUncaught } = require('./harness');
const driver = require('./characterization/driver');

test('clicking a backlink opens the note that links here', async ({ extension }) => {
  await extension.seedOnboarded();
  const page = await driver.openNewTab(extension);
  await driver.writeNote(page, { title: 'Target', lines: ['The note the link points at'] });
  await driver.createNote(page);
  await driver.writeNote(page, { title: 'Source', lines: ['See [[Target]] for more'] });

  await driver.openNote(page, 'Target');
  const backlink = page.locator('#backlinks-panel .backlink-item').filter({ hasText: 'Source' });
  await expect(backlink).toHaveCount(1);
  await backlink.click();

  await expect.poll(() => driver.noteTitle(page)).toBe('Source');
  await expect(page.locator('#note-tabs .note-tab.active .note-tab-name')).toHaveText('Source');
  await expectNoUncaught(extension, page);
});
