'use strict';

// NTN-21: the AI features run only when Settings says they do.
// - Settings reads its AI section each time it opens: the provider, the key (masked, and only
//   the key saved for the provider shown), the model, the Ollama URL, and both background jobs
//   (titles and insights) with their intervals and the rows they turn on. Opening it sends no
//   request and writes nothing.
// - A first run leaves both jobs off. An install that ran an earlier version has both turned
//   off once, at its first start, before either can run, in one write with the marker that
//   keeps it from running again, so a job turned back on stays on. A profile whose switch-off
//   already ran, as 1.4.4's own code left it, keeps its jobs as stored.
// - The switches' saves, a job's stop in every tab and mid-run, and the Insights tab are pinned
//   in test/job-switches.test.js and test/smart-tab.test.js.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { IDBFactory } = require('fake-indexeddb');
const {
  createLegacyEnv, createChromeStub, createDatabase, FakeDocument, settle, settingsOf, startEditorClient, note, block,
} = require('./helpers/legacy-env');
const { loadPageModule } = require('./helpers/page-module');

const FILES = [
  'js/utils.js', 'js/core/storage-error.js', 'js/storage.js', 'js/sidebar-utils.js', 'js/blocks.js', 'js/llm.js',
  'js/onboarding.js', 'js/controllers/notes-manager.js', 'js/controllers/ai-chat-controller.js',
  'js/controllers/settings-controller.js',
];
/** 1.4.x's settings code, as 1.4.1 and 1.4.4 both have it, and 1.4.4's onboarding, frozen from its tag */
const RELEASE_141_STORAGE = 'test/fixtures/storage/releases/v1.4.1/js/storage.js';
const RELEASE_144_ONBOARDING = 'test/fixtures/storage/releases/v1.4.4/js/onboarding.js';
const KEY = 'sk-test';
const CHAT = 'https://api.openai.com/v1/chat/completions';
const MINUTE = 60 * 1000;
const STEP = { timeout: 30_000 };
const QUIET = { debug() {}, info() {}, warn() {}, error() {} };
const CONFIGURED = { llmProvider: 'openai', llmApiKey: KEY, llmApiKeyProvider: 'openai', llmModel: 'gpt-4o-mini' };
/** The switch-off's marker, at the key 1.4.4 keeps it under */
const MARKER = 'setting_backgroundJobsOffOnce';
/** An untitled note long enough for both jobs to pick up */
const UNTITLED = {
  canvases: [note('n1', { name: 'Untitled' })],
  elements: [block('b1', 'n1', 0, 'Ship the beta to testers on Friday, then read every reply before the next build.')],
};
/**
 * Settings as an earlier version's first run left them, with a provider set up since: both jobs
 * on, and each last run two days back, so each job has a catch-up due at the next start
 */
const TWO_DAYS_AGO = Date.now() - 2 * 24 * 60 * 60 * 1000;
const EARLIER = {
  ...CONFIGURED, hasCompletedOnboarding: true,
  autoTitleEnabled: true, autoTitleInterval: 15, insightsEnabled: true, insightsInterval: 360,
  lastAutoTitleRun: TWO_DAYS_AGO, lastInsightsRun: TWO_DAYS_AGO,
};

/** `settings` as an earlier session stored them, in chrome.storage.local */
function storedSettings(settings) {
  const chrome = createChromeStub();
  chrome.local.setting_storageInitialized = true;
  for (const [key, value] of Object.entries(settings)) chrome.local[`setting_${key}`] = value;
  return chrome;
}

/**
 * Answer the provider for every page on `chrome`, recording each request in `chrome.requests`:
 * the requests the pages send through the worker's proxy, and the model list's own fetch. Each
 * answer is an empty reply, so a job asks again at its next run.
 */
function answerProvider(chrome) {
  chrome.requests = [];
  const { runtime } = chrome.api;
  const wake = runtime.sendMessage;
  runtime.sendMessage = (message, callback) => {
    if (!message || message.type !== 'API_REQUEST') return wake(message, callback);
    const url = String(message.url);
    chrome.requests.push({ url, method: (message.options && message.options.method) || 'GET' });
    setImmediate(() => callback({ ok: true, status: 200, data: replyFor(url) }));
    return undefined;
  };
}

