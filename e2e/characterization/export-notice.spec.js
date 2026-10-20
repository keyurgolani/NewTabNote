/**
 * The one-time notice to export before the next update changes how notes are stored
 * (NTN-18 slice 0). A profile whose notes hold something sees it below the note's title.
 * Export JSON asks to check that the file saved, and Done then records "exported"; Not now
 * records "dismissed"; after either, no tab shows it again. A profile with nothing of its
 * own at its first 1.4.1 start records "not-needed" and never sees it. Each test ends with
 * the uncaught-exception check.
 */

const { test, expect, expectNoUncaught } = require('../harness');
const driver = require('./driver');

const TITLE = 'Save a copy before the next update';
const BODY = 'The next NewTabNote update changes how notes are stored on this device. Exporting now gives you a copy to keep.';
const CONFIRM = 'Check that the file saved, then choose Done.';
const CONTENTS = 'Export JSON includes active and archived notes, templates, folders, and media. '
  + 'Not included: trash, themes, version history, AI chat history, and settings. '
  + 'Backlinks rebuild when each note is next saved.';
const ANY_TIME = 'You can export any time from Settings > Data & Backup.';
const HINT = 'Export JSON and Create Backup include active and archived notes, templates, folders, and media. '
  + 'Not included: trash, themes, version history, AI chat history, and settings. '
  + 'The Markdown ZIP holds active notes only. Backlinks rebuild when each note is next saved.';

const FIRST_STEP = {
  role: 'region', name: TITLE, live: 'polite', announces: [TITLE, BODY, CONTENTS, ANY_TIME], buttons: ['Export JSON', 'Not now'],
};
const CHECK_STEP = {
  role: 'region', name: TITLE, live: 'polite', announces: [TITLE, CONFIRM, CONTENTS, ANY_TIME], buttons: ['Done', 'Export again', 'Not now'],
};

// One active note, one archived, one template
const NOTES = [
  { name: 'Groceries', blocks: [{ type: 'text', content: 'eggs' }] },
  { name: 'Old trip', archived: true, blocks: [{ type: 'text', content: 'Lisbon' }] },
  { name: 'Weekly review', isTemplate: true, blocks: [{ type: 'text', content: 'Wins' }] },
];

const recorded = outcome => ({ version: 1, outcome, at: expect.any(Number) });
const withoutTime = ({ exportedAt, ...rest }) => rest;

