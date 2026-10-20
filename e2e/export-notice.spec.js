/**
 * The one-time notice to export before the next update changes how notes are stored
 * (NTN-18 slice 0). It shows once for a profile that has notes, never on an empty profile
 * or in the tab that runs onboarding, takes no focus, and records Export JSON or Not now
 * once, so no tab shows it again. Neither button changes a note. Each test also fails on
 * an uncaught exception that test/known-defects.json doesn't list.
 */

const fs = require('fs');
const { test, expect } = require('./harness');
const { toleratedUncaught } = require('./harness/known-defects');

const TOLERATED = toleratedUncaught();
const TITLE = 'Save a copy before the next update';
const LEFT_OUT = 'Not included: trash, themes, version history, AI chat history, and settings.';

/** The notice once it has filled; `.export-notice` is on the page from the moment it shows */
const notice = page => page.getByRole('region', { name: TITLE });
const anyNotice = page => page.locator('.export-notice');

/**
 * Keep each new tab's App.init() promise as window.__ntnStarted. app.js starts the app with
 * `window.app = app; app.init()`, so wrapping init as window.app is set catches the call.
 */
function recordStartup() {
  let app;
  Object.defineProperty(window, 'app', {
    configurable: true,
    get: () => app,
    set(value) {
      app = value;
      if (!value || typeof value.init !== 'function') return;
      const init = value.init;
      value.init = function recordedInit(...args) {
        const started = init.apply(this, args);
        window.__ntnStarted = Promise.resolve(started).then(() => 'done', error => `failed: ${error}`);
        return started;
      };
    },
  });
}

/** Wait until the page's App.init() has finished, which is after it shows or skips the notice */
async function waitForStartup(page) {
  await page.waitForFunction(() => window.__ntnStarted !== undefined);
  expect(await page.evaluate(() => window.__ntnStarted)).toBe('done');
}

async function openNewTab(extension, { wait = true } = {}) {
  const page = await extension.openSurface('newtab');
  if (wait) await waitForStartup(page);
  return page;
}

async function reload(page) {
  await page.reload();
  await waitForStartup(page);
}

/** An active note with a block, an archived note, and a template, written through the page's Storage */
async function seedNotes(page) {
  await page.evaluate(async () => {
    const groceries = await Storage.createNote('Groceries');
    await Storage.saveElement({ id: Utils.generateId(), canvasId: groceries.id, type: 'text', content: 'eggs', order: 0 });
    const trip = await Storage.createNote('Old trip');
    await Storage.archiveNote(trip.id);
    const template = await Storage.createNote('Weekly review');
    template.isTemplate = true;
    await Storage.updateNote(template);
  });
}

/** Every record of the stores that hold notes, read straight from IndexedDB */
async function noteRecords(page) {
  return page.evaluate(() => new Promise((resolve, reject) => {
    const open = indexedDB.open('CanvasTabDB');
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const db = open.result;
      const names = ['canvases', 'elements', 'media', 'folders'];
      const tx = db.transaction(names, 'readonly');
      const records = {};
      names.forEach(name => {
        const request = tx.objectStore(name).getAll();
        request.onsuccess = () => { records[name] = request.result; };
      });
      tx.oncomplete = () => { db.close(); resolve(records); };
      tx.onerror = () => reject(tx.error);
    };
  }));
}

const recorded = page => page.evaluate(async () => (await chrome.storage.local.get('setting_preMigrationNotice')).setting_preMigrationNotice);

/** Run `action` and return the JSON file it downloads */
async function downloadJson(page, action) {
  const [download] = await Promise.all([page.waitForEvent('download'), action()]);
  return { name: download.suggestedFilename(), data: JSON.parse(fs.readFileSync(await download.path(), 'utf8')) };
}

async function exportFromSettings(page) {
  await page.locator('#settings-btn').click();
  const settings = page.getByRole('dialog', { name: 'Settings' });
  await settings.getByRole('navigation', { name: 'Settings categories' }).getByRole('button', { name: 'Data & Backup' }).click();
  await settings.getByRole('button', { name: 'Export JSON' }).click();
}

async function expectNoUncaught(extension) {
  const unexpected = (await extension.uncaught()).filter(({ message }) => !TOLERATED.has(message));
  expect(unexpected.map(({ source, message, stack }) => `${source}: ${stack || message}`), 'uncaught exceptions').toEqual([]);
}

test.beforeEach(async ({ extension }) => {
  await extension.context.addInitScript(recordStartup);
});

test('an empty profile shows no notice, and a first run shows it only once onboarding is done', async ({ extension }) => {
  const page = await openNewTab(extension, { wait: false });
  const walkthrough = page.getByRole('dialog', { name: 'Onboarding walkthrough' });
  await expect(walkthrough).toBeVisible();
  await walkthrough.getByRole('button', { name: 'Skip' }).click();
  // Onboarding ends with the quick-start choice; App.init returns after it
  await page.getByRole('dialog', { name: 'Quick start' }).getByRole('button', { name: /Open the sample note/ }).click();
  await waitForStartup(page);
  await expect(page.locator('#page-title')).toHaveText('Welcome to NewTabNote 🚀');
  await expect(anyNotice(page)).toHaveCount(0);

  await reload(page);
  await expect(notice(page)).toBeVisible();
  await expect(notice(page)).toContainText(LEFT_OUT);
  await expectNoUncaught(extension);
});

