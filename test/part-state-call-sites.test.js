'use strict';

// #27 slice 3b: each place a part that loads at its first use says how its load went, where the
// part goes (js/ui/part-state.js). Search's failure goes first in the sidebar's list, where "No
// matching notes" would be; the AI chat's All Notes says it where its answer would go; the Markdown
// export says it in its section's row; and the embedding model's failure is one state under
// search's results and in Related Notes, held until Try again. A part's Reload runs the page's save
// guards first. Each test here reads what the page shows and what its live region says.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const Fuse = require('../js/lib/fuse.js');
const { createLegacyEnv, createDatabase, bootNewTab, NEW_TAB_FILES, FakeDocument, note, block, runUntil, plain, settle } = require('./helpers/legacy-env');

const FILES = [
  ...NEW_TAB_FILES,
  'js/core/dom-refs.js', 'js/core/logger.js', 'js/ui/export-notice.js', 'js/search.js', 'js/embeddings.js',
  'js/controllers/ai-chat-controller.js', 'js/app.js',
];

/** Notes A, B and C, with the search entries the indexer writes for them */
const RECORDS = {
  canvases: [note('A', { name: 'Alpha plan' }), note('B', { name: 'Beta plan' }), note('C', { name: 'Gamma' })],
  elements: [block('a1', 'A', 0, 'hello')],
  search_index: [
    { noteId: 'A', name: 'Alpha plan', content: 'hello', updatedAt: 1 },
    { noteId: 'B', name: 'Beta plan', content: '', updatedAt: 1 },
    { noteId: 'C', name: 'Gamma', content: '', updatedAt: 1 },
  ],
};

/**
 * A page loader whose libraries answer as `plan` lists, one answer per load: 'loaded', a failure
 * reason, or a promise of either. As the page's loader does, it holds a library's answer, and a
 * failure's retry loads it again.
 */
function plannedLoader(modules, plan) {
  const loads = [];
  const reloads = [];
  const held = new Map();
  const loader = {
    loads,
    reloads,
    saves: true,
    loadLibrary(name) {
      if (held.has(name)) return held.get(name);
      loads.push(name);
      const answer = Promise.resolve((plan[name] || []).shift() || 'chunk-missing').then((next) => {
        if (next === 'loaded') return { status: 'loaded', module: modules[name] };
        return {
          status: 'failed',
          reason: next,
          retry: () => {
            if (held.get(name) === answer) held.delete(name);
            return loader.loadLibrary(name);
          },
        };
      });
      held.set(name, answer);
      return answer;
    },
    registerReloadGuard: () => () => {},
    registerExtraDocument: () => () => {},
    reloadAfterGuards: async () => {
      reloads.push('guarded');
      return { reloaded: loader.saves };
    },
    reloadNow: () => reloads.push('now'),
  };
  return loader;
}

/** A promise and the call that settles it */
function deferred() {
  let finish;
  const promise = new Promise((resolve) => { finish = resolve; });
  return { promise, finish: (value) => finish(value) };
}

/** Each text the live region is given, in order */
function said(part) {
  const words = [];
  const region = part.liveRegion;
  let text = '';
  Object.defineProperty(region, 'textContent', {
    configurable: true,
    get: () => text,
    set: (value) => {
      text = String(value);
      if (text) words.push(text);
    },
  });
  return words;
}

/** The buttons a part shows, by their shown label */
const buttonsOf = (part) => [part.tryButton, part.reloadButton, part.anywayButton].filter((button) => !button.hidden)
  .map((button) => (button.children.length === 2 ? button.children[0].textContent : button.textContent));

/**
 * A new tab with the sidebar's search, App's loader and reload, and its search engine, over notes
 * A, B and C. `type(query)` types into the search field and waits for the list.
 */
