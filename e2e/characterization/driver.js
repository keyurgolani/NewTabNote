/**
 * How the characterization specs act on the legacy 1.4.x UI, and how they read it. Specs
 * say what a user does and assert on what these functions return, usually after a reload.
 * Reads return plain values (text, lists, block summaries), never a locator, so a later
 * issue that changes the UI on purpose updates this file, not the assertions.
 *
 * The driver may seed through the legacy Storage global and read app state to know when
 * the UI has settled. Specs never assert on either.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { expect, launchExtension, resolveDist } = require('../harness');

// BlockEditor.loadNote (js/editor.js) focuses the note's first block this long after it renders
const EDITOR_FOCUS_DELAY_MS = 50;
const SETTLE_TIMEOUT_MS = 10_000;

// ─── Startup ───

const trackedContexts = new WeakSet();

/**
 * Keep each new tab's App.init() promise as window.__ntnAppInit. app.js starts the app with
 * `window.app = app; app.init()`, so wrapping init as window.app is set catches the call.
 * Runs in every page of the session before the page's own scripts.
 */
function recordAppInit() {
  let app;
  Object.defineProperty(window, 'app', {
    configurable: true,
    enumerable: true,
    get: () => app,
    set(value) {
      app = value;
      const init = value && value.init;
      if (typeof init !== 'function') return;
      value.init = function recordedInit(...args) {
        const started = init.apply(this, args);
        window.__ntnAppInit = Promise.resolve(started).then(() => 'done', error => `failed: ${error}`);
        return started;
      };
    },
  });
}

async function trackStartup(extension) {
  if (trackedContexts.has(extension.context)) return;
  trackedContexts.add(extension.context);
  await extension.context.addInitScript(recordAppInit);
}

/**
 * Resolve after the deferred focus of every note the editor has loaded so far. HTML runs a
 * timer only after those set before it with an equal or shorter delay, so one set now with
 * the editor's delay runs after theirs.
 */
async function afterEditorFocus(page) {
  await page.evaluate(ms => new Promise(resolve => setTimeout(resolve, ms)), EDITOR_FOCUS_DELAY_MS);
}

/**
 * Wait until App.init() has finished and the editor has settled. Startup can load a note
 * twice (the last opened one, then the saved tabs), and each load moves focus to the
 * note's first block shortly after, so nothing may type before both have.
 */
async function waitForApp(page) {
  await page.waitForFunction(() => window.__ntnAppInit !== undefined, null, { polling: 50, timeout: SETTLE_TIMEOUT_MS })
    .catch(() => {
      throw new Error('The new tab never started its app (no App.init call). Open new tabs with driver.openNewTab.');
    });
  const outcome = await page.evaluate(() => window.__ntnAppInit);
  if (outcome !== 'done') throw new Error(`The new tab's App.init() ${outcome}`);
  await expect(page.locator('#note-tabs .note-tab.active'), 'the new tab opened a note').toBeVisible();
  await afterEditorFocus(page);
}

/**
 * Open a new tab (newtab.html) and wait until its app has started
 */
async function openNewTab(extension) {
  await trackStartup(extension);
  const page = await extension.openSurface('newtab');
  await waitForApp(page);
  return page;
}

/**
 * Reload a new tab and wait until its app has started again
 */
async function reload(page) {
  await page.reload();
  await waitForApp(page);
}

/**
 * Leave a mark in the page that a reload or a navigation clears
 */
async function markPage(page) {
  await page.evaluate(() => { window.__ntnMark = true; });
}

/**
 * Whether the page has reloaded or navigated since markPage
 */
async function wasReloaded(page) {
  return !(await page.evaluate(() => window.__ntnMark === true));
}

/**
 * Run `body` with a second session on its own fresh profile, attaching its log when the
 * body fails, and close it
 */
async function withFreshProfile({ playwright, headless }, testInfo, body, { dist } = {}) {
  const extension = await launchExtension({ dist, chromium: playwright.chromium, headless });
  try {
    await body(extension);
  } catch (error) {
    await testInfo.attach('fresh-profile-extension-log', { body: extension.log(), contentType: 'text/plain' }).catch(() => {});
    throw error;
  } finally {
    await extension.close();
  }
}