/** The provider's answer to `url`: a model list, or an empty chat reply */
const replyFor = (url) => (url.endsWith('/models') ? { data: [{ id: 'gpt-4.1' }] } : { choices: [{ message: { content: '' } }] });

/** Settings' AI section as newtab.html has it: every AI row hidden at first */
function buildPage(doc) {
  const add = (parent, tag, props = {}) => {
    const el = doc.createElement(tag);
    for (const [key, value] of Object.entries(props)) {
      if (key === 'className') el.className = value;
      else el[key] = value;
    }
    parent.appendChild(el);
    return el;
  };
  const row = (parent, className) => add(parent, 'div', { className: `setting-row ${className} hidden` });
  const modal = add(doc.body, 'div', { id: 'settings-modal', className: 'modal hidden' });
  add(modal, 'select', { id: 'llm-provider-select', value: 'none' });
  const group = add(row(modal, 'llm-api-key-row'), 'div', { className: 'api-key-input-group' });
  add(group, 'input', { id: 'llm-api-key', type: 'password' });
  const reveal = add(group, 'button', { className: 'icon-btn api-key-toggle-btn', title: 'Show API key' });
  add(reveal, 'svg', { className: 'eye-icon' });
  add(reveal, 'svg', { className: 'eye-off-icon hidden' });
  add(modal, 'p', { className: 'setting-hint api-key-warning llm-api-key-row hidden' });
  add(row(modal, 'llm-ollama-url-row'), 'input', { id: 'ollama-url', type: 'text' });
  add(modal, 'p', { className: 'setting-hint llm-ollama-hint hidden' });
  const modelRow = row(modal, 'llm-model-row');
  add(modelRow, 'select', { id: 'llm-model-select' });
  add(modelRow, 'button', { id: 'refresh-models-btn' });
  // A select's value is its first option's until something picks another
  add(row(modal, 'llm-auto-title-row'), 'input', { id: 'auto-title-enabled', type: 'checkbox', checked: false });
  add(row(modal, 'llm-auto-title-interval-row'), 'select', { id: 'auto-title-interval', value: '5' });
  add(modal, 'p', { className: 'setting-hint llm-auto-title-hint hidden' });
  add(row(modal, 'llm-insights-row'), 'input', { id: 'insights-enabled', type: 'checkbox', checked: false });
  add(row(modal, 'llm-insights-interval-row'), 'select', { id: 'insights-interval', value: '60' });
  add(modal, 'p', { className: 'setting-hint llm-insights-hint hidden' });
}

/**
 * A new tab on `chrome`'s stored settings and `indexedDB`'s notes: its kernel started as the
 * root starts it, LLMService read from storage as App.init reads it, and Settings, AI chat and
 * NotesManager wired as App wires them (App.buildControllers), the jobs not yet set up
 */
async function openPage({ chrome = createChromeStub(), indexedDB = new IDBFactory() } = {}) {
  if (!chrome.requests) answerProvider(chrome);
  const env = createLegacyEnv({ document: new FakeDocument(), chrome, indexedDB });
  env.global.ResizablePanel = class {};
  // The model list asks the provider straight, not through the worker
  env.global.fetch = async (url, options = {}) => {
    chrome.requests.push({ url: String(url), method: options.method || 'GET' });
    const body = replyFor(String(url));
    return { ok: true, status: 200, headers: { get: () => 'application/json' }, json: async () => body, text: async () => JSON.stringify(body) };
  };
  env.load(...FILES);
  buildPage(env.document);
  const Utils = env.get('Utils');
  Utils.showToast = () => {};
  Utils.trapFocus = () => () => {};
  await startEditorClient(env);
  const llm = env.get('LLM');
  await llm.init();
  const { createAIPort } = await loadPageModule(env, 'js/services/ai-port.mjs');
  const notes = new (env.get('NotesManager'))({
    storage: env.stores.searchIndex,
    domRefs: null,
    logger: QUIET,
    llm: createAIPort(),
    documentClient: env.documentClient,
    settings: env.settingsClient,
  });
  notes.getEditor = () => null;
  notes.followJobSettings();
  const ai = new (env.get('AIChatController'))({
    settings: env.settingsClient, domRefs: null, logger: QUIET, llm, documentClient: env.documentClient,
  });
  ai.getEditor = () => null;
  ai.updateAISidebarState = () => {};
  const settings = new (env.get('SettingsController'))({
    settings: env.settingsClient,
    documentClient: env.documentClient,
    validateBackup: env.validateBackup,
    domRefs: null,
    logger: QUIET,
    showAISettings: () => ai.updateLLMSettingsUI(),
  });
  ai.setupLLMSettings();
  settings.setupJobSettings();
  return { env, chrome, llm, notes, ai, settings, doc: env.document, Onboarding: env.get('Onboarding') };
}

