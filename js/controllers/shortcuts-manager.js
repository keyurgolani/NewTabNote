/**
 * ShortcutsManager — manages global and editor-level shortcut dispatch,
 * command palette activation, and focus mode toggling.
 *
 * @param {Object} deps
 * @param {DatabaseManager} deps.storage
 * @param {EventBus} deps.eventBus
 * @param {DomRefs} deps.domRefs
 * @param {Logger} deps.logger
 */
class ShortcutsManager {
  constructor({ storage, eventBus, domRefs, logger }) {
    this.storage = storage;
    this.eventBus = eventBus;
    this.domRefs = domRefs;
    this.logger = logger;

    // Focus mode state
    this.focusMode = false;

    // Command palette state
    this.commandPaletteItems = [];
    this.commandPaletteIndex = 0;

    // Bound keydown handler for cleanup
    this._keydownHandler = null;

    // App-level callbacks (set by App after construction)
    this.onToggleSidebar = null;
    this.onToggleAISidebar = null;
    this.onOpenNewTab = null;
    this.onOpenNoteById = null;
    this.onOpenNoteInNewTab = null;
    this.onOpenSettingsModal = null;
    this.onCloseAllModals = null;
    this.onToggleShortcutsModal = null;
    this.onEnsureDailyNote = null;
    this.onRefreshNotesList = null;
    this.onCycleTab = null;
    this.onCloseCurrentTab = null;
    this.getEditor = null;
    this.getOpenTabs = null;
    this.getNotes = null;
    this.getArchivedNotes = null;
    this.getSearchIndexByNoteId = null;
    this.getSidebarOpen = null;
    this.getAISidebarOpen = null;

    /** @type {function|null} */
    this._commandPaletteFocusTrapCleanup = null;
  }

  /** Initialize shortcuts: wire keydown listener, setup command palette. */
  async init() {
    this.updateShortcutLabels();
    this.setupCommandPalette();

    this._keydownHandler = async (e) => {
      if (await this.handleCommandPaletteShortcuts(e)) {
        return;
      }

      const isInput = e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.getAttribute('contenteditable') === 'true';
      const modKey = (navigator.platform.toUpperCase().indexOf('MAC') >= 0) ? e.metaKey : e.ctrlKey;
      const shortcutAction = typeof ShortcutUtils !== 'undefined'
        ? ShortcutUtils.getAppShortcutAction({
          code: e.code,
          key: e.key,
          modKey,
          shiftKey: e.shiftKey,
          altKey: e.altKey,
          isInput,
        })
        : null;

      switch (shortcutAction) {
        case 'show-shortcuts':
          e.preventDefault();
          if (this.onToggleShortcutsModal) this.onToggleShortcutsModal();
          return;
        case 'escape':
          e.preventDefault();
          if (this.focusMode) {
            this.toggleFocusMode(false);
            return;
          }
          if (this.onCloseAllModals) this.onCloseAllModals();
          return;
        case 'new-note':
        case 'legacy-new-note':
          e.preventDefault();
          if (this.onOpenNewTab) await this.onOpenNewTab();
          return;
        case 'command-palette':
          e.preventDefault();
          this.toggleCommandPalette();
          return;
        case 'toggle-ai':
          e.preventDefault();
          if (this.onToggleAISidebar) this.onToggleAISidebar();
          return;
        case 'toggle-sidebar':
          e.preventDefault();
          if (this.onToggleSidebar) await this.onToggleSidebar();
          return;
        case 'focus-search':
          e.preventDefault();
          document.getElementById('sidebar-search')?.focus();
          return;
        case 'toggle-focus-mode':
          e.preventDefault();
          this.toggleFocusMode();
          return;
        case 'daily-note':
          e.preventDefault();
          if (this.onEnsureDailyNote) {
            const note = await this.onEnsureDailyNote();
            if (note && this.onRefreshNotesList) await this.onRefreshNotesList();
            if (note && this.onOpenNoteInNewTab) await this.onOpenNoteInNewTab(note.id);
          }
          return;
        case 'next-tab':
          e.preventDefault();
          if (this.onCycleTab) this.onCycleTab(1);
          return;
        case 'prev-tab':
          e.preventDefault();
          if (this.onCycleTab) this.onCycleTab(-1);
          return;
        case 'close-tab':
          e.preventDefault();
          if (this.onCloseCurrentTab) await this.onCloseCurrentTab();
          return;
        default:
          return;
      }
    };

    window.addEventListener('keydown', this._keydownHandler);
  }

