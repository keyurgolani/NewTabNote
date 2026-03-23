/**
 * @typedef {Object} DomRefs
 * @property {function(string): HTMLElement|null} get - Get cached element by key.
 * @property {function(): void} init - Resolve and cache all known element references.
 */

/**
 * All known element IDs from newtab.html, grouped by region.
 * @type {string[]}
 */
const KNOWN_IDS = [
  // App root
  'app',

  // Sidebar
  'sidebar',
  'sidebar-toggle-container',
  'sidebar-tab-notes',
  'sidebar-tab-templates',
  'sidebar-search',
  'sidebar-sort',
  'sidebar-view-list',
  'sidebar-view-cards',
  'sidebar-new-note',
  'sidebar-daily-note',
  'sidebar-new-folder',
  'sidebar-import-note',
  'sidebar-calendar',
  'calendar-prev',
  'calendar-month-label',
  'calendar-next',
  'calendar-today',
  'calendar-days',
  'sidebar-notes-list',
  'sidebar-bulk-actions',
  'bulk-archive-btn',
  'bulk-delete-btn',
  'bulk-cancel-btn',
  'sidebar-trash-actions',
  'empty-trash-btn',
  'sidebar-tab-archive',
  'archive-count',
  'sidebar-tab-trash',
  'trash-count',
  'sidebar-stats',
  'shortcuts-btn',
  'sidebar-resize-handle',

  // Note context menu
  'note-context-menu',
  'ctx-select-note',
  'ctx-open-note',
  'ctx-generate-title',
  'ctx-export-note',
  'ctx-extract-insights',
  'ctx-archive-note',
  'ctx-convert-template',
  'ctx-back-to-note',
  'ctx-unarchive-note',
  'ctx-restore-note',
  'ctx-delete-note',
  'ctx-delete-permanent',

  // Header
  'header',
  'sidebar-toggle',
  'split-view-toggle',
  'pip-toggle',
  'note-tabs',
  'new-tab-btn',
  'save-status',
  'version-history-btn',
  'width-selector-header',
  'focus-mode-btn',
  'settings-btn',

  // Empty state
  'empty-state',
  'empty-state-create-btn',

  // Editor
  'workspace-container',
  'editor-container',
  'editor',
  'page-title',
  'page-timestamp',
  'blocks-container',
  'add-block-hint',
  'backlinks-panel',
  'backlinks-list',
  'slash-menu',
  'wiki-menu',
  'template-menu',
  'secondary-editor-container',

  // Stats dashboard
  'stats-dashboard',
  'stats-close-btn',
  'stat-total-notes',
  'stat-daily-notes',
  'stat-total-words',
  'stat-active-tags',
  'activity-chart',
  'content-chart',
  'tags-chart',
  'folders-chart',

  // AI sidebar
  'ai-sidebar',
  'ai-sidebar-resize-handle',
  'ai-sidebar-close',
  'ai-tab-note',
  'ai-tab-all',
  'ai-tab-smart',
  'ai-panel-note',
  'ai-sticky-suggestions',
  'ai-sticky-template-buttons',
  'ai-chat-messages',
  'ai-chat-loading',
  'ai-chat-input',
  'ai-chat-clear',
  'ai-chat-send',
  'ai-panel-all',
  'global-chat-messages',
  'global-chat-loading',
  'global-chat-loading-text',
  'global-chat-input',
  'global-chat-clear',
  'global-chat-send',
  'ai-panel-smart',
  'ai-smart-empty',
  'ai-smart-results',
  'ai-suggested-tags',
  'ai-extracted-actions',
  'ai-related-notes',
  'ai-smart-loading',
  'ai-not-configured-sidebar',
  'ai-sidebar-open-settings',
  'ai-floating-btn',
  'ai-note-suggestion-buttons',
  'ai-global-suggestion-buttons',

  // Settings modal
  'settings-modal',
  'theme-select',
  'open-theme-builder-btn',
  'font-select',
  'width-select',
  'daily-note-template-select',
  'llm-provider-select',
  'llm-api-key',
  'ollama-url',
  'llm-model-select',
  'refresh-models-btn',
  'auto-title-enabled',
  'auto-title-interval',
  'insights-enabled',
  'insights-interval',
  'ai-template-add-btn',
  'ai-template-reset-btn',
  'ai-prompt-template-list',
  'ai-prompt-template-empty',
  'ai-prompt-template-form',
  'ai-prompt-template-edit-id',
  'ai-prompt-template-label',
  'ai-prompt-template-scope',
  'ai-prompt-template-behavior',
  'ai-prompt-template-prompt',
  'ai-template-cancel-btn',
  'ai-template-save-btn',
  'trash-retention-select',
  'export-current-btn',
  'export-all-btn',
  'export-zip-btn',
  'backup-btn',
  'import-btn',
  'auto-backup-toggle',
  'backup-frequency-select',
  'pages-list',
  'delete-page-btn',

  // Theme builder modal
  'theme-builder-modal',
  'theme-builder-name',
  'theme-color-controls',
  'theme-builder-cancel',
  'theme-builder-save',

  // Shortcuts modal
  'shortcuts-modal',

  // Command palette modal
  'command-palette-modal',
  'command-palette-input',
  'command-palette-close',
  'command-palette-results',

  // AI insert preview modal
  'ai-insert-preview-modal',
  'ai-insert-preview-title',
  'ai-insert-preview-close',
  'ai-insert-preview-summary',
  'ai-insert-preview-counts',
  'ai-insert-preview-items',
  'ai-insert-preview-cancel',
  'ai-insert-preview-confirm',

  // Hidden file inputs
  'import-input',
  'note-import-input',
  'image-input',
  'file-input',
];

/**
 * Create a centralized DOM element cache that replaces scattered getElementById calls.
 * @returns {DomRefs}
 */
function createDomRefs() {
  /** @type {Map<string, HTMLElement|null>} */
  const cache = new Map();

  /**
   * Get a cached DOM element by its ID key.
   * @param {string} key - The element ID
   * @returns {HTMLElement|null} The cached element, or null if missing
   */
  function get(key) {
    if (!cache.has(key)) {
      console.warn(`[DomRefs] Unknown element key: "${key}"`);
      return null;
    }
    return cache.get(key);
  }

  /**
   * Resolve and cache all known element IDs from the document.
   */
  function init() {
    cache.clear();
    for (const id of KNOWN_IDS) {
      const el = document.getElementById(id);
      if (!el) {
        console.warn(`[DomRefs] Element not found: "${id}"`);
      }
      cache.set(id, el);
    }
  }

  return { get, init };
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { createDomRefs, KNOWN_IDS };
} else if (typeof window !== 'undefined') {
  window.createDomRefs = createDomRefs;
}