/** WCAG contrast of two opaque computed colors, `rgb(r, g, b)` */
function contrast(first, second) {
  const luminance = color => {
    const channels = color.match(/[\d.]+/g).map(Number);
    if (channels.length > 3 && channels[3] !== 1) throw new Error(`${color} isn't opaque`);
    const [r, g, b] = channels.slice(0, 3).map(channel => {
      const value = channel / 255;
      return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  const [lighter, darker] = [luminance(first), luminance(second)].sort((a, b) => b - a);
  return (lighter + 0.05) / (darker + 0.05);
}

/** A profile past onboarding with NOTES, and a new tab on it */
async function profileWithNotes(extension) {
  await extension.seedOnboarded();
  await driver.seedNotes(extension, NOTES);
  return driver.openNewTab(extension);
}

test('a first run records "not-needed", so neither the sample note nor later notes bring the notice', async ({ extension }) => {
  const page = await driver.openNewTab(extension, { wait: false });
  await driver.skipOnboarding(page);
  expect(await driver.noteTitle(page)).toBe('Welcome to NewTabNote 🚀');
  expect(await driver.exportNotice(page)).toBeNull();
  expect(await driver.exportNoticeRecord(page)).toEqual(recorded('not-needed'));

  await driver.reload(page);
  expect(await driver.exportNotice(page)).toBeNull();
  expect(await driver.exportNotice(await driver.openNewTab(extension))).toBeNull();
  await expectNoUncaught(extension, page);
});

test('a profile with no notes records "not-needed", and its first notes never bring the notice', async ({ extension }) => {
  await extension.seedOnboarded();
  const page = await driver.openNewTab(extension);
  expect(await driver.exportNotice(page)).toBeNull();
  expect(await driver.exportNoticeLiveRegion(page)).toEqual({ live: 'polite', text: '' });
  expect(await driver.exportNoticeRecord(page)).toEqual(recorded('not-needed'));

  await driver.writeNote(page, { title: 'Packing', lines: ['socks'] });
  await driver.reload(page);
  expect(await driver.noteTitle(page)).toBe('Packing');
  expect(await driver.exportNotice(page)).toBeNull();
  expect(await driver.exportNotice(await driver.openNewTab(extension))).toBeNull();
  await expectNoUncaught(extension, page);
});

test('the notice is in place before the note\'s first block, a region named by its heading whose live part holds only its text', async ({ extension }) => {
  const page = await profileWithNotes(extension);
  expect(await driver.noticeShownBeforeFirstBlock(page)).toBe(true);
  expect(await driver.exportNotice(page)).toEqual(FIRST_STEP);
  expect(await driver.exportContentsHint(page)).toBe(HINT);
  await expectNoUncaught(extension, page);
});

test('Export JSON asks to check the file; Done records "exported", and the file is the one Settings exports', async ({ extension }) => {
  const page = await profileWithNotes(extension);
  expect(await driver.exportNotice(page)).toEqual(FIRST_STEP);

  const fromNotice = await driver.readJsonDownload(await driver.exportFromNotice(page));
  await expect.poll(() => driver.exportNotice(page)).toEqual(CHECK_STEP);
  expect(await driver.exportNoticeRecord(page), 'the file may not have saved').toBeNull();
  const again = await driver.readJsonDownload(await driver.exportFromNotice(page, 'Export again'));
  expect(await driver.exportNotice(page)).toEqual(CHECK_STEP);

  await driver.chooseInExportNotice(page, 'Done');
  await expect.poll(() => driver.exportNotice(page)).toBeNull();
  expect(await driver.exportNoticeRecord(page)).toEqual(recorded('exported'));

  const fromSettings = await driver.readJsonDownload(await driver.exportJson(page));
  for (const file of [fromNotice, again, fromSettings]) {
    expect(file.name).toMatch(/^new-tab-note-export-.+\.json$/);
    expect(typeof file.data.exportedAt).toBe('number');
  }
  expect(withoutTime(fromNotice.data)).toEqual(withoutTime(fromSettings.data));
  expect(withoutTime(again.data)).toEqual(withoutTime(fromSettings.data));
  expect(fromNotice.data.canvases.map(note => note.name).sort()).toEqual(['Groceries', 'Old trip', 'Weekly review']);

  await driver.closeSettings(page);
  await driver.reload(page);
  expect(await driver.exportNotice(page)).toBeNull();
  await expectNoUncaught(extension, page);
});

test('an Export JSON right after typing has the edit in the file', async ({ extension }) => {
  const page = await profileWithNotes(extension);
  // The new tab focuses the note's first block; click Export JSON inside the editor's 500 ms save delay
  await page.keyboard.press('End');
  await page.keyboard.type(' and milk');
  const file = await driver.readJsonDownload(await driver.exportFromNotice(page));
  expect(file.data.elements.map(element => element.content)).toContain('eggs and milk');
  await expectNoUncaught(extension, page);
});

for (const theme of ['light', 'dark']) {
  test(`in the ${theme} theme, the notice's text and button labels are at least 4.5:1`, async ({ extension }) => {
    const page = await profileWithNotes(extension);
    await driver.setTheme(page, theme);
    await driver.closeSettings(page);
    expect(await driver.theme(page)).toBe(theme);

    const { card, text, buttons, hovered } = await driver.exportNoticeColors(page);
    for (const line of text) expect(contrast(line.color, card), line.text).toBeGreaterThanOrEqual(4.5);
    for (const [state, list] of [['shown', buttons], ['hovered', hovered]]) {
      for (const button of list) {
        expect(contrast(button.color, button.background), `${button.label}, ${state}`).toBeGreaterThanOrEqual(4.5);
      }
    }
    await expectNoUncaught(extension, page);
  });
}

test('an export from Settings moves the notice to the check-the-file step in every tab', async ({ extension }) => {
  const page = await profileWithNotes(extension);
  const other = await driver.openNewTab(extension);
  expect(await driver.exportNotice(other)).toEqual(FIRST_STEP);

  await driver.exportJson(page);
  await driver.closeSettings(page);
  await expect.poll(() => driver.exportNotice(page)).toEqual(CHECK_STEP);
  await expect.poll(() => driver.exportNotice(other)).toEqual(CHECK_STEP);
  expect(await driver.exportNoticeRecord(page)).toBeNull();

  await driver.chooseInExportNotice(other, 'Done');
  await expect.poll(() => driver.exportNotice(other)).toBeNull();
  await expect.poll(() => driver.exportNotice(page)).toBeNull();
  expect(await driver.exportNoticeRecord(page)).toEqual(recorded('exported'));
  await expectNoUncaught(extension, page);
});

test('Not now records "dismissed", every tab drops the notice, and the note stays as it was', async ({ extension }) => {
  const page = await profileWithNotes(extension);
  const other = await driver.openNewTab(extension);
  const before = await driver.blocks(page);

  await driver.chooseInExportNotice(page, 'Not now');
  await expect.poll(() => driver.exportNotice(page)).toBeNull();
  await expect.poll(() => driver.exportNotice(other)).toBeNull();
  expect(await driver.exportNoticeRecord(page)).toEqual(recorded('dismissed'));

  for (const tab of [page, other]) {
    await driver.reload(tab);
    expect(await driver.exportNotice(tab)).toBeNull();
  }
  expect(await driver.noteTitle(page)).toBe('Groceries');
  expect(await driver.blocks(page)).toEqual(before);
  await expectNoUncaught(extension, page);
});

test('the title stays the first stop after the header, so typing a title there leaves the notice alone', async ({ extension }) => {
  const page = await profileWithNotes(extension);
  const downloads = [];
  page.on('download', download => downloads.push(download));

  await driver.focusHeaderButton(page, 'Settings');
  await page.keyboard.press('Tab');
  expect(await driver.focused(page)).toEqual({ kind: 'title', pane: 'left', text: 'Groceries' });
  await page.keyboard.type('Big shop ');
  await expect.poll(() => driver.noteTitle(page)).toContain('Big shop ');
  expect(await driver.exportNotice(page)).toEqual(FIRST_STEP);
  expect(await driver.exportNoticeRecord(page)).toBeNull();
  expect(downloads).toEqual([]);
  await expectNoUncaught(extension, page);
});

test('the notice\'s buttons come next, at least 44 by 44, and letters typed on one go to the note', async ({ extension }) => {
  const page = await profileWithNotes(extension);
  for (const { label, width, height } of await driver.exportNoticeButtonSizes(page)) {
    expect(width, label).toBeGreaterThanOrEqual(44);
    expect(height, label).toBeGreaterThanOrEqual(44);
  }

  await driver.focusHeaderButton(page, 'Settings');
  await page.keyboard.press('Tab');
  await page.keyboard.press('Tab');
  expect(await driver.focused(page)).toEqual({ kind: 'button', text: 'Export JSON' });
  await page.keyboard.press('Tab');
  expect(await driver.focused(page)).toEqual({ kind: 'button', text: 'Not now' });

  await page.keyboard.type('bacon');
  await expect.poll(() => driver.blocks(page)).toEqual([{ type: 'text', text: 'eggsbacon' }]);
  expect(await driver.focused(page)).toEqual({ kind: 'block', pane: 'left', index: 0, text: 'eggsbacon' });
  expect(await driver.exportNotice(page)).toEqual(FIRST_STEP);
  await expectNoUncaught(extension, page);
});

test('Space on Not now records "dismissed" and puts focus and the caret back where they were', async ({ extension }) => {
  const page = await profileWithNotes(extension);
  // The new tab focuses the note's first block; put the caret between "egg" and "s"
  expect(await driver.focused(page)).toEqual({ kind: 'block', pane: 'left', index: 0, text: 'eggs' });
  await page.keyboard.press('End');
  await page.keyboard.press('ArrowLeft');

  await page.keyboard.press('Shift+Tab');
  expect(await driver.focused(page)).toEqual({ kind: 'button', text: 'Not now' });
  await page.keyboard.press('Space');
  await expect.poll(() => driver.exportNotice(page)).toBeNull();
  expect(await driver.exportNoticeRecord(page)).toEqual(recorded('dismissed'));
  expect(await driver.focused(page)).toEqual({ kind: 'block', pane: 'left', index: 0, text: 'eggs' });

  await page.keyboard.type('!');
  await expect.poll(() => driver.blocks(page)).toEqual([{ type: 'text', text: 'egg!s' }]);
  await expectNoUncaught(extension, page);
});
