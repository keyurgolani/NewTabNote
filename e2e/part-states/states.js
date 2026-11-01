/**
 * #27 slice 3b's states on the packaged build, as steps that bring a new tab there, for
 * e2e/part-states.spec.js, which checks each one, and for the design review's screenshots.
 *
 * A state is { build, open, reach, said }: `build` changes a copy of the build (a library's file
 * gone, one that loads and throws, another build's build-info.json, the workspace chunk gone),
 * `open` says how the tab opens, and `reach(page)` takes the open tab to the state and answers the
 * element that shows it. `said` is what its live region last said, when that isn't the state's
 * first sentence. Notes are seeded first: Alpha plan, Beta plan and Gamma.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { expect, resolveDist, chunkFile, launchExtension } = require('../harness');
const driver = require('../characterization/driver');

const NOTES = [
  { name: 'Gamma', blocks: [{ type: 'text', content: 'Notes about the garden' }] },
  { name: 'Beta plan', blocks: [{ type: 'text', content: 'Second draft of the plan' }] },
  { name: 'Alpha plan', blocks: [{ type: 'text', content: 'Pack the tent and the stove for the weekend trip' }] },
];

/** A library's file in the build, by the loader's name for it */
const LIBRARY_FILES = { chart: 'js/lib/chart.js', fuse: 'js/lib/fuse.js', jszip: 'js/lib/jszip.min.js', transformers: 'js/lib/transformers.js' };

/**
 * Run `body(dist)` on a copy of the build with `remove` taken out and `edit` applied, by path in
 * the build, then delete the copy. With nothing to change, `body` runs on the build itself.
 */
async function withBuild({ remove = [], edit = {} } = {}, body) {
  if (remove.length === 0 && Object.keys(edit).length === 0) return body(resolveDist());
  const dist = fs.mkdtempSync(path.join(os.tmpdir(), 'ntn-e2e-states-'));
  try {
    fs.cpSync(resolveDist(), dist, { recursive: true });
    for (const file of remove) {
      if (!fs.existsSync(path.join(dist, file))) throw new Error(`The build has no ${file} to take out; update the states`);
      fs.rmSync(path.join(dist, file));
    }
    for (const [file, change] of Object.entries(edit)) {
      const target = path.join(dist, file);
      const before = fs.readFileSync(target, 'utf8');
      const after = change(before);
      if (after === before) throw new Error(`The edit to ${file} changed nothing; update the states`);
      fs.writeFileSync(target, after);
    }
    return await body(dist);
  } finally {
    fs.rmSync(dist, { recursive: true, force: true });
  }
}

/** A build where a library's file is gone, as a damaged install leaves it */
const missing = (name) => ({ remove: [LIBRARY_FILES[name]] });

/** A build where a library's file loads and defines nothing: the loader answers evaluation-failed */
const threw = (name) => ({ edit: { [LIBRARY_FILES[name]]: () => '/* a file that loaded and threw */\n' } });