/** A new tab's start as App runs it: the jobs' one-time switch-off, then each job's own setup */
async function startTab(shared) {
  const page = await openPage(shared);
  await page.Onboarding.turnBackgroundJobsOffOnce(page.env.settingsClient);
  await page.notes.setupAutoTitle();
  await page.notes.setupInsightsExtraction();
  await runsDone(page);
  return page;
}

/**
 * 1.4.4's own one-time switch-off, frozen from its tag, on 1.4.x's settings code, in a context
 * of its own that shares `chrome`, as 1.4.4's new tab ran it before this update
 */
function release144(chrome, indexedDB) {
  const release = createLegacyEnv({ context: 'page', indexedDB, chrome, worker: false, document: null });
  release.load('js/utils.js', RELEASE_141_STORAGE, RELEASE_144_ONBOARDING);
  return { Storage: release.get('Storage'), Onboarding: release.get('Onboarding') };
}

/** Requests that went to the provider's chat endpoint */
const chats = (page) => page.chrome.requests.filter((r) => r.url === CHAT).length;

/**
 * Let both jobs finish the run they're in. A run waits a second or so between notes on the
 * page's clock, so the clock moves on two seconds at a time until neither job is running.
 */
async function runsDone(page) {
  for (let i = 0; i < 50; i++) {
    await settle(60);
    if (!page.notes.autoTitleRunning && !page.notes.insightsRunning) return;
    page.env.clock.tick(2000);
  }
  throw new Error('the jobs never finished their runs');
}

/** Change a switch or a select the way the user does, then let the save land */
async function change(page, id, value) {
  const el = page.doc.getElementById(id);
  if (typeof value === 'boolean') el.checked = value;
  else el.value = value;
  el.dispatchEvent({ type: 'change' });
  await settle(60);
}

/** Each write since `from` (an index into chrome.writes()), as its keys, sorted */
const writesSince = (page, from) => page.chrome.writes().slice(from).map((w) => w.keys.slice().sort());
/** Every key written since `from` */
const keysWrittenSince = (page, from) => writesSince(page, from).flat();

const value = (page, id) => page.doc.getElementById(id).value;
const shown = (page, selector) => page.doc.querySelectorAll(selector).map((el) => !el.classList.contains('hidden'));
/** A stored setting, read straight from chrome.storage.local */
const stored = (page, key) => settingsOf(page.env).getSetting(key, null);