/**
 * Run `body` with a session on a copy of the build edited by `edits`, which maps each file
 * to a function from its text to the text to write. For the self-tests that check a spec
 * fails when the build does the wrong thing. An edit that changes nothing throws, so a
 * build that no longer has the code a self-test edits fails it instead of passing it.
 */
async function withEditedBuild({ playwright, headless }, testInfo, edits, body) {
  const dist = fs.mkdtempSync(path.join(os.tmpdir(), 'ntn-e2e-edited-'));
  try {
    fs.cpSync(resolveDist(), dist, { recursive: true });
    for (const [file, edit] of Object.entries(edits)) {
      const target = path.join(dist, file);
      const before = fs.readFileSync(target, 'utf8');
      const after = edit(before);
      if (after === before) throw new Error(`The edit to ${file} changed nothing; update the self-test that makes it`);
      fs.writeFileSync(target, after);
    }
    await withFreshProfile({ playwright, headless }, testInfo, body, { dist });
  } finally {
    fs.rmSync(dist, { recursive: true, force: true });
  }
}

// ─── Saving ───

/**
 * Run `action`, an edit to the open note, then wait for #save-status to show "Saving..."
 * and then "Saved". It reads "Saved" before the edit too, so every change is recorded
 * rather than the text read once.
 */
async function edit(page, action) {
  await page.evaluate(() => {
    const status = document.getElementById('save-status');
    const shown = [];
    const observer = new MutationObserver(() => shown.push(status.textContent));
    observer.observe(status, { childList: true, characterData: true, subtree: true });
    window.__ntnSaveStatus = { shown, observer };
  });
  await action();
  try {
    await page.waitForFunction(() => {
      const { shown, observer } = window.__ntnSaveStatus;
      const saving = shown.indexOf('Saving...');
      const saved = saving !== -1 && shown.indexOf('Saved', saving) !== -1
        && document.getElementById('save-status').textContent === 'Saved';
      if (saved) observer.disconnect();
      return saved;
    }, null, { polling: 100, timeout: SETTLE_TIMEOUT_MS });
  } catch {
    const shown = await page.evaluate(() => window.__ntnSaveStatus.shown).catch(() => []);
    throw new Error(`#save-status didn't go "Saving..." then "Saved" after the edit; it showed ${JSON.stringify(shown)}`);
  }
}

// ─── Notes ───

/**
 * The note TabController last opened. It caches the ID in chrome.storage.local after it
 * saves the open tabs, so a matching value also means the switch was saved.
 */
function lastOpenedNoteId(page) {
  return page.evaluate(async () => (await chrome.storage.local.get('lastOpenedNoteId')).lastOpenedNoteId || null);
}

/**
 * Title the open note, which has to be new and empty, then type `lines` into it, one
 * block each
 */
async function writeNote(page, { title, lines }) {
  await edit(page, () => page.locator('#page-title').fill(title));
  await edit(page, async () => {
    await page.locator('#blocks-container .block-content').first().click();
    for (const [index, line] of lines.entries()) {
      if (index > 0) await page.keyboard.press('Enter');
      await page.keyboard.type(line);
    }
  });
}

/**
 * Create a note with the sidebar's New Note button and wait until the editor has settled on it
 */
async function createNote(page) {
  const before = await lastOpenedNoteId(page);
  await page.getByRole('button', { name: 'Create New Note' }).click();
  // TabController.openNewTab records the new note as last opened, then focuses its title
  await expect.poll(() => lastOpenedNoteId(page), { timeout: SETTLE_TIMEOUT_MS }).not.toBe(before);
  await afterEditorFocus(page);
}

/**
 * Show the sidebar's Notes list. At 1.4.x a start that restores no saved tab leaves the
 * list empty until something refreshes it, as choosing Notes does.
 */
async function showNotes(page) {
  await page.locator('#sidebar-tab-notes').click();
}

