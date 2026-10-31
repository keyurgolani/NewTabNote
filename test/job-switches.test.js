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
 * as onboarding leaves them, the Settings controls, and NotesManager with a held AI port,
 * following its jobs' settings through the settings port as App has it do. With `name`, the
 * notes have that title, and with `text`, each holds it.
 * @param {{name?: string, text?: string}} [options]
 */
async function setup({ name = 'Untitled', text } = {}) {
  const env = createLegacyEnv();
  await createDatabase(env.indexedDB, {
    records: {
      canvases: ['A', 'B', 'C'].map((id) => note(id, { name })),
      elements: ['A', 'B', 'C'].map((id, index) => block(`${id.toLowerCase()}1`, id, 0, text === undefined ? TEXT[index] : text)),
    },
  });
  env.load(...FILES);
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
    // The search index handle App gives it (#17 PR 4b)
    storage: env.stores.searchIndex,
    domRefs: null,
    logger: quietLogger,
    llm: ai.port,
    documentClient: env.documentClient,
    settings: env.settingsClient,
  });
  manager.getEditor = () => null;
  manager.followJobSettings();
  const settings = new (env.get('SettingsController'))({
    settings: env.settingsClient,
    documentClient: env.documentClient,
    validateBackup: env.validateBackup,
    domRefs: null,
    logger: quietLogger,
  });
  settings.setupJobSettings();
  settings.setupSettingsSync();
  return { env, ai, manager, controls };
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

  it('a new interval saves only the interval, in one write, and restarts the timer on it', async () => {
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
      [['setting_autoTitleInterval']],
    );
    assert.equal(env.chrome.local.setting_autoTitleInterval, 60);
    assert.notEqual(manager.autoTitleIntervalId, null, 'still on, on the new interval');
    manager.destroy();
  });

  it("a tab whose Settings still shows the switch on doesn't turn it back on when its interval changes", async () => {
    const { env, ai, manager, controls } = await setup();
    // Another tab switched auto-title off; this one's switch still shows on
    await env.chrome.api.storage.local.set({ setting_autoTitleEnabled: false });
    await run(env, 1000);

    controls['auto-title-interval'].value = '30';
    controls['auto-title-interval'].dispatchEvent({ type: 'change' });
    await run(env, 5000);

    assert.equal(env.chrome.local.setting_autoTitleEnabled, false, 'still off');
    assert.equal(env.chrome.local.setting_autoTitleInterval, 30);
    assert.deepEqual(ai.calls, [], 'no note went to the provider');
    assert.equal(manager.autoTitleIntervalId, null);
  });

  for (const [job, setUp, enabledId, intervalId, intervalTo, runKey] of [
    ['auto-title', 'setupAutoTitle', 'auto-title-enabled', 'auto-title-interval', '60', 'setting_lastAutoTitleRun'],
    ['insights', 'setupInsightsExtraction', 'insights-enabled', 'insights-interval', '1440', 'setting_lastInsightsRun'],
  ]) {
    it(`a ${job} switch or interval changed in this tab sets the job up once, so it runs once and records one run`, async () => {
      // Titled notes too short for insights, so each run sends nothing and ends at once
      const { env, ai, manager, controls } = await setup({ name: 'Groceries', text: 'Milk and eggs' });
      await toggle(env, controls[enabledId], false);
      let setUps = 0;
      const original = manager[setUp].bind(manager);
      manager[setUp] = () => {
        setUps += 1;
        return original();
      };
      const runsRecorded = () => env.chrome.writes().filter((write) => write.keys.includes(runKey)).length;
      const before = runsRecorded();

      await toggle(env, controls[enabledId], true);
      assert.equal(setUps, 1, 'switched on: set up once, by the settings change');
      assert.equal(runsRecorded() - before, 1, 'one run, so one run recorded');
      // A run reads each note through #17's adapter since #17 PR 4a, which takes more turns than
      // Storage's reads did, and a run still going skips the next one, so this one ends first
      await waitFor(() => !manager.insightsRunning && !manager.autoTitleRunning, { message: 'the run ended' });

      controls[intervalId].value = intervalTo;
      controls[intervalId].dispatchEvent({ type: 'change' });
      await run(env, 1000);
      assert.equal(setUps, 2, 'a new interval: set up once more');
      assert.equal(runsRecorded() - before, 2);
      assert.deepEqual(ai.calls, [], 'no note went to the provider');
      manager.destroy();
    });
  }

  it('switching auto-title off while its catch-up run goes starts no timer after it', async () => {
    const { env, ai, manager } = await setup();
    // The last run was a day ago, so switching on runs a catch-up first
    await env.chrome.api.storage.local.set({ setting_lastAutoTitleRun: 1 });
    env.clock.tick(2 * 60 * 60 * 1000);
    const setUp = manager.setupAutoTitle();
    await waitFor(() => ai.calls.length === 1, { message: 'the catch-up sent its first note' });
    await env.chrome.api.storage.local.set({ setting_autoTitleEnabled: false });
    await ai.answer('generateTitle', 'Groceries');
    for (let step = 0; step < 20; step++) await run(env, 500);
    await setUp;

    assert.equal(manager.autoTitleIntervalId, null, 'no timer started');
    assert.deepEqual(ai.calls, ['generateTitle']);
  });

  for (const [control, key, from, to] of [
    ['auto-title-enabled', 'setting_autoTitleEnabled', true, false],
    ['auto-title-interval', 'setting_autoTitleInterval', '15', '60'],
    ['insights-interval', 'setting_insightsInterval', '60', '1440'],
  ]) {
    it(`a failed save of ${control} puts that control back to what's stored, and leaves the others`, async () => {
      const { env, controls, manager } = await setup();
      const before = {
        title: controls['auto-title-enabled'].checked,
        insights: controls['insights-enabled'].checked,
        titleInterval: controls['auto-title-interval'].value,
        insightsInterval: controls['insights-interval'].value,
      };
      env.chrome.failNextSet();
      const input = controls[control];
      if (typeof from === 'boolean') input.checked = to;
      else input.value = to;
      input.dispatchEvent({ type: 'change' });
      await run(env, 1000);

      const after = {
        title: controls['auto-title-enabled'].checked,
        insights: controls['insights-enabled'].checked,
        titleInterval: controls['auto-title-interval'].value,
        insightsInterval: controls['insights-interval'].value,
      };
      assert.deepEqual(after, before, 'the control is back, and nothing else moved');
      assert.equal(String(env.chrome.local[key]), String(from === true ? true : from), 'stored as it was');
      const row = env.document.querySelector('.llm-auto-title-interval-row');
      assert.equal(row.classList.contains('hidden'), false, 'the switch is on, so its interval row shows');
      manager.destroy();
    });
  }
});