async function sidebarPage({ plan = {}, modules = {}, vectors = [] } = {}) {
  const env = createLegacyEnv({ document: new FakeDocument() });
  await createDatabase(env.indexedDB, { records: RECORDS });
  const booted = await bootNewTab(env, { files: FILES });
  const doc = env.document;
  const elements = doc.stub(['sidebar', 'sidebar-notes-list', { id: 'sidebar-search', tag: 'input' }]);
  const loader = plannedLoader({ fuse: Fuse, ...modules }, plan);
  const App = env.get('App');
  const app = new App({ loader });
  app.logger = env.get('createLogger')();
  app.tabController = booted.tabs;
  const Embeddings = env.get('Embeddings');
  Embeddings.loadLibrary = app.libraryLoader();
  app.searchEngine.setVectors(vectors);
  const sidebar = new (env.get('SidebarController'))({
    settings: env.settingsClient, domRefs: null, logger: app.logger, documentClient: env.documentClient, storageState: { missingStores: [] },
  });
  // As App wires it before init
  sidebar.searchEngine = app.searchEngine;
  sidebar.partReload = app.partReload();
  sidebar.modelParts = app.modelParts;
  sidebar.getEditor = () => null;
  sidebar.noteList = env.noteList;
  // As init makes them, with their live regions on the page
  const search = sidebar.searchPlace();
  const model = sidebar.modelPlace();
  const searchSaid = said(search);
  const modelSaid = said(model);
  const list = elements['sidebar-notes-list'];
  const type = async (query) => {
    elements['sidebar-search'].value = query;
    sidebar.searchQuery = query;
    await runUntil(env, sidebar.renderNotesList());
  };
  /** The list as drawn: each part's words, each note's name, and the empty line */
  const shown = () => list.children.map((child) => {
    if (child === search.element) return `search: ${search.line.textContent}`;
    if (child === model.element) return `model: ${model.line.textContent}`;
    if (child.classList.contains('sidebar-empty')) return `empty: ${child.textContent}`;
    const name = child.querySelector('.sidebar-note-name');
    return name ? name.textContent : child.className;
  });
  return { env, app, sidebar, loader, search, model, searchSaid, modelSaid, list, elements, type, shown, Embeddings, booted };
}

