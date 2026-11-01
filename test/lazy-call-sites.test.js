'use strict';

// #27 slice 3: the four places a vendored library loads at its first use, through the page's
// loader (js/runtime/lazy.js): Stats' charts (Chart.js), search (Fuse.js), the Markdown export
// (JSZip), and the embedding model (transformers.js). Since #27 slice 3b each answers the loader's
// Result, never as an unhandled rejection, and the place where the part goes says a failure, with
// no toast (js/ui/part-state.js; test/part-state-call-sites.test.js has each place's states). The
// model still reports its embeddings.load-failed event. Each test then types into the open note,
// which still saves. Without the loader, as before, each reads its library's global.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createLegacyEnv, createDatabase, bootNewTab, NEW_TAB_FILES, FakeDocument, note, block, runUntil, plain } = require('./helpers/legacy-env');

const ROOT = path.join(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(ROOT, file), 'utf8');
const lazy = () => import('../js/runtime/lazy.js');

const FILES = [
  ...NEW_TAB_FILES,
  'js/core/dom-refs.js', 'js/core/logger.js', 'js/ui/export-notice.js', 'js/search.js', 'js/embeddings.js',
  'js/analytics.js', 'js/controllers/analytics-controller.js', 'js/app.js',
];

/** A new tab with note A open in its editor, its toasts recorded, and App's class */
async function page() {
  const env = createLegacyEnv({ document: new FakeDocument() });
  await createDatabase(env.indexedDB, {
    records: { canvases: [note('A', { name: 'Alpha' })], elements: [block('a1', 'A', 0, 'hello')] },
  });
  const booted = await bootNewTab(env, { files: FILES });
  await booted.tabs.openNoteInNewTab('A');
  const toasts = [];
  env.get('Utils').showToast = (message, kind) => toasts.push([message, kind]);
  return { env, ...booted, toasts, App: env.get('App') };
}

/**
 * A loader whose every library comes back failed for `reason`, with the names it was asked for.
 * A failure's retry loads it again, as the page's loader's does, and fails the same way.
 */
function failingLoader(reason = 'chunk-missing') {
  const loads = [];
  const loader = {
    loads,
    loadLibrary: async (name) => {
      loads.push(name);
      return { status: 'failed', reason, retry: () => loader.loadLibrary(name) };
    },
    registerReloadGuard: () => () => {},
    registerExtraDocument: () => () => {},
  };
  return loader;
}

/** A loader whose libraries are `modules`, by name */
function loadingLoader(modules) {
  const loads = [];
  return {
    loads,
    loadLibrary: async (name) => {
      loads.push(name);
      return { status: 'loaded', module: modules[name] };
    },
    registerReloadGuard: () => () => {},
    registerExtraDocument: () => () => {},
  };
}

/** App with `options`, and its logger, as init makes it */
function appOf(env, App, options) {
  const app = new App(options);
  app.logger = env.get('createLogger')();
  return app;
}

/** Run `act`, and fail on any rejection nothing handled while it ran */
async function noUnhandled(act) {
  const unhandled = [];
  const listener = (reason) => unhandled.push(reason);
  process.on('unhandledRejection', listener);
  try {
    await act();
    await new Promise((resolve) => setImmediate(resolve));
  } finally {
    process.off('unhandledRejection', listener);
  }
  assert.deepEqual(unhandled, [], 'nothing went unhandled');
}

/** Type into the open note's first block, as onBlockInput does, and answer what the store has */
async function typeAndSave(env, editor, text) {
  editor.blocks[0].content = text;
  editor.blocks[0].markUpdated();
  editor.scheduleSave();
  await runUntil(env, editor.flushSave());
  const stored = await env.get('Storage').getElementsByNote('A');
  return plain(stored.map((element) => element.content));
}

/** The four chart cards newtab.html has, each a heading over its canvas */
const CHART_CARDS = [
  ['activity-chart', 'Activity (Last 30 Days)'], ['content-chart', 'Content Breakdown'],
  ['tags-chart', 'Top Tags'], ['folders-chart', 'Notes by Folder'],
];

