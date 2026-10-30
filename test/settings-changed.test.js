// #13's settings.changed notice (#13, "Current problem", settings row, and "Security and
// privacy"): Storage.onSettingsChange tells its listeners which settings changed, by key name
// only, and never a value, so no listener is handed llmApiKey's old or new value. Consumers
// read the values they need again.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { createLegacyEnv, createDatabase, FakeDocument, settle, plain } = require('./helpers/legacy-env');

const FILES = ['js/utils.js', 'js/core/storage-error.js', 'js/storage.js', 'js/controllers/settings-controller.js'];

async function setup() {
  const env = createLegacyEnv({ document: new FakeDocument() });
  await createDatabase(env.indexedDB, {});
  env.load(...FILES);
  const Storage = env.get('Storage');
  await Storage.init();
  /** Tells every onChanged listener what chrome.storage reported, as Chrome does */
  const report = (changes, area = 'local') => {
    env.chrome.api.storage.onChanged.listeners.slice().forEach((listener) => listener(changes, area));
  };
  return { env, Storage, report };
}

const SECRET_OLD = 'sk-test-old-0000';
const SECRET_NEW = 'sk-test-new-1111';

describe('settings.changed (#13)', () => {
  it('names the settings that changed and nothing else: no old or new value, llmApiKey included', async () => {
    const { Storage, report } = await setup();
    const heard = [];
    Storage.onSettingsChange((notice) => heard.push(notice));
    report({
      setting_llmApiKey: { oldValue: SECRET_OLD, newValue: SECRET_NEW },
      setting_theme: { oldValue: 'light', newValue: 'dark' },
      canvases_cache: { newValue: 'not a setting' },
    });
    report({ setting_theme: { newValue: 'dark' } }, 'sync');
    report({ unrelated: { newValue: 1 } });
    assert.deepEqual(plain(heard), [{ type: 'settings.changed', keys: ['llmApiKey', 'theme'] }]);
    const text = JSON.stringify(heard);
    assert.equal(text.includes(SECRET_OLD) || text.includes(SECRET_NEW), false);
    assert.ok(Object.isFrozen(heard[0]) && Object.isFrozen(heard[0].keys));
  });

  it('lets Settings read again the values it applies, so a change from another tab still lands', async () => {
    const { env, Storage, report } = await setup();
    const SettingsController = env.get('SettingsController');
    const settings = new SettingsController({ storage: Storage, domRefs: null, logger: null });
    const applied = [];
    settings.onSidebarStateChanged = (key, value) => applied.push(['sidebar', key, value]);
    settings.onAISidebarWidthChanged = (value) => applied.push(['aiSidebarWidth', value]);
    settings.onAIPromptTemplatesChanged = (value) => applied.push(['aiPromptTemplates', value]);
    settings.onLLMSettingsChanged = () => applied.push(['llm']);
    settings.setupSettingsSync();

    // Another tab writes, and this tab hears of it
    await new Promise((resolve) => env.chrome.api.storage.local.set({
      setting_sidebarWidth: 320,
      setting_aiSidebarWidth: 410,
      setting_aiPromptTemplates: [{ id: 't1', label: 'Sum', prompt: 'Summarize' }],
      setting_llmApiKey: SECRET_NEW,
    }, resolve));
    report({
      setting_sidebarWidth: { oldValue: 280, newValue: 320 },
      setting_aiSidebarWidth: { newValue: 410 },
      setting_aiPromptTemplates: { newValue: [] },
      setting_llmApiKey: { oldValue: SECRET_OLD, newValue: SECRET_NEW },
    });
    for (let tries = 0; applied.length < 4 && tries < 50; tries += 1) await settle();
    assert.deepEqual(plain(applied), [
      ['sidebar', 'sidebarWidth', 320],
      ['aiSidebarWidth', 410],
      ['llm'],
      ['aiPromptTemplates', [{ id: 't1', label: 'Sum', prompt: 'Summarize' }]],
    ]);
  });
  it("applies nothing for a setting it couldn't read again, rather than a missing value", async () => {
    const { env, Storage, report } = await setup();
    const SettingsController = env.get('SettingsController');
    const settings = new SettingsController({ storage: Storage, domRefs: null, logger: null });
    const applied = [];
    settings.onSidebarStateChanged = (key, value) => applied.push([key, value]);
    settings.setupSettingsSync();
    await new Promise((resolve) => env.chrome.api.storage.local.set({ setting_sidebarOpen: true, setting_sidebarWidth: 300 }, resolve));
    // The read of sidebarOpen fails, and the one of sidebarWidth after it doesn't
    env.chrome.failNextGet();
    report({ setting_sidebarOpen: { newValue: true }, setting_sidebarWidth: { newValue: 300 } });
    for (let tries = 0; applied.length < 1 && tries < 50; tries += 1) await settle();
    await settle();
    assert.deepEqual(plain(applied), [['sidebarWidth', 300]]);
  });
});
