/**
 * A click while the new tab starts reaches the controller that owns it (#12 slice 7a). App
 * builds every controller before it binds a listener, so Focus mode and the sidebar's Import
 * and note menu work as they do once the tab has started. Before, a click in that window,
 * before the later controllers existed, ran App's own copy of their code, now removed, or
 * threw: Focus mode set App's copy of the state, which ShortcutsManager never read, so
 * Escape didn't leave it, an import wrote the note with Storage.createNote, outside the
 * kernel, and Move to trash threw on the missing NotesManager. Each test holds
 * SettingsController's init, which runs after the sidebar's, so the window stays open, and
 * fails on an uncaught exception that test/known-defects.json doesn't list.
 */

const { test, expect, expectNoUncaught } = require('./harness');
const driver = require('./characterization/driver');

/**
 * Hold SettingsController.init until the page calls window.__ntnReleaseSettingsInit, and set
 * window.__ntnSettingsInitHeld once it's held. Runs in every page before the page's own
 * scripts, so it wraps init as js/controllers/settings-controller.js publishes the class.
 */
function holdSettingsInit() {
  let SettingsController;
  const released = new Promise(resolve => { window.__ntnReleaseSettingsInit = resolve; });
  Object.defineProperty(window, 'SettingsController', {
    configurable: true,
    enumerable: true,
    get: () => SettingsController,
    set(value) {
      SettingsController = value;
      const init = value.prototype.init;
      value.prototype.init = async function heldInit(...args) {
        window.__ntnSettingsInitHeld = true;
        await released;
        return init.apply(this, args);
      };
    },
  });
}

/** A new tab on an onboarded profile with two notes, held while its later controllers start */
async function openHeld(extension) {
  await extension.seedOnboarded();
  await driver.seedNotes(extension, ['Alpha', 'Beta'].map(name => ({ name, blocks: [{ type: 'text', content: `${name} body` }] })));
  await driver.trackStartup(extension);
  await extension.context.addInitScript(holdSettingsInit);
  const page = await extension.openSurface('newtab');
  await page.waitForFunction(() => window.__ntnSettingsInitHeld === true);
  return page;
}

/** Let SettingsController.init run, and wait until App.init has returned */
async function release(page) {
  await page.evaluate(() => window.__ntnReleaseSettingsInit());
  await page.waitForFunction(() => window.__ntnAppInit !== undefined);
  expect(await page.evaluate(() => window.__ntnAppInit)).toBe('done');
}

test('Focus mode, turned on while the new tab starts, turns off with Escape once it has started', async ({ extension }) => {
  const page = await openHeld(extension);
  await page.locator('#focus-mode-btn').click();
  await expect(page.locator('body')).toHaveClass(/(^|\s)focus-mode(\s|$)/);

  await release(page);
  await page.keyboard.press('Escape');
  await expect(page.locator('body')).not.toHaveClass(/(^|\s)focus-mode(\s|$)/);
  // The state is ShortcutsManager's alone
  expect(await page.evaluate(() => ['focusMode' in app, app.shortcutsManager.focusMode])).toEqual([false, false]);
  await expectNoUncaught(extension, page);
});

test('Import, clicked in the sidebar while the new tab starts, makes the note through the kernel', async ({ extension }) => {
  const page = await openHeld(extension);
  // App's removed copy made the note with Storage.createNote; NotesManager's goes through the kernel
  await page.evaluate(() => {
    window.__ntnLegacyCreates = 0;
    const createNote = Storage.createNote;
    Storage.createNote = function countedCreateNote(...args) {
      window.__ntnLegacyCreates += 1;
      return createNote.apply(this, args);
    };
  });
  const chooser = page.waitForEvent('filechooser');
  await page.locator('#sidebar-import-note').click();
  await (await chooser).setFiles({ name: 'Window note.md', mimeType: 'text/markdown', buffer: Buffer.from('Imported while the new tab starts\n') });
  await expect(page.locator('.toast.success').last()).toHaveText('Note imported');
  expect(await page.evaluate(() => window.__ntnLegacyCreates)).toBe(0);

  await release(page);
  await driver.waitForApp(page);
  expect(await driver.listedNoteNames(page)).toContain('Window note');
  await expectNoUncaught(extension, page);
});

test("Move to trash, from a note's menu while the new tab starts, moves the note to trash", async ({ extension }) => {
  const page = await openHeld(extension);
  await driver.openNoteMenu(page, 'Alpha');
  await page.locator('#ctx-delete-note').click();
  await expect(page.locator('.toast.success').last()).toHaveText('Note moved to trash');

  await release(page);
  await driver.waitForApp(page);
  await expect.poll(() => driver.listedNoteNames(page)).toEqual(['Beta']);
  await expectNoUncaught(extension, page);
});
