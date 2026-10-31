'use strict';

// #12 slice 6, the privacy fix: Settings' auto-title and insights switches and intervals save
// through the settings port, and switching one off stops every further provider call for note
// text at once, in this tab and in the others. Before it, the controls had no change listener
// (their wiring was App.setupLLMSettings, which nothing called), so a user with a provider
// couldn't stop note text going to it once onboarding switched both on.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  createLegacyEnv, createDatabase, settle, waitFor, note, block, startEditorClient,
} = require('./helpers/legacy-env');

const FILES = [
  'js/utils.js',
  'js/core/storage-error.js',
  'js/storage.js',
  'js/sidebar-utils.js',
  'js/blocks.js',
  'js/controllers/notes-manager.js',
  'js/controllers/settings-controller.js',
];

const TEXT = [
  'Milk, eggs, and bread for the week, and the bakery on Sunday morning, before the market closes',
  'Quarterly review notes: revenue up, hiring paused until the spring, and the offsite moved to May',
  'Trip plan: the train on Friday, the museum on Saturday, and dinner with the cousins on Sunday',
];

const quietLogger = { debug() {}, info() {}, warn() {}, error() {} };

/**
 * A stub AI port that records each call and holds it until the test answers, so a run is
 * caught between two notes
 */
function heldAI() {
  const calls = [];
  const waiting = [];
  const hold = (method) => (...args) => {
    calls.push(method);
    return new Promise((resolve) => waiting.push({ method, resolve }));
  };
  return {
    calls,
    port: {
      isConfigured: () => true,
      generateTitle: hold('generateTitle'),
      extractInsights: hold('extractInsights'),
    },
    /** Wait for a call of `method`, then answer it */
    async answer(method, value) {
      const found = await waitFor(() => waiting.find((entry) => entry.method === method), { message: `a ${method} call` });
      waiting.splice(waiting.indexOf(found), 1);
      found.resolve(value);
    },
  };
}

/**
 * A new tab with three untitled notes that hold enough text for both jobs, both switched on
 * as onboarding leaves them, the Settings controls, NotesManager with a held AI port, and
 * SettingsController wired to it as App wires them
 */
async function setup() {
  const env = createLegacyEnv();
  await createDatabase(env.indexedDB, {
    records: {
      canvases: ['A', 'B', 'C'].map((id) => note(id, { name: 'Untitled' })),
      elements: ['A', 'B', 'C'].map((id, index) => block(`${id.toLowerCase()}1`, id, 0, TEXT[index])),
    },
  });
  env.load(...FILES);
  const Storage = env.get('Storage');
  await Storage.init();
  // After the first run's defaults, which switch both off
  Object.assign(env.chrome.local, {
    setting_autoTitleEnabled: true,
    setting_autoTitleInterval: 15,
    setting_insightsEnabled: true,
    setting_insightsInterval: 60,
  });
  await startEditorClient(env);
  env.get('Utils').showToast = () => {};

  const controls = env.document.stub([
    { id: 'auto-title-enabled', tag: 'input' },
    { id: 'auto-title-interval', tag: 'select' },
    { id: 'insights-enabled', tag: 'input' },
    { id: 'insights-interval', tag: 'select' },
  ]);
  for (const row of ['llm-auto-title-interval-row', 'llm-insights-interval-row']) {
    env.document.body.appendChild(env.document.createElement('div')).className = `setting-row ${row}`;
  }
  Object.assign(controls['auto-title-enabled'], { checked: true });
  Object.assign(controls['auto-title-interval'], { value: '15' });
  Object.assign(controls['insights-enabled'], { checked: true });
  Object.assign(controls['insights-interval'], { value: '60' });

  const ai = heldAI();
  const manager = new (env.get('NotesManager'))({
    storage: Storage,
    domRefs: null,
    logger: quietLogger,
    llm: ai.port,
    documentClient: env.documentClient,
  });
  manager.getEditor = () => null;
  const settings = new (env.get('SettingsController'))({
    storage: Storage,
    settings: env.settingsClient,
    domRefs: null,
    logger: quietLogger,
  });
  settings.onSetupAutoTitle = () => manager.setupAutoTitle();
  settings.onSetupInsightsExtraction = () => manager.setupInsightsExtraction();
  settings.setupJobSettings();
  settings.setupSettingsSync();
  return { env, Storage, ai, manager, controls };
}

