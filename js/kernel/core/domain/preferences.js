/**
 * The persisted preferences the kernel's settings port owns (#12, "State ownership"). They
 * live in chrome.storage.local, which carries a change to every open tab. #25 (settings
 * routes) owns their schemas, so until then a preference takes any structured-clone-safe
 * value.
 *
 * Provider settings (#11), sync settings (#19), the workspace session, chat history,
 * onboarding, and job bookkeeping get their own commands, so they aren't preferences.
 */

export const PREFERENCE_KEYS = Object.freeze([
  'theme',
  'font',
  'width',
  'trashRetention',
  'dailyNoteTemplate',
  'autoBackupEnabled',
  'autoBackupFrequency',
  'sidebarOpen',
  'sidebarWidth',
  'sidebarViewMode',
  'sidebarSortMode',
  'aiSidebarWidth',
  'autoTitleEnabled',
  'autoTitleInterval',
  'insightsEnabled',
  'insightsInterval',
  'embeddingsEnabled',
]);

/**
 * The values Storage.initializeDefaultSettings gives these keys on first run. Startup
 * maintenance writes them where nothing is stored yet.
 * @type {Readonly<Record<string, unknown>>}
 */
export const DEFAULT_PREFERENCES = Object.freeze({
  theme: 'system',
  font: 'default',
  width: 'default',
  trashRetention: 30,
  sidebarOpen: true,
  sidebarWidth: 260,
  sidebarViewMode: 'list',
  autoTitleEnabled: false,
  autoTitleInterval: 15,
  insightsEnabled: false,
  insightsInterval: 360,
  aiSidebarWidth: 360,
});
