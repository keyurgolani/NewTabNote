'use strict';

// #12 slice 6: the new tab's preferences, themes, chat history, and onboarding go through the
// settings port (js/kernel/composition/settings.js), one chrome.storage.local set per change
// under the keys 1.4.x wrote, so a setting still reaches every other open tab the way it did.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  createLegacyEnv, createDatabase, FakeDocument, settle, plain, note, startEditorClient,
} = require('./helpers/legacy-env');

const FILES = [
  'js/utils.js',
  'js/core/storage-error.js',
  'js/storage.js',
  'js/controllers/settings-controller.js',
  'js/controllers/theme-builder-controller.js',
  'js/onboarding.js',
];

/** One new tab on `shared`'s profile and chrome.storage, or on a new one */
async function openTab(shared) {
  const env = createLegacyEnv(
    shared ? { document: new FakeDocument(), indexedDB: shared.indexedDB, chrome: shared.chrome } : { document: new FakeDocument() },
  );
  if (!shared) await createDatabase(env.indexedDB, { records: { canvases: [note('A', { name: 'Alpha' })] } });
  env.load(...FILES);
  const Storage = env.get('Storage');
  await Storage.init();
  await startEditorClient(env);
  env.get('Utils').showToast = () => {};
  const settings = new (env.get('SettingsController'))({
    storage: Storage,
    settings: env.settingsClient,
    domRefs: null,
    logger: { debug() {}, info() {}, warn() {}, error() {} },
  });
  return { env, Storage, settings };
}

/** Let chrome.storage's notices and the reads they start run */
async function quiet() {
  await settle(30);
}

describe('the settings port (#12 slice 6)', () => {
  it('a font chosen in one tab reaches another, in one write under the key 1.4.x wrote', async () => {
    const first = await openTab();
    const second = await openTab(first.env);
    const select = first.env.document.stub(['settings-modal', 'settings-btn', { id: 'font-select', tag: 'select' }])['font-select'];
    first.settings.setupSettings();
    second.settings.setupSettingsSync();

    const before = first.env.chrome.writes().length;
    select.value = 'serif';
    select.dispatchEvent({ type: 'change' });
    await quiet();

    assert.deepEqual(first.env.chrome.writes().slice(before).map((write) => write.keys), [['setting_font']]);
    assert.equal(first.env.chrome.local.setting_font, 'serif');
    assert.equal(first.env.document.documentElement.dataset.font, 'serif', 'this tab applies it');
    assert.equal(second.env.document.documentElement.dataset.font, 'serif', 'the other tab applies it too');
  });

  it("the sidebar width another tab saved reaches this tab's sidebar", async () => {
    const first = await openTab();
    const second = await openTab(first.env);
    const applied = [];
    second.settings.onSidebarStateChanged = (key, value) => applied.push([key, value]);
    second.settings.setupSettingsSync();

    await first.env.settingsClient.setPreferences({ sidebarWidth: 320, aiSidebarWidth: 410 });
    await quiet();

    assert.deepEqual(applied, [['sidebarWidth', 320]]);
    assert.equal(first.env.chrome.local.setting_aiSidebarWidth, 410);
  });

  it('a theme built and saved is stored, then applied, and a reload reads both back', async () => {
    const tab = await openTab();
    const { env } = tab;
    const builder = new (env.get('ThemeBuilderController'))({
      storage: tab.Storage,
      settings: env.settingsClient,
      domRefs: null,
      logger: null,
    });
    const els = env.document.stub([
      'theme-builder-modal',
      'theme-builder-cancel',
      'theme-builder-save',
      { id: 'theme-builder-name', tag: 'input' },
    ]);
    els['theme-builder-modal'].appendChild(env.document.createElement('button')).className = 'close-btn';
    let applies = 0;
    builder.onApplyTheme = () => { applies += 1; };
    builder.setupThemeBuilder();
    builder.tempThemeProperties = { '--bg-primary': '#101010', '--text-primary': '#fafafa' };
    els['theme-builder-name'].value = 'Dusk';

    els['theme-builder-save'].click();
    await quiet();

    const [theme] = plain(await tab.Storage.getCustomThemes());
    assert.deepEqual(
      { name: theme.name, properties: theme.properties, updatedAt: typeof theme.updatedAt },
      { name: 'Dusk', properties: { '--bg-primary': '#101010', '--text-primary': '#fafafa' }, updatedAt: 'number' },
    );
    assert.equal(env.chrome.local.setting_theme, theme.id, 'the theme preference names it');
    assert.equal(applies, 1);

    const reloaded = await openTab(env);
    assert.equal(await reloaded.Storage.getSetting('theme'), theme.id);
    assert.equal(plain(await reloaded.Storage.getCustomThemes())[0].name, 'Dusk');
  });

  it("onboarding's first run switches its three features on in one write, and its end is recorded", async () => {
    const { env } = await openTab();
    const Onboarding = env.get('Onboarding');
    const before = env.chrome.writes().length;
    await Onboarding.setupFirstRun(env.settingsClient);
    await Onboarding.markComplete(env.settingsClient);

    assert.deepEqual(
      env.chrome.writes().slice(before).map((write) => write.keys.slice().sort()),
      [['setting_autoTitleEnabled', 'setting_embeddingsEnabled', 'setting_insightsEnabled'], ['setting_hasCompletedOnboarding']],
    );
    assert.equal(await Onboarding.hasCompleted(), true);
  });

  it('a write that fails rejects with its kind and code, never what was being saved', async () => {
    const { env } = await openTab();
    env.chrome.failNextSet();
    await assert.rejects(
      env.settingsClient.saveChatHistory('note', [{ role: 'user', content: 'private words' }], []),
      (error) => {
        assert.equal(error.name, 'SettingsWriteError');
        assert.match(error.message, /saveChatHistory \(unavailable: /);
        assert.ok(!error.message.includes('private words'));
        return true;
      },
    );
  });
});