describe('Settings shows the AI settings in effect', () => {
  it('shows each stored AI setting each time Settings opens, with the rows those settings turn on', STEP, async () => {
    const page = await openPage({
      chrome: storedSettings({
        ...CONFIGURED, autoTitleEnabled: true, autoTitleInterval: 30, insightsEnabled: true, insightsInterval: 720,
      }),
    });
    const writes = page.chrome.writes().length;
    const requests = page.chrome.requests.length;
    await page.settings.openSettingsModal();

    assert.equal(value(page, 'llm-provider-select'), 'openai');
    assert.equal(value(page, 'llm-api-key'), KEY);
    assert.equal(page.doc.getElementById('llm-api-key').type, 'password', 'the key is masked');
    assert.equal(value(page, 'llm-model-select'), 'gpt-4o-mini');
    assert.equal(page.doc.getElementById('auto-title-enabled').checked, true);
    assert.equal(value(page, 'auto-title-interval'), '30');
    assert.equal(page.doc.getElementById('insights-enabled').checked, true);
    assert.equal(value(page, 'insights-interval'), '720');
    assert.deepEqual(shown(page, '.llm-api-key-row'), [true, true], 'the key row and its warning');
    assert.deepEqual(shown(page, '.llm-model-row'), [true]);
    assert.deepEqual(shown(page, '.llm-ollama-url-row'), [false]);
    assert.deepEqual(shown(page, '.llm-ollama-hint'), [false]);
    assert.deepEqual(shown(page, '.llm-auto-title-row'), [true]);
    assert.deepEqual(shown(page, '.llm-auto-title-interval-row'), [true]);
    assert.deepEqual(shown(page, '.llm-auto-title-hint'), [true]);
    assert.deepEqual(shown(page, '.llm-insights-row'), [true]);
    assert.deepEqual(shown(page, '.llm-insights-interval-row'), [true]);
    assert.deepEqual(shown(page, '.llm-insights-hint'), [true]);
    assert.deepEqual(writesSince(page, writes), [], 'opening Settings wrote nothing');
    assert.deepEqual(page.chrome.requests.slice(requests), [], 'opening Settings sent nothing');

    // Another tab turns titles off: the next time Settings opens, it says so
    await settingsOf(page.env).setSetting('autoTitleEnabled', false);
    await settle(60);
    await page.settings.openSettingsModal();
    assert.equal(page.doc.getElementById('auto-title-enabled').checked, false);
    assert.deepEqual(shown(page, '.llm-auto-title-interval-row'), [false], "its interval's row follows it");
    assert.equal(page.doc.getElementById('insights-enabled').checked, true);
  });

  it("shows a local provider's stored URL and model, with both jobs off and their intervals hidden", STEP, async () => {
    const page = await openPage({
      chrome: storedSettings({
        llmProvider: 'ollama', ollamaUrl: 'http://localhost:11500', llmModel: 'llama3.2',
        autoTitleEnabled: false, autoTitleInterval: 60, insightsEnabled: false, insightsInterval: 1440,
      }),
    });
    const requests = page.chrome.requests.length;
    await page.settings.openSettingsModal();

    assert.equal(value(page, 'llm-provider-select'), 'ollama');
    assert.equal(value(page, 'ollama-url'), 'http://localhost:11500');
    assert.equal(value(page, 'llm-model-select'), 'llama3.2');
    assert.equal(page.doc.getElementById('auto-title-enabled').checked, false);
    assert.equal(value(page, 'auto-title-interval'), '60');
    assert.equal(page.doc.getElementById('insights-enabled').checked, false);
    assert.equal(value(page, 'insights-interval'), '1440');
    assert.deepEqual(shown(page, '.llm-api-key-row'), [false, false]);
    assert.deepEqual(shown(page, '.llm-ollama-url-row'), [true]);
    assert.deepEqual(shown(page, '.llm-ollama-hint'), [true]);
    assert.deepEqual(shown(page, '.llm-model-row'), [true]);
    assert.deepEqual(shown(page, '.llm-auto-title-row'), [true]);
    assert.deepEqual(shown(page, '.llm-auto-title-interval-row'), [false]);
    assert.deepEqual(shown(page, '.llm-insights-interval-row'), [false]);
    assert.deepEqual(page.chrome.requests.slice(requests), [], 'opening Settings sent nothing');
  });

  it('draws the key masked each time Settings opens, after it was shown', STEP, async () => {
    const page = await openPage({ chrome: storedSettings(CONFIGURED) });
    await page.settings.openSettingsModal();
    page.doc.querySelector('.api-key-toggle-btn').click();
    assert.equal(page.doc.getElementById('llm-api-key').type, 'text', 'the reveal button shows the key');

    await page.settings.openSettingsModal();
    const reveal = page.doc.querySelector('.api-key-toggle-btn');
    assert.equal(page.doc.getElementById('llm-api-key').type, 'password');
    assert.equal(reveal.title, 'Show API key');
    assert.equal(reveal.querySelector('.eye-icon').classList.contains('hidden'), false);
    assert.equal(reveal.querySelector('.eye-off-icon').classList.contains('hidden'), true);
  });

  it('opening Settings sends nothing and writes nothing, and shows the stored model as its one selected option', STEP, async () => {
    // The fake provider lists only gpt-4.1, so an open that fetched the list would also pick it
    const page = await openPage({ chrome: storedSettings({ ...CONFIGURED, autoTitleEnabled: true, insightsEnabled: true }) });
    const writes = page.chrome.writes().length;
    const requests = page.chrome.requests.length;
    await page.settings.openSettingsModal();
    await settle(60);

    assert.deepEqual(page.chrome.requests.slice(requests), [], 'opening Settings sent nothing');
    assert.deepEqual(writesSince(page, writes), [], 'opening Settings wrote nothing');
    assert.equal(await stored(page, 'llmModel'), 'gpt-4o-mini');
    const options = page.doc.getElementById('llm-model-select').children
      .map((o) => ({ value: o.value, text: o.textContent, selected: o.selected }));
    assert.deepEqual(options, [{ value: 'gpt-4o-mini', text: 'GPT-4o Mini', selected: true }]);
    assert.equal(value(page, 'llm-model-select'), 'gpt-4o-mini');
  });

  it('the key field shows only the key saved for the provider shown', STEP, async () => {
    const page = await openPage({
      chrome: storedSettings({
        llmProvider: 'openai', llmApiKey: 'test-key-of-another-provider', llmApiKeyProvider: 'anthropic', llmModel: 'gpt-4o-mini',
      }),
    });
    await page.settings.openSettingsModal();
    assert.equal(value(page, 'llm-provider-select'), 'openai');
    assert.equal(value(page, 'llm-api-key'), '', "another provider's key isn't shown");
  });

  it('loads the model list when the user asks for it with the refresh button', STEP, async () => {
    const page = await openPage({ chrome: storedSettings(CONFIGURED) });
    await page.settings.openSettingsModal();
    const requests = page.chrome.requests.length;
    page.doc.getElementById('refresh-models-btn').click();
    await settle(60);

    assert.deepEqual(page.chrome.requests.slice(requests).map((r) => r.url), ['https://api.openai.com/v1/models']);
    assert.deepEqual(page.doc.getElementById('llm-model-select').children.map((o) => o.value), ['gpt-4.1']);
  });
});