/** Keep the page's timers and promises moving for `ms` of page time, half a second a step */
async function run(env, ms) {
  for (let elapsed = 0; elapsed < ms; elapsed += 500) {
    env.clock.tick(500);
    await settle(2);
  }
}

/** Flip a Settings switch the way a click does */
async function toggle(env, input, checked) {
  input.checked = checked;
  input.dispatchEvent({ type: 'change' });
  await run(env, 1000);
}

describe('the auto-title and insights switches stop provider calls at once (privacy fix)', () => {
  it('switching auto-title off mid-run sends no other note to the provider, now or on a later tick', async () => {
    const { env, ai, manager, controls } = await setup();
    manager.setupAutoTitle();
    await waitFor(() => ai.calls.length === 1, { message: 'the first note sent' });

    await toggle(env, controls['auto-title-enabled'], false);
    await ai.answer('generateTitle', 'Groceries');
    // The rest of the run, and two of its 15-minute ticks
    await run(env, 40 * 60 * 1000);

    assert.deepEqual(ai.calls, ['generateTitle'], 'only the note already sent went to the provider');
    assert.equal(manager.autoTitleIntervalId, null, 'its timer stopped');
    assert.equal(env.chrome.local.setting_autoTitleEnabled, false, 'saved, under the key 1.4.x reads');
    assert.equal(env.chrome.local.setting_autoTitleInterval, 15);
    const row = env.document.querySelector('.llm-auto-title-interval-row');
    assert.equal(row.classList.contains('hidden'), true, 'its interval row hides');
  });

  it('switching insights off mid-run sends no other note to the provider, now or on a later tick', async () => {
    const { env, ai, manager, controls } = await setup();
    manager.setupInsightsExtraction();
    await waitFor(() => ai.calls.length === 1, { message: 'the first note sent' });

    await toggle(env, controls['insights-enabled'], false);
    await ai.answer('extractInsights', { todos: ['Buy milk'] });
    await run(env, 3 * 60 * 60 * 1000);

    assert.deepEqual(ai.calls, ['extractInsights']);
    assert.equal(manager.insightsIntervalId, null);
    assert.equal(env.chrome.local.setting_insightsEnabled, false);
  });

  it('another tab switching auto-title off stops this tab too, its run in flight included', async () => {
    const { env, ai, manager } = await setup();
    manager.setupAutoTitle();
    await waitFor(() => ai.calls.length === 1, { message: 'the first note sent' });

    // The other tab's settings port writes the key; chrome.storage tells this tab
    await env.chrome.api.storage.local.set({ setting_autoTitleEnabled: false });
    await run(env, 1000);
    await ai.answer('generateTitle', 'Groceries');
    await run(env, 40 * 60 * 1000);

    assert.deepEqual(ai.calls, ['generateTitle']);
    assert.equal(manager.autoTitleIntervalId, null);
  });

  it('a new interval saves with the switch, in one write, and restarts the timer on it', async () => {
    const { env, ai, manager, controls } = await setup();
    manager.setupAutoTitle();
    await waitFor(() => ai.calls.length === 1, { message: 'the first note sent' });
    // The run names all three notes, a second apart
    for (let i = 0; i < 3; i++) {
      for (let step = 0; step < 40 && ai.calls.length <= i; step++) await run(env, 500);
      await ai.answer('generateTitle', `Title ${i}`);
    }
    await run(env, 2000);
    assert.equal(ai.calls.length, 3, 'switched on, every untitled note went');
    const writes = env.chrome.writes().length;

    controls['auto-title-interval'].value = '60';
    controls['auto-title-interval'].dispatchEvent({ type: 'change' });
    await run(env, 1000);

    assert.deepEqual(
      env.chrome.writes().slice(writes, writes + 1).map((write) => write.keys.slice().sort()),
      [['setting_autoTitleEnabled', 'setting_autoTitleInterval']],
    );
    assert.equal(env.chrome.local.setting_autoTitleInterval, 60);
    assert.notEqual(manager.autoTitleIntervalId, null, 'still on, on the new interval');
    manager.destroy();
  });
});