/**
 * Stats as App builds it, over the page's note list, in the dashboard newtab.html has: its four
 * counts, and the chart cards in their grid. `shown()` is what the charts' place shows.
 */
function statsOf(env, app) {
  env.get('Analytics').connect({ noteList: env.noteList, getNoteBlocks: (noteId) => env.documentClient.blocksOf(noteId) });
  const doc = env.document;
  const { 'stats-dashboard': dashboard } = doc.stub(['stats-dashboard', 'stat-total-notes', 'stat-total-words', 'stat-daily-notes', 'stat-active-tags']);
  const grid = doc.createElement('div');
  grid.className = 'charts-grid';
  dashboard.appendChild(grid);
  for (const [id, title] of CHART_CARDS) {
    const card = doc.createElement('div');
    card.className = 'chart-wrapper';
    const heading = doc.createElement('h3');
    heading.textContent = title;
    const canvas = doc.createElement('canvas');
    canvas.id = id;
    card.appendChild(heading);
    card.appendChild(canvas);
    grid.appendChild(card);
  }
  const analytics = new (env.get('AnalyticsController'))({
    domRefs: null,
    logger: app.logger,
    loadLibrary: app.libraryLoader(),
    partReload: app.partReload(),
  });
  analytics.noteList = env.noteList;
  const shown = () => {
    const part = analytics.chartsPart;
    const placed = Boolean(part && part.element && part.element.parentNode === grid);
    return {
      placed,
      line: placed ? part.line.textContent : null,
      buttons: placed ? [part.tryButton, part.reloadButton].filter((button) => !button.hidden).map((button) => (button.children.length === 2 ? button.children[0].textContent : button.textContent)) : [],
      cards: grid.children.filter((child) => child.className === 'chart-wrapper').map((card) => card.style.display || 'shown'),
    };
  };
  return { analytics, grid, shown };
}

/** A Chart.js stand-in that records the charts drawn */
function chartLibrary() {
  const made = [];
  const Chart = class { constructor(canvas, config) { made.push(config.type); } destroy() {} };
  return { made, Chart };
}