test('an onboarded profile with no notes shows no notice', async ({ extension }) => {
  await extension.seedOnboarded();
  const page = await openNewTab(extension);
  await expect(page.locator('#page-title')).toHaveText('Untitled');
  await expect(anyNotice(page)).toHaveCount(0);
  await expectNoUncaught(extension);
});

test('Export JSON downloads what Settings > Export JSON does, records "exported", and the notice stays gone', async ({ extension }) => {
  await extension.seedOnboarded();
  const page = await openNewTab(extension);
  await seedNotes(page);
  await reload(page);
  await expect(notice(page)).toBeVisible();
  const before = await noteRecords(page);

  const fromNotice = await downloadJson(page, () => notice(page).getByRole('button', { name: 'Export JSON' }).click());
  await expect(anyNotice(page)).toHaveCount(0);
  expect(await recorded(page)).toEqual({ version: 1, outcome: 'exported', at: expect.any(Number) });

  const fromSettings = await downloadJson(page, () => exportFromSettings(page));
  expect(fromNotice.name).toMatch(/^new-tab-note-export-.+\.json$/);
  expect(fromSettings.name).toMatch(/^new-tab-note-export-.+\.json$/);
  const { exportedAt: noticeTime, ...noticeExport } = fromNotice.data;
  const { exportedAt: settingsTime, ...settingsExport } = fromSettings.data;
  expect(typeof noticeTime).toBe('number');
  expect(typeof settingsTime).toBe('number');
  expect(noticeExport).toEqual(settingsExport);
  expect(noticeExport.canvases.map(note => note.name).sort()).toEqual(['Groceries', 'Old trip', 'Untitled', 'Weekly review']);
  expect(await noteRecords(page)).toEqual(before);

  await reload(page);
  await expect(anyNotice(page)).toHaveCount(0);
  await expectNoUncaught(extension);
});

test('Not now records "dismissed", every tab drops the notice, and no note changes', async ({ extension }) => {
  await extension.seedOnboarded();
  const page = await openNewTab(extension);
  await seedNotes(page);
  await reload(page);
  const other = await openNewTab(extension);
  await expect(notice(page)).toBeVisible();
  await expect(notice(other)).toBeVisible();
  const before = await noteRecords(page);

  await notice(page).getByRole('button', { name: 'Not now' }).click();
  await expect(anyNotice(page)).toHaveCount(0);
  await expect(anyNotice(other)).toHaveCount(0);
  expect(await recorded(page)).toEqual({ version: 1, outcome: 'dismissed', at: expect.any(Number) });
  expect(await noteRecords(page)).toEqual(before);

  await reload(page);
  await reload(other);
  await expect(anyNotice(page)).toHaveCount(0);
  await expect(anyNotice(other)).toHaveCount(0);
  await expectNoUncaught(extension);
});

test('the notice leaves the editor writable and its buttons work from the keyboard', async ({ extension }) => {
  await extension.seedOnboarded();
  const page = await openNewTab(extension);
  await seedNotes(page);
  await reload(page);
  await expect(notice(page)).toBeVisible();

  // Focus stays in the note, and typing saves while the notice shows
  const firstBlock = page.locator('#blocks-container .block-content').first();
  await expect(firstBlock).toBeFocused();
  await page.keyboard.type('typed with the notice open');
  await expect.poll(() => page.evaluate(async () => {
    const [untitled] = (await Storage.getAllNotes()).filter(note => note.name === 'Untitled');
    return (await Storage.getElementsByNote(untitled.id)).map(block => block.content);
  })).toEqual(['typed with the notice open']);

  // Native buttons, at least 44 by 44, next in the tab order after the header
  const exportButton = notice(page).getByRole('button', { name: 'Export JSON' });
  const notNow = notice(page).getByRole('button', { name: 'Not now' });
  for (const button of [exportButton, notNow]) {
    const box = await button.boundingBox();
    expect(box.width).toBeGreaterThanOrEqual(44);
    expect(box.height).toBeGreaterThanOrEqual(44);
  }
  await page.locator('#settings-btn').focus();
  await page.keyboard.press('Tab');
  await expect(exportButton).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(notNow).toBeFocused();

  // Space picks Not now, and focus goes back to the note
  await page.keyboard.press('Space');
  await expect(anyNotice(page)).toHaveCount(0);
  await expect(firstBlock).toBeFocused();
  expect(await recorded(page)).toEqual({ version: 1, outcome: 'dismissed', at: expect.any(Number) });
  await expectNoUncaught(extension);
});