describe('a first run', () => {
  it('leaves both background jobs off, and marks their one-time switch-off as done', STEP, async () => {
    const page = await openPage();
    await page.Onboarding.setupFirstRun(page.env.settingsClient);
    await settle(60);

    assert.equal(await stored(page, 'autoTitleEnabled'), false);
    assert.equal(await stored(page, 'insightsEnabled'), false);
    assert.equal(await stored(page, 'embeddingsEnabled'), true);
    assert.equal(page.chrome.local[MARKER], true, 'the switch-off is marked as done');
  });
});

describe('an install that ran an earlier version', () => {
  it('has both background jobs turned off at its first start, before either runs, and marked as done', STEP, async () => {
    const indexedDB = new IDBFactory();
    await createDatabase(indexedDB, { records: UNTITLED });
    const page = await startTab({ chrome: storedSettings(EARLIER), indexedDB });

    assert.equal(await stored(page, 'autoTitleEnabled'), false);
    assert.equal(await stored(page, 'insightsEnabled'), false);
    assert.equal(page.chrome.local[MARKER], true, 'the switch-off is marked as done');
    assert.equal(page.notes.autoTitleIntervalId, null, 'titles never started');
    assert.equal(page.notes.insightsIntervalId, null, 'insights never started');
    assert.equal(chats(page), 0, 'nothing went to the provider');
    page.env.clock.tick(8 * 60 * MINUTE);
    await settle(60);
    assert.equal(chats(page), 0, 'nor later, past both intervals');
  });

  it('writes both switches and the marker in one write', STEP, async () => {
    const page = await openPage({ chrome: storedSettings(EARLIER) });
    const from = page.chrome.writes().length;
    assert.equal(await page.Onboarding.turnBackgroundJobsOffOnce(page.env.settingsClient), true, 'it turned them off');
    await settle(60);

    assert.deepEqual(writesSince(page, from), [[MARKER, 'setting_autoTitleEnabled', 'setting_insightsEnabled'].sort()]);
  });

  it('turns them off only once: a job turned back on stays on at every later start', STEP, async () => {
    const indexedDB = new IDBFactory();
    await createDatabase(indexedDB, { records: UNTITLED });
    const shared = { chrome: storedSettings(EARLIER), indexedDB };
    const first = await startTab(shared);
    await first.settings.openSettingsModal();
    await change(first, 'auto-title-enabled', true);
    await runsDone(first);
    assert.equal(await stored(first, 'autoTitleEnabled'), true, 'the user turned titles back on');

    for (const start of ['the second start', 'the third start']) {
      const page = await startTab(shared);
      assert.equal(await stored(page, 'autoTitleEnabled'), true, `titles stay on at ${start}`);
      assert.equal(await stored(page, 'insightsEnabled'), false, `insights stay off at ${start}`);
      assert.notEqual(page.notes.autoTitleIntervalId, null, `titles run at ${start}`);
      assert.equal(page.notes.insightsIntervalId, null, `insights don't at ${start}`);
    }
  });

  it("when it can't read whether the switch-off ran, it writes nothing and rejects", STEP, async () => {
    const page = await openPage({ chrome: storedSettings(EARLIER) });
    const from = page.chrome.writes().length;
    page.chrome.failNextGet();
    await assert.rejects(
      () => page.Onboarding.turnBackgroundJobsOffOnce(page.env.settingsClient),
      (error) => /couldn't read getWorkspaceData/.test(error.message),
    );
    await settle(60);

    assert.deepEqual(writesSince(page, from), [], 'it wrote nothing');
    assert.equal(await stored(page, 'autoTitleEnabled'), true, 'the switches are as they were');
    assert.equal(page.chrome.local[MARKER], undefined, 'and nothing marks it done');
  });

  it('reads the marker at the key the version before kept it under', STEP, async () => {
    const page = await openPage({ chrome: storedSettings({ ...EARLIER, backgroundJobsOffOnce: true }) });
    assert.deepEqual(await page.env.settingsClient.workspaceData(['backgroundJobsOffOnce']), { backgroundJobsOffOnce: true });
  });
});