describe("the jobs' timers wait each interval Settings offers, the longest included", () => {
  /** What Chromium does with a delay past 2^31 - 1 ms: it fires at once */
  const CHROMIUM_LONGEST_MS = 2 ** 31 - 1;

  for (const [job, minutes] of [
    ...[5, 15, 30, 60, 1440, 7200, 10080, 20160, 43200].map((value) => ['autoTitle', value]),
    ...[60, 360, 720, 1440, 10080].map((value) => ['insights', value]),
  ]) {
    it(`${job}, every ${minutes} minutes: once when it starts, then once per interval and never sooner`, async () => {
      const { env, manager } = await setup();
      const delays = [];
      const realSetInterval = env.global.setInterval;
      // A delay past the longest Chromium takes fires at once, as it does in Chromium
      env.global.setInterval = (fn, ms) => {
        delays.push(ms);
        return realSetInterval(fn, ms > CHROMIUM_LONGEST_MS ? 1 : ms);
      };
      let runs = 0;
      const runName = job === 'autoTitle' ? 'runAutoTitle' : 'runInsightsExtraction';
      manager[runName] = () => { runs += 1; };
      if (job === 'autoTitle') manager.startAutoTitleInterval(minutes);
      else manager.startInsightsInterval(minutes);
      const interval = minutes * 60 * 1000;

      assert.equal(runs, 1, 'the run as it starts');
      env.clock.tick(interval - 1);
      assert.equal(runs, 1, 'nothing sooner than the interval');
      env.clock.tick(1);
      assert.equal(runs, 2, 'one run at the interval');
      env.clock.tick(interval);
      assert.equal(runs, 3, 'and one each interval after');
      assert.ok(delays.every((ms) => ms <= CHROMIUM_LONGEST_MS), `every delay fits a timer: ${delays}`);
      manager.destroy();
    });
  }
});