/**
 * The names the sidebar lists, top to bottom
 */
function listedNoteNames(page) {
  return page.locator('#sidebar-notes-list .sidebar-note-item .sidebar-note-name').allTextContents();
}

/**
 * Open the note the sidebar lists as `name` and wait until the editor has settled on it
 */
async function openNote(page, name) {
  await showNotes(page);
  const item = page.locator('#sidebar-notes-list .sidebar-note-item').filter({ has: page.getByText(name, { exact: true }) });
  await expect(item, `the sidebar lists one note named "${name}"`).toHaveCount(1);
  const id = await item.getAttribute('data-id');
  const [activeTab] = await page.locator('#note-tabs .note-tab.active .note-tab-name').allTextContents();
  if (activeTab === name && await lastOpenedNoteId(page) === id) return;
  await item.click();
  await expect.poll(() => lastOpenedNoteId(page), { timeout: SETTLE_TIMEOUT_MS }).toBe(id);
  await afterEditorFocus(page);
}

/**
 * The open note's title
 */
function noteTitle(page) {
  return page.locator('#page-title').textContent();
}

/**
 * The open note's blocks in order, as a user sees them: { type, text } for a text-like
 * block (and `checked` for a to-do), { type, title, url } for a bookmark, { type, src } for
 * an image
 */
function blocks(page) {
  return page.locator('#blocks-container > .block').evaluateAll(elements => elements.map(element => {
    const type = element.dataset.type;
    if (type === 'bookmark') {
      const card = element.querySelector('.bookmark-card');
      const title = card && card.querySelector('.bookmark-title');
      return { type, title: title ? title.textContent : null, url: card ? card.getAttribute('href') : null };
    }
    if (type === 'image') {
      // The editor moves data-src to src once the image scrolls into view
      const image = element.querySelector('.image-block-wrapper img');
      return { type, src: image ? image.getAttribute('src') || image.dataset.src || null : null };
    }
    const content = element.querySelector('.block-content');
    const block = { type, text: content ? content.textContent : '' };
    if (type === 'todo') block.checked = element.classList.contains('checked');
    return block;
  }));
}

/**
 * Type `query` into the sidebar's search box
 */
async function searchNotes(page, query) {
  await page.getByPlaceholder('Search notes...').fill(query);
}

// ─── Daily note ───

/**
 * Open today's Daily Note with the sidebar's button and wait until the editor has settled on it
 */
async function openTodaysDailyNote(page) {
  await page.getByRole('button', { name: "Today's Daily Note" }).click();
  // The sidebar marks the open note once the editor has loaded it
  const open = page.locator('#sidebar-notes-list .sidebar-note-item.active');
  await expect(open.locator('.sidebar-note-name')).toHaveText(/^Daily Note - /);
  const id = await open.getAttribute('data-id');
  await expect.poll(() => lastOpenedNoteId(page), { timeout: SETTLE_TIMEOUT_MS }).toBe(id);
  await afterEditorFocus(page);
}

/**
 * Today's Daily Note title as en-US prints it in the browser's time zone, UTC
 */
function todaysDailyNoteTitle(date = new Date()) {
  return `Daily Note - ${date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' })}`;
}

// ─── Service worker ───

/**
 * The global name of background.js's captureToDailyNote. The build minifies background.js
 * with its top-level names renamed (terser picks up `module: true` from js/main.js through
 * the options object scripts/build.js shares), so at 1.4.x it is the one global function
 * that calls Storage.ensureDailyNote(). #12 slice 1 keeps it on self as captureToDailyNote.
 */
