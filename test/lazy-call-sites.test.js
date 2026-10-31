'use strict';

// #27 slice 3: the four places a vendored library loads at its first use, through the page's
// loader (js/runtime/lazy.js): Stats' charts (Chart.js), search (Fuse.js), the Markdown export
// (JSZip), and the embedding model (transformers.js). One that didn't load lands where a
// failure there landed before (R1): Stats and search on App's "An unexpected error occurred"
// toast, on purpose through App's path and never as an unhandled rejection; the export on
// "Export failed"; the model on its embeddings.load-failed event. Each test then types into the
// open note, which still saves. Without the loader, as before, each reads its library's global.

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

/** A loader whose every library comes back failed for `reason`, with the names it was asked for */
function failingLoader(reason = 'chunk-missing') {
  const loads = [];
  return {
    loads,
    loadLibrary: async (name) => {
      loads.push(name);
      return { status: 'failed', reason, retry: async () => ({ status: 'failed', reason, retry: null }) };
    },
    registerReloadGuard: () => () => {},
    registerExtraDocument: () => () => {},
  };
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

/** Stats as App builds it, over the page's note list, with the elements its counts go in */
function statsOf(env, app) {
  env.get('Analytics').connect({ noteList: env.noteList, getNoteBlocks: (noteId) => env.documentClient.blocksOf(noteId) });
  env.document.stub(['stat-total-notes', 'stat-total-words', 'stat-daily-notes', 'stat-active-tags']);
  const analytics = new (env.get('AnalyticsController'))({
    domRefs: null,
    logger: app.logger,
    loadLibrary: app.libraryLoader(),
    showUnexpectedError: (context, error) => app.showUnexpectedError(context, error),
  });
  analytics.noteList = env.noteList;
  return analytics;
}

describe("Stats' charts: Chart.js at the first Stats", () => {
  it("draws with the Chart.js the loader loaded", async () => {
    const { env, App } = await page();
    const made = [];
    const Chart = class { constructor(canvas, config) { made.push(config.type); } destroy() {} };
    const loader = loadingLoader({ chart: Chart });
    const analytics = statsOf(env, appOf(env, App, { loader }));
    await analytics.renderAnalytics();
    assert.deepEqual(loader.loads, ['chart']);
    assert.deepEqual(made, ['line', 'doughnut', 'bar', 'polarArea']);
  });

  it("one that didn't load keeps the counts, draws no chart, and shows the toast through App's path; typing still saves", async () => {
    const { env, App, toasts, tabs } = await page();
    const loader = failingLoader();
    const app = appOf(env, App, { loader });
    const analytics = statsOf(env, app);
    await noUnhandled(() => analytics.renderAnalytics());
    assert.deepEqual(loader.loads, ['chart']);
    assert.equal(String(env.document.getElementById('stat-total-notes').textContent), '1');
    assert.deepEqual(Object.keys(analytics.charts), []);
    assert.deepEqual(toasts, [['An unexpected error occurred', 'error']]);
    // The log line names the library and the reason, never a note
    const [line] = env.warnings().filter(({ args }) => args.some((arg) => arg && /Chart\.js didn't load/.test(String(arg.message || arg))));
    assert.ok(line, JSON.stringify(env.warnings().map(({ args }) => String(args[0]))));
    assert.deepEqual(await typeAndSave(env, tabs.editor, 'still typing'), ['still typing']);
  });

  it('is how App builds Stats', () => {
    assert.match(read('js/app.js'), /new AnalyticsController\(\{[^}]*loadLibrary: this\.libraryLoader\(\),\s*showUnexpectedError: \(context, error\) => this\.showUnexpectedError\(context, error\),\s*\}\);/);
  });
});

describe('search: Fuse.js at the first index', () => {
  it('builds the index from every entry with the Fuse.js the loader loaded, before the search runs', async () => {
    const { env, App } = await page();
    const Fuse = class { constructor(data) { this.data = data; } search() { return this.data.map((item) => ({ item, score: 0 })); } };
    const loader = loadingLoader({ fuse: Fuse });
    const app = appOf(env, App, { loader });
    const entries = [{ id: 'A', name: 'Alpha' }, { id: 'B', name: 'Beta' }];
    await app.searchEngine.updateIndex(entries);
    assert.deepEqual(loader.loads, ['fuse']);
    assert.equal(app.searchEngine.fuse.data, entries);
    // Both callers wait for the index before they search (AC8)
    assert.match(read('js/controllers/sidebar-controller.js'), /if \(this\.searchEngine\) await this\.searchEngine\.updateIndex\(searchIndexData\);\n {4}const searchResults = this\.searchEngine \? await this\.searchEngine\.search\(this\.searchQuery\) : \[\];/);
    assert.match(read('js/controllers/ai-chat-controller.js'), /await this\.searchEngine\.updateIndex\(searchIndexData\);\n {6}\}\n\n {6}const searchResults = this\.searchEngine \? await this\.searchEngine\.search\(message\) : \[\];/);
  });

  it("one that didn't load leaves the index as it was and shows the toast through App's path; typing still saves", async () => {
    const { env, App, toasts, tabs } = await page();
    const loader = failingLoader();
    const app = appOf(env, App, { loader });
    await noUnhandled(() => app.searchEngine.updateIndex([{ id: 'A', name: 'Alpha' }]));
    assert.deepEqual(loader.loads, ['fuse']);
    assert.equal(app.searchEngine.fuse, null);
    assert.deepEqual(toasts, [['An unexpected error occurred', 'error']]);
    assert.deepEqual(await typeAndSave(env, tabs.editor, 'still typing'), ['still typing']);
  });

  it('reads the global Fuse.js without the loader, as before', async () => {
    const { env, App } = await page();
    const app = appOf(env, App, {});
    env.global.Fuse = class { constructor(data) { this.data = data; } };
    await app.searchEngine.updateIndex([{ id: 'A' }]);
    assert.deepEqual(plain(app.searchEngine.fuse.data), [{ id: 'A' }]);
  });
});

describe('the Markdown export: JSZip at the first export', () => {
  it("one that didn't load shows Export failed, as a missing JSZip did; typing still saves", async () => {
    const { env, App, toasts, tabs } = await page();
    const loader = failingLoader();
    const app = appOf(env, App, { loader });
    const settings = new (env.get('SettingsController'))({
      settings: env.settingsClient,
      documentClient: env.documentClient,
      validateBackup: env.validateBackup,
      domRefs: null,
      logger: null,
      loadLibrary: app.libraryLoader(),
    });
    await noUnhandled(() => settings.exportAllAsMarkdown());
    assert.deepEqual(loader.loads, ['jszip']);
    assert.deepEqual(toasts, [['Export failed', 'error']]);
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
    const settings = new (env.get('SettingsController'))({
      settings: env.settingsClient, documentClient: env.documentClient, validateBackup: env.validateBackup, domRefs: null, logger: null,
      loadLibrary: appOf(env, App, { loader: loadingLoader({ jszip: JSZip }) }).libraryLoader(),
    });
    await settings.exportAllAsMarkdown();
    assert.equal(zips.length, 1);
    assert.deepEqual(zips[0].files.map(([name]) => name), ['alpha.md']);
  });

  it('is how App builds Settings', () => {
    assert.match(read('js/app.js'), /new SettingsController\(\{[^}]*loadLibrary: this\.libraryLoader\(\),\s*\}\);/);
  });
});