describe("search's place in the sidebar (#27 slice 3b)", () => {
  it("Fuse.js that didn't load says so first in the list, in the sidebar's card, where \"No matching notes\" would be, and once across keystrokes", async () => {
    const page = await sidebarPage();
    await page.type('pl');
    assert.deepEqual(page.shown(), ['search: Failed to load search. Please try again.']);
    assert.equal(page.search.element.className, 'part-state is-narrow');
    assert.deepEqual(buttonsOf(page.search), ['Try again']);
    // Its live region is in the sidebar, outside the list each keystroke draws again
    assert.equal(page.search.liveRegion.parentNode, page.elements.sidebar);
    await page.type('pla');
    await page.type('plan');
    assert.deepEqual(page.shown(), ['search: Failed to load search. Please try again.']);
    assert.deepEqual(page.searchSaid, ['Failed to load search. Please try again.']);
    assert.deepEqual(page.loader.loads, ['fuse'], 'the loader holds the failure until Try again');
  });

  it("Try again that fails says the second failure with Reload, focus stays on Try again, and the next keystroke says the first failure's words", async () => {
    const page = await sidebarPage({ plan: { fuse: ['chunk-missing', 'chunk-missing'] } });
    await page.type('plan');
    page.search.tryButton.focus();
    page.search.tryButton.click();
    await settle();
    assert.equal(page.search.line.textContent, 'Failed to load search again.');
    assert.equal(page.search.lineNote.textContent, "Reloading the page may fix it, and doesn't delete your notes.");
    assert.deepEqual(buttonsOf(page.search), ['Try again', 'Reload']);
    assert.equal(page.env.document.activeElement, page.search.tryButton);
    await page.type('plans');
    assert.equal(page.search.line.textContent, 'Failed to load search. Please try again.');
    assert.deepEqual(buttonsOf(page.search), ['Try again']);
    assert.deepEqual(page.searchSaid, [
      'Failed to load search. Please try again.',
      "Failed to load search again. Reloading the page may fix it, and doesn't delete your notes.",
      'Failed to load search. Please try again.',
    ]);
  });

  it('Try again that loads Fuse.js runs the search again, takes the failure away, and moves focus to the search field', async () => {
    const page = await sidebarPage({ plan: { fuse: ['chunk-missing', 'loaded'] } });
    await page.type('zzz');
    page.search.tryButton.focus();
    page.search.tryButton.click();
    await runUntil(page.env, settle());
    await settle();
    assert.deepEqual(page.shown(), ['empty: No matching notes']);
    assert.equal(page.env.document.activeElement, page.elements['sidebar-search']);
    assert.equal(page.searchSaid.at(-1), 'No matching notes');
    assert.deepEqual(page.loader.loads, ['fuse', 'fuse']);
  });

  it('Try again that loads Fuse.js lists the matches and says how many: "2 notes match." or "1 note matches."', async () => {
    for (const [query, names, count] of [['plan', ['Beta plan', 'Alpha plan'], '2 notes match.'], ['Gamma', ['Gamma'], '1 note matches.']]) {
      const page = await sidebarPage({ plan: { fuse: ['chunk-missing', 'loaded'] } });
      await page.type(query);
      page.search.tryButton.click();
      await runUntil(page.env, settle());
      await settle();
      assert.deepEqual(page.shown(), names, query);
      assert.equal(page.searchSaid.at(-1), count);
    }
  });

  it('a file that threw, or another build on disk, says so with Reload alone, and Reload runs the save guards first', async () => {
    for (const reason of ['evaluation-failed', 'build-mismatch']) {
      const page = await sidebarPage({ plan: { fuse: [reason] } });
      await page.type('plan');
      assert.equal(page.search.line.textContent, 'Failed to load search.', reason);
      assert.equal(page.search.lineNote.textContent, "Reloading the page may fix it, and doesn't delete your notes.");
      assert.deepEqual(buttonsOf(page.search), ['Reload']);
      page.search.reloadButton.click();
      await settle();
      assert.deepEqual(page.loader.reloads, ['guarded']);
    }
  });

  it('a Reload a save stopped says so in its place, with Try again and Reload anyway', async () => {
    const page = await sidebarPage({ plan: { fuse: ['evaluation-failed'] } });
    page.loader.saves = false;
    await page.type('plan');
    page.search.reloadButton.focus();
    page.search.reloadButton.click();
    await settle();
    assert.equal(page.search.line.textContent, "Failed to save your changes, so the page didn't reload.");
    assert.equal(page.search.lineNote.textContent, 'Please try again. If it keeps failing, copy anything you need, then reload.');
    assert.deepEqual(buttonsOf(page.search), ['Try again', 'Reload anyway']);
    assert.equal(page.env.document.activeElement, page.search.tryButton);
    page.search.anywayButton.click();
    assert.deepEqual(page.loader.reloads, ['guarded', 'now']);
  });

  it("a load that runs 400 ms shows \"Loading search…\" as a line where the results go, which holds 300 ms", async () => {
    const slow = deferred();
    const page = await sidebarPage({ plan: { fuse: [slow.promise] } });
    page.sidebar.searchQuery = 'zzz';
    const drawn = page.sidebar.renderNotesList();
    await settle();
    page.env.clock.tick(399);
    assert.deepEqual(page.shown(), []);
    page.env.clock.tick(1);
    assert.deepEqual(page.shown(), ['search: Loading search…']);
    assert.equal(page.search.element.className, 'part-state is-line');
    slow.finish('loaded');
    await settle();
    assert.deepEqual(page.shown(), ['search: Loading search…'], 'it holds');
    page.env.clock.tick(300);
    await runUntil(page.env, drawn);
    assert.deepEqual(page.shown(), ['empty: No matching notes']);
  });

  it('leaving search takes its failure away, and a load still running draws nothing in the notes list', async () => {
    const slow = deferred();
    const page = await sidebarPage({ plan: { fuse: ['chunk-missing'] } });
    await page.type('plan');
    assert.equal(page.shown().length, 1);
    await page.type('');
    assert.ok(!page.shown().some((line) => line.startsWith('search:')), JSON.stringify(page.shown()));
    assert.equal(page.search.state, 'idle');

    const later = await sidebarPage({ plan: { fuse: [slow.promise] } });
    later.sidebar.searchQuery = 'plan';
    const drawn = later.sidebar.renderNotesList();
    await settle();
    await later.type('');
    later.env.clock.tick(400);
    slow.finish('chunk-missing');
    await runUntil(later.env, drawn);
    assert.ok(!later.shown().some((line) => line.startsWith('search:')), JSON.stringify(later.shown()));
  });
});

/** transformers.js as a stand-in whose model embeds every text the same way */
function transformersStub({ pipeline } = {}) {
  return {
    env: { backends: { onnx: { wasm: {} } } },
    pipeline: pipeline || (async () => async () => ({ data: [1, 0] })),
  };
}