async function captureFunctionName(extension) {
  const found = await extension.worker.evaluate(() => {
    if (typeof self.captureToDailyNote === 'function') return ['captureToDailyNote'];
    return Object.getOwnPropertyNames(self).filter(key => {
      const descriptor = Object.getOwnPropertyDescriptor(self, key);
      return descriptor && typeof descriptor.value === 'function'
        && /\bStorage\.ensureDailyNote\(/.test(Function.prototype.toString.call(descriptor.value));
    });
  });
  if (found.length !== 1) {
    throw new Error(`Expected one capture function in the service worker, found ${found.length > 0 ? found.join(', ') : 'none'}; `
      + 'update captureFunctionName in e2e/characterization/driver.js');
  }
  return found[0];
}

/**
 * Resolve once a write through the worker's Storage global can't be lost. At 1.4.x the
 * startup Storage.init() ends by deleting blocks whose note it hadn't read yet, so a block
 * written while it runs can vanish. Since #33 that check only reads, and Storage.openState
 * turns 'open' once the database is open, which is enough.
 *
 * A 1.4.x worker has no openState, so this waits for the startup promise itself.
 * background.js keeps it in a top-level binding that captureToDailyNote awaits first, and
 * the minifier renames it, so the name comes from that function's source. A module worker
 * (#12) keeps its top-level bindings out of the global scope, so without openState this
 * fails asking for an update instead of guessing.
 */
async function workerStorageSettled(extension) {
  if (await extension.worker.evaluate(() => Boolean(self.Storage) && 'openState' in self.Storage)) {
    await expect.poll(() => extension.worker.evaluate(() => self.Storage.openState), { timeout: SETTLE_TIMEOUT_MS }).not.toBe('closed');
    const state = await extension.worker.evaluate(() => self.Storage.openState);
    if (state !== 'open') throw new Error(`The service worker's Storage didn't open its database (openState: ${state})`);
    return;
  }
  const capture = await captureFunctionName(extension);
  const binding = await extension.worker.evaluate(name => {
    const awaited = /\bawait\s+([A-Za-z_$][\w$]*)\s*[;,)]/.exec(Function.prototype.toString.call(self[name]));
    return awaited ? awaited[1] : null;
  }, capture);
  // An expression evaluates in the worker's global scope, which holds a classic script's
  // top-level bindings and none of a module's
  if (!binding || await extension.worker.evaluate(`typeof ${binding}`) !== 'object') {
    throw new Error("Couldn't reach the storage promise captureToDailyNote awaits (a module worker's bindings aren't global); "
      + 'update workerStorageSettled in e2e/characterization/driver.js');
  }
  await extension.worker.evaluate(binding);
}

/**
 * Write `notes` ([{ name, blocks: [element fields] }]) through the worker's Storage global,
 * blocks in order. Run it before the first new tab opens, so the app starts on these notes.
 */
async function seedNotes(extension, notes) {
  await workerStorageSettled(extension);
  await extension.worker.evaluate(async notes => {
    for (const { name, blocks } of notes) {
      const note = await self.Storage.createNote(name);
      for (const [order, block] of blocks.entries()) {
        await self.Storage.saveElement({ id: self.Utils.generateId(), canvasId: note.id, order, ...block });
      }
    }
  }, notes);
}

/**
 * Call background.js's captureToDailyNote(item) in the service worker
 */
async function captureToDailyNote(extension, item) {
  const name = await captureFunctionName(extension);
  await extension.worker.evaluate(([name, item]) => self[name](item), [name, item]);
}

/**
 * Capture `text` selected on the page at `source` to today's Daily Note, as the selection
 * menu does
 */
async function captureText(extension, { text, source }) {
  await captureToDailyNote(extension, { type: 'text', content: text, source });
}

/**
 * Capture the page at `url`, titled `title`, to today's Daily Note as a bookmark, as the
 * page menu and command do
 */
async function captureBookmark(extension, { url, title }) {
  await captureToDailyNote(extension, { type: 'bookmark', url, title });
}

// ─── Settings ───

/**
 * Open Settings at `category`, as its navigation names it
 */
async function openSettings(page, category) {
  await page.locator('#settings-btn').click();
  const settings = page.getByRole('dialog', { name: 'Settings' });
  await expect(settings).toBeVisible();
  await settings.getByRole('navigation', { name: 'Settings categories' }).getByRole('button', { name: category }).click();
  return settings;
}

/**
 * Pick `theme` (light, dark, or system) in Settings > Appearance
 */
async function setTheme(page, theme) {
  const settings = await openSettings(page, 'Appearance');
  await settings.locator('#theme-select').selectOption(theme);
}