/** A build whose build-info.json is another build's, as a dev build written over an open tab is */
const otherBuild = () => ({ edit: { 'build-info.json': (text) => text.replace(/"buildId": "[^"]+"/, '"buildId": "another-build-on-disk"') } });

/** A build without its workspace chunk, which the boot root loads */
const noWorkspace = () => ({ remove: [chunkFile(resolveDist(), 'workspace')] });

/**
 * Launch a session on `dist`, seeded and onboarded, in `theme`, and open a new tab at `width`
 * by 900. `wait` is false for a tab that never starts the app.
 */
async function openTab({ playwright, headless }, dist, { width = 1440, theme = 'light', wait = true } = {}) {
  const extension = await launchExtension({ dist, chromium: playwright.chromium, headless });
  try {
    await extension.seedOnboarded();
    // The one-time export notice, answered, so the page shows only the state
    await extension.worker.evaluate(() => chrome.storage.local.set({ setting_preMigrationNotice: { version: 1, outcome: 'dismissed', at: Date.now() } }));
    if (wait) await driver.seedNotes(extension, NOTES);
    const page = await driver.openNewTab(extension, { wait });
    await page.setViewportSize({ width, height: 900 });
    await page.emulateMedia({ colorScheme: theme === 'dark' ? 'dark' : 'light' });
    if (wait) {
      await untilIdleWorkRan(page);
      // The product's theme, as Settings > Appearance picks it
      if (theme === 'dark') {
        await driver.setTheme(page, 'dark');
        await driver.closeSettings(page);
        await expect.poll(() => driver.theme(page)).toBe('dark');
      }
    }
    return { extension, page };
  } catch (error) {
    await extension.close();
    throw error;
  }
}

/** Wait until the start's deferred work has run: Stats bound, and the search's vectors read */
async function untilIdleWorkRan(page) {
  await expect.poll(() => page.evaluate(() => Boolean(app.graphView) && Array.isArray(app.searchEngine.vectors))).toBe(true);
}

/**
 * Hold each script the loader puts on the page for `name` back `ms` before it goes in, so the
 * library's load runs that long
 */
function slowLibrary(page, name, ms) {
  return page.evaluate(([file, delay]) => {
    const head = document.head;
    const append = head.appendChild.bind(head);
    head.appendChild = (node) => {
      if (node instanceof HTMLScriptElement && node.src.includes(file)) {
        setTimeout(() => append(node), delay);
        return node;
      }
      return append(node);
    };
  }, [LIBRARY_FILES[name], ms]);
}

/** The model's vectors for the notes, so search and Related Notes ask the model for matches */
function modelVectors(page) {
  return page.evaluate(() => {
    const vectors = app.notesManager.notes.map((note) => ({ noteId: note.id, vector: [1, 0], updatedAt: Date.now() }));
    app.searchEngine.setVectors(vectors);
  });
}

/** A provider for the Insights tab that answers at once, on the page, with nothing leaving it */
function stubProvider(page) {
  return page.evaluate(() => {
    Object.assign(LLM, {
      isConfigured: () => true,
      extractInsights: async () => ({ todos: ['Pack the tent'], reminders: [], deadlines: [], highlights: [], tags: ['camping'] }),
    });
  });
}

async function openStats(page) {
  await page.locator('#sidebar-stats').click();
  const view = page.locator('#stats-dashboard');
  await expect(view).toBeVisible();
  // The view slides up 20 px as it opens; what's on it is measured and shot once it's still
  await expect.poll(() => view.evaluate((element) => getComputedStyle(element).transform)).toMatch(/^(none|matrix\(1, 0, 0, 1, 0, 0\))$/);
}

/** Settings > Data & Backup > Export All (ZIP/MD) */
async function exportMarkdown(page) {
  const settings = await driver.openSettings(page, 'Data & Backup');
  await settings.getByRole('button', { name: 'Export All (ZIP/MD)' }).click();
  return settings;
}

/** The AI sidebar on a tab, Insights or All Notes, with the stub provider set up */
async function openAITab(page, tab) {
  await stubProvider(page);
  await page.evaluate(() => app.updateAISidebarState());
  await page.locator('#ai-floating-btn').click();
  await expect(page.locator('#ai-sidebar')).toBeVisible();
  await page.locator(tab === 'all' ? '#ai-tab-all' : '#ai-tab-smart').click();
}

/** A part's panel, by its place */
const PLACES = {
  charts: '.charts-grid > .part-state',
  search: '#sidebar-notes-list > .part-state:first-child',
  model: '#sidebar-notes-list > .part-state:last-child',
  export: '.settings-section > .part-state',
  related: '#ai-related-notes > .part-state',
  allNotes: '#global-chat-messages > .part-state',
};

/** Press the part's Try again, and wait for its line to read `words` */
async function tryAgain(page, place, words) {
  const panel = page.locator(PLACES[place]);
  await panel.getByRole('button', { name: 'Try again' }).click();
  await expect(panel.locator('.part-state-text')).toContainText(words);
  return panel;
}

/**
 * A save that fails, its retry included, for the open editors: each gets a copy of the page's
 * document client (which is frozen) whose saveContent answers unavailable, as a full disk does
 * (`quota`), or as a page whose connection to the notes database is gone does
 * (`reload-required`), which the editor's own notice explains
 */
function failingSaves(page, code = 'quota') {
  return page.evaluate((answer) => {
    for (const editor of app.tabController.getOpenEditors()) {
      editor.documentClient = Object.freeze({
        ...editor.documentClient,
        saveContent: () => Promise.resolve({ kind: 'unavailable', cause: answer, code: answer, retryable: false }),
        // A connection that's gone was gone before the save, or the editor counts the save stored
        ...(answer === 'reload-required' ? { connectionOpen: () => false } : {}),
      });
    }
  }, code);
}

/** A locator's box on the page: where it's drawn, whatever the page's scroll */
function boxOf(locator) {
  return locator.evaluate((element) => {
    const box = element.getBoundingClientRect();
    return { x: box.x + window.scrollX, y: box.y + window.scrollY, width: box.width, height: box.height };
  });
}

/** Within a pixel, as layout rounds */
const NEAR = 1;

/** Whether box `outer` holds all of box `inner`, so a pointer anywhere on `inner` is on `outer` */
const holds = (outer, inner) => outer.x <= inner.x + NEAR && outer.y <= inner.y + NEAR
  && outer.x + outer.width >= inner.x + inner.width - NEAR && outer.y + outer.height >= inner.y + inner.height - NEAR;

/** Whether two boxes share more than a pixel */
const overlaps = (a, b) => a.x < b.x + b.width - NEAR && b.x < a.x + a.width - NEAR && a.y < b.y + b.height - NEAR && b.y < a.y + a.height - NEAR;

/** Whether two boxes are the same, within a pixel */
const same = (a, b) => ['x', 'y', 'width', 'height'].every((key) => Math.abs(a[key] - b[key]) <= NEAR);

/** Put a library's file back where the session loaded the extension from, as a repaired install does */
function restoreLibrary(extension, name) {
  const file = LIBRARY_FILES[name];
  fs.copyFileSync(path.join(resolveDist(), file), path.join(extension.extensionDir, file));
}

/**
 * Type at the end of the open note's first block, so a save is due: the caret goes to the end of
 * its text wherever the click lands, as at 800, where the block wraps and End would stop mid-text
 */
async function typeLine(page, text) {
  const block = page.locator('#editor-container .block-content').first();
  const before = await block.textContent();
  await block.click();
  await block.evaluate((element) => {
    const range = document.createRange();
    range.selectNodeContents(element);
    range.collapse(false);
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
  });
  await page.keyboard.type(text);
  await expect(block).toHaveText(`${before}${text}`);
}

/** Press the part's Reload, and wait for the failed save in its place */
async function pressReload(panel, words = "Failed to save your changes, so the page didn't reload.") {
  const reload = panel.locator('button.part-state-reload');
  await expect(reload).toBeVisible();
  const pressed = await boxOf(reload);
  await reload.click();
  await expect(panel).toContainText(words, { timeout: 15_000 });
  expect(holds(await boxOf(panel.locator('button.part-state-try')), pressed), 'Try again takes the place of the Reload pressed').toBe(true);
  expect(overlaps(await boxOf(panel.locator('button.part-state-anyway')), pressed), 'Reload anyway lands clear of it').toBe(false);
  return panel;
}

/**
 * u5: the charts' Reload, whose save guard failed, with the failed save in Reload's place. Try
 * again lands where the Reload pressed was, and Reload anyway lands clear of it.
 */
async function saveFailed(page) {
  await failingSaves(page);
  await typeLine(page, ' and a line never stored');
  await openStats(page);
  return pressReload(page.locator(PLACES.charts));
}

/** u5 reached from the second failure's Reload, the one beside Try again */
async function saveFailedFromAgain(page) {
  await failingSaves(page);
  await typeLine(page, ' and a line never stored');
  await openStats(page);
  const panel = await tryAgain(page, 'charts', 'Failed to load the charts again.');
  return pressReload(panel);
}

/**
 * The states, each at a width and theme: { name, about, build, open, reach }. `reach` answers the
 * locator that shows the state.
 */
const STATES = [
  {
    name: 'b1-boot-failed', about: "the workspace chunk is gone: NewTabNote couldn't start, with Reload", build: noWorkspace, open: { wait: false },
    reach: async (page) => {
      const failure = page.locator('#ntn-boot-failure');
      await expect(failure.getByRole('alert')).toContainText("NewTabNote couldn't start.");
      return failure;
    },
  },
  {
    name: 'c1-charts-failed', about: "Chart.js's file is gone: one failure where the four charts go, with Try again", build: () => missing('chart'),
    reach: async (page) => {
      await openStats(page);
      const panel = page.locator(PLACES.charts);
      await expect(panel).toContainText('Failed to load the charts. Please try again.');
      return panel;
    },
  },
  {
    name: 'c3-charts-loading', about: 'Chart.js loads past 400 ms: "Loading charts…" as a line where the charts go', build: () => ({}),
    reach: async (page) => {
      await slowLibrary(page, 'chart', 60_000);
      await openStats(page);
      const line = page.locator(PLACES.charts);
      await expect(line).toContainText('Loading charts…');
      return line;
    },
  },
  {
    name: 'c5-charts-failed-again', about: 'Try again failed too: the second failure, with Reload beside Try again', build: () => missing('chart'),
    reach: async (page) => {
      await openStats(page);
      return tryAgain(page, 'charts', 'Failed to load the charts again.');
    },
  },
  {
    name: 'c7-charts-threw', about: 'Chart.js loaded and threw: its words over the reload line, with Reload alone', build: () => threw('chart'),
    reach: async (page) => {
      await openStats(page);
      const panel = page.locator(PLACES.charts);
      await expect(panel).toContainText('Failed to load the charts.');
      await expect(panel.getByRole('button', { name: 'Reload' })).toBeVisible();
      return panel;
    },
  },
  {
    name: 'c8-charts-other-build', about: "another build's build-info.json: as a file that threw, Reload alone", build: otherBuild,
    reach: async (page) => {
      await openStats(page);
      const panel = page.locator(PLACES.charts);
      await expect(panel).toContainText('Failed to load the charts.');
      return panel;
    },
  },
  {
    name: 's1-search-failed', about: "Fuse.js's file is gone: the failure first in the list, where \"No matching notes\" would be", build: () => missing('fuse'),
    reach: async (page) => {
      await driver.searchNotes(page, 'plan');
      const panel = page.locator(PLACES.search);
      await expect(panel).toContainText('Failed to load search. Please try again.');
      return panel;
    },
  },
  {
    name: 's4-search-failed-again', about: 'Try again failed too: the second failure, with Reload', build: () => missing('fuse'),
    reach: async (page) => {
      await driver.searchNotes(page, 'plan');
      await expect(page.locator(PLACES.search)).toContainText('Failed to load search. Please try again.');
      return tryAgain(page, 'search', 'Failed to load search again.');
    },
  },
  {
    name: 's6-search-threw', about: 'Fuse.js loaded and threw: Reload alone', build: () => threw('fuse'),
    reach: async (page) => {
      await driver.searchNotes(page, 'plan');
      const panel = page.locator(PLACES.search);
      await expect(panel).toContainText('Failed to load search.');
      await expect(panel.getByRole('button', { name: 'Reload' })).toBeVisible();
      return panel;
    },
  },
  {
    name: 'e1-export-failed', about: "JSZip's file is gone: a row of its section, with Try again", build: () => missing('jszip'),
    reach: async (page) => {
      await exportMarkdown(page);
      const row = page.locator(PLACES.export);
      await expect(row).toContainText('Failed to export your notes as Markdown. Please try again.');
      return row;
    },
  },
  {
    name: 'e4-export-failed-again', about: 'Try again failed too: Export JSON still works, with Reload', build: () => missing('jszip'),
    reach: async (page) => {
      await exportMarkdown(page);
      await expect(page.locator(PLACES.export)).toContainText('Please try again.');
      return tryAgain(page, 'export', 'Failed to export your notes as Markdown again. Export JSON still works.');
    },
  },
  {
    name: 'e6-export-threw', about: 'JSZip loaded and threw: Export JSON still works, Reload alone', build: () => threw('jszip'),
    reach: async (page) => {
      await exportMarkdown(page);
      const row = page.locator(PLACES.export);
      await expect(row).toContainText('Failed to export your notes as Markdown. Export JSON still works.');
      return row;
    },
  },
  {
    name: 'm1-semantic-failed', about: "transformers.js's file is gone: the model's failure under the keyword matches", build: () => missing('transformers'),
    reach: async (page) => {
      await modelVectors(page);
      await driver.searchNotes(page, 'plan');
      const panel = page.locator(PLACES.model);
      await expect(panel).toContainText('Failed to load semantic search. Please try again.');
      return panel;
    },
  },
  {
    name: 'm3-semantic-failed-again', about: "the model's Try again failed too", build: () => missing('transformers'),
    reach: async (page) => {
      await modelVectors(page);
      await driver.searchNotes(page, 'plan');
      await expect(page.locator(PLACES.model)).toContainText('Please try again.');
      return tryAgain(page, 'model', 'Failed to load semantic search again.');
    },
  },
  {
    name: 'm4-related-failed', about: "the model's failure in Related Notes, on the Insights tab", build: () => missing('transformers'),
    reach: async (page) => {
      await stubProvider(page);
      await modelVectors(page);
      await openAITab(page, 'smart');
      const panel = page.locator(PLACES.related);
      await expect(panel).toContainText('Failed to load semantic search. Please try again.');
      return panel;
    },
  },
  {
    name: 'a1-all-notes-failed', about: "Fuse.js's file is gone: the AI chat's All Notes says so where its answer would go", build: () => missing('fuse'),
    reach: async (page) => {
      await openAITab(page, 'all');
      await page.locator('#global-chat-input').fill('What did I plan?');
      await page.locator('#global-chat-input').press('Enter');
      const panel = page.locator(PLACES.allNotes);
      await expect(panel).toContainText('Failed to load search. Please try again.');
      return panel;
    },
  },
  {
    name: 'u5-save-failed', about: "Reload's save guard failed: the failed save in Reload's place, with Try again and Reload anyway", build: () => threw('chart'),
    reach: saveFailed,
  },
  {
    name: 'u5-trying-again', about: "u5's Try again while the guards run: Saving… at Try again's width, held with focus, over \"Saving your changes before reloading.\"", build: () => threw('chart'),
    said: 'Saving your changes before reloading.',
    reach: async (page) => {
      const panel = await saveFailed(page);
      // This time the guard never answers, so the state stays for its 10 s
      await page.evaluate(() => { app.tabController.saveOpenEditors = () => new Promise(() => {}); });
      const tryAgainButton = panel.locator('button.part-state-try');
      const before = await boxOf(tryAgainButton);
      await tryAgainButton.click();
      await expect(tryAgainButton).toHaveAttribute('aria-disabled', 'true');
      await expect(tryAgainButton).toHaveAccessibleName('Saving…');
      await expect(tryAgainButton).toBeFocused();
      await expect(panel.locator('.part-state-note')).toHaveText('Saving your changes before reloading.');
      expect(same(await boxOf(tryAgainButton), before), 'Try again keeps its place and width as it reads Saving…').toBe(true);
      return panel;
    },
  },
  {
    name: 'u5-notice', about: "a part's Reload, from the keyboard, whose failed save the editor's own notice explains: its words take focus, and the row stays as it was", build: () => threw('fuse'),
    // The row said the guards were saving, then the notice speaks for the failure
    said: 'Saving your changes before reloading.',
    reach: async (page) => {
      await driver.searchNotes(page, 'plan');
      const panel = page.locator(PLACES.search);
      await expect(panel).toContainText('Failed to load search.');
      // The page's connection to the notes database is gone, which the editor's notice says
      await failingSaves(page, 'reload-required');
      await typeLine(page, ' and a line never stored');
      const notice = page.locator('.reload-notice');
      await expect(notice).toBeVisible();
      // From the keyboard, so the focus ring shows where the handover puts focus: on the notice's
      // words, which a second Enter can't reload from, not on its unguarded Reload
      await panel.locator('button.part-state-reload').focus();
      await page.keyboard.press('Enter');
      const words = notice.locator('.note-gone-text');
      await expect(words).toBeFocused({ timeout: 15_000 });
      await expect(words).toHaveAttribute('tabindex', '-1');
      await driver.markPage(page);
      await page.keyboard.press('Enter');
      expect(await driver.wasReloaded(page)).toBe(false);
      await expect(words).toBeFocused();
      await expect(panel).toContainText('Failed to load search.');
      return panel;
    },
  },
  {
    name: 'u5-from-again', about: "u5 from the second failure's Reload, beside Try again: Try again in that Reload's place, its own place kept empty, and Reload anyway on a line of its own under them", build: () => missing('chart'),
    reach: saveFailedFromAgain,
  },
  {
    name: 'u5-from-again-failed-again', about: "the same after its Try again failed too, in the save's words for a second failure", build: () => missing('chart'),
    reach: async (page) => {
      const panel = await saveFailedFromAgain(page);
      await panel.locator('button.part-state-try').click();
      await expect(panel).toContainText("Failed to save your changes again, so the page didn't reload.", { timeout: 15_000 });
      return panel;
    },
  },
  {
    name: 'm5-related-first-download', about: "the model's first download in Related Notes: its status line says the model downloads the first time", build: () => ({}),
    said: 'The model downloads the first time, which can take a minute.',
    reach: async (page) => {
      // The model's files take their time coming from the network, which is never reached here
      await page.route(/^https:\/\/huggingface\.co\//, () => {});
      await stubProvider(page);
      await modelVectors(page);
      await openAITab(page, 'smart');
      const line = page.locator(PLACES.related);
      await expect(line).toContainText('Loading semantic search…');
      await expect(line).toContainText('The model downloads the first time, which can take a minute.', { timeout: 15_000 });
      return line;
    },
  },
];

module.exports = {
  NOTES, LIBRARY_FILES, PLACES, STATES, withBuild, missing, threw, otherBuild, noWorkspace, openTab, untilIdleWorkRan, slowLibrary,
  modelVectors, stubProvider, openStats, exportMarkdown, openAITab, tryAgain, failingSaves, restoreLibrary, typeLine, boxOf, holds, overlaps, same,
};
