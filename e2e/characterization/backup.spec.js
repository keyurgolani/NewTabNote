/**
 * Characterization: an Export JSON backup restored with Import / Restore into a fresh
 * profile brings back the same notes with the same blocks in the same order. It doesn't
 * check IDs, or which archived notes, templates, and folders a backup leaves out (#33
 * changes both).
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { test, expect } = require('../harness');
const driver = require('./driver');

// A 1 by 1 PNG
const IMAGE = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

// Text, heading, to-do, code, bookmark, and image blocks, as seeded and as each note shows them
const NOTES = [
  {
    name: 'Trip plan',
    blocks: [
      { type: 'h1', content: 'Itinerary' },
      { type: 'text', content: 'Fly out Friday' },
      { type: 'todo', content: 'Book hotel', checked: true },
    ],
    shows: [
      { type: 'h1', text: 'Itinerary' },
      { type: 'text', text: 'Fly out Friday' },
      { type: 'todo', text: 'Book hotel', checked: true },
    ],
  },
  {
    name: 'Snippets',
    blocks: [
      { type: 'code', content: 'npm run build' },
      { type: 'bookmark', url: 'https://example.test/docs', title: 'Build docs' },
    ],
    shows: [
      { type: 'code', text: 'npm run build' },
      { type: 'bookmark', title: 'Build docs', url: 'https://example.test/docs' },
    ],
  },
  {
    name: 'Photos',
    blocks: [
      { type: 'image', imageUrl: IMAGE },
      { type: 'text', content: 'Sunset at the pier' },
    ],
    shows: [
      { type: 'image', src: IMAGE },
      { type: 'text', text: 'Sunset at the pier' },
    ],
  },
];

test('an Export JSON backup restores the same notes and blocks into a fresh profile', async ({ extension, playwright, headless }, testInfo) => {
  // Two profiles, each started from scratch
  test.slow();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ntn-backup-'));
  const backup = path.join(dir, 'backup.json');
  try {
    await extension.seedOnboarded();
    await driver.seedNotes(extension, NOTES.map(({ name, blocks }) => ({ name, blocks })));
    await driver.exportJson(await driver.openNewTab(extension), backup);

    await driver.withFreshProfile({ playwright, headless }, testInfo, async profile => {
      await profile.seedOnboarded();
      const page = await driver.openNewTab(profile);
      await driver.importBackup(page, backup);

      await driver.reload(page);
      await driver.showNotes(page);
      await expect.poll(async () => (await driver.listedNoteNames(page)).sort()).toEqual(NOTES.map(note => note.name).sort());
      for (const { name, shows } of NOTES) {
        await driver.openNote(page, name);
        await expect.poll(() => driver.noteTitle(page)).toBe(name);
        await expect.poll(() => driver.blocks(page), `the blocks of "${name}"`).toEqual(shows);
      }
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