describe("Stats' charts: Chart.js at the first Stats", () => {
  it("draws with the Chart.js the loader loaded, and nothing in their place", async () => {
    const { env, App } = await page();
    const { made, Chart } = chartLibrary();
    const loader = loadingLoader({ chart: Chart });
    const { analytics, shown } = statsOf(env, appOf(env, App, { loader }));
    await analytics.renderAnalytics();
    assert.deepEqual(loader.loads, ['chart']);
    assert.deepEqual(made, ['line', 'doughnut', 'bar', 'polarArea']);
    assert.deepEqual(shown(), { placed: false, line: null, buttons: [], cards: ['shown', 'shown', 'shown', 'shown'] });
  });

  it("one that didn't load keeps the counts and says so in the charts' place, with Try again and no toast; typing still saves", async () => {
    const { env, App, toasts, tabs } = await page();
    const loader = failingLoader();
    const app = appOf(env, App, { loader });
    const { analytics, shown } = statsOf(env, app);
    await noUnhandled(() => analytics.renderAnalytics());
    assert.deepEqual(loader.loads, ['chart']);
    assert.equal(String(env.document.getElementById('stat-total-notes').textContent), '1');
    assert.deepEqual(Object.keys(analytics.charts), []);
    assert.deepEqual(shown(), {
      placed: true, line: 'Failed to load the charts. Please try again.', buttons: ['Try again'], cards: ['none', 'none', 'none', 'none'],
    });
    assert.equal(analytics.chartsPart.liveRegion.textContent, 'Failed to load the charts. Please try again.');
    assert.deepEqual(toasts, []);
    assert.deepEqual(await typeAndSave(env, tabs.editor, 'still typing'), ['still typing']);
  });

  it("Try again that loads draws the four charts in their cards and moves focus to the first chart's heading", async () => {
    const { env, App } = await page();
    const { made, Chart } = chartLibrary();
    const loader = {
      loads: [],
      loadLibrary: async (name) => {
        loader.loads.push(name);
        return { status: 'failed', reason: 'chunk-missing', retry: async () => ({ status: 'loaded', module: Chart }) };
      },
      registerReloadGuard: () => () => {},
      registerExtraDocument: () => () => {},
    };
    const { analytics, grid, shown } = statsOf(env, appOf(env, App, { loader }));
    await analytics.renderAnalytics();
    const part = analytics.chartsPart;
    part.tryButton.focus();
    part.tryButton.click();
    await runUntil(env, new Promise((resolve) => setImmediate(resolve)));
    await runUntil(env, analytics.countsRead);
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(made, ['line', 'doughnut', 'bar', 'polarArea']);
    assert.deepEqual(shown(), { placed: false, line: null, buttons: [], cards: ['shown', 'shown', 'shown', 'shown'] });
    const heading = grid.children[0].children[0];
    assert.ok(env.document.activeElement === heading, "focus is on the first chart's heading");
    assert.equal(heading.getAttribute('tabindex'), '-1');
  });

  it("a reopened Stats says the first failure's words again until Try again is pressed", async () => {
    const { env, App } = await page();
    const loader = failingLoader();
    const { analytics, shown } = statsOf(env, appOf(env, App, { loader }));
    await analytics.renderAnalytics();
    analytics.chartsPart.tryButton.click();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(shown().line, 'Failed to load the charts again.');
    assert.deepEqual(shown().buttons, ['Try again', 'Reload']);
    await analytics.renderAnalytics();
    assert.equal(shown().line, 'Failed to load the charts. Please try again.');
    assert.deepEqual(shown().buttons, ['Try again']);
  });

  it('is how App builds Stats', () => {
    assert.match(read('js/app.js'), /new AnalyticsController\(\{[^}]*loadLibrary: this\.libraryLoader\(\),\s*partReload: this\.partReload\(\),\s*\}\);/);
  });
});

describe("a part's Reload: App's guarded reload and the editors' own notices", () => {
  it("runs the loader's reload after the guards, its reload without them, and finds an editor's own notice", async () => {
    const { env, App, tabs } = await page();
    const calls = [];
    const loader = { ...loadingLoader({}), reloadAfterGuards: async () => { calls.push('guarded'); return { reloaded: false }; }, reloadNow: () => calls.push('now') };
    const app = appOf(env, App, { loader });
    app.tabController = tabs;
    const reload = app.partReload();
    assert.deepEqual(plain(await reload.guarded()), { reloaded: false });
    reload.now();
    assert.deepEqual(calls, ['guarded', 'now']);
    assert.ok(reload.ownNotice() === null, 'no editor shows a notice');
    tabs.editor._onReloadRequired();
    // The notice's words take focus, which a second Enter can't reload from without the guards,
    // and from which Tab reaches its Reload
    const words = reload.ownNotice();
    assert.equal(words.textContent, "This page lost its connection to your notes, so these changes aren't saved. Copy anything you need, then reload.");
    assert.equal(words.getAttribute('tabindex'), '-1');
    assert.ok(tabs.editor.root.contains(words));
    assert.equal(appOf(env, App, {}).partReload(), null, "without the loader a part's Reload is the browser's");
  });

  it("is no editor's notice while a failed save has no notice of its own", async () => {
    const { tabs } = await page();
    tabs.editor._onReloadRequired();
    tabs.secondaryEditor._failedSeq.set('B', 3);
    assert.ok(tabs.ownNoticeText() === null, 'no notice while the failed save has none of its own');
    tabs.secondaryEditor._failedSeq.clear();
    assert.match(tabs.ownNoticeText().textContent, /^This page lost its connection to your notes/);
  });

  it("hands over to a deleted note's notice by its words too", async () => {
    const { tabs } = await page();
    tabs.editor._onNoteGone({ noteId: tabs.editor.noteId });
    const words = tabs.ownNoticeText();
    assert.equal(words.textContent, "This note was deleted, so these changes aren't saved.");
    assert.equal(words.getAttribute('tabindex'), '-1');
  });
});

