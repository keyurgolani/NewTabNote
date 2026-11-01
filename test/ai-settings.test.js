'use strict';

// NTN-21: the AI features run only when Settings and the AI sidebar say they do.
// - Settings reads its AI section from storage each time it opens: the provider, the key
//   (masked), the model, the Ollama URL, and both background jobs (titles and insights) with
//   their intervals and the rows they turn on. Opening it sends no request and writes nothing.
// - Each job's switch and interval save the moment the user changes them, and start, stop or
//   restart the job. A job whose stored switch turns off stops in every open new tab.
// - A first run leaves both jobs off.
// - The AI sidebar's Insights tab reads the note only while the sidebar is open.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { IDBFactory } = require('fake-indexeddb');
const {
  createLegacyEnv, createChromeStub, createLockManager, createChannelBus, createDatabase, settle, note, block,
} = require('./helpers/legacy-env');

const FILES = [
  'js/utils.js', 'js/core/storage-error.js', 'js/storage.js', 'js/llm.js', 'js/onboarding.js',
  'js/controllers/notes-manager.js', 'js/controllers/ai-chat-controller.js', 'js/controllers/settings-controller.js',
];
const KEY = 'sk-test';
const CHAT = 'https://api.openai.com/v1/chat/completions';
const MINUTE = 60 * 1000;
const QUIET = { debug() {}, info() {}, warn() {}, error() {} };
const CONFIGURED = { llmProvider: 'openai', llmApiKey: KEY, llmModel: 'gpt-4o-mini' };
/** An untitled note long enough for both jobs to pick up */
const UNTITLED = {
  canvases: [note('n1', { name: 'Untitled' })],
  elements: [block('b1', 'n1', 0, 'Ship the beta to testers on Friday, then read every reply before the next build.')],
};

/** `settings` as an earlier session stored them, in chrome.storage.local */
function storedSettings(settings) {
  const chrome = createChromeStub();
  chrome.local.setting_storageInitialized = true;
  for (const [key, value] of Object.entries(settings)) chrome.local[`setting_${key}`] = value;
  return chrome;
}

/** Settings' AI section and the AI sidebar, as newtab.html has them: every AI row hidden at first */
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
  add(doc.body, 'div', { id: 'ai-sidebar', className: 'ai-sidebar hidden' });
  add(doc.body, 'button', { id: 'ai-floating-btn' });
}

/**
 * A new tab on `chrome`'s stored settings and `indexedDB`'s notes, with Settings, the AI
 * controller and NotesManager wired the way App wires them (js/app.js initAIChatController
 * and initSettingsController). `fetch` records each request and answers with an empty reply,
 * so a job asks the provider again at its next run.
 */
async function openPage({ chrome = createChromeStub(), indexedDB, locks, channels } = {}) {
  const env = createLegacyEnv({ chrome, indexedDB, locks, channels });
  const requests = [];
  env.global.fetch = async (url, options = {}) => {
    requests.push({ url: String(url), method: options.method || 'GET' });
    const body = String(url).endsWith('/models') ? { data: [{ id: 'gpt-4.1' }] } : { choices: [{ message: { content: '' } }] };
    return { ok: true, status: 200, headers: { get: () => 'application/json' }, json: async () => body, text: async () => JSON.stringify(body) };
  };
  // The jobs read a block's text in a document of their own; its text without its tags stands in for that here
  env.document.implementation = {
    createHTMLDocument: () => ({
      createElement: () => {
        let text = '';
        return { set innerHTML(html) { text = String(html).replace(/<[^>]*>/g, ''); }, get textContent() { return text; } };
      },
    }),
  };
  env.load(...FILES);
  buildPage(env.document);
  const Storage = env.get('Storage');
  await Storage.init();
  const llm = env.get('LLM');
  await llm.init();
  const deps = { storage: Storage, eventBus: null, domRefs: null, logger: QUIET };
  const notes = new (env.get('NotesManager'))({ ...deps, llm });
  const ai = new (env.get('AIChatController'))({ ...deps, llm });
  const settings = new (env.get('SettingsController'))(deps);
  ai.getEditor = () => null;
  ai.onUpdateAutoTitleSettings = (enabled, interval) => notes.updateAutoTitleSettings(enabled, interval);
  ai.onUpdateInsightsSettings = (enabled, interval) => notes.updateInsightsSettings(enabled, interval);
  settings.onUpdateLLMSettingsUI = () => ai.updateLLMSettingsUI();
  settings.onSetupAutoTitle = () => notes.setupAutoTitle();
  settings.onSetupInsightsExtraction = () => notes.setupInsightsExtraction();
  ai.setupLLMSettings();
  return { env, chrome, Storage, llm, notes, ai, settings, requests, doc: env.document };
}