describe("the embedding model's place under search's results (#27 slice 3b)", () => {
  it("its failure goes under the list, and holds: a new search doesn't load it again", async () => {
    const page = await sidebarPage({ plan: { fuse: ['loaded'], transformers: ['chunk-missing'] }, vectors: [{ noteId: 'A', vector: [1, 0] }] });
    await page.type('zzz');
    assert.deepEqual(page.shown(), ['model: Failed to load semantic search. Please try again.']);
    assert.equal(page.model.element.className, 'part-state is-narrow');
    await page.type('zzzz');
    assert.deepEqual(page.loader.loads, ['fuse', 'transformers'], 'one load of the model for the page');
    assert.deepEqual(page.modelSaid, ['Failed to load semantic search. Please try again.']);
  });

  it('a load past 400 ms shows "Loading semantic search…" under the keyword results, and its matches take its place', async () => {
    const slow = deferred();
    const page = await sidebarPage({
      plan: { fuse: ['loaded'], transformers: [slow.promise] },
      modules: { transformers: transformersStub() },
      vectors: [{ noteId: 'C', vector: [1, 0] }],
    });
    page.sidebar.searchQuery = 'zzz';
    const drawn = page.sidebar.renderNotesList();
    await settle();
    page.env.clock.tick(400);
    assert.deepEqual(page.shown(), ['model: Loading semantic search…']);
    slow.finish('loaded');
    await settle();
    page.env.clock.tick(300);
    await runUntil(page.env, drawn);
    assert.deepEqual(page.shown(), ['Gamma'], "the model's match where its status was");
  });

  it("the keyword matches draw at once, and the model's matches join under them where its status was", async () => {
    const slow = deferred();
    const page = await sidebarPage({
      plan: { fuse: ['loaded'], transformers: [slow.promise] },
      modules: { transformers: transformersStub() },
      vectors: [{ noteId: 'C', vector: [1, 0] }, { noteId: 'A', vector: [1, 0] }],
    });
    page.sidebar.searchQuery = 'plan';
    const drawn = page.sidebar.renderNotesList();
    await settle();
    assert.deepEqual(page.shown(), ['Beta plan', 'Alpha plan'], 'before the model answers');
    page.env.clock.tick(400);
    assert.deepEqual(page.shown(), ['Beta plan', 'Alpha plan', 'model: Loading semantic search…']);
    slow.finish('loaded');
    await settle();
    page.env.clock.tick(300);
    await runUntil(page.env, drawn);
    // Alpha plan is listed already, so only Gamma joins, under the matches, best keyword match first
    assert.deepEqual(page.shown(), ['Beta plan', 'Alpha plan', 'Gamma']);
  });

  it("the model's failure under keyword matches says they match the words typed", async () => {
    const page = await sidebarPage({ plan: { fuse: ['loaded'], transformers: ['chunk-missing'] }, vectors: [{ noteId: 'C', vector: [1, 0] }] });
    await page.type('plan');
    assert.deepEqual(page.shown(), ['Beta plan', 'Alpha plan', 'model: Failed to load semantic search. Please try again.']);
    assert.equal(page.model.lineNote.textContent, 'These results match the words you typed.');
  });

  it("Fuse.js that didn't load, with the model's matches listed, says they match by meaning only", async () => {
    const page = await sidebarPage({
      plan: { fuse: ['chunk-missing'], transformers: ['loaded'] },
      modules: { transformers: transformersStub() },
      vectors: [{ noteId: 'C', vector: [1, 0] }],
    });
    await page.type('zzz');
    assert.deepEqual(page.shown(), ['search: Failed to load search. Please try again.', 'Gamma']);
    assert.equal(page.search.lineNote.textContent, 'These results match by meaning only.');
  });

  it("the first download's line comes under the loading words while a file comes from the network", async () => {
    const page = await sidebarPage({ plan: { fuse: ['loaded'] }, vectors: [{ noteId: 'C', vector: [1, 0] }] });
    page.app.modelParts.loadingNote('The model downloads the first time, which can take a minute.');
    const slow = deferred();
    const library = page.loader.loadLibrary;
    page.loader.loadLibrary = (name) => (name === 'transformers' ? slow.promise : library(name));
    page.sidebar.searchQuery = 'zzz';
    const drawn = page.sidebar.renderNotesList();
    await settle();
    page.env.clock.tick(400);
    assert.equal(page.model.line.textContent, 'Loading semantic search…');
    assert.equal(page.model.lineNote.textContent, 'The model downloads the first time, which can take a minute.');
    slow.finish({ status: 'failed', reason: 'chunk-missing', retry: async () => ({ status: 'failed', reason: 'chunk-missing', retry: null }) });
    page.env.clock.tick(300);
    await runUntil(page.env, drawn);
  });
});