describe('search: Fuse.js at the first index', () => {
  it('builds the index from every entry with the Fuse.js the loader loaded, before the search runs, and answers loaded', async () => {
    const { env, App } = await page();
    const Fuse = class { constructor(data) { this.data = data; } search() { return this.data.map((item) => ({ item, score: 0 })); } };
    const loader = loadingLoader({ fuse: Fuse });
    const app = appOf(env, App, { loader });
    const entries = [{ id: 'A', name: 'Alpha' }, { id: 'B', name: 'Beta' }];
    const answer = await app.searchEngine.updateIndex(entries);
    assert.equal(answer.status, 'loaded');
    assert.deepEqual(loader.loads, ['fuse']);
    assert.equal(app.searchEngine.fuse.data, entries);
    // Both callers wait for the index before they search (AC8), and read its answer (#27 slice 3b)
    assert.match(read('js/controllers/sidebar-controller.js'), /const index = \(\) => engine\.updateIndex\(searchIndexData\);\n {6}indexed = search \? await search\.loading\(index\) : await index\(\);\n {4}\}/);
    assert.match(read('js/controllers/ai-chat-controller.js'), /const indexed = await this\.searchEngine\.updateIndex\(searchIndexData\);\n {8}if \(indexed\.status !== 'loaded' && part\) \{/);
  });

  it("one that didn't load leaves the index as it was and answers the failure, with no toast; typing still saves", async () => {
    const { env, App, toasts, tabs } = await page();
    const loader = failingLoader();
    const app = appOf(env, App, { loader });
    let answer;
    await noUnhandled(async () => { answer = await app.searchEngine.updateIndex([{ id: 'A', name: 'Alpha' }]); });
    assert.deepEqual([answer.status, answer.reason, typeof answer.retry], ['failed', 'chunk-missing', 'function']);
    assert.deepEqual(loader.loads, ['fuse']);
    assert.equal(app.searchEngine.fuse, null);
    assert.deepEqual(toasts, []);
    assert.deepEqual(await typeAndSave(env, tabs.editor, 'still typing'), ['still typing']);
  });

  it('reads the global Fuse.js without the loader, as before', async () => {
    const { env, App } = await page();
    const app = appOf(env, App, {});
    env.global.Fuse = class { constructor(data) { this.data = data; } };
    await app.searchEngine.updateIndex([{ id: 'A' }]);
    assert.deepEqual(plain(app.searchEngine.fuse.data), [{ id: 'A' }]);
  });

  it('is how App builds the search engine, with no toast for a library that did not load', () => {
    assert.match(read('js/app.js'), /this\.searchEngine = new SearchEngine\(\{\}, \{\n {6}loadLibrary: this\.libraryLoader\(\),\n {4}\}\);/);
  });
});