  /** Tear down listeners. */
  destroy() {
    if (this._keydownHandler) {
      window.removeEventListener('keydown', this._keydownHandler);
      this._keydownHandler = null;
    }
  }

  // ─── Focus Mode ───

  toggleFocusMode(force) {
    this.focusMode = force !== undefined ? force : !this.focusMode;
    if (this.focusMode && this.onCloseAllModals) {
      this.onCloseAllModals();
    }
    document.body.classList.toggle('focus-mode', this.focusMode);
  }

  // ─── Shortcut Labels ───

  updateShortcutLabels() {
    const isMac = navigator.platform.toUpperCase().indexOf('MAC') >= 0;
    const modLabel = isMac ? '⌘' : 'Ctrl';

    document.querySelectorAll('.mod-key').forEach(el => {
      el.textContent = modLabel;
    });

    if (isMac) {
      const statsBtn = document.getElementById('sidebar-stats');
      if (statsBtn) statsBtn.title = 'Analytics & Stats (Alt+I)';
    }
  }

  // ─── Command Palette ───

  setupCommandPalette() {
    const modal = document.getElementById('command-palette-modal');
    const input = document.getElementById('command-palette-input');
    const results = document.getElementById('command-palette-results');
    const closeBtn = document.getElementById('command-palette-close');

    if (!modal || !input || !results) {
      return;
    }

    input.addEventListener('input', () => {
      this.refreshCommandPaletteResults(input.value);
    });

    closeBtn?.addEventListener('click', () => {
      this.toggleCommandPalette(false);
    });

    modal.addEventListener('click', (e) => {
      if (e.target === modal) {
        this.toggleCommandPalette(false);
      }
    });

    results.addEventListener('click', async (e) => {
      const itemEl = e.target.closest('.command-palette-item');
      if (!itemEl) {
        return;
      }

      const index = Number(itemEl.dataset.index);
      if (Number.isInteger(index)) {
        await this.selectCommandPaletteItem(index);
      }
    });
  }

  isCommandPaletteOpen() {
    const modal = document.getElementById('command-palette-modal');
    return Boolean(modal && !modal.classList.contains('hidden'));
  }

  toggleCommandPalette(force, initialQuery = '') {
    const modal = document.getElementById('command-palette-modal');
    const input = document.getElementById('command-palette-input');

    if (!modal || !input) {
      return;
    }

    const show = force !== undefined ? force : modal.classList.contains('hidden');

    if (!show) {
      modal.classList.add('hidden');
      if (this._commandPaletteFocusTrapCleanup) { this._commandPaletteFocusTrapCleanup(); this._commandPaletteFocusTrapCleanup = null; }
      input.value = '';
      this.commandPaletteItems = [];
      this.commandPaletteIndex = 0;
      return;
    }

    if (this.onCloseAllModals) this.onCloseAllModals();
    modal.classList.remove('hidden');
    this._commandPaletteFocusTrapCleanup = Utils.trapFocus(modal);
    input.value = initialQuery;
    this.refreshCommandPaletteResults(initialQuery);
    requestAnimationFrame(() => {
      input.focus();
      input.select();
    });
  }