describe("the model's failure is one state in search and Related Notes (#27 slice 3b, change 12)", () => {
  /** The sidebar's page, with the AI chat's Insights tab on the same App, open on note B */
  async function bothPlaces(plan) {
    const page = await sidebarPage({ plan, modules: { transformers: transformersStub() }, vectors: [{ noteId: 'C', vector: [1, 0] }] });
    const { env, app } = page;
    env.document.stub(['ai-sidebar', 'ai-smart-empty', 'ai-smart-results', 'ai-suggested-tags', 'ai-extracted-actions']);
    const section = env.document.createElement('div');
    section.className = 'ai-smart-section';
    const header = env.document.createElement('div');
    header.className = 'ai-smart-section-header';
    const related = env.document.createElement('div');
    related.id = 'ai-related-notes';
    section.appendChild(header);
    section.appendChild(related);
    env.document.body.appendChild(section);
    const chat = new (env.get('AIChatController'))({
      settings: env.settingsClient, domRefs: null, logger: app.logger, llm: { isConfigured: () => true, extractInsights: async () => ({ todos: [] }) },
      documentClient: env.documentClient,
    });
    chat.searchEngine = app.searchEngine;
    chat.partReload = app.partReload();
    chat.modelParts = app.modelParts;
    chat.noteList = env.noteList;
    chat.aiSidebarOpen = true;
    chat.aiActiveTab = 'smart';
    chat.getEditor = () => ({ noteId: 'B', noteData: { id: 'B', name: 'Beta plan' }, getAllBlocksTextContent: () => 'Alpha plan for the weekend trip', titleEl: null });
    const relatedPart = chat.relatedPlace();
    const relatedSaid = said(relatedPart);
    return { ...page, chat, relatedPart, relatedSaid, header };
  }

  it('shows in both places, and one Try again that works clears both, with focus where it was pressed', async () => {
    const page = await bothPlaces({ fuse: ['loaded'], transformers: ['chunk-missing', 'loaded'] });
    await page.type('plan');
    await runUntil(page.env, page.chat.updateSmartSuggestions());
    assert.equal(page.model.state, 'failed');
    assert.equal(page.relatedPart.state, 'failed');
    assert.equal(page.relatedPart.line.textContent, 'Failed to load semantic search. Please try again.');
    assert.equal(page.relatedPart.lineNote.textContent, 'Until it loads, related notes match words only.');
    page.relatedPart.tryButton.focus();
    page.relatedPart.tryButton.click();
    await runUntil(page.env, settle());
    await settle();
    assert.equal(page.model.state, 'idle');
    assert.equal(page.relatedPart.state, 'idle');
    assert.deepEqual(page.loader.loads, ['fuse', 'transformers', 'transformers'], 'one load for both places');
    assert.equal(page.env.document.activeElement, page.header, "focus goes to Related Notes' heading");
    assert.equal(page.header.getAttribute('tabindex'), '-1');
  });

  it('a Try again that fails shows the second failure in both places, once for the page', async () => {
    const page = await bothPlaces({ fuse: ['loaded'], transformers: ['chunk-missing', 'chunk-missing'] });
    await page.type('plan');
    await runUntil(page.env, page.chat.updateSmartSuggestions());
    page.model.tryButton.focus();
    page.model.tryButton.click();
    await runUntil(page.env, settle());
    await settle();
    assert.equal(page.model.line.textContent, 'Failed to load semantic search again.');
    assert.equal(page.relatedPart.line.textContent, 'Failed to load semantic search again.');
    assert.equal(page.env.document.activeElement, page.model.tryButton, 'focus stays on the Try again pressed');
    assert.deepEqual(page.loader.loads, ['fuse', 'transformers', 'transformers']);
  });
});

