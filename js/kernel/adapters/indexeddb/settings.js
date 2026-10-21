/**
 * Settings stay in chrome.storage.local (#17, "Settings"), whose onChanged carries them to
 * every open tab, under the keys 1.4.x uses. #25 (settings) owns their schemas and defaults.
 */

/** @typedef {import('../../core/ports/repository.js').SettingsArea} SettingsArea */

/**
 * The chrome.storage.local key a setting lives under: `setting_<key>`, as Storage.setSetting
 * writes it, except the last-opened note, which TabController writes under its own name.
 * @param {SettingsArea} area
 * @param {string} key
 * @returns {string}
 */
export function settingKey(area, key) {
  return area === 'session' && key === 'lastOpenedNoteId' ? key : `setting_${key}`;
}

/** Set once startup maintenance has written the first-run settings, as Storage sets it */
export const INITIALIZED_KEY = 'setting_storageInitialized';

/**
 * What Storage.initializeDefaultSettings writes on a profile's first run, key for key, so a
 * root that moves to this adapter starts a new profile the same way (test/kernel/storage-open
 * holds the two to each other). Storage writes all of them over whatever is stored; startup
 * maintenance here writes only the ones with nothing stored, so a value set first is kept.
 */
export const FIRST_RUN_SETTINGS = Object.freeze({
  setting_theme: 'system',
  setting_font: 'default',
  setting_width: 'default',
  setting_llmProvider: 'none',
  setting_llmApiKey: '',
  setting_llmModel: '',
  setting_ollamaUrl: 'http://localhost:11434',
  setting_trashRetention: 30,
  setting_sidebarOpen: true,
  setting_sidebarWidth: 260,
  setting_sidebarViewMode: 'list',
  setting_autoTitleEnabled: false,
  setting_autoTitleInterval: 15,
  setting_insightsEnabled: false,
  setting_insightsInterval: 360,
  setting_aiSidebarWidth: 360,
  setting_openTabs: null,
  setting_activeTabIndex: 0,
  setting_aiChatHistory: Object.freeze([]),
  setting_noteChatMessages: Object.freeze([]),
  setting_globalChatHistory: Object.freeze([]),
  setting_globalChatMessages: Object.freeze([]),
  setting_lastAutoTitleRun: 0,
  setting_lastInsightsRun: 0,
});
