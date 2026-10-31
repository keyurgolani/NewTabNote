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
const { expect, launchExtension, resolveDist, builtFiles } = require('../harness');

// BlockEditor.loadNote (js/editor.js) focuses the note's first block this long after it renders
const EDITOR_FOCUS_DELAY_MS = 50;
const SETTLE_TIMEOUT_MS = 10_000;

// ─── Startup ───

const trackedContexts = new WeakSet();

/**
 * Note in window.__ntnNoticeAtFirstBlock whether the export notice took up space when the
 * note's first block went on the page. Runs in every page before the page's own scripts.
 */
function recordFirstBlock() {
  const observer = new MutationObserver(() => {
    if (!document.querySelector('#blocks-container .block')) return;
    observer.disconnect();
    const notice = document.getElementById('export-notice');
    window.__ntnNoticeAtFirstBlock = Boolean(notice) && notice.getBoundingClientRect().height > 0;
  });
  observer.observe(document, { childList: true, subtree: true });
}

/**
 * Have every page of the session record its startup: the harness keeps each new tab's
 * App.init() promise as window.__ntnAppInit in every page (e2e/harness/app-hook.js), and this
 * adds recordFirstBlock. openNewTab does this; call it first when a spec opens the new tab
 * some other way.
 */
async function trackStartup(extension) {
  if (trackedContexts.has(extension.context)) return;
  trackedContexts.add(extension.context);
  await extension.context.addInitScript(recordFirstBlock);
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
 * note's first block shortly after, so nothing may type before both have. App.init()
 * catches its own errors and shows them, or the storage guard, in place of the app, so
 * either fails here too.
 */
async function waitForApp(page) {
  await page.waitForFunction(() => window.__ntnAppInit !== undefined, null, { polling: 50, timeout: SETTLE_TIMEOUT_MS })
    .catch(() => {
      throw new Error('The new tab never started its app (no App.init call). Open new tabs with driver.openNewTab.');
    });
  const outcome = await page.evaluate(() => window.__ntnAppInit);
  if (outcome !== 'done') throw new Error(`The new tab's App.init() ${outcome}`);
  const shown = await page.evaluate(() => {
    const guard = document.querySelector('.storage-guard');
    if (guard) return `shows the storage guard: ${guard.textContent.trim()}`;
    const failed = Array.from(document.querySelectorAll('#app h2')).find(heading => heading.textContent === 'Failed to initialize');
    return failed ? `failed to start: ${failed.parentElement.textContent.trim()}` : null;
  });
  if (shown) throw new Error(`The new tab ${shown}`);
  await expect(page.locator('#note-tabs .note-tab.active'), 'the new tab opened a note').toBeVisible();
  await afterEditorFocus(page);
}

/**
 * Open a new tab (newtab.html) and wait until its app has started, or with `wait: false`
 * return as soon as it loads, for a start that waits on the user (onboarding); call
 * waitForApp once it can finish
 */
async function openNewTab(extension, { wait = true } = {}) {
  await trackStartup(extension);
  const page = await extension.openSurface('newtab');
  if (wait) await waitForApp(page);
  return page;
}

/**
 * On a first run (a new tab opened with `wait: false`), skip the onboarding walkthrough,
 * open the sample note it offers, and wait until the app has started
 */
async function skipOnboarding(page) {
  const walkthrough = page.getByRole('dialog', { name: 'Onboarding walkthrough' });
  await expect(walkthrough).toBeVisible();
  await walkthrough.getByRole('button', { name: 'Skip' }).click();
  // Onboarding ends with the quick-start choice, and App.init returns after it
  await page.getByRole('dialog', { name: 'Quick start' }).getByRole('button', { name: /Open the sample note/ }).click();
  await waitForApp(page);
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
 * Run `body` with a session on a copy of the build edited by `edits`, which maps each file of
 * the sources to a function from its text to the text to write: a module the bundler folded
 * into chunks in each chunk that holds it (dist-report/modules.json). For the self-tests that
 * check a spec fails when the build does the wrong thing. An edit that changes nothing in a
 * file throws, so a build that no longer has the code a self-test edits fails it instead of
 * passing it.
 */
async function withEditedBuild({ playwright, headless }, testInfo, edits, body) {
  const dist = fs.mkdtempSync(path.join(os.tmpdir(), 'ntn-e2e-edited-'));
  try {
    fs.cpSync(resolveDist(), dist, { recursive: true });
    for (const [file, edit] of Object.entries(edits)) {
      const holders = builtFiles(resolveDist(), file);
      if (holders.length === 0) throw new Error(`The build holds no ${file}; update the self-test that edits it`);
      for (const built of holders) {
        const target = path.join(dist, built);
        const before = fs.readFileSync(target, 'utf8');
        const after = edit(before);
        if (after === before) throw new Error(`The edit to ${file} changed nothing in ${built}; update the self-test that makes it`);
        fs.writeFileSync(target, after);
      }
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
 * list empty until something refreshes it, as choosing Notes does. #12 lists them on such a
 * start (e2e/sidebar-start.spec.js). Choosing Notes still reads and draws the list again,
 * and what it shows stays the same.
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
 * The open note's blocks' content as stored, once the editor has written what it has
 * pending, in order
 */
function savedBlocks(page) {
  return page.evaluate(async () => {
    await app.editor.flushSave();
    const elements = await Storage.getElementsByNote(app.editor.noteId);
    return elements.sort((a, b) => a.order - b.order).map(element => element.content);
  });
}

/**
 * Right-click the sidebar's note named `name` and wait for its menu
 */
async function openNoteMenu(page, name) {
  await showNotes(page);
  await page.locator('#sidebar-notes-list .sidebar-note-item')
    .filter({ has: page.getByText(name, { exact: true }) })
    .click({ button: 'right' });
  await expect(page.getByRole('menu', { name: 'Note actions' })).toBeVisible();
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
 * In an extension page: open #13's port, say hello as `surface`, and resolve once the worker
 * answers, closes the port, or 5 s pass. A worker with no router (1.4.x) closes it.
 */
function helloOnPort(surface) {
  return new Promise(resolve => {
    const port = chrome.runtime.connect({ name: 'ntn-rpc' });
    let finished = false;
    const done = () => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      port.disconnect();
      resolve();
    };
    const timer = setTimeout(done, 5000);
    port.onDisconnect.addListener(() => {
      // Read, so a port no listener took isn't an unchecked runtime.lastError
      void chrome.runtime.lastError;
      done();
    });
    port.onMessage.addListener(done);
    port.postMessage(JSON.stringify({
      frame: 'hello',
      protocol: { major: 1, minor: 0 },
      extensionVersion: chrome.runtime.getManifest().version,
      surface,
      sessionId: `driver-${Date.now()}`,
    }));
  });
}

/**
 * Start the worker's background coordinator the way a page does, with a session on #13's
 * port: since #35 the worker opens its database on the first event that needs it, not when
 * it wakes, and one Chrome stopped wakes for the port. The session is the offscreen page's,
 * which reads and writes nothing, opened in a tab and closed again.
 */
async function startCoordinator(extension) {
  const page = await extension.context.newPage();
  try {
    await page.goto(extension.url('offscreen.html'));
    await page.evaluate(helloOnPort, 'offscreen');
  } finally {
    await page.close();
  }
}

/**
 * Resolve once a write through the worker's Storage global can't be lost. At 1.4.x the
 * startup Storage.init() ends by deleting blocks whose note it hadn't read yet, so a block
 * written while it runs can vanish. Since #33 that check only reads, and Storage.openState
 * turns 'open' once the database is open, which is enough. Since #35 the database opens on
 * the first event that needs it, so this starts the coordinator first (startCoordinator).
 *
 * A 1.4.x worker has no openState, so this waits for the startup promise itself.
 * background.js keeps it in a top-level binding that captureToDailyNote awaits first, and
 * the minifier renames it, so the name comes from that function's source. A module worker
 * (#12) keeps its top-level bindings out of the global scope, so without openState this
 * fails asking for an update instead of guessing.
 */
async function workerStorageSettled(extension) {
  await startCoordinator(extension);
  // Since #17 PR 1b the worker's kernel runs on #17's adapter, after its migration run, and
  // nothing in the worker opens its Storage global, so the harness opens it, as it is, once the
  // run is in (a run that upgrades later would close it)
  if (await extension.worker.evaluate(() => Boolean(self.storageUpgrade) && Boolean(self.Storage))) {
    await extension.worker.evaluate(async () => {
      await self.storageUpgrade;
      if (self.Storage.openState !== 'open') await self.Storage.openExisting();
    });
  }
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
 * Write `notes` ([{ name, blocks: [element fields], archived, isTemplate }]) through the
 * worker's Storage global, blocks in order, then archive the archived ones and make the
 * templates templates. Run it before the first new tab opens, so the app starts on these
 * notes. Each note starts in a later millisecond than the one before it was last written,
 * as when a user writes them one after another, so the last one is the newest: the app
 * lists it first and a new tab opens it. Notes that share an updatedAt sort by their
 * random IDs.
 */
async function seedNotes(extension, notes) {
  await workerStorageSettled(extension);
  await extension.worker.evaluate(async notes => {
    let lastWrite = 0;
    for (const { name, blocks = [], archived = false, isTemplate = false } of notes) {
      while (Date.now() <= lastWrite) await new Promise(resolve => setTimeout(resolve, 1));
      const note = await self.Storage.createNote(name);
      for (const [order, block] of blocks.entries()) {
        await self.Storage.saveElement({ id: self.Utils.generateId(), canvasId: note.id, order, ...block });
      }
      if (archived) await self.Storage.archiveNote(note.id);
      if (isTemplate) await self.Storage.updateNote({ ...(await self.Storage.getNote(note.id)), isTemplate: true });
      lastWrite = (await self.Storage.getNote(note.id)).updatedAt;
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
 * The theme the page shows: 'light' or 'dark', from the theme engine's <html data-theme>,
 * which the light theme leaves off
 */
function theme(page) {
  return page.evaluate(() => document.documentElement.getAttribute('data-theme') || 'light');
}

/**
 * Close Settings with Escape
 */
async function closeSettings(page) {
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog', { name: 'Settings' })).toBeHidden();
}

/**
 * Whether Settings is open
 */
function settingsOpen(page) {
  return page.getByRole('dialog', { name: 'Settings' }).isVisible();
}

/**
 * The Settings > Data & Backup hint on what exports hold. Leaves Settings open.
 */
async function exportContentsHint(page) {
  const settings = await openSettings(page, 'Data & Backup');
  return settings.locator('#export-contents-hint').textContent();
}

/**
 * Export JSON from Settings > Data & Backup, saving the download as `file` if given.
 * Returns the Download. Leaves Settings open.
 */
async function exportJson(page, file) {
  const settings = await openSettings(page, 'Data & Backup');
  const download = page.waitForEvent('download');
  await settings.getByRole('button', { name: 'Export JSON' }).click();
  const done = await download;
  if (file) await done.saveAs(file);
  return done;
}

/**
 * A JSON download's file name and parsed contents
 */
async function readJsonDownload(download) {
  return { name: download.suggestedFilename(), data: JSON.parse(fs.readFileSync(await download.path(), 'utf8')) };
}

// ─── Export notice (NTN-18 slice 0) ───

/**
 * The export notice as the new tab shows it, or null when it shows none: its role and
 * name, how its live region announces, what that announces (heading, then each
 * paragraph), and the labels of the buttons beside it
 */
async function exportNotice(page) {
  const notice = page.locator('#export-notice');
  if (!(await notice.isVisible())) return null;
  const shown = await notice.evaluate(card => {
    const label = document.getElementById(card.getAttribute('aria-labelledby') || '');
    const live = card.querySelector('[aria-live]');
    return {
      name: label ? label.textContent : null,
      live: live ? live.getAttribute('aria-live') : null,
      announces: live ? Array.from(live.children, child => child.textContent) : [],
      buttons: Array.from(card.querySelectorAll('button'), button => button.textContent),
    };
  });
  // The role as the accessibility tree has it: a section is a region only once it has a name
  const asRegion = shown.name ? page.getByRole('region', { name: shown.name, exact: true }) : null;
  const role = asRegion && await asRegion.count() === 1 ? 'region' : null;
  return { role, ...shown };
}

/**
 * The export notice's live region, which is on the page whether or not the notice shows:
 * how it announces and the text it holds
 */
function exportNoticeLiveRegion(page) {
  return page.locator('#export-notice [aria-live]').evaluate(live => ({ live: live.getAttribute('aria-live'), text: live.textContent }));
}

/**
 * The export notice's colors as the page computes them (`rgb(...)` strings): the card's
 * background, each line of text, and each button's label and background, as shown and,
 * under `hovered`, with the pointer over it
 */
async function exportNoticeColors(page) {
  const notice = page.locator('#export-notice');
  const read = () => notice.evaluate(async card => {
    // Hover changes come with a transition; read the colors it ends on
    await Promise.all(card.getAnimations({ subtree: true }).map(animation => animation.finished.catch(() => {})));
    return {
      card: getComputedStyle(card).backgroundColor,
      text: Array.from(card.querySelectorAll('.export-notice-text > *'), line => ({ text: line.textContent, color: getComputedStyle(line).color })),
      buttons: Array.from(card.querySelectorAll('button'), button => {
        const style = getComputedStyle(button);
        return { label: button.textContent, color: style.color, background: style.backgroundColor };
      }),
    };
  });
  const shown = await read();
  const hovered = [];
  for (const { label } of shown.buttons) {
    await notice.getByRole('button', { name: label, exact: true }).hover();
    hovered.push((await read()).buttons.find(button => button.label === label));
  }
  await page.mouse.move(0, 0);
  return { ...shown, hovered };
}

/**
 * The size of each of the export notice's buttons, as { label, width, height }
 */
function exportNoticeButtonSizes(page) {
  return page.locator('#export-notice button').evaluateAll(buttons => buttons.map(button => {
    const { width, height } = button.getBoundingClientRect();
    return { label: button.textContent, width, height };
  }));
}

/**
 * Click the export notice's button labeled `label`
 */
async function chooseInExportNotice(page, label) {
  // Bounded, so a notice that never shows fails the step rather than the whole test's time
  await page.locator('#export-notice').getByRole('button', { name: label, exact: true }).click({ timeout: SETTLE_TIMEOUT_MS });
}

/**
 * Click the export notice's Export JSON (or Export again) and return the Download
 */
async function exportFromNotice(page, label = 'Export JSON') {
  const download = page.waitForEvent('download');
  await chooseInExportNotice(page, label);
  return download;
}

/**
 * What the profile recorded for the export notice (setting_preMigrationNotice), the record
 * the next version reads, or null
 */
function exportNoticeRecord(page) {
  return page.evaluate(async () => (await chrome.storage.local.get('setting_preMigrationNotice')).setting_preMigrationNotice || null);
}

/**
 * Whether the export notice already took up space when the page's first note block went on
 * the page (see recordFirstBlock), so the note laid out once
 */
function noticeShownBeforeFirstBlock(page) {
  return page.evaluate(() => window.__ntnNoticeAtFirstBlock);
}

// ─── Focus ───

/**
 * Focus the header button named `name`, as a click or Tab would
 */
async function focusHeaderButton(page, name) {
  await page.locator('#header').getByRole('button', { name, exact: true }).focus();
}

/**
 * What has focus: { kind: 'title', text } for a note's title, { kind: 'block', pane, index,
 * text } for a block, { kind: 'button', text } for a button, or { kind: 'page' }
 */
function focused(page) {
  return page.evaluate(() => {
    const element = document.activeElement;
    if (!element || element === document.body) return { kind: 'page' };
    const pane = element.closest('#secondary-editor-container') ? 'right' : 'left';
    if (element.classList.contains('page-title')) return { kind: 'title', pane, text: element.textContent };
    const block = element.classList.contains('block-content') ? element.closest('.block') : null;
    if (block) {
      const index = Array.from(block.parentElement.querySelectorAll(':scope > .block')).indexOf(block);
      return { kind: 'block', pane, index, text: element.textContent };
    }
    if (element.tagName === 'BUTTON') return { kind: 'button', text: element.textContent.trim() || element.getAttribute('aria-label') };
    return { kind: element.tagName.toLowerCase(), text: element.textContent };
  });
}

// ─── Split view ───

/**
 * Turn on split view with the header's button and wait until the right pane shows a note
 */
async function openSplitView(page) {
  await page.locator('#header').getByRole('button', { name: 'Toggle Split View', exact: true }).click();
  await expect(page.locator('#secondary-editor-container .block-content').first()).toBeVisible();
  await afterEditorFocus(page);
}

/**
 * Turn split view off with the header's button and wait until the right pane is gone
 */
async function closeSplitView(page) {
  await page.locator('#header').getByRole('button', { name: 'Toggle Split View', exact: true }).click();
  await expect(page.locator('#secondary-editor-container')).toBeHidden();
}

/**
 * Click into the left pane's block at `index` and put the caret at its end
 */
async function clickBlock(page, index) {
  await page.locator('#blocks-container > .block .block-content').nth(index).click();
  await page.keyboard.press('End');
}

/**
 * The right pane's blocks in order, as blocks() reads the left pane's
 */
function rightPaneBlocks(page) {
  return page.locator('#secondary-editor-container .blocks-container > .block').evaluateAll(elements => elements.map(element => {
    const content = element.querySelector('.block-content');
    return { type: element.dataset.type, text: content ? content.textContent : '' };
  }));
}

/**
 * Click into the right pane's block at `index` and put the caret at its end
 */
async function clickRightPaneBlock(page, index) {
  await page.locator('#secondary-editor-container .blocks-container > .block .block-content').nth(index).click();
  await page.keyboard.press('End');
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
  trackStartup,
  afterEditorFocus,
  waitForApp,
  openNewTab,
  skipOnboarding,
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
  savedBlocks,
  openNoteMenu,
  searchNotes,
  openTodaysDailyNote,
  todaysDailyNoteTitle,
  seedNotes,
  captureText,
  captureBookmark,
  setTheme,
  theme,
  openSettings,
  closeSettings,
  settingsOpen,
  exportContentsHint,
  exportJson,
  readJsonDownload,
  exportNotice,
  exportNoticeLiveRegion,
  exportNoticeColors,
  exportNoticeButtonSizes,
  chooseInExportNotice,
  exportFromNotice,
  exportNoticeRecord,
  noticeShownBeforeFirstBlock,
  focusHeaderButton,
  focused,
  openSplitView,
  closeSplitView,
  clickBlock,
  rightPaneBlocks,
  clickRightPaneBlock,
  recordToasts,
  importBackup,
  openPopup,
  addQuickNote,
  recentNoteNames,
};