describe("the Insights tab draws each section when its own answer arrives (#27 slice 3b, gap 6)", () => {
  it("draws the provider's tags and action items while the model still loads, and Related Notes' status meanwhile", async () => {
    const slow = deferred();
    const page = await sidebarPage({ plan: { fuse: ['loaded'], transformers: [slow.promise] }, modules: { transformers: transformersStub() }, vectors: [{ noteId: 'C', vector: [1, 0] }] });
    const { env, app } = page;
    env.document.stub(['ai-sidebar', 'ai-smart-empty', 'ai-smart-results', 'ai-suggested-tags', 'ai-extracted-actions', 'ai-related-notes']);
    const chat = new (env.get('AIChatController'))({
      settings: env.settingsClient, domRefs: null, logger: app.logger,
      llm: { isConfigured: () => true, extractInsights: async () => ({ todos: ['Pack the tent'], tags: ['camping'] }) },
      documentClient: env.documentClient,
    });
    chat.searchEngine = app.searchEngine;
    await app.searchEngine.updateIndex(RECORDS.search_index);
    chat.modelParts = app.modelParts;
    chat.noteList = env.noteList;
    chat.aiSidebarOpen = true;
    chat.aiActiveTab = 'smart';
    chat.getEditor = () => ({ noteId: 'B', noteData: { id: 'B', name: 'Beta plan' }, getAllBlocksTextContent: () => 'Alpha plan for the weekend trip', titleEl: null });
    const updated = chat.updateSmartSuggestions();
    await settle();
    assert.match(env.document.getElementById('ai-suggested-tags').textContent, /#camping/);
    assert.match(env.document.getElementById('ai-extracted-actions').textContent, /Pack the tent/);
    env.clock.tick(400);
    assert.equal(chat.relatedPart ? chat.relatedPart.line.textContent : chat._relatedPart.line.textContent, 'Loading semantic search…');
    slow.finish('chunk-missing');
    await settle();
    env.clock.tick(300);
    await runUntil(env, updated);
    assert.equal(chat._relatedPart.state, 'failed');
  });
});

describe('Embeddings holds a failed load until Try again (#27 slice 3b, change 12)', () => {
  function model(plan) {
    const env = createLegacyEnv({ document: null });
    env.load('js/embeddings.js');
    const Embeddings = env.get('Embeddings');
    const loader = plannedLoader({ transformers: transformersStub() }, plan);
    Embeddings.loadLibrary = (name) => loader.loadLibrary(name);
    return { env, Embeddings, loader };
  }

  it('answers the failure, embeds nothing, and loads again only through the failure\'s retry', async () => {
    const { Embeddings, loader } = model({ transformers: ['chunk-missing', 'loaded'] });
    const failed = await Embeddings.init();
    assert.deepEqual([failed.status, failed.reason], ['failed', 'chunk-missing']);
    assert.equal(await Embeddings.generateEmbedding('a query'), null);
    assert.equal(await Embeddings.generateEmbedding('a note to embed'), null);
    assert.deepEqual(loader.loads, ['transformers'], 'no load per query or note');
    const loaded = await failed.retry();
    assert.equal(loaded.status, 'loaded');
    assert.deepEqual(plain(await Embeddings.generateEmbedding('a query')), [1, 0]);
    assert.deepEqual(loader.loads, ['transformers', 'transformers']);
  });

  it("a model whose files don't come is a failure Try again can help", async () => {
    const { Embeddings } = model({ transformers: ['loaded'] });
    Embeddings.loadLibrary = async () => ({ status: 'loaded', module: transformersStub({ pipeline: async () => { throw new TypeError('Failed to fetch'); } }) });
    const failed = await Embeddings.init();
    assert.deepEqual([failed.status, failed.reason, typeof failed.retry], ['failed', 'model-failed', 'function']);
  });

  it("says the first download while pipeline() starts a file the browser's cache doesn't hold, and stops when the load ends", async () => {
    const { env, Embeddings } = model({ transformers: ['loaded'] });
    const cached = new Set(['https://huggingface.co/Xenova/all-MiniLM-L6-v2/resolve/main/config.json']);
    const asked = [];
    env.global.caches = {
      open: async (name) => {
        asked.push(name);
        return { match: async (url) => (cached.has(url) ? {} : undefined) };
      },
    };
    const downloads = [];
    Embeddings.onDownload = (downloading) => downloads.push(downloading);
    const files = deferred();
    Embeddings.loadLibrary = async () => ({
      status: 'loaded',
      module: {
        env: { backends: { onnx: { wasm: {} } }, useBrowserCache: true, remoteHost: 'https://huggingface.co/', remotePathTemplate: '{model}/resolve/{revision}/' },
        pipeline: async (task, name, { progress_callback: progress }) => {
          progress({ status: 'initiate', name, file: 'config.json' });
          await settle();
          assert.deepEqual(downloads, [], 'a file from the cache is no download');
          progress({ status: 'initiate', name, file: 'onnx/model_quantized.onnx' });
          await settle();
          assert.deepEqual(downloads, [true]);
          await files.promise;
          return async () => ({ data: [1, 0] });
        },
      },
    });
    const loading = Embeddings.init();
    await settle();
    files.finish();
    assert.equal((await loading).status, 'loaded');
    assert.deepEqual(downloads, [true, false]);
    assert.deepEqual(asked, ['transformers-cache', 'transformers-cache']);
  });
});

/**
 * The AI chat's All Notes on a new tab, with App's loader, search engine and reload. `ask(text)`
 * sends a question and waits for the chat's answer.
 */
async function chatPage({ plan = {} } = {}) {
  const env = createLegacyEnv({ document: new FakeDocument() });
  await createDatabase(env.indexedDB, { records: RECORDS });
  const booted = await bootNewTab(env, { files: FILES });
  const doc = env.document;
  const elements = doc.stub([
    'ai-sidebar', 'global-chat-messages', 'global-chat-loading', 'global-chat-loading-text', { id: 'global-chat-input', tag: 'textarea' },
    { id: 'global-chat-send', tag: 'button' },
  ]);
  const loader = plannedLoader({ fuse: Fuse }, plan);
  const App = env.get('App');
  const app = new App({ loader });
  app.logger = env.get('createLogger')();
  app.tabController = booted.tabs;
  const chat = new (env.get('AIChatController'))({
    settings: env.settingsClient, domRefs: null, logger: app.logger, llm: { isConfigured: () => true }, documentClient: env.documentClient,
  });
  chat.searchEngine = app.searchEngine;
  chat.partReload = app.partReload();
  chat.modelParts = app.modelParts;
  chat.saveGlobalChatHistory = async () => {};
  // An answer's markup, which this page has no parser for
  env.global.sanitizeHtml = (html) => html;
  const part = chat.allNotesPlace();
  const ask = async (text) => {
    elements['global-chat-input'].value = text;
    await runUntil(env, chat.sendGlobalChatMessage());
  };
  const messages = elements['global-chat-messages'];
  const shown = () => messages.children.map((child) => {
    if (child === part.element) return `failure: ${part.line.textContent}`;
    const content = child.querySelector('.ai-message-content');
    return `${child.className}: ${(content || child).textContent}`;
  });
  return { env, app, chat, loader, part, ask, shown, elements };
}

describe("the AI chat's All Notes (#27 slice 3b, change 13)", () => {
  it("Fuse.js that didn't load says so where the answer would go, under the question, not as the chat's answer", async () => {
    const page = await chatPage();
    await page.ask('What did I plan?');
    assert.deepEqual(page.shown(), ['ai-chat-message user: What did I plan?', 'failure: Failed to load search. Please try again.']);
    assert.deepEqual(buttonsOf(page.part), ['Try again']);
    assert.equal(page.part.liveRegion, null, 'the messages are a live region already');
    assert.ok(page.elements['global-chat-loading'].classList.contains('hidden'));
    assert.equal(page.elements['global-chat-send'].disabled, false);
  });

  it('Try again loads Fuse.js and asks the same question again', async () => {
    const page = await chatPage({ plan: { fuse: ['chunk-missing', 'loaded'] } });
    await page.ask('zzz unknown');
    page.part.tryButton.click();
    await runUntil(page.env, settle());
    await settle();
    assert.deepEqual(page.shown(), [
      'ai-chat-message user: zzz unknown',
      "ai-chat-message assistant: I couldn't find any notes that seem relevant to your question. Try adding more detail to your query.",
    ]);
    assert.deepEqual(page.loader.loads, ['fuse', 'fuse']);
  });

  it("a second failure says so with Reload, and a new question says the first failure's words under it", async () => {
    const page = await chatPage({ plan: { fuse: ['chunk-missing', 'chunk-missing'] } });
    await page.ask('first question');
    page.part.tryButton.click();
    await settle();
    assert.equal(page.part.line.textContent, 'Failed to load search again.');
    assert.deepEqual(buttonsOf(page.part), ['Try again', 'Reload']);
    await page.ask('second question');
    assert.deepEqual(page.shown(), [
      'ai-chat-message user: first question',
      'ai-chat-message user: second question',
      'failure: Failed to load search. Please try again.',
    ]);
  });
});

/** Settings' Data & Backup section on a new tab, with Export All, and App's loader and reload */
async function exportPage({ plan = {}, modules = {} } = {}) {
  const env = createLegacyEnv({ document: new FakeDocument() });
  await createDatabase(env.indexedDB, { records: RECORDS });
  const booted = await bootNewTab(env, { files: FILES });
  const doc = env.document;
  const section = doc.createElement('div');
  section.className = 'settings-section';
  const button = doc.createElement('button');
  button.id = 'export-zip-btn';
  button.textContent = 'Export All (ZIP/MD)';
  section.appendChild(button);
  doc.body.appendChild(section);
  const loader = plannedLoader(modules, plan);
  const App = env.get('App');
  const app = new App({ loader });
  app.logger = env.get('createLogger')();
  app.tabController = booted.tabs;
  const settings = new (env.get('SettingsController'))({
    settings: env.settingsClient, documentClient: env.documentClient, validateBackup: env.validateBackup, domRefs: null, logger: null,
    loadLibrary: app.libraryLoader(), partReload: app.partReload(),
  });
  settings._swapLabel(button);
  const part = settings.exportPlace();
  const toasts = [];
  env.get('Utils').showToast = (message, kind) => toasts.push([message, kind]);
  const label = () => button.children[0].textContent;
  return { env, settings, part, button, section, loader, toasts, label };
}

/** JSZip as a stand-in that zips and hands the file over */
class ZipStub {
  folder() { return { file() {} }; }
  async generateAsync() { return new Blob(['zip']); }
}

describe("the Markdown export's row (#27 slice 3b, change 14)", () => {
  it("Try again takes the row away, moves focus to Export All, which says Exporting… past 400 ms, then a second JSZip failure's words", async () => {
    const slow = deferred();
    const page = await exportPage({ plan: { jszip: ['chunk-missing', slow.promise] } });
    await runUntil(page.env, page.settings.exportAllAsMarkdown());
    assert.equal(page.part.line.textContent, 'Failed to export your notes as Markdown. Please try again.');
    page.part.tryButton.focus();
    page.part.tryButton.click();
    await settle();
    assert.equal(page.part.element.parentNode, null, 'the row goes while it runs');
    assert.equal(page.env.document.activeElement, page.button);
    assert.equal(page.button.getAttribute('aria-disabled'), 'true');
    assert.equal(page.label(), 'Export All (ZIP/MD)');
    page.env.clock.tick(400);
    assert.equal(page.label(), 'Exporting…');
    slow.finish('chunk-missing');
    await settle();
    page.env.clock.tick(300);
    await settle();
    assert.equal(page.label(), 'Export All (ZIP/MD)');
    assert.equal(page.button.getAttribute('aria-disabled'), null);
    assert.equal(page.part.element.parentNode, page.section);
    assert.equal(page.part.line.textContent, 'Failed to export your notes as Markdown again. Export JSON still works.');
    assert.equal(page.part.lineNote.textContent, "Reloading the page may fix it, and doesn't delete your notes.");
    assert.deepEqual(buttonsOf(page.part), ['Try again', 'Reload']);
    assert.equal(page.env.document.activeElement, page.button, 'focus stays on Export All');
    assert.deepEqual(page.toasts, []);
  });

  it("a failure that isn't JSZip's uses the row too, and its Try again keeps the first failure's words", async () => {
    const page = await exportPage({ plan: { jszip: ['loaded'] }, modules: { jszip: ZipStub } });
    page.settings.documentClient = { activeNotes: async () => { throw new Error('the notes could not be read'); } };
    await runUntil(page.env, page.settings.exportAllAsMarkdown());
    assert.equal(page.part.line.textContent, 'Failed to export your notes as Markdown. Please try again.');
    page.part.tryButton.click();
    await runUntil(page.env, settle());
    assert.equal(page.part.line.textContent, 'Failed to export your notes as Markdown. Please try again.');
    assert.deepEqual(buttonsOf(page.part), ['Try again']);
    assert.deepEqual(page.toasts, []);
  });

  it('JSZip that loaded and threw says so with Reload alone, pointing at Export JSON', async () => {
    const page = await exportPage({ plan: { jszip: ['evaluation-failed'] } });
    await runUntil(page.env, page.settings.exportAllAsMarkdown());
    assert.equal(page.part.line.textContent, 'Failed to export your notes as Markdown. Export JSON still works.');
    assert.equal(page.part.lineNote.textContent, "Reloading the page may fix it, and doesn't delete your notes.");
    assert.deepEqual(buttonsOf(page.part), ['Reload']);
  });

  it('an export that works says so as before, and leaves no row', async () => {
    const page = await exportPage({ plan: { jszip: ['loaded'] }, modules: { jszip: ZipStub } });
    page.env.global.URL = { createObjectURL: () => 'blob:zip', revokeObjectURL: () => {} };
    await runUntil(page.env, page.settings.exportAllAsMarkdown());
    assert.equal(page.part.element, null);
    assert.deepEqual(page.toasts, [['All notes exported as ZIP', 'success']]);
  });
});
