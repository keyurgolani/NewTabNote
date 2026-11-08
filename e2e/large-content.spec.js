/**
 * #259's guard, heavy, in the packaged extension (the review's B1): a note change, a snapshot and
 * its restore, and an import of several MiB each commit through the new tab's kernel, and read back
 * whole. 1.6.0 saves each in the page, and so does next's build. Once #35 slice 4d sends them to
 * the worker over the runtime port, each still has to go, since each is under the ceiling
 * (contracts/limits.js, COMMAND_CEILING_BYTES) and over the port's old 1 MiB.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { test, expect, expectNoUncaught } = require('./harness');
const driver = require('./characterization/driver');

const MiB = 1024 * 1024;

// A 1 by 1 PNG, which a data URL can carry with any tail, since a reader stops at its last chunk
const IMAGE = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

/** An image's data URL of about `bytes`, a whole number of base64 quads */
const imageOf = bytes => `${IMAGE}${'A'.repeat(Math.floor(bytes / 4) * 4)}`;

/** The note as the new tab's kernel reads it, its blocks with it */
function storedNote(page, noteId) {
  return page.evaluate(async id => {
    const state = await app.kernel.query({ type: 'getNote', noteId: id });
    return state.kind === 'ready' ? state.data : null;
  }, noteId);
}

/** What each of a note's stored blocks holds, as a length, so a cut shows */
async function storedSizes(page, noteId) {
  const note = await storedNote(page, noteId);
  if (!note) return null;
  return note.blocks.map(block => ({
    type: block.type,
    content: (block.content || '').length,
    image: (block.imageUrl || '').length,
    file: (block.fileData || '').length,
  }));
}

test('a 2 MiB file block saves through the kernel, and reads back whole after a reload (#259)', async ({ extension }) => {
  test.slow();
  await extension.seedOnboarded();
  // seedNotes holds only the types 1.4.x's recordings saved, so the block becomes a file block in the editor
  await driver.seedNotes(extension, [{ name: 'Files', blocks: [{ type: 'text', content: '' }] }]);
  const page = await driver.openNewTab(extension);
  await driver.openNote(page, 'Files');
  const noteId = await page.evaluate(() => app.editor.noteId);

  // The file picker's path: the editor reads the file as a data URL into the block, then saves
  const fileSize = await page.evaluate(async bytes => {
    const [first] = app.editor.blocks;
    app.editor.changeBlockType(first.id, 'file', { confirmed: true });
    const block = app.editor.getBlockById(first.id);
    const file = new File([new Uint8Array(bytes).fill(7)], 'report.pdf', { type: 'application/pdf' });
    await app.editor.handleFileUpload({ target: { files: [file], dataset: { blockId: block.id } } });
    await app.editor.flushSave();
    return file.size;
  }, 2 * MiB);
  expect(fileSize).toBe(2 * MiB);
  // Base64 takes 4 characters for each 3 bytes, after the data URL's prefix
  const encoded = Math.ceil((2 * MiB) / 3) * 4;
  await expect.poll(async () => (await storedSizes(page, noteId))?.[0]?.file).toBeGreaterThan(encoded);

  await driver.reload(page);
  await driver.openNote(page, 'Files');
  const sizes = await storedSizes(page, noteId);
  expect(sizes?.[0]?.type).toBe('file');
  expect(sizes?.[0]?.file).toBeGreaterThan(encoded);
  await expectNoUncaught(extension, page);
});

test('a snapshot of a note with 3 MiB of images saves, and its restore brings them back whole (#259)', async ({ extension }) => {
  test.slow();
  const images = [imageOf(1.5 * MiB), imageOf(1.5 * MiB)];
  await extension.seedOnboarded();
  await driver.seedNotes(extension, [
    {
      name: 'Photos',
      blocks: [
        { type: 'image', imageUrl: images[0] },
        { type: 'image', imageUrl: images[1] },
        { type: 'text', content: 'Pier at sunset' },
      ],
    },
  ]);
  const page = await driver.openNewTab(extension);
  await driver.openNote(page, 'Photos');
  const noteId = await page.evaluate(() => app.editor.noteId);

  // The 5-minute interval's snapshot, taken now, as version history's own case takes it
  await page.evaluate(async () => {
    app.editor._snapshotDirty = true;
    await app.editor._autoSnapshot();
  });
  const snapshots = () =>
    page.evaluate(async id => {
      const state = await app.kernel.query({ type: 'listSnapshots', noteId: id });
      return state.kind === 'ready' ? state.data.length : -1;
    }, noteId);
  await expect.poll(snapshots).toBe(1);

  // The note goes on without its images, then the snapshot is restored
  await page.evaluate(async () => {
    app.editor.blocks = app.editor.blocks.filter(block => block.type !== 'image');
    app.editor.scheduleSave();
    await app.editor.flushSave();
  });
  const imagesStored = async () => (await storedSizes(page, noteId))?.filter(block => block.type === 'image').map(block => block.image);
  await expect.poll(imagesStored).toEqual([]);
  await page.locator('#version-history-btn').click();
  const item = page.locator('#version-history-panel .version-history-item');
  await expect(item).toHaveCount(1);
  await item.getByRole('button', { name: 'Revert' }).click();
  await page.locator('.confirm-dialog-confirm').click();
  await expect.poll(imagesStored).toEqual(images.map(image => image.length));
  await expectNoUncaught(extension, page);
});

test('an Export JSON backup of 6 MiB imports with Replace all, every note whole (#259)', async ({ extension, playwright, headless }, testInfo) => {
  test.slow();
  const notes = [1, 2, 3].map(index => ({ name: `Long note ${index}`, blocks: [{ type: 'text', content: `${index}`.repeat(2 * MiB) }] }));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ntn-large-'));
  const backup = path.join(dir, 'backup.json');
  try {
    await extension.seedOnboarded();
    await driver.seedNotes(extension, notes);
    await driver.exportJson(await driver.openNewTab(extension), backup);
    expect(fs.statSync(backup).size).toBeGreaterThan(6 * MiB);

    await driver.withFreshProfile({ playwright, headless }, testInfo, async profile => {
      await profile.seedOnboarded();
      const page = await driver.openNewTab(profile);
      await driver.importBackup(page, backup);
      await driver.reload(page);
      await driver.showNotes(page);
      await expect.poll(async () => (await driver.listedNoteNames(page)).sort()).toEqual(notes.map(note => note.name).sort());
      for (const note of notes) {
        await driver.openNote(page, note.name);
        const noteId = await page.evaluate(() => app.editor.noteId);
        await expect.poll(async () => (await storedSizes(page, noteId))?.map(block => block.content)).toEqual([2 * MiB]);
      }
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
