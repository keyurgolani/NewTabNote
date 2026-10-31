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
    settings: env.settingsClient,
    documentClient: env.documentClient,
    validateBackup: env.validateBackup,
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
    assert.equal(await Onboarding.hasCompleted(env.settingsClient), true);
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

// #12 slice 7: the controllers read their settings through the port in place of Storage. Where
// 1.4.x called getSetting, each key nothing is stored under, and every key when the read fails,
// gets the default that call gave, and the console says the read failed as getSetting did.
describe("the controllers' reads through the settings port (#12 slice 7)", () => {
  const READ_FILES = [
    ...FILES,
    'js/theme-engine.js',
    'js/ai-prompt-templates.js',
    'js/controllers/sidebar-controller.js',
    'js/controllers/ai-chat-controller.js',
    'js/search.js',
    'js/app.js',
  ];

  /** AI chat as App makes it, drawing no message */
  const chatOf = (env) => {
    const chat = new (env.get('AIChatController'))({
      settings: env.settingsClient, domRefs: null, logger: null, llm: null, documentClient: env.documentClient,
    });
    chat.addChatMessage = () => {};
    chat.addGlobalChatMessage = () => {};
    return chat;
  };

  const SIDEBAR_STEPS = [
    'updateSidebarState', 'applySidebarWidth', 'applySidebarViewMode', '_bindSidebarListeners', 'setupCalendar',
    'setupSidebarResize', 'setupSidebarViewToggle', 'setupNoteContextMenu', '_bindBulkActions', '_bindSidebarDropHandlers',
  ];
  const AI_SETUP_STEPS = [
    'loadChatHistory', 'setupAISidebarResize', 'setupGlobalChat', 'setupLLMSettings', 'setupAIPromptTemplateSettings',
    'renderAIPromptSuggestions', 'updateAISidebarState', '_setupAccessibility',
  ];
  // Settings' controls as newtab.html has them, which updateSettingsUI fills in
  const SETTINGS_CONTROLS = [
    { id: 'theme-select', tag: 'select' }, { id: 'font-select', tag: 'select' }, { id: 'width-select', tag: 'select' },
    { id: 'auto-backup-toggle', tag: 'input' }, { id: 'backup-frequency-select', tag: 'select' },
    { id: 'trash-retention-select', tag: 'select' }, { id: 'daily-note-template-select', tag: 'select' },
  ];
  // What AI chat starts with when no prompt templates are stored (js/ai-prompt-templates.js)
  const DEFAULT_PROMPT_TEMPLATES = [
    'note-summarize', 'note-expand', 'note-title', 'note-takeaways', 'note-questions',
    'global-deadlines', 'global-meetings', 'global-tasks', 'global-find',
  ];

  /** Settings as App makes it, on `settings` unless given */
  const settingsOf = (env, settings = env.settingsClient) => new (env.get('SettingsController'))({
    settings,
    documentClient: env.documentClient,
    validateBackup: env.validateBackup,
    domRefs: null,
    logger: { debug() {}, info() {}, warn() {}, error() {} },
  });

  // [what reads, what's stored for it, its read, what it read from that, what it reads with
  // nothing there, and which of its chrome.storage reads is the one that fails (the first by default)]
  const READS = [
    ['the sidebar', { sidebarOpen: false, sidebarWidth: 300, sidebarSortMode: 'title', sidebarViewMode: 'cards' }, async (env) => {
      const sidebar = new (env.get('SidebarController'))({
        settings: env.settingsClient, storageState: env.storageState, domRefs: null, logger: null,
      });
      for (const step of SIDEBAR_STEPS) sidebar[step] = () => {};
      await sidebar.init();
      return [sidebar.sidebarOpen, sidebar.sidebarWidth, sidebar.sidebarSortMode, sidebar.sidebarViewMode];
    }, [false, 300, 'title', 'cards'], [true, 260, 'updated', 'list']],
    // Each conversation in its own read, the note chat's first
    ["AI chat's note conversation", {
      aiChatHistory: [{ role: 'user', content: 'a question' }],
      noteChatMessages: [{ content: 'a question', type: 'user' }],
    }, async (env) => {
      const chat = chatOf(env);
      await chat.loadChatHistory();
      return plain([chat.aiChatHistory, chat.noteChatMessages]);
    }, [[{ role: 'user', content: 'a question' }], [{ content: 'a question', type: 'user' }]], [[], []]],
    ["AI chat's all-notes conversation", {
      globalChatHistory: [{ role: 'user', content: 'another' }],
      globalChatMessages: [{ content: 'another', type: 'user' }],
    }, async (env) => {
      const chat = chatOf(env);
      await chat.loadChatHistory();
      return plain([chat.globalChatHistory, chat.globalChatMessages]);
    }, [[{ role: 'user', content: 'another' }], [{ content: 'another', type: 'user' }]], [[], []], 2],
    ["AI chat's panel width", { aiSidebarWidth: 410 }, async (env) => {
      env.document.stub(['ai-sidebar']);
      const chat = chatOf(env);
      for (const step of AI_SETUP_STEPS) chat[step] = async () => {};
      await chat.setupAI();
      return chat.aiSidebarWidth;
    }, 410, 360],
    ["AI chat's prompt templates", {
      aiPromptTemplates: [{ id: 'mine', label: 'Mine', prompt: 'My prompt', scope: 'note', behavior: 'send' }],
    }, async (env) => {
      const chat = chatOf(env);
      chat.renderAIPromptSuggestions = () => {};
      await chat.loadAIPromptTemplates();
      return plain(chat.aiPromptTemplates.map((template) => template.id));
    }, ['mine'], DEFAULT_PROMPT_TEMPLATES],
    ['what Settings shows', {
      theme: 'dark', font: 'serif', width: 'wide', autoBackupEnabled: true, autoBackupFrequency: 3, trashRetention: 7,
      dailyNoteTemplate: 'T',
    }, async (env) => {
      const controls = env.document.stub(SETTINGS_CONTROLS);
      const settings = settingsOf(env);
      settings.updateThemePreview = () => {};
      settings.updateNotesList = async () => {};
      await settings.updateSettingsUI();
      const template = controls['daily-note-template-select'].children.find((option) => option.selected);
      return {
        theme: controls['theme-select'].value,
        font: controls['font-select'].value,
        width: controls['width-select'].value,
        autoBackup: controls['auto-backup-toggle'].checked,
        frequency: controls['backup-frequency-select'].value,
        retention: controls['trash-retention-select'].value,
        template: template ? template.value : '',
      };
    }, { theme: 'dark', font: 'serif', width: 'wide', autoBackup: true, frequency: '3', retention: '7', template: 'T' },
    { theme: 'system', font: 'default', width: 'default', autoBackup: false, frequency: '7', retention: '30', template: '' }],
    ["Settings' font", { font: 'serif' }, async (env) => {
      await settingsOf(env).applyFont();
      return env.document.documentElement.dataset.font;
    }, 'serif', 'default'],
    ["Settings' width", { width: 'wide' }, async (env) => {
      const settings = settingsOf(env);
      settings.updateWidthSelectorPill = () => {};
      await settings.applyWidth();
      return env.document.documentElement.dataset.width;
    }, 'wide', 'default'],
    ["auto-backup's check", { autoBackupEnabled: true, autoBackupFrequency: 1, lastBackupAt: 0 }, async (env) => {
      let backups = 0;
      await settingsOf(env, { ...env.settingsClient, createAutoBackup: async () => { backups += 1; } }).checkBackupStatus();
      return backups;
    }, 1, 0],
    ["Replace all's trash retention", { trashRetention: 7 }, async (env) => {
      const settings = settingsOf(env);
      let message = '';
      settings._dialogs = () => ({ confirmDialog: async (dialog) => { message = dialog.message; return false; } });
      await settings._confirmReplaceAll();
      return message.match(/for \d+ days/)[0];
    }, 'for 7 days', 'for 30 days'],
    ["the theme builder's starting colors", { theme: 'dark' }, async (env) => {
      env.document.stub(['theme-builder-modal', 'theme-color-controls', { id: 'theme-builder-name', tag: 'input' }]);
      const builder = new (env.get('ThemeBuilderController'))({ settings: env.settingsClient, domRefs: null, logger: null });
      await builder.openThemeBuilder();
      const Themes = env.get('Themes');
      return plain(builder.tempThemeProperties)['--bg-primary'] === Themes.darkProperties['--bg-primary'] ? 'dark' : 'light';
    }, 'dark', 'light'],
    ['the theme the page starts with', { theme: 'dark' }, async (env) => {
      const Themes = env.get('Themes');
      await Themes.init();
      return Themes.currentTheme;
    }, 'dark', 'light'],
    ['the theme App applies when it changes', { theme: 'dark' }, async (env) => {
      const applied = [];
      env.get('Themes').applyTheme = async (theme) => { applied.push(theme); };
      await env.get('App').prototype.applyTheme.call({ settings: env.settingsClient });
      return applied;
    }, ['dark'], ['system']],
    ['whether onboarding ran', { hasCompletedOnboarding: true }, async (env) => env.get('Onboarding').hasCompleted(env.settingsClient), true, false],
  ];
  const READ_KEYS = [...new Set(READS.flatMap(([, stored]) => Object.keys(stored)))];

  /**
   * A new tab with a note and a template, whose chrome.storage holds `stored` and nothing else
   * of what these reads read: startup stored some of 1.4.x's first-run values, which go. With
   * `failing`, chrome.storage's read number `failingRead` from now fails, the next one by default.
   */
  async function tabWith(stored, { failing = false, failingRead = 1 } = {}) {
    const env = createLegacyEnv({ document: new FakeDocument() });
    await createDatabase(env.indexedDB, {
      records: { canvases: [note('A', { name: 'Alpha' }), note('T', { name: 'Morning', isTemplate: true })] },
    });
    env.load(...READ_FILES);
    await env.get('Storage').init();
    await startEditorClient(env);
    await env.noteList.settled();
    for (const key of READ_KEYS) delete env.chrome.local[`setting_${key}`];
    for (const [key, value] of Object.entries(stored)) env.chrome.local[`setting_${key}`] = value;
    const Themes = env.get('Themes');
    Themes.connect({ settings: env.settingsClient });
    // The fake document's style can't take custom properties
    Themes.injectProperties = () => {};
    if (failing) {
      for (let read = 1; read < failingRead; read++) env.chrome.passNextGet();
      env.chrome.failNextGet();
    }
    return env;
  }

  const readFailures = (env) => env.logs.filter(({ level, args }) => level === 'warn' && args[0] === 'Error getting setting:').length;

  for (const [what, stored, read, asStored, byDefault, failingRead = 1] of READS) {
    it(`${what} reads what's stored, and 1.4.x's defaults where nothing is or the read fails`, async () => {
      assert.deepEqual(await read(await tabWith(stored)), asStored, 'as stored');
      assert.deepEqual(await read(await tabWith({})), byDefault, 'nothing stored');
      const failing = await tabWith(stored, { failing: true, failingRead });
      assert.deepEqual(await read(failing), byDefault, 'the read fails');
      assert.equal(readFailures(failing), 1);
    });
  }

  it("a failed read of one AI conversation leaves the other loaded, and nothing writes the failed one over before it's read", async () => {
    const stored = {
      aiChatHistory: [{ role: 'user', content: 'a question' }],
      noteChatMessages: [{ content: 'a question', type: 'user' }],
      globalChatHistory: [{ role: 'user', content: 'another' }],
      globalChatMessages: [{ content: 'another', type: 'user' }],
    };
    // The note conversation's read is the one that fails
    const env = await tabWith(stored, { failing: true });
    const before = env.chrome.writes().length;
    const chat = chatOf(env);
    await chat.loadChatHistory();
    assert.deepEqual(plain([chat.aiChatHistory, chat.noteChatMessages]), [[], []], 'the conversation whose read failed shows empty');
    assert.deepEqual(plain([chat.globalChatHistory, chat.globalChatMessages]), [stored.globalChatHistory, stored.globalChatMessages],
      'the other one loaded');
    assert.equal(readFailures(env), 1);

    // A chat in the conversation that loaded saves that one alone
    chat.globalChatHistory.push({ role: 'user', content: 'a third' });
    chat.globalChatMessages.push({ content: 'a third', type: 'user' });
    await chat.saveGlobalChatHistory();
    assert.deepEqual(env.chrome.writes().slice(before).map((write) => write.keys.slice().sort()),
      [['setting_globalChatHistory', 'setting_globalChatMessages']]);
    assert.deepEqual(plain([env.chrome.local.setting_aiChatHistory, env.chrome.local.setting_noteChatMessages]),
      [stored.aiChatHistory, stored.noteChatMessages], 'the one that failed is as stored');

    // The next read finds it
    const again = chatOf(env);
    await again.loadChatHistory();
    assert.deepEqual(plain([again.aiChatHistory, again.noteChatMessages]), [stored.aiChatHistory, stored.noteChatMessages]);
    assert.equal(again.globalChatMessages.length, 2);
  });

  /** AI chat's prompt templates, loaded as App's setup loads them, by id */
  const loadTemplates = async (env) => {
    const chat = chatOf(env);
    chat.renderAIPromptSuggestions = () => {};
    await chat.loadAIPromptTemplates();
    return plain(chat.aiPromptTemplates.map((template) => template.id));
  };

  it('a failed read of the prompt templates shows the defaults and writes nothing over the ones stored (a 1.4.x fix)', async () => {
    const stored = { aiPromptTemplates: [{ id: 'mine', label: 'Mine', prompt: 'My prompt', scope: 'note', behavior: 'send' }] };
    const env = await tabWith(stored, { failing: true });
    const before = env.chrome.writes().length;
    assert.deepEqual(await loadTemplates(env), DEFAULT_PROMPT_TEMPLATES);
    assert.equal(readFailures(env), 1);
    assert.deepEqual(env.chrome.writes().slice(before), [], 'nothing is written');
    assert.deepEqual(plain(env.chrome.local.setting_aiPromptTemplates), stored.aiPromptTemplates, 'the stored templates are as they were');
    // The next read finds them
    assert.deepEqual(await loadTemplates(env), ['mine']);
  });

  it('with no prompt templates stored, AI chat shows the defaults and saves them, as 1.4.x did', async () => {
    const env = await tabWith({});
    const before = env.chrome.writes().length;
    assert.deepEqual(await loadTemplates(env), DEFAULT_PROMPT_TEMPLATES);
    assert.deepEqual(env.chrome.writes().slice(before).map((write) => write.keys), [['setting_aiPromptTemplates']]);
    assert.deepEqual(plain(env.chrome.local.setting_aiPromptTemplates.map((template) => template.id)), DEFAULT_PROMPT_TEMPLATES);
    // Saved once: the next read finds them, and writes nothing
    const again = env.chrome.writes().length;
    assert.deepEqual(await loadTemplates(env), DEFAULT_PROMPT_TEMPLATES);
    assert.equal(env.chrome.writes().length, again);
  });

  /** AI chat after a failed read of its prompt templates, with Settings' toasts recorded */
  const afterFailedRead = async (stored) => {
    const env = await tabWith(stored, { failing: true });
    const toasts = [];
    env.get('Utils').showToast = (message, kind) => toasts.push([message, kind]);
    const chat = chatOf(env);
    chat.renderAIPromptSuggestions = () => {};
    chat.renderAIPromptTemplateSettings = () => {};
    await chat.loadAIPromptTemplates();
    return { env, chat, toasts, ids: () => plain(chat.aiPromptTemplates.map((template) => template.id)) };
  };

  it('after a failed read, a Settings edit of the prompt templates reads them first and writes nothing over the ones stored', async () => {
    const stored = { aiPromptTemplates: [{ id: 'mine', label: 'Mine', prompt: 'My prompt', scope: 'note', behavior: 'send' }] };
    const { env, chat, toasts, ids } = await afterFailedRead(stored);
    assert.deepEqual(ids(), DEFAULT_PROMPT_TEMPLATES);
    const before = env.chrome.writes().length;

    // Its read fails again: the delete is refused
    env.chrome.failNextGet();
    assert.equal(await chat.persistAIPromptTemplates(chat.aiPromptTemplates.slice(1), 'AI prompt template removed'), false);
    assert.deepEqual(ids(), DEFAULT_PROMPT_TEMPLATES);
    // Its read finds the stored list: that shows, and the delete is refused
    assert.equal(await chat.persistAIPromptTemplates(chat.aiPromptTemplates.slice(1), 'AI prompt template removed'), false);
    assert.deepEqual(ids(), ['mine']);
    assert.deepEqual(env.chrome.writes().slice(before), [], 'nothing is written');
    assert.deepEqual(plain(env.chrome.local.setting_aiPromptTemplates), stored.aiPromptTemplates, 'the stored templates are as they were');
    // Through the failure path Settings already has
    assert.deepEqual(toasts, [['Failed to save AI prompt templates', 'error'], ['Failed to save AI prompt templates', 'error']]);

    // The next edit is of the list that's stored, and saves
    assert.equal(await chat.persistAIPromptTemplates([], 'AI prompt template removed'), true);
    assert.deepEqual(env.chrome.writes().slice(before).map((write) => write.keys), [['setting_aiPromptTemplates']]);
    assert.deepEqual(plain(env.chrome.local.setting_aiPromptTemplates), []);
  });

  it('after a failed read, an edit of a default template the stored list lacks is kept when submitted again, beside the stored ones', async () => {
    const stored = { aiPromptTemplates: [{ id: 'mine', label: 'Mine', prompt: 'My prompt', scope: 'note', behavior: 'send' }] };
    const { env, chat, toasts, ids } = await afterFailedRead(stored);
    // Settings' template editor, as newtab.html has it
    const editor = env.document.stub([
      { id: 'ai-prompt-template-form', tag: 'form' }, { id: 'ai-prompt-template-edit-id', tag: 'input' },
      { id: 'ai-prompt-template-label', tag: 'input' }, { id: 'ai-prompt-template-scope', tag: 'select' },
      { id: 'ai-prompt-template-behavior', tag: 'select' }, { id: 'ai-prompt-template-prompt', tag: 'textarea' },
      { id: 'ai-template-save-btn', tag: 'button' },
    ]);
    const form = editor['ai-prompt-template-form'];
    const before = env.chrome.writes().length;

    // The user edits a default, which the list stored doesn't have
    chat.openAIPromptTemplateEditor('note-summarize');
    editor['ai-prompt-template-label'].value = 'Short summary';
    editor['ai-prompt-template-prompt'].value = 'Summarize this note in three lines';
    // Its save reads the stored list first, which shows, and is refused. The editor keeps the text
    await chat.submitAIPromptTemplateForm();
    assert.deepEqual(ids(), ['mine']);
    assert.deepEqual(env.chrome.writes().slice(before), [], 'nothing is written');
    assert.equal(form.classList.contains('hidden'), false);
    assert.equal(editor['ai-prompt-template-label'].value, 'Short summary');

    // Submitted again, it saves as a new template, after the stored one, which is as it was
    await chat.submitAIPromptTemplateForm();
    assert.deepEqual(env.chrome.writes().slice(before).map((write) => write.keys), [['setting_aiPromptTemplates']]);
    assert.deepEqual(plain(env.chrome.local.setting_aiPromptTemplates), [
      ...stored.aiPromptTemplates,
      { id: 'note-summarize', label: 'Short summary', prompt: 'Summarize this note in three lines', scope: 'note', behavior: 'send' },
    ]);
    assert.deepEqual(ids(), ['mine', 'note-summarize']);
    assert.equal(form.classList.contains('hidden'), true);
    assert.deepEqual(toasts, [['Failed to save AI prompt templates', 'error'], ['AI prompt templates updated', 'success']]);
  });

  it('after a failed read with no prompt templates stored, the first Settings edit saves', async () => {
    const { env, chat, ids } = await afterFailedRead({});
    assert.equal(await chat.persistAIPromptTemplates(chat.aiPromptTemplates.slice(1), 'AI prompt template removed'), true);
    assert.deepEqual(ids(), DEFAULT_PROMPT_TEMPLATES.slice(1));
    assert.deepEqual(plain(env.chrome.local.setting_aiPromptTemplates.map((template) => template.id)), DEFAULT_PROMPT_TEMPLATES.slice(1));
  });

  it('a custom theme the page starts on, and the theme options, come from the themes the port lists', async () => {
    const env = await tabWith({});
    const themeId = await env.settingsClient.saveTheme({ name: 'Dusk', properties: { '--bg-primary': '#101010' } });
    env.chrome.local.setting_theme = themeId;
    const Themes = env.get('Themes');
    const injected = [];
    Themes.injectProperties = (properties) => injected.push(plain(properties));
    await Themes.init();
    assert.deepEqual(injected, [{ '--bg-primary': '#101010' }]);
    assert.equal(env.document.documentElement.getAttribute('data-theme'), 'dark');
    assert.deepEqual(plain(await Themes.getThemeOptions()).at(-1), { id: themeId, name: 'Dusk', isCustom: true });
  });
});