describe("the embedding model: transformers.js at the model's first load", () => {
  it("one that didn't load is the embeddings.load-failed event it was, with no model; typing still saves", async () => {
    const { env, App, toasts, tabs } = await page();
    const loader = failingLoader();
    const seen = [];
    const app = appOf(env, App, { loader, events: { event: (code, fields, failure) => seen.push([code, failure && failure.name]) } });
    app.attachFailureEvents();
    const Embeddings = env.get('Embeddings');
    // As App.init gives it the loader
    Embeddings.loadLibrary = app.libraryLoader();
    await noUnhandled(() => Embeddings.init());
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
    await Embeddings.init();
    assert.deepEqual(loader.loads, ['transformers']);
    assert.equal(Embeddings.isReady, true);
    assert.equal(backends.onnx.wasm.proxy, false);
  });

  it('is how App.init gives Embeddings the loader', () => {
    assert.match(read('js/app.js'), /if \(typeof Embeddings !== 'undefined'\) Embeddings\.loadLibrary = this\.libraryLoader\(\);/);
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
    assert.deepEqual(registered, [pipDocument]);
    pipListeners.pagehide.forEach((fn) => fn({ type: 'pagehide' }));
    assert.deepEqual(registered, []);
    assert.match(read('js/app.js'), /registerExtraDocument: this\.loader \? \(target\) => this\.loader\.registerExtraDocument\(target\) : null,/);
  });
});