/** Requests that went to the provider's chat endpoint */
const chats = (page) => page.requests.filter((r) => r.url === CHAT).length;

/** Let `ms` pass on the page's clock, `step` at a time, letting the runs its timers start finish */
async function pass(page, ms, step = 5 * MINUTE) {
  for (let done = 0; done < ms; done += step) {
    page.env.clock.tick(Math.min(step, ms - done));
    await settle(60);
  }
}

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

/** The running timer's period for `id`, in ms, or null when there's none */
function periodOf(page, id) {
  const timer = id === null || id === undefined ? null : page.env.clock.timers.get(Number(id));
  return timer ? timer.interval : null;
}

/** Change a switch or a select the way the user does, then let the save land */
async function change(page, id, value) {
  const el = page.doc.getElementById(id);
  if (typeof value === 'boolean') el.checked = value;
  else el.value = value;
  el.dispatchEvent({ type: 'change' });
  await settle(60);
}

/** The keys written since `from` (an index into chrome.writes()) */
const writtenSince = (page, from) => page.chrome.writes().slice(from).flatMap((w) => w.keys);

const value = (page, id) => page.doc.getElementById(id).value;
const shown = (page, selector) => page.doc.querySelectorAll(selector).map((el) => !el.classList.contains('hidden'));

describe('Settings shows the AI settings in effect', () => {
  it('shows each stored AI setting each time Settings opens, with the rows those settings turn on', async () => {
    const page = await openPage({
      chrome: storedSettings({
        ...CONFIGURED, autoTitleEnabled: true, autoTitleInterval: 30, insightsEnabled: true, insightsInterval: 720,
      }),
    });
    const writes = page.chrome.writes().length;
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
    assert.deepEqual(writtenSince(page, writes), [], 'opening Settings wrote nothing');
    assert.deepEqual(page.requests, [], 'opening Settings sent nothing');
  });

  it("shows a local provider's stored URL and model, with both jobs off and their intervals hidden", async () => {
    const page = await openPage({
      chrome: storedSettings({
        llmProvider: 'ollama', ollamaUrl: 'http://localhost:11500', llmModel: 'llama3.2',
        autoTitleEnabled: false, autoTitleInterval: 60, insightsEnabled: false, insightsInterval: 1440,
      }),
    });
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
    assert.deepEqual(page.requests, [], 'opening Settings sent nothing');
  });

  it('draws the key masked each time Settings opens, after it was shown', async () => {
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

  it("loads the AI section with no request and no write, showing the stored model as it's stored", async () => {
    // The fake provider lists only gpt-4.1, so a load that fetched the list would also pick it
    const page = await openPage({ chrome: storedSettings({ ...CONFIGURED, autoTitleEnabled: true, insightsEnabled: true }) });
    const writes = page.chrome.writes().length;
    await page.ai.updateLLMSettingsUI();
    await settle(60);

    assert.deepEqual(page.requests, [], 'the AI section sent nothing');
    assert.deepEqual(writtenSince(page, writes), [], 'the AI section wrote nothing');
    assert.equal(await page.Storage.getSetting('llmModel', null), 'gpt-4o-mini');
    assert.equal(value(page, 'llm-model-select'), 'gpt-4o-mini');
    const options = page.doc.getElementById('llm-model-select').children.map((o) => ({ value: o.value, text: o.textContent, selected: o.selected }));
    assert.deepEqual(options, [{ value: 'gpt-4o-mini', text: 'GPT-4o Mini', selected: true }]);
  });

  it('loads the model list when the user asks for it with the refresh button', async () => {
    const page = await openPage({ chrome: storedSettings(CONFIGURED) });
    await page.settings.openSettingsModal();
    page.doc.getElementById('refresh-models-btn').click();
    await settle(60);

    assert.deepEqual(page.requests.map((r) => r.url), ['https://api.openai.com/v1/models']);
    assert.deepEqual(page.doc.getElementById('llm-model-select').children.map((o) => o.value), ['gpt-4.1']);
  });
});

describe("Settings saves each background job's switch and interval as the user changes them", () => {
  for (const job of [
    { name: 'the titles job', toggle: 'auto-title-enabled', select: 'auto-title-interval', enabled: 'autoTitleEnabled', interval: 'autoTitleInterval', timer: 'autoTitleIntervalId', setup: 'setupAutoTitle', row: '.llm-auto-title-interval-row', minutes: 15, next: '30' },
    { name: 'the insights job', toggle: 'insights-enabled', select: 'insights-interval', enabled: 'insightsEnabled', interval: 'insightsInterval', timer: 'insightsIntervalId', setup: 'setupInsightsExtraction', row: '.llm-insights-interval-row', minutes: 360, next: '720' },
  ]) {
    /** A new tab whose stored `job` is on or off, with the provider configured, started as App starts it */
    const start = async (on) => {
      const factory = new IDBFactory();
      await createDatabase(factory, { records: UNTITLED });
      const page = await openPage({
        chrome: storedSettings({ ...CONFIGURED, [job.enabled]: on, [job.interval]: job.minutes }),
        indexedDB: factory,
      });
      await page.notes[job.setup]();
      await runsDone(page);
      await page.settings.openSettingsModal();
      return page;
    };

    it(`turning ${job.name} off saves it, stops its timer, and nothing more goes to the provider`, async () => {
      const page = await start(true);
      assert.ok(chats(page) >= 1, `${job.name} ran at the start`);
      const running = chats(page);
      await pass(page, job.minutes * MINUTE);
      await runsDone(page);
      assert.ok(chats(page) > running, `${job.name} runs on its timer`);

      const writes = page.chrome.writes().length;
      await change(page, job.toggle, false);

      assert.equal(await page.Storage.getSetting(job.enabled, null), false, 'the switch saved');
      assert.equal(page.notes[job.timer], null, `${job.name} stopped`);
      assert.deepEqual(writtenSince(page, writes).sort(), [`setting_${job.enabled}`, `setting_${job.interval}`].sort(), "only the user's change wrote");
      const sent = chats(page);
      await pass(page, 4 * job.minutes * MINUTE);
      assert.equal(chats(page), sent, 'nothing more went to the provider');
    });

    it(`turning ${job.name} on with the provider configured saves it and starts it`, async () => {
      const page = await start(false);
      assert.equal(page.notes[job.timer], null, `${job.name} is off`);
      assert.equal(chats(page), 0);

      await change(page, job.toggle, true);
      await runsDone(page);

      assert.equal(await page.Storage.getSetting(job.enabled, null), true, 'the switch saved');
      assert.equal(periodOf(page, page.notes[job.timer]), job.minutes * MINUTE, `${job.name} runs on its interval`);
      assert.ok(chats(page) >= 1, `${job.name} ran at once`);
      assert.deepEqual(shown(page, job.row), [true], 'its interval shows');
    });

    it(`changing ${job.name}'s interval saves it and restarts its timer on the new interval`, async () => {
      const page = await start(true);
      const before = page.notes[job.timer];
      assert.equal(periodOf(page, before), job.minutes * MINUTE);

      await change(page, job.select, job.next);
      await runsDone(page);

      assert.equal(await page.Storage.getSetting(job.interval, null), Number(job.next), 'the interval saved');
      assert.notEqual(page.notes[job.timer], before, 'the timer restarted');
      assert.equal(periodOf(page, page.notes[job.timer]), Number(job.next) * MINUTE);
      assert.equal(periodOf(page, before), null, 'the old timer is gone');
    });
  }

  it('stops a job in another open new tab once its stored switch is off', async () => {
    const chrome = storedSettings({
      ...CONFIGURED, autoTitleEnabled: true, autoTitleInterval: 15, insightsEnabled: true, insightsInterval: 360,
    });
    const factory = new IDBFactory();
    await createDatabase(factory, { records: UNTITLED });
    const shared = { chrome, indexedDB: factory, locks: createLockManager(), channels: createChannelBus() };
    const first = await openPage(shared);
    const second = await openPage(shared);
    second.settings.setupSettingsSync();
    await second.notes.setupAutoTitle();
    await second.notes.setupInsightsExtraction();
    await runsDone(second);
    assert.notEqual(second.notes.autoTitleIntervalId, null, 'titles run in the other tab');
    assert.notEqual(second.notes.insightsIntervalId, null, 'insights run in the other tab');

    // The first tab turns both off, and chrome.storage.onChanged tells every open page
    await first.notes.updateAutoTitleSettings(false, 15);
    await first.notes.updateInsightsSettings(false, 360);
    const changes = {
      setting_autoTitleEnabled: { oldValue: true, newValue: false },
      setting_insightsEnabled: { oldValue: true, newValue: false },
    };
    for (const listener of chrome.api.storage.onChanged.listeners.slice()) listener(changes, 'local');
    await settle(60);

    assert.equal(second.notes.autoTitleIntervalId, null, 'titles stopped in the other tab');
    assert.equal(second.notes.insightsIntervalId, null, 'insights stopped in the other tab');
    const sent = chats(second);
    await pass(second, 8 * 60 * MINUTE);
    assert.equal(chats(second), sent, 'nothing more went to the provider from the other tab');
  });
});

describe('a first run', () => {
  it('leaves both background jobs off', async () => {
    const env = createLegacyEnv();
    env.load(...FILES);
    const Storage = env.get('Storage');
    await Storage.init();
    await env.get('Onboarding').setupFirstRun();
    await settle();

    assert.equal(await Storage.getSetting('autoTitleEnabled', null), false);
    assert.equal(await Storage.getSetting('insightsEnabled', null), false);
  });
});

describe("the AI sidebar's Insights tab", () => {
  /** A new tab on a note, with the provider configured and the AI sidebar shut */
  const start = async () => {
    const page = await openPage({ chrome: storedSettings(CONFIGURED) });
    const editor = {
      noteId: 'n1',
      noteData: { id: 'n1', name: 'Launch' },
      titleEl: { textContent: 'Launch' },
      getAllBlocksTextContent: () => 'Ship the beta to testers on Friday, then read every reply.',
    };
    page.ai.getEditor = () => editor;
    return page;
  };

  it('reads the note on an edit while the sidebar is open on it', async () => {
    const page = await start();
    page.ai.openAISidebar();
    page.ai.switchAITab('smart');
    await settle(60);
    const opened = chats(page);
    assert.equal(opened, 1, 'showing the tab reads the note');

    // An edit, as App's editor change handler reports it
    await page.ai.updateSmartSuggestions();
    assert.equal(chats(page), opened + 1, 'an edit reads it again');
  });

  it('sends nothing to the provider once the sidebar is closed, after showing the tab', async () => {
    const page = await start();
    page.ai.openAISidebar();
    page.ai.switchAITab('smart');
    await settle(60);
    const opened = chats(page);
    page.ai.closeAISidebar();

    await page.ai.updateSmartSuggestions();
    await page.ai.updateSmartSuggestions(true);
    assert.equal(chats(page), opened, 'nothing went to the provider with the sidebar closed');
  });
});