/**
 * The theme the page shows: 'light' or 'dark', from the theme engine's <html data-theme>
 */
function theme(page) {
  return page.evaluate(() => document.documentElement.getAttribute('data-theme'));
}

/**
 * Save the Settings > Data & Backup > Export JSON download as `file`
 */
async function exportJson(page, file) {
  const settings = await openSettings(page, 'Data & Backup');
  const download = page.waitForEvent('download');
  await settings.getByRole('button', { name: 'Export JSON' }).click();
  await (await download).saveAs(file);
}

/**
 * Record the text and kind of every toast the page shows from now on in window.__ntnToasts.
 * A toast is gone a few seconds after it appears, so it's recorded as it's added.
 */
async function recordToasts(page) {
  await page.evaluate(() => {
    const toasts = [];
    new MutationObserver(records => {
      for (const record of records) {
        for (const node of record.addedNodes) {
          if (node.nodeType === Node.ELEMENT_NODE && node.classList.contains('toast')) {
            toasts.push({ text: node.textContent, success: node.classList.contains('success') });
          }
        }
      }
    }).observe(document.body, { childList: true, subtree: true });
    window.__ntnToasts = toasts;
  });
}

/**
 * Restore `file` with Settings > Data & Backup > Import / Restore, replacing every note,
 * and wait for the import to finish
 */
async function importBackup(page, file) {
  await recordToasts(page);
  const settings = await openSettings(page, 'Data & Backup');
  const chooser = page.waitForEvent('filechooser');
  await settings.getByRole('button', { name: 'Import / Restore' }).click();
  await (await chooser).setFiles(file);

  const prompt = page.getByRole('dialog', { name: /^(Import Data|Import backup)$/ });
  await expect(prompt).toBeVisible();
  if (await prompt.getAttribute('aria-label') === 'Import Data') {
    // 1.4.0 asks "Merge with existing data?": Confirm merges, Cancel replaces all
    await prompt.getByRole('button', { name: 'Cancel' }).click();
  } else {
    // #33 offers Merge, Replace all, and Cancel, then confirms Replace all
    await prompt.getByRole('button', { name: 'Replace all' }).click();
    await page.getByRole('dialog', { name: 'Replace all notes?' }).getByRole('button', { name: 'Replace all' }).click();
  }
  // The success toast comes once every record is written: "Import complete" at 1.4.0,
  // "Imported 3 notes and 7 blocks." after #33. A failure's toast shows in the timeout.
  await expect.poll(() => page.evaluate(() => window.__ntnToasts), { timeout: SETTLE_TIMEOUT_MS })
    .toContainEqual(expect.objectContaining({ text: expect.stringMatching(/^(Import complete|Imported )/), success: true }));
}

// ─── Popup ───

/**
 * Open popup.html and wait until it has listed the recent notes, which is when it starts
 * listening to the quick note input
 */
async function openPopup(extension) {
  const popup = await extension.openSurface('popup');
  await expect(popup.locator('#page-list')).not.toHaveText('Loading...');
  return popup;
}

/**
 * Type `text` into the popup's quick note input and press Enter
 */
async function addQuickNote(popup, text) {
  const input = popup.getByRole('textbox', { name: 'Quick note input' });
  await input.fill(text);
  await input.press('Enter');
}

/**
 * The names in the popup's recent list, newest first
 */
function recentNoteNames(popup) {
  return popup.locator('#page-list .page-item .name').allTextContents();
}

module.exports = {
  openNewTab,
  reload,
  markPage,
  wasReloaded,
  withFreshProfile,
  withEditedBuild,
  writeNote,
  createNote,
  showNotes,
  listedNoteNames,
  openNote,
  noteTitle,
  blocks,
  searchNotes,
  openTodaysDailyNote,
  todaysDailyNoteTitle,
  seedNotes,
  captureText,
  captureBookmark,
  setTheme,
  theme,
  exportJson,
  importBackup,
  openPopup,
  addQuickNote,
  recentNoteNames,
};