describe('the Markdown export: JSZip at the first export', () => {
  /** Settings as App builds it, with the Data & Backup section's Export All and its hint */
  function settingsOf(env, app) {
    const doc = env.document;
    const section = doc.createElement('div');
    section.className = 'settings-section';
    const button = doc.createElement('button');
    button.id = 'export-zip-btn';
    button.textContent = 'Export All (ZIP/MD)';
    section.appendChild(button);
    doc.body.appendChild(section);
    const settings = new (env.get('SettingsController'))({
      settings: env.settingsClient,
      documentClient: env.documentClient,
      validateBackup: env.validateBackup,
      domRefs: null,
      logger: null,
      loadLibrary: app.libraryLoader(),
      partReload: app.partReload(),
    });
    settings._swapLabel(button);
    return { settings, section, button };
  }

  it("one that didn't load says so in its section's row, with Try again and no toast; typing still saves", async () => {
    const { env, App, toasts, tabs } = await page();
    const loader = failingLoader();
    const app = appOf(env, App, { loader });
    const { settings, section } = settingsOf(env, app);
    await noUnhandled(() => settings.exportAllAsMarkdown());
    assert.deepEqual(loader.loads, ['jszip']);
    const part = settings._exportPart;
    assert.ok(part.element.parentNode === section, 'the row is in its section');
    assert.equal(part.element.className, 'part-state is-flat');
    assert.equal(part.line.textContent, 'Failed to export your notes as Markdown. Please try again.');
    assert.deepEqual(toasts, []);
    assert.deepEqual(await typeAndSave(env, tabs.editor, 'still typing'), ['still typing']);
  });

  it('zips with the JSZip the loader loaded', async () => {
    const { env, App } = await page();
    const zips = [];
    const JSZip = class {
      constructor() { this.files = []; zips.push(this); }
      folder() { return { file: (name, text) => this.files.push([name, text]) }; }
      // Where a page hands the zip to the browser, which this one can't
      async generateAsync() { throw new Error('no download here'); }
    };
    const { settings } = settingsOf(env, appOf(env, App, { loader: loadingLoader({ jszip: JSZip }) }));
    await settings.exportAllAsMarkdown();
    assert.equal(zips.length, 1);
    assert.deepEqual(zips[0].files.map(([name]) => name), ['alpha.md']);
    // The file never reached the browser: the row says so, with the first failure's words
    assert.equal(settings._exportPart.line.textContent, 'Failed to export your notes as Markdown. Please try again.');
  });

  it('is how App builds Settings', () => {
    assert.match(read('js/app.js'), /new SettingsController\(\{[^}]*loadLibrary: this\.libraryLoader\(\),\s*partReload: this\.partReload\(\),\s*\}\);/);
  });
});

