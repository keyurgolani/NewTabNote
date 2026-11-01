/**
 * #27 slice 3b's states on the packaged build, as steps that bring a new tab there, for
 * e2e/part-states.spec.js, which checks each one, and for the design review's screenshots.
 *
 * A state is { build, open, reach }: `build` changes a copy of the build (a library's file gone,
 * one that loads and throws, another build's build-info.json, the workspace chunk gone), `open`
 * says how the tab opens, and `reach(page)` takes the open tab to the state and answers the
 * element that shows it. Notes are seeded first: Alpha plan, Beta plan and Gamma.
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
  await expect(page.locator('#stats-dashboard')).toBeVisible();
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
 * A save that fails, its retry included, as a full disk answers it, for the open editors: each
 * gets the page's document client with saveContent answering unavailable
 */
function failingSaves(page) {
  return page.evaluate(() => {
    for (const editor of app.tabController.getOpenEditors()) {
      const client = editor.documentClient;
      const unavailable = () => Promise.resolve({ kind: 'unavailable', cause: 'quota', code: 'quota', retryable: false });
      editor.documentClient = new Proxy(client, { get: (target, key) => (key === 'saveContent' ? unavailable : target[key]) });
    }
  });
}

/** Put a library's file back where the session loaded the extension from, as a repaired install does */
function restoreLibrary(extension, name) {
  const file = LIBRARY_FILES[name];
  fs.copyFileSync(path.join(resolveDist(), file), path.join(extension.extensionDir, file));
}

/** Type into the open note, so a save is due */
async function typeLine(page, text) {
  await page.locator('#editor-container .block-content').first().click();
  await page.keyboard.press('End');
  await page.keyboard.type(text);
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
    reach: async (page) => {
      await failingSaves(page);
      await typeLine(page, ' and a line never stored');
      await openStats(page);
      const panel = page.locator(PLACES.charts);
      await panel.locator('button.part-state-swap').click();
      await expect(panel).toContainText("Failed to save your changes, so the page didn't reload.", { timeout: 15_000 });
      return panel;
    },
  },
];

module.exports = {
  NOTES, LIBRARY_FILES, PLACES, STATES, withBuild, missing, threw, otherBuild, noWorkspace, openTab, untilIdleWorkRan, slowLibrary,
  modelVectors, stubProvider, openStats, exportMarkdown, openAITab, tryAgain, failingSaves, restoreLibrary, typeLine,
};