  getCommandPaletteCommands() {
    const sidebarOpen = this.getSidebarOpen ? this.getSidebarOpen() : true;
    const aiSidebarOpen = this.getAISidebarOpen ? this.getAISidebarOpen() : false;

    return [
      {
        id: 'new-note',
        title: 'New Note',
        description: 'Create a blank note and focus the title',
        keywords: ['create', 'note', 'blank'],
      },
      {
        id: 'open-daily-note',
        title: 'Open Daily Note',
        description: 'Jump to today\'s note',
        keywords: ['daily', 'today', 'journal'],
      },
      {
        id: 'open-settings',
        title: 'Open Settings',
        description: 'Adjust appearance, AI, and backups',
        keywords: ['preferences', 'config', 'options'],
      },
      {
        id: 'toggle-sidebar',
        title: sidebarOpen ? 'Hide Sidebar' : 'Show Sidebar',
        description: 'Collapse or expand the notes sidebar',
        keywords: ['sidebar', 'navigation', 'panel'],
      },
      {
        id: 'toggle-ai',
        title: aiSidebarOpen ? 'Hide AI Sidebar' : 'Show AI Sidebar',
        description: 'Open or close the AI assistant',
        keywords: ['assistant', 'chat', 'ai'],
      },
      {
        id: 'toggle-focus-mode',
        title: this.focusMode ? 'Exit Focus Mode' : 'Enter Focus Mode',
        description: 'Hide distractions and center the editor',
        keywords: ['focus', 'zen', 'writing'],
      },
    ];
  }