describe("the embedding model: transformers.js at the model's first load", () => {
  it("one that didn't load is the embeddings.load-failed event it was, with no model, and answers the failure; typing still saves", async () => {
    const { env, App, toasts, tabs } = await page();
    const loader = failingLoader();
    const seen = [];
    const app = appOf(env, App, { loader, events: { event: (code, fields, failure) => seen.push([code, failure && failure.name]) } });
    app.attachFailureEvents();
    const Embeddings = env.get('Embeddings');
    // As App.init gives it the loader
    Embeddings.loadLibrary = app.libraryLoader();
    let answer;
    await noUnhandled(async () => { answer = await Embeddings.init(); });
    assert.deepEqual([answer.status, answer.reason, typeof answer.retry], ['failed', 'chunk-missing', 'function']);
    assert.deepEqual(loader.loads, ['transformers']);
    assert.deepEqual(seen, [['embeddings.load-failed', 'Error']]);
    assert.equal(Embeddings.pipeline, null);
    assert.deepEqual(toasts, [], 'no toast, as before');
    assert.deepEqual(await typeAndSave(env, tabs.editor, 'still typing'), ['still typing']);
  });

  it('loads the model with the transformers.js the loader loaded', async () => {
    const { env, App } = await page();
    const backends = { onnx: { wasm: {} } };
    const transformers = { env: { backends }, pipeline: async () => async () => ({ data: [1, 0] }) };
    const loader = loadingLoader({ transformers });
    const Embeddings = env.get('Embeddings');
    Embeddings.loadLibrary = appOf(env, App, { loader }).libraryLoader();
    const answer = await Embeddings.init();
    assert.equal(answer.status, 'loaded');
    assert.deepEqual(loader.loads, ['transformers']);
    assert.equal(Embeddings.isReady, true);
    assert.equal(backends.onnx.wasm.proxy, false);
  });

  it('is how App.init gives Embeddings the loader, and the first download to the model\'s places', () => {
    assert.match(read('js/app.js'), /if \(typeof Embeddings !== 'undefined'\) \{\n {8}Embeddings\.loadLibrary = this\.libraryLoader\(\);\n {8}Embeddings\.onDownload = \(downloading\) => \{/);
  });
});

describe("App's reload guard and the PiP window's stylesheets", () => {
  it("a reload through the loader waits for the open editors' pending saves", async () => {
    const { createLoader } = await lazy();
    const reloadWith = async (guarded) => {
      const { env, App, tabs } = await page();
      let reloads = 0;
      const loader = createLoader({
        buildId: 'build-a', getURL: (file) => file, fetchJson: async () => null, importUrl: async () => ({}), document: null, global: {},
        warn: () => {}, reload: () => { reloads += 1; }, setTimeout: () => 0, clearTimeout: () => {}, libraries: {},
      });
      const app = appOf(env, App, { loader });
      app.tabController = tabs;
      if (guarded) app.guardReloads();
      // Typed, and its debounced save not due yet: the page's clock doesn't move here
      const editor = tabs.editor;
      editor.blocks[0].content = 'typed just before the reload';
      editor.blocks[0].markUpdated();
      editor.scheduleSave();
      await runUntil(env, loader.reloadAfterGuards());
      assert.equal(reloads, 1);
      const stored = await env.get('Storage').getElementsByNote('A');
      return plain(stored.map((element) => element.content));
    };
    assert.deepEqual(await reloadWith(true), ['typed just before the reload']);
    // Without App's guard the reload comes first
    assert.deepEqual(await reloadWith(false), ['hello']);
    assert.match(read('js/app.js'), /this\.tabController\.editorPorts = this\.editorPorts;\n {6}this\.guardReloads\(\);/);
  });

  it("doesn't reload while an open editor's save fails twice, answers the failure, and says it once, with no toast", async () => {
    const { createLoader } = await lazy();
    const { env, App, tabs, toasts } = await page();
    let reloads = 0;
    const loader = createLoader({
      buildId: 'build-a', getURL: (file) => file, fetchJson: async () => null, importUrl: async () => ({}), document: null, global: {},
      warn: () => {}, reload: () => { reloads += 1; }, setTimeout: () => 0, clearTimeout: () => {}, libraries: {},
    });
    const app = appOf(env, App, { loader });
    app.tabController = tabs;
    app.guardReloads();
    // The kernel answers the next two writes unavailable, as a full disk does
    const editor = tabs.editor;
    const real = editor.documentClient.saveContent.bind(editor.documentClient);
    let failures = 2;
    editor.documentClient.saveContent = (save) => {
      if (failures > 0) {
        failures -= 1;
        return Promise.resolve({ kind: 'unavailable', cause: 'quota', code: 'quota', retryable: false });
      }
      return real(save);
    };
    editor.blocks[0].content = 'typed and never stored';
    editor.blocks[0].markUpdated();
    editor.scheduleSave();
    assert.deepEqual(plain(await runUntil(env, loader.reloadAfterGuards())), { reloaded: false });
    assert.equal(reloads, 0);
    assert.deepEqual(toasts, [], 'the call site that asked for the reload says it');
    assert.equal(await runUntil(env, tabs.saveOpenEditors()), false, 'the edit still is not stored');
  });

  it('the PiP window gets each stylesheet a chunk adds while it is open, until it closes', async () => {
    const { env, tabs } = await page();
    const registered = [];
    tabs.registerExtraDocument = (target) => {
      registered.push(target);
      return () => registered.splice(registered.indexOf(target), 1);
    };
    const pipDocument = new FakeDocument();
    const pipListeners = {};
    env.document.styleSheets = [];
    env.global.documentPictureInPicture = {
      requestWindow: async () => ({
        document: pipDocument,
        addEventListener: (type, fn) => (pipListeners[type] = pipListeners[type] || []).push(fn),
        close() {},
      }),
    };
    await tabs.openNoteInPiP('A');
    assert.ok(registered.length === 1 && registered[0] === pipDocument, "the PiP window's document is registered");
    pipListeners.pagehide.forEach((fn) => fn({ type: 'pagehide' }));
    assert.ok(registered.length === 0, "the PiP window's document is let go when it closes");
    assert.match(read('js/app.js'), /registerExtraDocument: this\.loader \? \(target\) => this\.loader\.registerExtraDocument\(target\) : null,/);
  });
});