describe('an install that ran 1.4.4', () => {
  it('keeps both jobs as stored when the version before already turned them off once', STEP, async () => {
    const indexedDB = new IDBFactory();
    await createDatabase(indexedDB, { records: UNTITLED });
    const chrome = storedSettings(EARLIER);
    // 1.4.4's own switch-off at its first start, then titles turned back on in its Settings
    const old = release144(chrome, indexedDB);
    assert.equal(await old.Onboarding.turnBackgroundJobsOffOnce(), true, "1.4.4's switch-off ran");
    await old.Storage.setSetting('autoTitleEnabled', true);
    assert.equal(chrome.local[MARKER], true, '1.4.4 left its marker');

    // This build's first start on that profile
    const page = await openPage({ chrome, indexedDB });
    const from = page.chrome.writes().length;
    assert.equal(await page.Onboarding.turnBackgroundJobsOffOnce(page.env.settingsClient), false, 'there was nothing to turn off');
    await page.notes.setupAutoTitle();
    await page.notes.setupInsightsExtraction();
    await runsDone(page);

    const written = keysWrittenSince(page, from);
    for (const key of ['setting_autoTitleEnabled', 'setting_insightsEnabled', MARKER]) {
      assert.equal(written.includes(key), false, `${key} wasn't written`);
    }
    assert.equal(await stored(page, 'autoTitleEnabled'), true, 'titles stay on');
    assert.equal(await stored(page, 'insightsEnabled'), false, 'insights stay off');
    assert.notEqual(page.notes.autoTitleIntervalId, null, 'titles run');
    assert.equal(page.notes.insightsIntervalId, null, "insights don't");
  });
});