  getCommandPaletteNotes() {
    const editor = this.getEditor ? this.getEditor() : null;
    const activeNoteId = editor?.noteId;
    const openTabs = this.getOpenTabs ? this.getOpenTabs() : [];
    const openNoteIds = new Set(openTabs.map(tab => tab.noteId));
    const notes = this.getNotes ? this.getNotes() : [];
    const archivedNotes = this.getArchivedNotes ? this.getArchivedNotes() : [];
    const searchIndexByNoteId = this.getSearchIndexByNoteId ? this.getSearchIndexByNoteId() : new Map();
    const noteCollections = [...notes, ...archivedNotes];

    return noteCollections.map(note => {
      const searchEntry = searchIndexByNoteId.get(note.id);
      const previewSource = note.preview || searchEntry?.content || '';
      const preview = previewSource
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 140);

      return {
        id: note.id,
        name: note.name || 'Untitled',
        preview,
        searchText: searchEntry?.content || preview,
        tags: note.insights?.tags || searchEntry?.tags || [],
        badges: note.archived ? ['Archived'] : [],
        updatedAt: note.updatedAt || 0,
        createdAt: note.createdAt || 0,
        isActive: note.id === activeNoteId,
        isOpen: openNoteIds.has(note.id),
      };
    });
  }

  refreshCommandPaletteResults(query) {
    if (typeof CommandPaletteUtils === 'undefined') {
      return;
    }

    const input = document.getElementById('command-palette-input');
    const nextQuery = query !== undefined ? query : input?.value || '';

    this.commandPaletteItems = CommandPaletteUtils.buildCommandPaletteItems({
      query: nextQuery,
      commands: this.getCommandPaletteCommands(),
      notes: this.getCommandPaletteNotes(),
      limit: 12,
    });

    if (query !== undefined) {
      this.commandPaletteIndex = 0;
    } else {
      this.commandPaletteIndex = Math.min(
        this.commandPaletteIndex,
        Math.max(this.commandPaletteItems.length - 1, 0)
      );
    }

    this.renderCommandPaletteResults();
  }

  renderCommandPaletteResults() {
    const results = document.getElementById('command-palette-results');
    if (!results) {
      return;
    }

    results.innerHTML = '';

    if (this.commandPaletteItems.length === 0) {
      const emptyState = document.createElement('div');
      emptyState.className = 'command-palette-empty';
      emptyState.textContent = 'No notes or commands match that search.';
      results.appendChild(emptyState);
      return;
    }

    this.commandPaletteItems.forEach((item, index) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = `command-palette-item ${index === this.commandPaletteIndex ? 'selected' : ''}`;
      button.dataset.index = String(index);
      button.setAttribute('role', 'option');
      button.setAttribute('aria-selected', index === this.commandPaletteIndex ? 'true' : 'false');

      const main = document.createElement('div');
      main.className = 'command-palette-item-main';

      const titleRow = document.createElement('div');
      titleRow.className = 'command-palette-item-title-row';

      const title = document.createElement('span');
      title.className = 'command-palette-item-title';
      title.textContent = item.title;
      titleRow.appendChild(title);
      main.appendChild(titleRow);

      if (item.subtitle) {
        const subtitle = document.createElement('div');
        subtitle.className = 'command-palette-item-subtitle';
        subtitle.textContent = item.subtitle;
        main.appendChild(subtitle);
      }

      const meta = document.createElement('div');
      meta.className = 'command-palette-item-meta';

      const kindChip = document.createElement('span');
      kindChip.className = `command-palette-chip kind-${item.kind}`;
      kindChip.textContent = item.kind === 'command' ? 'Command' : 'Note';
      meta.appendChild(kindChip);

      if (Array.isArray(item.badges)) {
        item.badges.forEach(label => {
          const badge = document.createElement('span');
          badge.className = 'command-palette-chip';
          badge.textContent = label;
          meta.appendChild(badge);
        });
      }

      button.appendChild(main);
      button.appendChild(meta);
      results.appendChild(button);
    });

    const selected = results.querySelector('.command-palette-item.selected');
    selected?.scrollIntoView({ block: 'nearest' });
  }

  moveCommandPaletteSelection(direction) {
    if (this.commandPaletteItems.length === 0) {
      return;
    }

    const lastIndex = this.commandPaletteItems.length - 1;
    this.commandPaletteIndex = Math.max(0, Math.min(lastIndex, this.commandPaletteIndex + direction));
    this.renderCommandPaletteResults();
  }

  async selectCommandPaletteItem(index = this.commandPaletteIndex) {
    const item = this.commandPaletteItems[index];
    if (!item) {
      return;
    }

    await this.executeCommandPaletteItem(item);
  }

  async executeCommandPaletteItem(item) {
    this.toggleCommandPalette(false);

    if (item.kind === 'note') {
      if (this.onOpenNoteById) await this.onOpenNoteById(item.noteId);
      return;
    }

    switch (item.commandId) {
      case 'new-note':
        if (this.onOpenNewTab) await this.onOpenNewTab();
        break;
      case 'open-daily-note':
        if (this.onEnsureDailyNote) {
          const note = await this.onEnsureDailyNote();
          if (note && this.onRefreshNotesList) await this.onRefreshNotesList();
          if (note && this.onOpenNoteInNewTab) await this.onOpenNoteInNewTab(note.id);
        }
        break;
      case 'open-settings':
        if (this.onOpenSettingsModal) await this.onOpenSettingsModal();
        break;
      case 'toggle-sidebar':
        if (this.onToggleSidebar) await this.onToggleSidebar();
        break;
      case 'toggle-ai':
        if (this.onToggleAISidebar) this.onToggleAISidebar();
        break;
      case 'toggle-focus-mode':
        this.toggleFocusMode();
        break;
      default:
        break;
    }
  }

  async handleCommandPaletteShortcuts(e) {
    if (!this.isCommandPaletteOpen()) {
      return false;
    }

    switch (e.key) {
      case 'Escape':
        e.preventDefault();
        this.toggleCommandPalette(false);
        return true;
      case 'ArrowDown':
        e.preventDefault();
        this.moveCommandPaletteSelection(1);
        return true;
      case 'ArrowUp':
        e.preventDefault();
        this.moveCommandPaletteSelection(-1);
        return true;
      case 'Tab':
        e.preventDefault();
        this.moveCommandPaletteSelection(e.shiftKey ? -1 : 1);
        return true;
      case 'Enter':
        e.preventDefault();
        await this.selectCommandPaletteItem();
        return true;
      default:
        return false;
    }
  }
}

// Dual CommonJS/browser export
if (typeof module !== 'undefined' && module.exports) {
  module.exports = ShortcutsManager;
} else if (typeof window !== 'undefined') {
  window.ShortcutsManager = ShortcutsManager;
}
