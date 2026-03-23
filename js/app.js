/**
 * Main application entry point
 */

class App {
  constructor() {
    this.editor = null;
    this.secondaryEditor = null;
    this.pipWindow = null;
    this.pipEditor = null;
    this.activeEditorSide = 'left'; // 'left' or 'right'
    this.splitViewEnabled = false;
    this.sidebarOpen = true;
    this.sidebarView = 'notes'; // 'notes', 'archive', or 'trash'
    this.sidebarWidth = 260;
    this.sidebarSortMode = 'updated';
    this.sidebarViewMode = 'list'; // 'list' or 'cards'
    this.notes = [];
    this.archivedNotes = [];
    this.trashedNotes = [];
    this.templates = []; // NEW: templates list
    this.folders = []; // NEW: folders list
    this.searchIndexByNoteId = new Map();
    this.searchQuery = '';
    this.contextMenuNoteId = null;
    // Calendar
    const now = new Date();
    this.calendarMonth = now.getMonth();
    this.calendarYear = now.getFullYear();
    // Tab management
    this.openTabs = []; // Array of { noteId, name, side }
    this.activeTabIndex = 0;
    // Auto-title
    this.autoTitleIntervalId = null;
    this.autoTitleRunning = false;
    // Insights extraction
    this.insightsIntervalId = null;
    this.insightsRunning = false;
    // AI Chat sidebar
    this.aiSidebarOpen = false;
    this.aiSidebarWidth = 360;
    this.sidebarResizer = null;
    this.aiSidebarResizer = null;
    this.focusMode = false;
    this.commandPaletteItems = [];
    this.commandPaletteIndex = 0;
    this.aiChatHistory = [];
    this.aiPromptTemplates = [];
    this.aiPromptTemplateEditingId = null;
    this.aiInsertPreviewState = null;
    // Virtual Scroller
    this.notesScroller = null;
    // Search Indexer
    this.indexerWorker = null;
    this.searchEngine = new SearchEngine();
    // Sidebar controller
    this.sidebarController = null;
    // Tab controller
    this.tabController = null;
    // AI Chat controller
    this.aiChatController = null;
    // Settings controller
    this.settingsController = null;
    // Theme builder controller
    this.themeBuilderController = null;
    // Analytics controller
    this.analyticsController = null;
    // Graph view
    this.graphView = null;
    // Notes manager
    this.notesManager = null;
    // Shortcuts manager
    this.shortcutsManager = null;
    // Export/Import service
    this.exportImportService = null;
    // Sync service
    this.syncService = null;
    // Core infrastructure
    this.eventBus = null;
    this.domRefs = null;
    this.logger = null;
    // Analytics
    this.statsOpen = false;
    this.charts = {};
    // Multi-select
    this.selectionMode = false;
    this.selectedNoteIds = new Set();
    this.triggerIndexing = Utils.debounce((noteId) => {
      if (noteId && this.notesManager) {
        this.notesManager.updateNoteIndex(noteId);
      } else {
        this.rebuildSearchIndex();
      }
    }, 300);
  }

  /**
   * Initialize the application
   */
  async init() {
    try {
      // Initialize core infrastructure
      this.eventBus = createEventBus();
      this.logger = createLogger();
      this.domRefs = createDomRefs();

      // Initialize storage
      await Storage.init();

      // Populate DOM cache after document is ready
      this.domRefs.init();

      // Initialize LLM service
      await LLM.init();

      // Global unhandled rejection handler
      window.addEventListener('unhandledrejection', (event) => {
        this.logger.error('App', 'Unhandled promise rejection', event.reason);
        Utils.showToast('An unexpected error occurred', 'error');
      });

      // Get notes and folders
      this.notes = await Storage.getAllNotes();
      this.archivedNotes = await Storage.getArchivedNotes();
      this.trashedNotes = await Storage.getTrashedNotes();
      this.templates = await Storage.getTemplates();
      this.folders = await Storage.getAllFolders();
      await this.refreshSearchIndexEntries();

      // Initialize editors
      const editorChangeHandler = Utils.debounce(() => {
        if (this.aiChatController) {
          this.aiChatController.updateSmartSuggestions();
        } else {
          this.updateSmartSuggestions();
        }
      }, 2000);

      this.editor = new BlockEditor({
        root: document.getElementById('editor-container'),
        onChange: editorChangeHandler
      });
      this.secondaryEditor = new BlockEditor({
        root: document.getElementById('secondary-editor-container'),
        onChange: editorChangeHandler
      });
      window.editor = this.editor;
      window.secondaryEditor = this.secondaryEditor;

      // Wire version history button (Req 31.2)
      const versionHistoryBtn = document.getElementById('version-history-btn');
      if (versionHistoryBtn) {
        versionHistoryBtn.addEventListener('click', () => {
          const activeEditor = this.getEditor();
          if (activeEditor && activeEditor.noteId) {
            activeEditor.toggleVersionHistory();
          }
        });
      }

      // Wire focus mode button (Req 32.1)
      const focusModeBtn = document.getElementById('focus-mode-btn');
      if (focusModeBtn) {
        focusModeBtn.addEventListener('click', () => {
          this.toggleFocusMode();
        });
      }

      // Setup UI
      this.setupPageSelector(this.notes);
      await this.initSidebarController();
      await this.initTabController();
      await this.initAIChatController();
      await this.initSettingsController();
      this.setupEmptyState();
      await this.initNotesManager();
      await this.initShortcutsManager();
      await this.initExportImportService();

      // Initialize Theme Engine
      await Themes.init();
      await this.initThemeBuilderController();

      // Check if we have notes to display
      const hasCompletedOnboarding = await Onboarding.hasCompleted();
      if (this.notes.length === 0 && this.archivedNotes.length === 0 && !hasCompletedOnboarding) {
        // First-run: show onboarding walkthrough
        await this.runOnboarding();
      } else if (this.notes.length === 0 && this.archivedNotes.length === 0) {
        // Returning user with no notes
        await this.createFirstNote();
      } else if (this.notes.length > 0) {
        // Try loading cached last-opened note for fast startup (Req 27.2)
        const cachedNoteId = await TabController.getCachedLastOpenedNoteId();
        const cachedNote = cachedNoteId ? this.notes.find(n => n.id === cachedNoteId) : null;
        if (cachedNote) {
          await this.editor.loadNote(cachedNote.id);
        } else {
          await this.editor.loadNote(this.notes[0].id);
        }
        await this.tabController.loadSavedTabs();
      }

      this.updateEmptyState();
      this.updateBadgeCounts();

      // Defer non-critical initialization until after first render (Req 27.1)
      const deferWork = async () => {
        await this.initAnalyticsController();
        await this.initGraphView();
        await this.initSyncService();
        if (this.notesManager) {
          await this.notesManager.deferredInit();
          this.indexerWorker = this.notesManager.indexerWorker;
        }
      };

      if (typeof requestIdleCallback === 'function') {
        requestIdleCallback(() => deferWork().catch(e => this.logger.error('App', 'Deferred init failed', e)));
      } else {
        setTimeout(() => deferWork().catch(e => this.logger.error('App', 'Deferred init failed', e)), 200);
      }

      this.logger.info('App', 'New Tab Note initialized successfully');
    } catch (error) {
      console.error('Failed to initialize app:', error);
      this.showErrorState(error);
    }
  }

  /**
   * Setup empty state button
   */
  setupEmptyState() {
    const createBtn = document.getElementById('empty-state-create-btn');
    if (createBtn) {
      createBtn.addEventListener('click', async () => {
        await this.createFirstNote();
      });
    }
  }

  /**
   * Create first note from empty state
   */
  async createFirstNote() {
    const note = await Storage.createNote('Untitled');
    await this.refreshNotesList();
    await this.openNoteInNewTab(note.id);
    document.getElementById('page-title').focus();
  }

  /**
   * Run onboarding for new users
   */
  async runOnboarding() {
    // 1. Setup default settings
    await Onboarding.setupFirstRun();

    // 2. Create Welcome Note with example blocks
    const note = await Storage.createNote('Welcome to NewTabNote 🚀');
    const blocks = Onboarding.getWelcomeNoteContent();
    for (let i = 0; i < blocks.length; i++) {
      const blockData = blocks[i];
      await Storage.saveElement({
        id: Utils.generateId(),
        type: blockData.type,
        content: blockData.content || '',
        canvasId: note.id,
        order: i,
        checked: blockData.checked || false,
        indentLevel: 0,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });
    }

    // 3. Load the welcome note so the editor is visible during walkthrough
    await this.refreshNotesList();
    await this.openNoteInNewTab(note.id);

    // 4. Run interactive tooltip walkthrough (dismiss at any step marks complete)
    await Onboarding.runWalkthrough();

    // 5. Mark onboarding as complete
    await Onboarding.markComplete();

    // 6. Show quick-start prompt
    const choice = await Onboarding.showQuickStartPrompt(note.id);

    // 7. Handle user's choice
    if (choice === 'blank') {
      await this.createFirstNote();
    } else if (choice === 'import') {
      // Trigger import dialog
      const importInput = document.getElementById('note-import-input');
      if (importInput) {
        importInput.click();
      }
    }
    // 'sample' — already viewing the welcome note, nothing to do
  }

  /**
   * Show pulse highlights for key features
   */
  showFeatureHighlights() {
    const targets = [
      { id: 'ai-floating-btn', name: 'AI Sidebar' },
      { id: 'sidebar-stats', name: 'Activity Dashboard' },
      { id: 'sidebar-daily-note', name: 'Daily Notes' }
    ];

    targets.forEach(target => {
      const el = document.getElementById(target.id);
      if (el) {
        el.classList.add('feature-highlight-pulse');
        // Remove after 10 seconds or when clicked
        setTimeout(() => el.classList.remove('feature-highlight-pulse'), 10000);
        el.addEventListener('click', () => el.classList.remove('feature-highlight-pulse'), { once: true });
      }
    });
  }

  /**
   * Initialize the SidebarController and wire callbacks.
   */
  async initSidebarController() {
    this.sidebarController = new SidebarController({
      storage: Storage,
      eventBus: this.eventBus,
      domRefs: this.domRefs,
      logger: this.logger,
    });

    // Share data
    this.sidebarController.notes = this.notes;
    this.sidebarController.archivedNotes = this.archivedNotes;
    this.sidebarController.trashedNotes = this.trashedNotes;
    this.sidebarController.templates = this.templates;
    this.sidebarController.folders = this.folders;
    this.sidebarController.searchIndexByNoteId = this.searchIndexByNoteId;
    this.sidebarController.searchEngine = this.searchEngine;

    // Wire callbacks so the controller can trigger App-level actions
    this.sidebarController.onOpenNoteInNewTab = (noteId) => this.openNoteInNewTab(noteId);
    this.sidebarController.onOpenNewTab = () => this.openNewTab();
    this.sidebarController.getEditor = () => this.getEditor();
    this.sidebarController.onArchiveNote = (noteId) => this.archiveNote(noteId);
    this.sidebarController.onUnarchiveNote = (noteId) => this.unarchiveNote(noteId);
    this.sidebarController.onTrashNote = (noteId) => this.trashNoteById(noteId);
    this.sidebarController.onRestoreNote = (noteId) => this.restoreNoteById(noteId);
    this.sidebarController.onPermanentlyDeleteNote = (noteId) => this.permanentlyDeleteNoteById(noteId);
    this.sidebarController.onGenerateTitle = (noteId) => this.generateTitleForNote(noteId);
    this.sidebarController.onExportNote = (noteId) => this.exportNoteById(noteId);
    this.sidebarController.onExtractInsights = (noteId) => this.extractInsightsForNote(noteId);
    this.sidebarController.onConvertNoteToTemplate = (noteId) => this.convertNoteToTemplate(noteId);
    this.sidebarController.onConvertTemplateToNote = (noteId) => this.convertTemplateToNote(noteId);
    this.sidebarController.onImportNote = (file) => this.importNote(file);

    await this.sidebarController.init();

    // Sync state back to App for backward compat
    this.sidebarOpen = this.sidebarController.sidebarOpen;
    this.sidebarView = this.sidebarController.sidebarView;
    this.sidebarWidth = this.sidebarController.sidebarWidth;
    this.sidebarSortMode = this.sidebarController.sidebarSortMode;
    this.sidebarViewMode = this.sidebarController.sidebarViewMode;
  }

  /**
   * Initialize the TabController and wire callbacks.
   */
  async initTabController() {
    this.tabController = new TabController({
      storage: Storage,
      eventBus: this.eventBus,
      domRefs: this.domRefs,
      logger: this.logger,
    });

    // Share editor references
    this.tabController.editor = this.editor;
    this.tabController.secondaryEditor = this.secondaryEditor;

    // Wire callbacks so the controller can trigger App-level actions
    this.tabController.onCreateNote = () => Storage.createNote('Untitled');
    this.tabController.onRefreshNotesList = () => this.refreshNotesList();
    this.tabController.onRenderNotesList = () => this.renderNotesList();
    this.tabController.onGetNotes = () => this.notes;

    await this.tabController.init();

    // Sync state back to App for backward compat
    this.openTabs = this.tabController.openTabs;
    this.activeTabIndex = this.tabController.activeTabIndex;
    this.splitViewEnabled = this.tabController.splitViewEnabled;
    this.activeEditorSide = this.tabController.activeEditorSide;
    this.pipWindow = this.tabController.pipWindow;
    this.pipEditor = this.tabController.pipEditor;
  }

  /**
   * Initialize the AIChatController and wire callbacks.
   */
  async initAIChatController() {
    this.aiChatController = new AIChatController({
      storage: Storage,
      eventBus: this.eventBus,
      domRefs: this.domRefs,
      logger: this.logger,
      llm: LLM,
    });

    // Share search engine reference
    this.aiChatController.searchEngine = this.searchEngine;

    // Wire callbacks so the controller can trigger App-level actions
    this.aiChatController.getEditor = () => this.getEditor();
    this.aiChatController.onOpenNoteInNewTab = (noteId) => this.openNoteInNewTab(noteId);
    this.aiChatController.onOpenNoteById = (noteId) => this.openNoteById(noteId);
    this.aiChatController.onRefreshNotesList = () => this.refreshNotesList();
    this.aiChatController.onRenderNotesList = () => this.renderNotesList();
    this.aiChatController.onOpenNewTab = () => this.openNewTab();
    this.aiChatController.onOpenSettingsModal = () => this.openSettingsModal();
    this.aiChatController.onCloseAllModals = () => this.closeAllModals();
    this.aiChatController.onGetOpenTabs = () => this.openTabs;
    this.aiChatController.onRenderTabs = () => this.renderTabs();
    this.aiChatController.onSaveTabs = () => this.saveTabs();
    this.aiChatController.onGetNotes = () => this.notes;
    this.aiChatController.onTriggerIndexing = () => this.triggerIndexing();
    this.aiChatController.onLoadEmbeddingsModel = () => {
      if (this.notesManager) this.notesManager.loadEmbeddingsModel();
    };

    await this.aiChatController.init();

    // Sync state back to App for backward compat
    this.aiSidebarOpen = this.aiChatController.aiSidebarOpen;
    this.aiSidebarWidth = this.aiChatController.aiSidebarWidth;
    this.aiChatHistory = this.aiChatController.aiChatHistory;
    this.aiPromptTemplates = this.aiChatController.aiPromptTemplates;
    this.aiInsertPreviewState = this.aiChatController.aiInsertPreviewState;
  }

  /**
   * Initialize the SettingsController and wire callbacks.
   */
  async initSettingsController() {
    this.settingsController = new SettingsController({
      storage: Storage,
      eventBus: this.eventBus,
      domRefs: this.domRefs,
      logger: this.logger,
    });

    // Wire callbacks so the controller can trigger App-level actions
    this.settingsController.getEditor = () => this.getEditor();
    this.settingsController.onApplyTheme = () => this.applyTheme();
    this.settingsController.onOpenThemeBuilder = () => {
      if (this.themeBuilderController) {
        this.themeBuilderController.openThemeBuilder();
      } else {
        this.openThemeBuilder();
      }
    };
    this.settingsController.onCloseAllModals = () => this.closeAllModals();
    this.settingsController.onRefreshNotesList = () => this.refreshNotesList();
    this.settingsController.onOpenNoteInNewTab = (noteId) => this.openNoteInNewTab(noteId);
    this.settingsController.onCloseTabForNote = (noteId) => this.closeTabForNote(noteId);
    this.settingsController.onHandleNoteRemoved = (noteId) => this.handleNoteRemoved(noteId);
    this.settingsController.onSetupAutoTitle = () => this.setupAutoTitle();
    this.settingsController.onSetupInsightsExtraction = () => this.setupInsightsExtraction();
    this.settingsController.onRenderAIPromptTemplateSettings = () => {
      if (this.aiChatController) {
        this.aiChatController.renderAIPromptTemplateSettings();
      } else {
        this.renderAIPromptTemplateSettings();
      }
    };

    // Settings sync callbacks
    this.settingsController.onSidebarStateChanged = (key, value) => {
      if (key === 'sidebarOpen') {
        this.sidebarOpen = value;
        this.updateSidebarState();
      } else if (key === 'sidebarWidth') {
        this.sidebarWidth = value;
        this.applySidebarWidth();
      } else if (key === 'sidebarViewMode') {
        this.sidebarViewMode = value;
        this.applySidebarViewMode();
      } else if (key === 'sidebarSortMode') {
        this.sidebarSortMode = value;
        const sortSelect = document.getElementById('sidebar-sort');
        if (sortSelect) sortSelect.value = this.sidebarSortMode;
        this.renderNotesList();
      }
    };
    this.settingsController.onAISidebarWidthChanged = (value) => {
      this.aiSidebarWidth = value;
      if (this.aiChatController) {
        this.aiChatController.aiSidebarWidth = this.aiSidebarWidth;
      }
      const aiSidebar = document.getElementById('ai-sidebar');
      if (aiSidebar && this.aiSidebarOpen) {
        aiSidebar.style.width = this.aiSidebarWidth + 'px';
      }
    };
    this.settingsController.onLLMSettingsChanged = async () => {
      await LLM.init();
      this.updateAISidebarState();
    };
    this.settingsController.onAIPromptTemplatesChanged = (newValue) => {
      if (this.aiChatController) {
        this.aiChatController.aiPromptTemplates = this.aiChatController.sanitizeAIPromptTemplates(newValue);
        this.aiChatController.renderAIPromptSuggestions();
        this.aiChatController.renderAIPromptTemplateSettings();
        this.aiPromptTemplates = this.aiChatController.aiPromptTemplates;
      } else {
        this.aiPromptTemplates = this.sanitizeAIPromptTemplates(newValue);
        this.renderAIPromptSuggestions();
        this.renderAIPromptTemplateSettings();
      }
    };

    await this.settingsController.init();
  }

  /**
   * Initialize the ThemeBuilderController and wire callbacks.
   */
  async initThemeBuilderController() {
    this.themeBuilderController = new ThemeBuilderController({
      storage: Storage,
      eventBus: this.eventBus,
      domRefs: this.domRefs,
      logger: this.logger,
    });

    // Wire callbacks so the controller can trigger App-level actions
    this.themeBuilderController.onApplyTheme = () => this.applyTheme();

    await this.themeBuilderController.init();
  }

  /**
   * Initialize the AnalyticsController and wire callbacks.
   */
  async initAnalyticsController() {
    this.analyticsController = new AnalyticsController({
      storage: Storage,
      eventBus: this.eventBus,
      domRefs: this.domRefs,
      logger: this.logger,
    });

    // Share data
    this.analyticsController.notes = this.notes;
    this.analyticsController.folders = this.folders;

    // Wire callbacks so the controller can query App-level state
    this.analyticsController.onGetSidebarOpen = () => this.sidebarOpen;
    this.analyticsController.onGetAISidebarOpen = () => this.aiSidebarOpen;

    await this.analyticsController.init();

    // Sync state back to App for backward compat
    this.statsOpen = this.analyticsController.statsOpen;
    this.charts = this.analyticsController.charts;
  }

  async initGraphView() {
    if (typeof GraphView === 'undefined') return;

    this.graphView = new GraphView({
      storage: Storage,
      eventBus: this.eventBus,
      logger: this.logger,
    });

    this.graphView.onOpenNote = (noteId) => this.openNoteInNewTab(noteId);
    this.graphView.onGetSidebarOpen = () => this.sidebarOpen;
    this.graphView.onGetAISidebarOpen = () => this.aiSidebarOpen;

    await this.graphView.init();
  }

  /**
   * Initialize the SyncService for cross-device sync (Req 35).
   */
  async initSyncService() {
    if (typeof SyncService === 'undefined') return;

    this.syncService = new SyncService({
      storage: Storage,
      eventBus: this.eventBus,
      logger: this.logger,
    });

    await this.syncService.init();

    // Listen for sync state changes to update UI
    this.eventBus.on('sync:stateChanged', (state) => {
      this._updateSyncStatusUI(state);
    });

    // If a provider was previously configured, try reconnecting
    if (this.syncService.state.provider) {
      try {
        const providerName = this.syncService.state.provider;
        if (providerName === 'webdav') {
          const config = await Storage.getSetting('syncWebdavConfig');
          if (config) {
            await this.syncService.connect(providerName, config);
            this.syncService.startAutoSync();
          }
        }
        // gdrive/dropbox would need re-auth via stored tokens (placeholder)
      } catch (err) {
        this.logger.warn('App', 'Failed to reconnect sync provider', err);
      }
    }

    this._updateSyncStatusUI(this.syncService.getState());
  }

  /**
   * Update the sync status indicator in the header.
   * @param {Object} state - SyncState
   */
  _updateSyncStatusUI(state) {
    let indicator = document.getElementById('sync-status-indicator');
    if (!indicator) return;

    if (!state.provider) {
      indicator.classList.add('hidden');
      return;
    }

    indicator.classList.remove('hidden');
    const icon = indicator.querySelector('.sync-status-icon');
    const text = indicator.querySelector('.sync-status-text');
    if (!icon || !text) return;

    if (state.status === 'syncing') {
      icon.className = 'sync-status-icon syncing';
      text.textContent = 'Syncing...';
    } else if (state.status === 'error') {
      icon.className = 'sync-status-icon error';
      text.textContent = state.errorMessage || 'Sync error';
    } else {
      icon.className = 'sync-status-icon idle';
      const lastSync = state.lastSyncAt
        ? new Date(state.lastSyncAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
        : 'Never';
      const pending = state.pendingChanges > 0 ? ` (${state.pendingChanges} pending)` : '';
      text.textContent = 'Synced ' + lastSync + pending;
    }
  }


  /**
   * Initialize the NotesManager and wire callbacks.
   */
  async initNotesManager() {
    this.notesManager = new NotesManager({
      storage: Storage,
      eventBus: this.eventBus,
      domRefs: this.domRefs,
      logger: this.logger,
      llm: LLM,
    });

    // Share data
    this.notesManager.notes = this.notes;
    this.notesManager.archivedNotes = this.archivedNotes;
    this.notesManager.trashedNotes = this.trashedNotes;
    this.notesManager.templates = this.templates;
    this.notesManager.folders = this.folders;
    this.notesManager.searchEngine = this.searchEngine;
    this.notesManager.searchIndexByNoteId = this.searchIndexByNoteId;

    // Wire callbacks so the manager can trigger App-level actions
    this.notesManager.onRefreshNotesList = () => this.refreshNotesList();
    this.notesManager.onRenderNotesList = () => this.renderNotesList();
    this.notesManager.onCloseTabForNote = (noteId) => this.closeTabForNote(noteId);
    this.notesManager.onOpenNoteInNewTab = (noteId) => this.openNoteInNewTab(noteId);
    this.notesManager.onCreateFirstNote = () => this.createFirstNote();
    this.notesManager.onUpdateEmptyState = () => this.updateEmptyState();
    this.notesManager.getEditor = () => this.getEditor();
    this.notesManager.getOpenTabs = () => this.openTabs;
    this.notesManager.onRenderTabs = () => this.renderTabs();
    this.notesManager.onSaveTabs = () => this.saveTabs();

    await this.notesManager.init();

    // Sync state back to App for backward compat
    this.autoTitleIntervalId = this.notesManager.autoTitleIntervalId;
    this.autoTitleRunning = this.notesManager.autoTitleRunning;
    this.insightsIntervalId = this.notesManager.insightsIntervalId;
    this.insightsRunning = this.notesManager.insightsRunning;
    this.indexerWorker = this.notesManager.indexerWorker;
  }

  /**
   * Initialize the ShortcutsManager and wire callbacks.
   */
  async initShortcutsManager() {
    this.shortcutsManager = new ShortcutsManager({
      storage: Storage,
      eventBus: this.eventBus,
      domRefs: this.domRefs,
      logger: this.logger,
    });

    // Wire callbacks so the manager can trigger App-level actions
    this.shortcutsManager.onToggleSidebar = () => this.toggleSidebar();
    this.shortcutsManager.onToggleAISidebar = () => this.toggleAISidebar();
    this.shortcutsManager.onOpenNewTab = () => this.openNewTab();
    this.shortcutsManager.onOpenNoteById = (noteId) => this.openNoteById(noteId);
    this.shortcutsManager.onOpenNoteInNewTab = (noteId) => this.openNoteInNewTab(noteId);
    this.shortcutsManager.onOpenSettingsModal = () => this.openSettingsModal();
    this.shortcutsManager.onCloseAllModals = () => this.closeAllModals();
    this.shortcutsManager.onToggleShortcutsModal = () => this.toggleShortcutsModal();
    this.shortcutsManager.onEnsureDailyNote = () => Storage.ensureDailyNote();
    this.shortcutsManager.onRefreshNotesList = () => this.refreshNotesList();
    this.shortcutsManager.onCycleTab = (dir) => {
      if (this.tabController) this.tabController.cycleTab(dir);
    };
    this.shortcutsManager.onCloseCurrentTab = () => {
      if (this.tabController) return this.tabController.closeCurrentTab();
    };
    this.shortcutsManager.getEditor = () => this.getEditor();
    this.shortcutsManager.getOpenTabs = () => this.openTabs;
    this.shortcutsManager.getNotes = () => this.notes;
    this.shortcutsManager.getArchivedNotes = () => this.archivedNotes;
    this.shortcutsManager.getSearchIndexByNoteId = () => this.searchIndexByNoteId;
    this.shortcutsManager.getSidebarOpen = () => this.sidebarOpen;
    this.shortcutsManager.getAISidebarOpen = () => this.aiSidebarOpen;

    await this.shortcutsManager.init();

    // Sync state back to App for backward compat
    this.focusMode = this.shortcutsManager.focusMode;
    this.commandPaletteItems = this.shortcutsManager.commandPaletteItems;
    this.commandPaletteIndex = this.shortcutsManager.commandPaletteIndex;
  }

  /**
   * Initialize the ExportImportService and wire controller references.
   */
  async initExportImportService() {
    this.exportImportService = new ExportImportService({
      storage: Storage,
      eventBus: this.eventBus,
      domRefs: this.domRefs,
      logger: this.logger,
    });

    // Wire controller references
    this.exportImportService.settingsController = this.settingsController;
    this.exportImportService.notesManager = this.notesManager;

    // Wire App-level callbacks
    this.exportImportService.getEditor = () => this.getEditor();
    this.exportImportService.onRefreshNotesList = () => this.refreshNotesList();
    this.exportImportService.onOpenNoteInNewTab = (noteId) => this.openNoteInNewTab(noteId);

    await this.exportImportService.init();
  }

  /**
   * Setup sidebar functionality
   */
  async setupSidebar() {
    const sidebar = document.getElementById('sidebar');
    const toggleBtn = document.getElementById('sidebar-toggle');
    const newNoteBtn = document.getElementById('sidebar-new-note');
    const searchInput = document.getElementById('sidebar-search');
    const sortSelect = document.getElementById('sidebar-sort');
    const tabNotes = document.getElementById('sidebar-tab-notes');
    const tabTemplates = document.getElementById('sidebar-tab-templates');
    const tabArchive = document.getElementById('sidebar-tab-archive');
    const tabTrash = document.getElementById('sidebar-tab-trash');
    const emptyTrashBtn = document.getElementById('empty-trash-btn');
    const dailyNoteBtn = document.getElementById('sidebar-daily-note');
    const newFolderBtn = document.getElementById('sidebar-new-folder');

    // Load sidebar state from settings
    this.sidebarOpen = await Storage.getSetting('sidebarOpen', true);
    this.sidebarWidth = await Storage.getSetting('sidebarWidth', 260);
    this.sidebarSortMode = await Storage.getSetting('sidebarSortMode', 'updated');
    this.sidebarViewMode = await Storage.getSetting('sidebarViewMode', 'list');
    if (sortSelect) {
      sortSelect.value = this.sidebarSortMode;
    }

    this.updateSidebarState();
    this.applySidebarWidth();
    this.applySidebarViewMode();

    // Toggle sidebar
    toggleBtn.addEventListener('click', async () => {
      await this.toggleSidebar();
    });

    // New note button - opens in new tab
    newNoteBtn.addEventListener('click', async () => {
      // Switch to notes view if not already
      if (this.sidebarView !== 'notes') {
        this.sidebarView = 'notes';
        this.updateSidebarTabs();
      }
      await this.openNewTab();
    });

    // Daily Note button
    if (dailyNoteBtn) {
      dailyNoteBtn.addEventListener('click', async () => {
        const note = await Storage.ensureDailyNote();
        await this.refreshNotesList();
        await this.openNoteInNewTab(note.id);
      });
    }

    // New Folder button
    if (newFolderBtn) {
      newFolderBtn.addEventListener('click', async () => {
        const name = await promptDialog({ title: 'New Folder', message: 'Folder name:', defaultValue: 'New Folder' });
        if (name) {
          await Storage.createFolder(name);
          await this.refreshNotesList();
        }
      });
    }

    // Import note button
    const importNoteBtn = document.getElementById('sidebar-import-note');
    const noteImportInput = document.getElementById('note-import-input');

    if (importNoteBtn && noteImportInput) {
      importNoteBtn.addEventListener('click', () => {
        // Switch to notes view if not already
        if (this.sidebarView !== 'notes') {
          this.sidebarView = 'notes';
          this.updateSidebarTabs();
        }
        noteImportInput.click();
      });

      noteImportInput.addEventListener('change', async (e) => {
        const file = e.target.files[0];
        if (file) {
          await this.importNote(file);
        }
        e.target.value = '';
      });
    }

    // Search input with fuzzy search
    searchInput.addEventListener('input', async (e) => {
      this.searchQuery = e.target.value;
      await this.renderNotesList();
    });

    if (sortSelect) {
      sortSelect.addEventListener('change', async (e) => {
        this.sidebarSortMode = e.target.value;
        await Storage.setSetting('sidebarSortMode', this.sidebarSortMode);
        await this.renderNotesList();
      });
    }

    // Sidebar tabs
    tabNotes.addEventListener('click', () => {
      this.sidebarView = 'notes';
      this.updateSidebarTabs();
      this.refreshNotesList();
    });

    if (tabTemplates) {
      tabTemplates.addEventListener('click', () => {
        this.sidebarView = 'templates';
        this.updateSidebarTabs();
        this.refreshNotesList();
      });
    }

    tabArchive.addEventListener('click', async () => {
      this.sidebarView = 'archive';
      this.updateSidebarTabs();
      await this.renderNotesList();
    });

    tabTrash.addEventListener('click', async () => {
      this.sidebarView = 'trash';
      this.updateSidebarTabs();
      await this.renderNotesList();
    });

    // Empty trash button
    emptyTrashBtn.addEventListener('click', async () => {
      await this.emptyTrash();
    });

    // Setup calendar
    this.setupCalendar();

    // Setup sidebar resize
    this.setupSidebarResize();

    // Setup view toggle
    this.setupSidebarViewToggle();

    // Setup context menu
    this.setupNoteContextMenu();

    // Bulk Actions
    const bulkArchiveBtn = document.getElementById('bulk-archive-btn');
    const bulkDeleteBtn = document.getElementById('bulk-delete-btn');
    const bulkCancelBtn = document.getElementById('bulk-cancel-btn');

    if (bulkArchiveBtn) bulkArchiveBtn.addEventListener('click', () => this.performBulkAction('archive'));
    if (bulkDeleteBtn) bulkDeleteBtn.addEventListener('click', () => this.performBulkAction('trash'));
    if (bulkCancelBtn) bulkCancelBtn.addEventListener('click', () => this.exitSelectionMode());

    // Run trash cleanup on startup
    await this.runTrashCleanup();
  }

  /**
   * Setup sidebar resize functionality
   */
  setupSidebarResize() {
    const sidebar = document.getElementById('sidebar');
    const resizeHandle = document.getElementById('sidebar-resize-handle');

    if (this.sidebarResizer) {
      this.sidebarResizer.destroy();
    }

    if (!sidebar || !resizeHandle) return;

    this.sidebarResizer = new ResizablePanel({
      panel: sidebar,
      handle: resizeHandle,
      min: 180,
      max: 500,
      direction: 'right',
      onResizeEnd: async (width) => {
        this.sidebarWidth = width;
        await Storage.setSetting('sidebarWidth', this.sidebarWidth);
      },
    });
  }

  /**
   * Setup sidebar view toggle (list/cards)
   */
  setupSidebarViewToggle() {
    const listBtn = document.getElementById('sidebar-view-list');
    const cardsBtn = document.getElementById('sidebar-view-cards');

    if (!listBtn || !cardsBtn) return;

    listBtn.addEventListener('click', async () => {
      this.sidebarViewMode = 'list';
      this.applySidebarViewMode();
      await Storage.setSetting('sidebarViewMode', 'list');
    });

    cardsBtn.addEventListener('click', async () => {
      this.sidebarViewMode = 'cards';
      this.applySidebarViewMode();
      await Storage.setSetting('sidebarViewMode', 'cards');
    });
  }

  /**
   * Setup calendar widget
   */
  setupCalendar() {
    const prevBtn = document.getElementById('calendar-prev');
    const nextBtn = document.getElementById('calendar-next');
    const todayBtn = document.getElementById('calendar-today');

    if (prevBtn) {
      prevBtn.addEventListener('click', () => {
        this.calendarMonth--;
        if (this.calendarMonth < 0) {
          this.calendarMonth = 11;
          this.calendarYear--;
        }
        this.renderCalendar();
      });
    }

    if (nextBtn) {
      nextBtn.addEventListener('click', () => {
        this.calendarMonth++;
        if (this.calendarMonth > 11) {
          this.calendarMonth = 0;
          this.calendarYear++;
        }
        this.renderCalendar();
      });
    }

    if (todayBtn) {
      todayBtn.addEventListener('click', () => {
        const now = new Date();
        this.calendarMonth = now.getMonth();
        this.calendarYear = now.getFullYear();
        this.renderCalendar();
      });
    }

    this.renderCalendar();
  }

  /**
   * Render calendar grid
   */
  renderCalendar() {
    if (this.sidebarController) {
      this.sidebarController.renderCalendar();
      return;
    }
    const daysContainer = document.getElementById('calendar-days');
    const monthLabel = document.getElementById('calendar-month-label');
    if (!daysContainer || !monthLabel) return;

    const year = this.calendarYear;
    const month = this.calendarMonth;

    // Update month label
    const monthDate = new Date(year, month, 1);
    monthLabel.textContent = monthDate.toLocaleDateString('en-US', { month: 'short', year: 'numeric' });

    // Build set of dates that have daily notes
    const dailyNoteDates = new Set();
    const allNotes = [...this.notes, ...this.archivedNotes];
    allNotes.forEach(n => {
      if (n.isDaily && n.dateStr) dailyNoteDates.add(n.dateStr);
    });

    const today = new Date();
    const todayStr = today.toISOString().split('T')[0];

    // First day of the month and total days
    const firstDay = new Date(year, month, 1).getDay(); // 0=Sun
    const daysInMonth = new Date(year, month + 1, 0).getDate();
    const daysInPrevMonth = new Date(year, month, 0).getDate();

    daysContainer.innerHTML = '';

    // Previous month padding days
    for (let i = firstDay - 1; i >= 0; i--) {
      const day = daysInPrevMonth - i;
      const prevMonth = month === 0 ? 11 : month - 1;
      const prevYear = month === 0 ? year - 1 : year;
      const dateStr = `${prevYear}-${String(prevMonth + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
      const el = this.createCalendarDay(day, dateStr, 'other-month', dailyNoteDates, todayStr);
      daysContainer.appendChild(el);
    }

    // Current month days
    for (let day = 1; day <= daysInMonth; day++) {
      const dateStr = `${year}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
      const el = this.createCalendarDay(day, dateStr, '', dailyNoteDates, todayStr);
      daysContainer.appendChild(el);
    }

    // Next month padding to fill remaining cells
    const totalCells = firstDay + daysInMonth;
    const remaining = totalCells % 7 === 0 ? 0 : 7 - (totalCells % 7);
    for (let day = 1; day <= remaining; day++) {
      const nextMonth = month === 11 ? 0 : month + 1;
      const nextYear = month === 11 ? year + 1 : year;
      const dateStr = `${nextYear}-${String(nextMonth + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
      const el = this.createCalendarDay(day, dateStr, 'other-month', dailyNoteDates, todayStr);
      daysContainer.appendChild(el);
    }
  }

  /**
   * Create a calendar day element
   */
  createCalendarDay(day, dateStr, extraClass, dailyNoteDates, todayStr) {
    const el = document.createElement('div');
    el.className = 'calendar-day';
    if (extraClass) el.classList.add(extraClass);
    if (dateStr === todayStr) el.classList.add('today');
    if (dailyNoteDates.has(dateStr)) el.classList.add('has-note');
    el.textContent = day;
    el.dataset.date = dateStr;

    el.addEventListener('click', async () => {
      const note = await Storage.ensureDailyNoteForDate(dateStr);
      await this.refreshNotesList();
      await this.openNoteInNewTab(note.id);
    });

    return el;
  }

  /**
   * Apply sidebar width from settings
   */
  applySidebarWidth() {
    if (this.sidebarController) {
      this.sidebarController.applySidebarWidth();
      return;
    }
    const sidebar = document.getElementById('sidebar');
    if (sidebar && this.sidebarWidth) {
      sidebar.style.width = this.sidebarWidth + 'px';
    }
  }

  /**
   * Apply sidebar view mode (list/cards)
   */
  applySidebarViewMode() {
    if (this.sidebarController) {
      this.sidebarController.applySidebarViewMode();
      return;
    }
    const notesList = document.getElementById('sidebar-notes-list');
    const listBtn = document.getElementById('sidebar-view-list');
    const cardsBtn = document.getElementById('sidebar-view-cards');

    if (notesList) {
      notesList.classList.toggle('cards-view', this.sidebarViewMode === 'cards');
    }

    if (listBtn && cardsBtn) {
      listBtn.classList.toggle('active', this.sidebarViewMode === 'list');
      cardsBtn.classList.toggle('active', this.sidebarViewMode === 'cards');
    }
  }

  /**
   * Update sidebar tabs active state
   */
  updateSidebarTabs() {
    if (this.sidebarController) {
      this.sidebarController.updateSidebarTabs();
      return;
    }
    const tabNotes = document.getElementById('sidebar-tab-notes');
    const tabTemplates = document.getElementById('sidebar-tab-templates');
    const tabArchive = document.getElementById('sidebar-tab-archive');
    const tabTrash = document.getElementById('sidebar-tab-trash');
    const noteActions = document.querySelector('.sidebar-note-actions');
    const trashActions = document.getElementById('sidebar-trash-actions');

    tabNotes.classList.toggle('active', this.sidebarView === 'notes');
    if (tabTemplates) {
      tabTemplates.classList.toggle('active', this.sidebarView === 'templates');
    }
    // Archive and Trash are now footer buttons
    if (tabArchive) tabArchive.classList.toggle('active', this.sidebarView === 'archive');
    if (tabTrash) tabTrash.classList.toggle('active', this.sidebarView === 'trash');

    // Hide note actions and calendar in views other than notes
    const isNotesView = this.sidebarView === 'notes';
    if (noteActions) {
      noteActions.style.display = isNotesView ? 'flex' : 'none';
    }
    const calendar = document.getElementById('sidebar-calendar');
    if (calendar) {
      calendar.style.display = isNotesView ? 'block' : 'none';
    }

    // Show trash actions only in trash view
    trashActions.classList.toggle('hidden', this.sidebarView !== 'trash' || this.trashedNotes.length === 0);
  }

  /**
   * Setup context menu for notes
   */
  setupNoteContextMenu() {
    const contextMenu = document.getElementById('note-context-menu');

    // Close context menu on click outside
    document.addEventListener('click', (e) => {
      if (!contextMenu.contains(e.target)) {
        contextMenu.classList.add('hidden');
        this.contextMenuNoteId = null;
      }
    });

    // Context menu actions
    document.getElementById('ctx-open-note').addEventListener('click', async () => {
      const noteId = this.contextMenuNoteId;
      contextMenu.classList.add('hidden');
      if (noteId) {
        await this.openNoteInNewTab(noteId);
      }
    });

    document.getElementById('ctx-generate-title').addEventListener('click', async () => {
      const noteId = this.contextMenuNoteId;
      contextMenu.classList.add('hidden');
      if (noteId) {
        await this.generateTitleForNote(noteId);
      }
    });

    document.getElementById('ctx-export-note').addEventListener('click', async () => {
      const noteId = this.contextMenuNoteId;
      contextMenu.classList.add('hidden');
      if (noteId) {
        await this.exportNoteById(noteId);
      }
    });

    document.getElementById('ctx-extract-insights').addEventListener('click', async () => {
      const noteId = this.contextMenuNoteId;
      contextMenu.classList.add('hidden');
      if (noteId) {
        await this.extractInsightsForNote(noteId);
      }
    });

    document.getElementById('ctx-archive-note').addEventListener('click', async () => {
      const noteId = this.contextMenuNoteId;
      contextMenu.classList.add('hidden');
      if (noteId) {
        await this.archiveNote(noteId);
      }
    });

    document.getElementById('ctx-unarchive-note').addEventListener('click', async () => {
      const noteId = this.contextMenuNoteId;
      contextMenu.classList.add('hidden');
      if (noteId) {
        await this.unarchiveNote(noteId);
      }
    });

    document.getElementById('ctx-delete-note').addEventListener('click', async () => {
      const noteId = this.contextMenuNoteId;
      contextMenu.classList.add('hidden');
      if (noteId) {
        await this.trashNoteById(noteId);
      }
    });

    document.getElementById('ctx-restore-note').addEventListener('click', async () => {
      const noteId = this.contextMenuNoteId;
      contextMenu.classList.add('hidden');
      if (noteId) {
        await this.restoreNoteById(noteId);
      }
    });

    document.getElementById('ctx-delete-permanent').addEventListener('click', async () => {
      const noteId = this.contextMenuNoteId;
      contextMenu.classList.add('hidden');
      if (noteId) {
        await this.permanentlyDeleteNoteById(noteId);
      }
    });

    document.getElementById('ctx-convert-template').addEventListener('click', async () => {
      const noteId = this.contextMenuNoteId;
      contextMenu.classList.add('hidden');
      if (noteId) {
        await this.convertNoteToTemplate(noteId);
      }
    });

    document.getElementById('ctx-back-to-note').addEventListener('click', async () => {
      const noteId = this.contextMenuNoteId;
      contextMenu.classList.add('hidden');
      if (noteId) {
        await this.convertTemplateToNote(noteId);
      }
    });
  }

  /**
   * Export a note by ID as markdown
   */
  async exportNoteById(noteId) {
    if (this.notesManager) {
      await this.notesManager.exportNoteById(noteId);
      return;
    }
    try {
      const note = await Storage.getNote(noteId);
      if (!note) {
        Utils.showToast('Note not found', 'error');
        return;
      }

      const blocks = await Storage.getElementsByNote(noteId);

      // Build markdown content
      let markdown = `# ${note.name || 'Untitled'}\n\n`;

      // Sort blocks by order
      const sortedBlocks = blocks.sort((a, b) => (a.order || 0) - (b.order || 0));

      for (const block of sortedBlocks) {
        markdown += this.blockToMarkdown(block);
      }

      // Generate filename from note title
      const filename = (note.name || 'Untitled')
        .replace(/[^a-z0-9\s-]/gi, '')
        .replace(/\s+/g, '-')
        .toLowerCase() + '.md';

      Utils.downloadFile(markdown, filename);
      Utils.showToast('Note exported', 'success');
    } catch (error) {
      console.error('Export note failed:', error);
      Utils.showToast('Export failed', 'error');
    }
  }

  /**
   * Convert a block to markdown format
   */
  blockToMarkdown(block) {
    const content = this.htmlToMarkdown(block.content || '');

    switch (block.type) {
      case 'h1':
        return `# ${content}\n\n`;
      case 'h2':
        return `## ${content}\n\n`;
      case 'h3':
        return `### ${content}\n\n`;
      case 'bullet':
        return `- ${content}\n`;
      case 'numbered':
        return `1. ${content}\n`;
      case 'todo':
        const checked = block.checked ? 'x' : ' ';
        return `- [${checked}] ${content}\n`;
      case 'quote':
        return `> ${content}\n\n`;
      case 'code':
        return `\`\`\`\n${content}\n\`\`\`\n\n`;
      case 'divider':
        return `---\n\n`;
      case 'callout':
        return `> 💡 ${content}\n\n`;
      case 'toggle':
        const childContent = this.htmlToMarkdown(block.children || '');
        return `<details>\n<summary>${content}</summary>\n\n${childContent}\n</details>\n\n`;
      case 'table':
        if (block.tableData && Array.isArray(block.tableData)) {
          let tableMarkdown = '';
          block.tableData.forEach((row, index) => {
            tableMarkdown += '| ' + row.join(' | ') + ' |\n';
            if (index === 0) {
              tableMarkdown += '| ' + row.map(() => '---').join(' | ') + ' |\n';
            }
          });
          return tableMarkdown + '\n';
        }
        return '';
      case 'bookmark':
        return `[${block.title || block.url}](${block.url})\n\n`;
      case 'image':
        if (block.src) {
          return `![${block.caption || 'Image'}](${block.src})\n\n`;
        }
        return '';
      case 'equation':
        return `$$${block.equation || ''}$$\n\n`;
      case 'text':
      default:
        return content ? `${content}\n\n` : '';
    }
  }

  /**
   * Parse markdown text into an array of block objects
   */
  markdownToBlocks(text) {
    if (typeof AIResponseUtils !== 'undefined' && AIResponseUtils.markdownToBlocks) {
      return AIResponseUtils.markdownToBlocks(text);
    }

    const blocks = [];
    const lines = text.split('\n');
    let i = 0;

    while (i < lines.length) {
      const line = lines[i];

      // Skip empty lines
      if (line.trim() === '') {
        i++;
        continue;
      }

      // Fenced code block
      if (line.trim().startsWith('```')) {
        const codeLines = [];
        i++;
        while (i < lines.length && !lines[i].trim().startsWith('```')) {
          codeLines.push(lines[i]);
          i++;
        }
        i++; // skip closing ```
        blocks.push({ type: 'code', content: Utils.escapeHtml(codeLines.join('\n')) });
        continue;
      }

      // Horizontal rule
      if (/^(-{3,}|\*{3,}|_{3,})$/.test(line.trim())) {
        blocks.push({ type: 'divider', content: '' });
        i++;
        continue;
      }

      // Headers
      const h1Match = line.match(/^# (.+)$/);
      if (h1Match) {
        blocks.push({ type: 'h1', content: this.markdownInlineToHtml(h1Match[1]) });
        i++;
        continue;
      }
      const h2Match = line.match(/^## (.+)$/);
      if (h2Match) {
        blocks.push({ type: 'h2', content: this.markdownInlineToHtml(h2Match[1]) });
        i++;
        continue;
      }
      const h3Match = line.match(/^### (.+)$/);
      if (h3Match) {
        blocks.push({ type: 'h3', content: this.markdownInlineToHtml(h3Match[1]) });
        i++;
        continue;
      }

      // Todo items: - [x] or - [ ]
      const todoMatch = line.match(/^- \[([ xX])\] (.*)$/);
      if (todoMatch) {
        blocks.push({
          type: 'todo',
          content: this.markdownInlineToHtml(todoMatch[2]),
          checked: todoMatch[1].toLowerCase() === 'x',
        });
        i++;
        continue;
      }

      // Bullet list items
      const bulletMatch = line.match(/^[\-\*] (.+)$/);
      if (bulletMatch) {
        blocks.push({ type: 'bullet', content: this.markdownInlineToHtml(bulletMatch[1]) });
        i++;
        continue;
      }

      // Numbered list items
      const numberedMatch = line.match(/^\d+\. (.+)$/);
      if (numberedMatch) {
        blocks.push({ type: 'numbered', content: this.markdownInlineToHtml(numberedMatch[1]) });
        i++;
        continue;
      }

      // Blockquote
      const quoteMatch = line.match(/^> (.+)$/);
      if (quoteMatch) {
        const quoteLines = [quoteMatch[1]];
        i++;
        while (i < lines.length && lines[i].match(/^> (.+)$/)) {
          quoteLines.push(lines[i].match(/^> (.+)$/)[1]);
          i++;
        }
        blocks.push({ type: 'quote', content: this.markdownInlineToHtml(quoteLines.join('\n')) });
        continue;
      }

      // Table (line with pipes)
      if (line.trim().startsWith('|') && line.trim().endsWith('|')) {
        const tableRows = [];
        while (i < lines.length && lines[i].trim().startsWith('|') && lines[i].trim().endsWith('|')) {
          const row = lines[i].trim();
          // Skip separator row (| --- | --- |)
          if (/^\|[\s\-:]+\|$/.test(row.replace(/\|/g, '|').replace(/[^|\-:\s]/g, ''))) {
            i++;
            continue;
          }
          const cells = row.slice(1, -1).split('|').map(c => c.trim());
          tableRows.push(cells);
          i++;
        }
        if (tableRows.length > 0) {
          blocks.push({
            type: 'table',
            content: '',
            tableData: tableRows,
            rows: tableRows.length,
            cols: tableRows[0].length,
          });
        }
        continue;
      }

      // Equation block ($$...$$)
      if (line.trim().startsWith('$$')) {
        let equation = line.trim().slice(2);
        if (equation.endsWith('$$')) {
          equation = equation.slice(0, -2);
        } else {
          i++;
          const eqLines = [equation];
          while (i < lines.length && !lines[i].trim().endsWith('$$')) {
            eqLines.push(lines[i]);
            i++;
          }
          if (i < lines.length) {
            eqLines.push(lines[i].trim().slice(0, -2));
            i++;
          }
          equation = eqLines.join('\n');
        }
        blocks.push({ type: 'equation', content: '', equation: equation.trim() });
        if (line.trim().endsWith('$$') && line.trim() !== '$$') i++;
        continue;
      }

      // Image: ![alt](src)
      const imgMatch = line.match(/^!\[([^\]]*)\]\(([^)]+)\)$/);
      if (imgMatch) {
        blocks.push({ type: 'image', content: '', caption: imgMatch[1], src: imgMatch[2], imageUrl: imgMatch[2] });
        i++;
        continue;
      }

      // Link on its own line: [text](url) — treat as bookmark
      const linkMatch = line.match(/^\[([^\]]+)\]\(([^)]+)\)$/);
      if (linkMatch) {
        blocks.push({ type: 'bookmark', content: '', title: linkMatch[1], url: linkMatch[2] });
        i++;
        continue;
      }

      // Default: text paragraph (collect consecutive non-empty lines)
      const paraLines = [line];
      i++;
      while (i < lines.length && lines[i].trim() !== '' &&
             !lines[i].match(/^#{1,3} /) &&
             !lines[i].match(/^[\-\*] /) &&
             !lines[i].match(/^\d+\. /) &&
             !lines[i].match(/^> /) &&
             !lines[i].trim().startsWith('```') &&
             !lines[i].trim().startsWith('|') &&
             !lines[i].trim().startsWith('$$') &&
             !/^(-{3,}|\*{3,}|_{3,})$/.test(lines[i].trim())) {
        paraLines.push(lines[i]);
        i++;
      }
      blocks.push({ type: 'text', content: this.markdownInlineToHtml(paraLines.join('\n')) });
    }

    return blocks;
  }

  /**
   * Convert markdown inline formatting to HTML
   */
  markdownInlineToHtml(text) {
    if (typeof AIResponseUtils !== 'undefined' && AIResponseUtils.markdownInlineToHtml) {
      return AIResponseUtils.markdownInlineToHtml(text);
    }

    let result = text;
    // Bold
    result = result.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    result = result.replace(/__([^_]+)__/g, '<strong>$1</strong>');
    // Italic
    result = result.replace(/(?<![*\w])\*([^*]+)\*(?![*\w])/g, '<em>$1</em>');
    result = result.replace(/(?<![_\w])_([^_]+)_(?![_\w])/g, '<em>$1</em>');
    // Strikethrough
    result = result.replace(/~~([^~]+)~~/g, '<del>$1</del>');
    // Inline code
    result = result.replace(/`([^`]+)`/g, '<code>$1</code>');
    // Links
    result = result.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');
    // Line breaks within a paragraph
    result = result.replace(/\n/g, '<br>');
    return result;
  }

  /**
   * Show context menu for a note
   */
  showNoteContextMenu(e, noteId, viewType) {
    if (this.sidebarController) {
      this.sidebarController.showNoteContextMenu(e, noteId, viewType);
      return;
    }
    e.preventDefault();
    e.stopPropagation();

    const contextMenu = document.getElementById('note-context-menu');
    const selectBtn = document.getElementById('ctx-select-note');
    const openBtn = document.getElementById('ctx-open-note');
    const generateTitleBtn = document.getElementById('ctx-generate-title');
    const exportBtn = document.getElementById('ctx-export-note');
    const extractInsightsBtn = document.getElementById('ctx-extract-insights');
    const archiveBtn = document.getElementById('ctx-archive-note');
    const unarchiveBtn = document.getElementById('ctx-unarchive-note');
    const restoreBtn = document.getElementById('ctx-restore-note');
    const deleteBtn = document.getElementById('ctx-delete-note');
    const deletePermanentBtn = document.getElementById('ctx-delete-permanent');
    const convertTemplateBtn = document.getElementById('ctx-convert-template');
    const backToNoteBtn = document.getElementById('ctx-back-to-note');

    this.contextMenuNoteId = noteId;

    // Reset select action listener to avoid duplicates
    const newSelectBtn = selectBtn.cloneNode(true);
    selectBtn.parentNode.replaceChild(newSelectBtn, selectBtn);
    newSelectBtn.addEventListener('click', () => {
      this.enterSelectionMode(noteId);
      contextMenu.classList.add('hidden');
    });

    // Show/hide buttons based on view type
    const isNotes = viewType === 'notes';
    const isArchive = viewType === 'archive';
    const isTrash = viewType === 'trash';
    const isTemplates = viewType === 'templates';

    openBtn.classList.toggle('hidden', isTrash);
    generateTitleBtn.classList.toggle('hidden', isTrash || isTemplates);
    exportBtn.classList.toggle('hidden', isTrash);
    extractInsightsBtn.classList.toggle('hidden', isTrash || isTemplates);
    archiveBtn.classList.toggle('hidden', !isNotes);
    unarchiveBtn.classList.toggle('hidden', !isArchive);
    restoreBtn.classList.toggle('hidden', !isTrash);
    deleteBtn.classList.toggle('hidden', isTrash);
    deletePermanentBtn.classList.toggle('hidden', !isTrash);

    if (convertTemplateBtn) convertTemplateBtn.classList.toggle('hidden', !isNotes);
    if (backToNoteBtn) backToNoteBtn.classList.toggle('hidden', !isTemplates);

    // Position context menu
    const x = Math.min(e.clientX, window.innerWidth - 180);
    const y = Math.min(e.clientY, window.innerHeight - 200);
    contextMenu.style.left = x + 'px';
    contextMenu.style.top = y + 'px';
    contextMenu.classList.remove('hidden');
  }

  /**
   * Generate title for a note using AI (ignores all configurations)
   */
  async generateTitleForNote(noteId) {
    if (this.notesManager) {
      await this.notesManager.generateTitleForNote(noteId);
      return;
    }
    // Check if LLM is configured
    if (!LLM.isConfigured()) {
      Utils.showToast('AI not configured. Please set up in Settings.', 'error');
      return;
    }

    // Show loading state
    const isCurrentNote = this.editor && this.editor.noteId === noteId;
    const pageTitle = document.getElementById('page-title');
    const sidebarItem = document.querySelector(`.sidebar-note-item[data-note-id="${noteId}"]`);

    if (isCurrentNote && pageTitle) {
      pageTitle.classList.add('title-generating');
    }
    if (sidebarItem) {
      sidebarItem.classList.add('generating');
    }

    try {
      // Get note and its content
      const note = await Storage.getNote(noteId);
      if (!note) {
        Utils.showToast('Note not found', 'error');
        return;
      }

      const blocks = await Storage.getElementsByNote(noteId);
      const content = blocks
        .sort((a, b) => (a.order || 0) - (b.order || 0))
        .map(b => this.extractBlockText(b))
        .filter(t => t.trim())
        .join('\n\n');

      if (content.trim().length < 10) {
        Utils.showToast('Not enough content to generate title', 'error');
        return;
      }

      const newTitle = await LLM.generateTitle(content);

      if (!newTitle || !newTitle.trim()) {
        Utils.showToast('Failed to generate title', 'error');
        return;
      }

      // Update note with new title
      note.name = newTitle;
      note.lastAutoTitleAt = Date.now();
      await Storage.updateNote(note);

      // Update UI if this note is currently open in editor
      if (isCurrentNote) {
        this.editor.setTitleProgrammatically(newTitle);
      }

      // Update tab name if open
      const tabIndex = this.openTabs.findIndex(t => t.noteId === noteId);
      if (tabIndex !== -1) {
        this.openTabs[tabIndex].name = newTitle;
        this.renderTabs();
        await this.saveTabs();
      }

      // Update sidebar
      this.renderNotesList();

      Utils.showToast(`Title updated: "${newTitle}"`, 'success');
    } catch (error) {
      console.error('Failed to generate title:', error);
      Utils.showToast('Failed to generate title: ' + error.message, 'error');
    } finally {
      // Remove loading state
      if (pageTitle) {
        pageTitle.classList.remove('title-generating');
      }
      // Sidebar item may have been re-rendered, so query again
      const updatedSidebarItem = document.querySelector(`.sidebar-note-item[data-note-id="${noteId}"]`);
      if (updatedSidebarItem) {
        updatedSidebarItem.classList.remove('generating');
      }
    }
  }

  /**
   * Extract insights for a note by ID
   */
  async extractInsightsForNote(noteId) {
    if (this.notesManager) {
      await this.notesManager.extractInsightsForNote(noteId);
      return;
    }
    // Check if LLM is configured
    if (!LLM.isConfigured()) {
      Utils.showToast('AI not configured. Please set up in Settings.', 'error');
      return;
    }

    // Mark extraction as in progress (persisted across page refreshes)
    await Storage.setSetting(`insightsExtracting_${noteId}`, Date.now());

    // Show loading state on sidebar item
    const sidebarItem = document.querySelector(`.sidebar-note-item[data-note-id="${noteId}"]`);
    if (sidebarItem) {
      sidebarItem.classList.add('generating');
    }

    // Show loading state in insights section if this is the current note
    const isCurrentNote = this.editor && this.editor.noteId === noteId;
    if (isCurrentNote) {
      this.showInsightsLoading();
    }

    try {
      // Get note and its content
      const note = await Storage.getNote(noteId);
      if (!note) {
        Utils.showToast('Note not found', 'error');
        return;
      }

      const blocks = await Storage.getElementsByNote(noteId);
      const content = blocks
        .sort((a, b) => (a.order || 0) - (b.order || 0))
        .map(b => this.extractBlockText(b))
        .filter(t => t.trim())
        .join('\n\n');

      if (content.trim().length < 20) {
        Utils.showToast('Not enough content to extract insights', 'error');
        return;
      }

      this.logger.debug('App', 'Extracting insights for note content length:', content.length);
      const insights = await LLM.extractInsights(content, note.name);

      if (!insights) {
        Utils.showToast('Could not extract insights. Check console for details.', 'info');
        return;
      }

      // Update note with insights
      note.insights = insights;
      note.lastInsightsExtractedAt = Date.now();
      note.lastInsightsContentHash = this.generateContentHash(content);
      await Storage.updateNote(note);

      // Update UI if this note is currently open in editor
      if (isCurrentNote) {
        this.editor.noteData = note;
        this.editor.renderInsights();
      }

      // Count extracted items
      const itemCount = (insights.todos?.length || 0) +
        (insights.reminders?.length || 0) +
        (insights.deadlines?.length || 0) +
        (insights.highlights?.length || 0);

      Utils.showToast(`Extracted ${itemCount} insight${itemCount !== 1 ? 's' : ''}`, 'success');
    } catch (error) {
      console.error('Failed to extract insights:', error);
      Utils.showToast('Failed to extract insights: ' + error.message, 'error');
      // Remove loading state from insights on error
      if (isCurrentNote) {
        this.hideInsightsLoading();
      }
    } finally {
      // Clear extraction state
      await Storage.setSetting(`insightsExtracting_${noteId}`, null);

      // Remove loading state
      const updatedSidebarItem = document.querySelector(`.sidebar-note-item[data-note-id="${noteId}"]`);
      if (updatedSidebarItem) {
        updatedSidebarItem.classList.remove('generating');
      }
    }
  }

  /**
   * Show loading indicator in insights section
   */
  showInsightsLoading() {
    // Remove existing insights section
    const existingInsights = document.getElementById('note-insights');
    if (existingInsights) {
      existingInsights.remove();
    }

    // Create loading placeholder
    const loadingEl = document.createElement('div');
    loadingEl.id = 'note-insights';
    loadingEl.className = 'note-insights insights-loading';
    loadingEl.innerHTML = `
      <div class="note-insights-header">
        <div class="note-insights-title">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M12 2a2 2 0 0 1 2 2c0 .74-.4 1.39-1 1.73V7h1a7 7 0 0 1 7 7h1a1 1 0 0 1 1 1v3a1 1 0 0 1-1 1h-1v1a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-1H2a1 1 0 0 1-1-1v-3a1 1 0 0 1 1-1h1a7 7 0 0 1 7-7h1V5.73c-.6-.34-1-.99-1-1.73a2 2 0 0 1 2-2z"></path>
          </svg>
          <span>AI Insights</span>
        </div>
        <div class="insights-loading-indicator">
          <div class="insights-spinner"></div>
          <span>Extracting...</span>
        </div>
      </div>
    `;

    // Insert after timestamp
    const timestamp = document.getElementById('page-timestamp');
    if (timestamp) {
      timestamp.after(loadingEl);
    }
  }

  /**
   * Hide loading indicator in insights section
   */
  hideInsightsLoading() {
    const loadingEl = document.getElementById('note-insights');
    if (loadingEl && loadingEl.classList.contains('insights-loading')) {
      loadingEl.remove();
    }
  }

  /**
   * Archive a note by ID
   */
  async archiveNote(noteId) {
    if (this.notesManager) {
      await this.notesManager.archiveNote(noteId);
      return;
    }
    await Storage.archiveNote(noteId);
    await this.closeTabForNote(noteId);
    await this.refreshNotesList();
    await this.handleNoteRemoved(noteId);
    Utils.showToast('Note archived', 'success');
  }

  /**
   * Unarchive a note by ID
   */
  async unarchiveNote(noteId) {
    if (this.notesManager) {
      await this.notesManager.unarchiveNote(noteId);
      return;
    }
    await Storage.unarchiveNote(noteId);
    await this.refreshNotesList();
    Utils.showToast('Note restored from archive', 'success');
  }

  /**
   * Move note to trash by ID
   */
  async trashNoteById(noteId) {
    if (this.notesManager) {
      await this.notesManager.trashNoteById(noteId);
      return;
    }
    const result = await Storage.trashNote(noteId);
    await this.closeTabForNote(noteId);
    await this.refreshNotesList();
    await this.handleNoteRemoved(noteId);

    if (result && result.permanentlyDeleted) {
      Utils.showToast('Empty note deleted', 'success');
    } else {
      Utils.showToast('Note moved to trash', 'success');
    }
  }

  /**
   * Restore note from trash by ID
   */
  async restoreNoteById(noteId) {
    if (this.notesManager) {
      await this.notesManager.restoreNoteById(noteId);
      return;
    }
    await Storage.restoreNote(noteId);
    await this.refreshNotesList();
    Utils.showToast('Note restored from trash', 'success');
  }

  /**
   * Permanently delete note by ID
   */
  async permanentlyDeleteNoteById(noteId) {
    if (this.notesManager) {
      await this.notesManager.permanentlyDeleteNoteById(noteId);
      return;
    }
    if (!await confirmDialog({ title: 'Delete Permanently', message: 'Delete this note permanently? This cannot be undone.', confirmText: 'Delete', danger: true })) {
      return;
    }

    await Storage.permanentlyDeleteNote(noteId);
    Utils.showToast('Note permanently deleted', 'success');
  }

  /**
   * Close tab for a specific note if open
   */
  closeTabForNote(noteId) {
    if (this.tabController) {
      this.tabController.closeTabForNote(noteId);
      return;
    }
    const tabIndex = this.openTabs.findIndex(t => t.noteId === noteId);
    if (tabIndex !== -1) {
      this.closeTab(tabIndex);
    }
  }

  /**
   * Convert a note to a template
   */
  async convertNoteToTemplate(noteId) {
    if (this.notesManager) {
      await this.notesManager.convertNoteToTemplate(noteId);
      return;
    }
    const note = await Storage.getNote(noteId);
    if (!note) return;

    note.isTemplate = true;
    note.folderId = null; // Templates don't live in folders
    await Storage.updateNote(note);
    Utils.showToast('Note converted to template', 'success');
    await this.refreshNotesList();
  }

  /**
   * Convert a template back to a note
   */
  async convertTemplateToNote(noteId) {
    if (this.notesManager) {
      await this.notesManager.convertTemplateToNote(noteId);
      return;
    }
    const note = await Storage.getNote(noteId);
    if (!note) return;

    note.isTemplate = false;
    await Storage.updateNote(note);
    Utils.showToast('Template converted to note', 'success');
    await this.refreshNotesList();
  }

  /**
   * Handle when a note is removed (archived/trashed) - create new note or load another
   */
  async handleNoteRemoved(noteId) {
    if (this.notesManager) {
      await this.notesManager.handleNoteRemoved(noteId);
      return;
    }
    const notes = await Storage.getAllNotes();

    if (notes.length === 0) {
      // Create a new untitled note so user can start typing immediately
      await this.createFirstNote();
    } else if (this.openTabs.length === 0) {
      // Load first available note if no tabs open
      await this.openNoteInNewTab(notes[0].id);
    }

    this.updateEmptyState();
  }

  /**
   * Empty trash - permanently delete all trashed notes
   */
  async emptyTrash() {
    if (this.sidebarController) {
      await this.sidebarController.emptyTrash();
      return;
    }
    if (this.trashedNotes.length === 0) {
      Utils.showToast('Trash is already empty', 'info');
      return;
    }

    if (!await confirmDialog({ title: 'Empty Trash', message: `Permanently delete ${this.trashedNotes.length} note(s)? This cannot be undone.`, confirmText: 'Delete', danger: true })) {
      return;
    }

    await Storage.emptyTrash();
    await this.refreshNotesList();
    Utils.showToast('Trash emptied', 'success');
  }

  /**
   * Run trash cleanup based on retention setting
   */
  async runTrashCleanup() {
    const retentionDays = await Storage.getSetting('trashRetention', 30);
    if (retentionDays > 0) {
      const deletedCount = await Storage.cleanupTrash(retentionDays);
      if (deletedCount > 0) {
        this.logger.info('App', `Auto-deleted ${deletedCount} expired note(s) from trash`);
        await this.refreshNotesList();
      }
    }
  }

  /**
   * Legacy delete method - now uses trash
   */
  async deleteNoteById(noteId) {
    await this.trashNoteById(noteId);
  }

  /**
   * Update sidebar open/closed state
   */
  updateSidebarState() {
    if (this.sidebarController) {
      this.sidebarController.updateSidebarState();
      return;
    }
    const sidebar = document.getElementById('sidebar');
    const toggleBtn = document.getElementById('sidebar-toggle');
    const headerLeft = document.querySelector('.header-left');
    const sidebarToggleContainer = document.getElementById('sidebar-toggle-container');

    if (this.sidebarOpen) {
      sidebar.classList.remove('collapsed');
      toggleBtn.classList.add('active');
      // Move toggle button into sidebar
      if (sidebarToggleContainer && toggleBtn.parentElement !== sidebarToggleContainer) {
        sidebarToggleContainer.appendChild(toggleBtn);
      }
    } else {
      sidebar.classList.add('collapsed');
      toggleBtn.classList.remove('active');
      // Move toggle button back to header
      if (headerLeft && toggleBtn.parentElement !== headerLeft) {
        headerLeft.appendChild(toggleBtn);
      }
    }
  }

  /**
   * Toggle sidebar open/closed and persist the state
   */
  async toggleSidebar(force) {
    if (this.sidebarController) {
      await this.sidebarController.toggleSidebar(force);
      this.sidebarOpen = this.sidebarController.sidebarOpen;
      return;
    }
    this.sidebarOpen = force !== undefined ? force : !this.sidebarOpen;
    this.updateSidebarState();
    await Storage.setSetting('sidebarOpen', this.sidebarOpen);
  }

  toggleFocusMode(force) {
    if (this.shortcutsManager) {
      this.shortcutsManager.toggleFocusMode(force);
      this.focusMode = this.shortcutsManager.focusMode;
      return;
    }
    this.focusMode = force !== undefined ? force : !this.focusMode;
    if (this.focusMode) {
      this.closeAllModals();
    }
    document.body.classList.toggle('focus-mode', this.focusMode);
  }

  /**
   * Refresh notes list from storage
   */
  async refreshNotesList() {
    this.notes = await Storage.getAllNotes();
    this.archivedNotes = await Storage.getArchivedNotes();
    this.trashedNotes = await Storage.getTrashedNotes();
    this.templates = await Storage.getTemplates();
    this.folders = await Storage.getAllFolders();
    await this.refreshSearchIndexEntries();

    // Sync data to sidebar controller
    if (this.sidebarController) {
      this.sidebarController.notes = this.notes;
      this.sidebarController.archivedNotes = this.archivedNotes;
      this.sidebarController.trashedNotes = this.trashedNotes;
      this.sidebarController.templates = this.templates;
      this.sidebarController.folders = this.folders;
      this.sidebarController.searchIndexByNoteId = this.searchIndexByNoteId;
      this.sidebarController.updateBadgeCounts();
      await this.sidebarController.renderNotesList();
      this.sidebarController.renderCalendar();
      this.sidebarController.updateSidebarTabs();
    } else {
      this.updateBadgeCounts();
      await this.renderNotesList();
      this.renderCalendar();
      this.updateSidebarTabs();
    }

    // Sync data to notes manager
    if (this.notesManager) {
      this.notesManager.notes = this.notes;
      this.notesManager.archivedNotes = this.archivedNotes;
      this.notesManager.trashedNotes = this.trashedNotes;
      this.notesManager.templates = this.templates;
      this.notesManager.folders = this.folders;
      this.notesManager.searchIndexByNoteId = this.searchIndexByNoteId;
    }

    this.refreshPageSelector();
    this.updateEmptyState();
    if (this.shortcutsManager) {
      if (this.shortcutsManager.isCommandPaletteOpen()) {
        this.shortcutsManager.refreshCommandPaletteResults();
      }
    } else if (this.isCommandPaletteOpen()) {
      this.refreshCommandPaletteResults();
    }
  }

  /**
   * Update badge counts for archive and trash tabs
   */
  updateBadgeCounts() {
    if (this.sidebarController) {
      this.sidebarController.updateBadgeCounts();
      return;
    }
    const archiveBadge = document.getElementById('archive-count');
    const trashBadge = document.getElementById('trash-count');

    if (archiveBadge) {
      if (this.archivedNotes.length > 0) {
        archiveBadge.textContent = this.archivedNotes.length;
        archiveBadge.classList.remove('hidden');
      } else {
        archiveBadge.classList.add('hidden');
      }
    }

    if (trashBadge) {
      if (this.trashedNotes.length > 0) {
        trashBadge.textContent = this.trashedNotes.length;
        trashBadge.classList.remove('hidden');
      } else {
        trashBadge.classList.add('hidden');
      }
    }
  }

  async refreshSearchIndexEntries() {
    if (this.notesManager) {
      const entries = await this.notesManager.refreshSearchIndexEntries();
      this.searchIndexByNoteId = this.notesManager.searchIndexByNoteId;
      return entries;
    }
    const entries = await Storage.getSearchIndex();
    this.searchIndexByNoteId = new Map(entries.map(entry => [entry.noteId, entry]));
    return entries;
  }

  /**
   * Update empty state visibility
   */
  updateEmptyState() {
    const emptyState = document.getElementById('empty-state');
    const editorContainer = document.getElementById('editor-container');
    const header = document.getElementById('header');

    const hasNoNotes = this.notes.length === 0 && this.archivedNotes.length === 0;

    if (hasNoNotes) {
      emptyState.classList.remove('hidden');
      editorContainer.classList.add('hidden');
      // Hide tabs area when no notes
      document.getElementById('note-tabs').innerHTML = '';
    } else {
      emptyState.classList.add('hidden');
      editorContainer.classList.remove('hidden');
    }
  }

  /**
   * Show empty state
   */
  showEmptyState() {
    const emptyState = document.getElementById('empty-state');
    const editorContainer = document.getElementById('editor-container');

    emptyState.classList.remove('hidden');
    editorContainer.classList.add('hidden');
    document.getElementById('note-tabs').innerHTML = '';
    this.openTabs = [];
    if (this.tabController) {
      this.tabController.openTabs = this.openTabs;
    }
  }

  /**
   * Update a single note's preview data in the sidebar without a full refresh.
   * Called by the editor after each save so the sidebar stays current.
   * @param {Object} noteData - The saved note object with updated preview/todoProgress
   */
  updateSidebarNotePreview(noteData) {
    if (!noteData || !noteData.id) return;
    const lists = [this.notes, this.archivedNotes];
    if (this.sidebarController) {
      lists.push(this.sidebarController.notes, this.sidebarController.archivedNotes);
    }
    for (const list of lists) {
      if (!Array.isArray(list)) continue;
      const note = list.find(n => n.id === noteData.id);
      if (note) {
        note.preview = noteData.preview;
        note.todoProgress = noteData.todoProgress;
        note.updatedAt = noteData.updatedAt || Date.now();
        note.name = noteData.name;
      }
    }
    this.renderNotesList();
  }

  /**
   * Render notes list in sidebar (with folders)
   */
  async renderNotesList() {
    if (this.sidebarController) {
      await this.sidebarController.renderNotesList();
      return;
    }
    const list = document.getElementById('sidebar-notes-list');
    if (!list) return;

    list.innerHTML = '';
    const isSearch = this.searchQuery.trim() !== '';

    if (isSearch) {
      await this.renderSearchResults(list);
      return;
    }

    if (this.sidebarView === 'archive') {
      if (this.archivedNotes.length === 0) {
        this.renderEmptySidebar(list);
      } else {
        this.archivedNotes.forEach(note => {
          list.appendChild(this.createSidebarNoteItem(note));
        });
      }
      return;
    }

    if (this.sidebarView === 'trash') {
      if (this.trashedNotes.length === 0) {
        this.renderEmptySidebar(list);
      } else {
        this.trashedNotes.forEach(note => {
          list.appendChild(this.createSidebarNoteItem(note));
        });
      }
      return;
    }

    if (this.sidebarView === 'templates') {
      if (this.templates.length === 0) {
        this.renderEmptySidebar(list);
      } else {
        this.getSortedSidebarNotes(this.templates).forEach(note => {
          list.appendChild(this.createSidebarNoteItem(note));
        });
      }
      return;
    }

    // Default view: Notes with folders
    if (this.notes.length === 0 && this.folders.length === 0) {
      this.renderEmptySidebar(list);
      return;
    }

    // Group notes by folder
    const notesInFolders = {};
    const rootNotes = [];

    this.notes.forEach(note => {
      if (note.folderId) {
        if (!notesInFolders[note.folderId]) notesInFolders[note.folderId] = [];
        notesInFolders[note.folderId].push(note);
      } else {
        rootNotes.push(note);
      }
    });

    // Render folder tree
    this.renderFolderTree(list, null, notesInFolders);

    // Render root notes
    this.getSortedSidebarNotes(rootNotes).forEach(note => {
      list.appendChild(this.createSidebarNoteItem(note));
    });
  }

  getSortedSidebarNotes(notes) {
    if (typeof SidebarUtils === 'undefined') {
      return notes;
    }

    return SidebarUtils.sortNotes(notes, this.sidebarSortMode);
  }

  /**
   * Render folder tree recursively
   */
  renderFolderTree(container, parentId, notesInFolders) {
    const foldersToRender = this.folders.filter(f => f.parentId === parentId);

    foldersToRender.forEach(folder => {
      const folderEl = document.createElement('div');
      folderEl.className = `sidebar-folder ${folder.collapsed ? 'collapsed' : ''}`;
      folderEl.dataset.id = folder.id;

      const header = document.createElement('div');
      header.className = 'sidebar-folder-header';
      header.innerHTML = `
        <svg class="folder-arrow" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <polyline points="6 9 12 15 18 9"></polyline>
        </svg>
        <svg class="folder-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"></path>
        </svg>
        <span class="folder-name">${folder.name}</span>
      `;

      header.addEventListener('click', async (e) => {
        e.stopPropagation();
        folder.collapsed = !folder.collapsed;
        folderEl.classList.toggle('collapsed', folder.collapsed);
        await Storage.updateFolder(folder);
      });

      // Context menu for folder
      header.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        this.showFolderContextMenu(e, folder);
      });

      // Drag and drop for folder (to move notes into it)
      header.addEventListener('dragover', (e) => {
        e.preventDefault();
        header.classList.add('drag-over');
      });
      header.addEventListener('dragleave', () => {
        header.classList.remove('drag-over');
      });
      header.addEventListener('drop', async (e) => {
        e.preventDefault();
        header.classList.remove('drag-over');
        const noteId = e.dataTransfer.getData('noteId');
        const draggedFolderId = e.dataTransfer.getData('folderId');

        if (noteId) {
          await Storage.moveNoteToFolder(noteId, folder.id);
          await this.refreshNotesList();
        } else if (draggedFolderId && draggedFolderId !== folder.id) {
          // Prevent moving a folder into itself or its children
          if (!this.isChildFolder(draggedFolderId, folder.id)) {
            const draggedFolder = this.folders.find(f => f.id === draggedFolderId);
            if (draggedFolder) {
              draggedFolder.parentId = folder.id;
              await Storage.updateFolder(draggedFolder);
              await this.refreshNotesList();
            }
          }
        }
      });

      folderEl.appendChild(header);

      // Drag and drop for the whole folder (to move it into another folder)
      folderEl.draggable = true;
      folderEl.addEventListener('dragstart', (e) => {
        e.stopPropagation();
        e.dataTransfer.setData('folderId', folder.id);
        folderEl.classList.add('dragging');
      });
      folderEl.addEventListener('dragend', (e) => {
        e.stopPropagation();
        folderEl.classList.remove('dragging');
      });

      const contents = document.createElement('div');
      contents.className = 'sidebar-folder-contents';

      // Render subfolders
      this.renderFolderTree(contents, folder.id, notesInFolders);

      // Render notes in this folder
      const notes = this.getSortedSidebarNotes(notesInFolders[folder.id] || []);
      notes.forEach(note => {
        const el = this.createSidebarNoteItem(note);
        contents.appendChild(el);
      });

      folderEl.appendChild(contents);
      container.appendChild(folderEl);
    });
  }

  /**
   * Helper to render empty sidebar message
   */
  renderEmptySidebar(list, isSearch = false) {
    const empty = document.createElement('div');
    empty.className = 'sidebar-empty';
    if (isSearch) {
      empty.textContent = 'No matching notes';
    } else if (this.sidebarView === 'archive') {
      empty.textContent = 'No archived notes';
    } else if (this.sidebarView === 'trash') {
      empty.textContent = 'Trash is empty';
    } else {
      empty.textContent = 'No notes yet';
    }
    list.appendChild(empty);
  }

  /**
   * Helper to create sidebar note item
   */
  createSidebarNoteItem(note) {
    const el = document.createElement('div');
    const isActive = (this.editor && this.editor.noteId === note.id) ||
      (this.secondaryEditor && this.secondaryEditor.noteId === note.id);
    el.className = `sidebar-note-item ${isActive ? 'active' : ''}`;
    if (this.selectionMode) {
      el.classList.add('selection-mode');
    }
    if (note.archived || note.trashed) {
      el.classList.add('archived');
    }
    el.dataset.id = note.id;
    el.draggable = !this.selectionMode;

    // Checkbox for multi-select
    const checkbox = document.createElement('div');
    checkbox.className = `sidebar-note-checkbox ${this.selectedNoteIds.has(note.id) ? 'checked' : ''}`;
    checkbox.addEventListener('click', (e) => {
      e.stopPropagation();
      this.toggleNoteSelection(note.id);
    });
    el.appendChild(checkbox);

    const model = typeof SidebarUtils !== 'undefined'
      ? SidebarUtils.buildSidebarNoteModel(note, {
        searchIndexEntry: this.searchIndexByNoteId.get(note.id),
      })
      : {
        title: note.name || 'Untitled',
        preview: note.preview || '',
        relativeTime: '',
        tags: [],
        todoSummary: '',
        isPinned: Boolean(note.pinned),
      };

    const content = document.createElement('div');
    content.className = 'sidebar-note-content';

    const header = document.createElement('div');
    header.className = 'sidebar-note-header';

    const title = document.createElement('div');
    title.className = 'sidebar-note-name';
    title.textContent = model.title;
    header.appendChild(title);

    if (model.relativeTime) {
      const time = document.createElement('div');
      time.className = 'sidebar-note-time';
      time.textContent = model.relativeTime;
      header.appendChild(time);
    }

    content.appendChild(header);

    if (model.preview) {
      const preview = document.createElement('div');
      preview.className = 'sidebar-note-preview';
      preview.textContent = model.preview;
      content.appendChild(preview);
    }

    if (model.todoSummary || model.tags.length > 0) {
      const footer = document.createElement('div');
      footer.className = 'sidebar-note-footer';

      if (model.todoSummary) {
        const progress = document.createElement('span');
        progress.className = 'sidebar-note-progress';
        progress.textContent = model.todoSummary;
        footer.appendChild(progress);
      }

      model.tags.forEach(tag => {
        const tagEl = document.createElement('span');
        tagEl.className = 'sidebar-note-tag';
        tagEl.textContent = `#${tag}`;
        footer.appendChild(tagEl);
      });

      content.appendChild(footer);
    }

    el.appendChild(content);

    const canPin = this.sidebarView === 'notes' && !note.archived && !note.trashed && !note.isTemplate;
    if (canPin) {
      const pinBtn = document.createElement('button');
      pinBtn.className = `sidebar-note-pin ${model.isPinned ? 'pinned' : ''}`;
      pinBtn.type = 'button';
      pinBtn.title = model.isPinned ? 'Unpin note' : 'Pin note';
      pinBtn.setAttribute('aria-label', model.isPinned ? 'Unpin note' : 'Pin note');
      pinBtn.setAttribute('aria-pressed', model.isPinned ? 'true' : 'false');
      pinBtn.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <path d="M12 17v5"></path>
        <path d="M5 3h14l-3 7v4l-4-2-4 2v-4z"></path>
      </svg>`;
      pinBtn.addEventListener('click', async (e) => {
        e.stopPropagation();
        await this.toggleNotePin(note.id);
      });
      el.appendChild(pinBtn);
    }

    el.addEventListener('click', () => {
      if (this.selectionMode) {
        this.toggleNoteSelection(note.id);
      } else {
        this.openNoteInNewTab(note.id);
      }
    });

    el.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      this.showNoteContextMenu(e, note.id, this.sidebarView);
    });

    return el;
  }

  async toggleNotePin(noteId) {
    const note = await Storage.getNote(noteId);
    if (!note) {
      return;
    }

    note.pinned = !note.pinned;
    await Storage.updateNote(note);
    await this.refreshNotesList();
    Utils.showToast(note.pinned ? 'Note pinned' : 'Note unpinned', 'success');
  }

  /**
   * Render search results (flat list)
   */
  async renderSearchResults(list) {
    // Sync search index data to SearchEngine
    const searchIndexData = await this.refreshSearchIndexEntries();
    this.searchEngine.updateIndex(searchIndexData);
    const searchResults = await this.searchEngine.search(this.searchQuery);

    // Filter based on current view
    let sourceNotes = this.notes;
    if (this.sidebarView === 'archive') sourceNotes = this.archivedNotes;
    if (this.sidebarView === 'trash') sourceNotes = this.trashedNotes;

    const searchResultIds = new Set(searchResults.map(r => r.id));
    const filteredNotes = sourceNotes.filter(n => searchResultIds.has(n.id));

    // Sort by search score
    const scoreMap = new Map(searchResults.map(r => [r.id, r.score]));
    filteredNotes.sort((a, b) => (scoreMap.get(b.id) || 0) - (scoreMap.get(a.id) || 0));

    filteredNotes.forEach(note => {
      const el = this.createSidebarNoteItem(note);
      list.appendChild(el);
    });

    if (filteredNotes.length === 0) {
      this.renderEmptySidebar(list, true);
    }
  }

  /**
   * Render notes as cards (fallback for scroller)
   */
  renderNotesCards(list, filteredNotes) {
    list.innerHTML = '';
    list.classList.add('cards-view');
    // ... implement if needed, or just use existing logic
    filteredNotes.forEach(note => {
      const item = this.createSidebarNoteItem(note);
      list.appendChild(item);
    });
  }

  /**
   * Setup page selector (legacy - now using tabs)
   * Kept for backward compatibility but does nothing
   */
  setupPageSelector(notes) {
    // Legacy method - tabs are now used instead
    // The page-select element has been removed from HTML
  }

  /**
   * Refresh page selector (legacy - now using tabs)
   */
  async refreshPageSelector() {
    // Legacy method - tabs are now used instead
  }

  // ============ Tab Management ============

  /**
   * Setup tab functionality
   */
  setupTabs() {
    if (this.tabController) return;
    // Legacy fallback — TabController handles this in initTabController
  }

  /**
   * Load saved tabs from storage or create initial tab
   */
  async loadSavedTabs() {
    if (this.tabController) {
      await this.tabController.loadSavedTabs();
      return;
    }
  }

  /**
   * Save tabs to storage
   */
  async saveTabs() {
    if (this.tabController) {
      await this.tabController.saveTabs();
      return;
    }
  }

  /**
   * Render tabs in the header
   */
  renderTabs() {
    if (this.tabController) {
      this.tabController.renderTabs();
      return;
    }
  }

  /**
   * Switch to a specific tab
   */
  async switchToTab(index) {
    if (this.tabController) {
      await this.tabController.switchToTab(index);
      return;
    }
  }

  /**
   * Open a note in a new tab
   */
  async openNoteInNewTab(noteId) {
    if (this.tabController) {
      await this.tabController.openNoteInNewTab(noteId);
      return;
    }
  }

  /**
   * Open a new tab with a new note
   */
  async openNewTab() {
    if (this.tabController) {
      await this.tabController.openNewTab();
      return;
    }
  }

  /**
   * Close a tab
   */
  async closeTab(index) {
    if (this.tabController) {
      await this.tabController.closeTab(index);
      return;
    }
  }

  /**
   * Update tab name when note title changes
   */
  updateCurrentTabName(name) {
    if (this.tabController) {
      this.tabController.updateCurrentTabName(name);
      return;
    }
  }

  /**
   * Open note in current tab or new tab based on modifier key
   */
  async openNoteWithModifier(noteId, event) {
    if (this.tabController) {
      await this.tabController.openNoteWithModifier(noteId, event);
      return;
    }
  }

  /**
   * Setup settings modal
   */
  setupSettings() {
    if (this.settingsController) return; // Handled by SettingsController
  }
  /**
   * Update settings UI
   */
  async updateSettingsUI() {
    if (this.settingsController) {
      await this.settingsController.updateSettingsUI();
      // Also update LLM settings from AIChatController
      if (this.aiChatController) {
        await this.aiChatController.updateLLMSettingsUI();
      }
      return;
    }
  }

  /**
   * Update notes list in settings
   */
  async updateNotesList() {
    if (this.settingsController) {
      await this.settingsController.updateNotesList();
      return;
    }
  }

  async openSettingsModal() {
    if (this.settingsController) {
      await this.settingsController.openSettingsModal();
      return;
    }
  }

  setupCommandPalette() {
    if (this.shortcutsManager) {
      // Already initialized via initShortcutsManager
      return;
    }
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
    if (this.shortcutsManager) {
      return this.shortcutsManager.isCommandPaletteOpen();
    }
    const modal = document.getElementById('command-palette-modal');
    return Boolean(modal && !modal.classList.contains('hidden'));
  }

  toggleCommandPalette(force, initialQuery = '') {
    if (this.shortcutsManager) {
      this.shortcutsManager.toggleCommandPalette(force, initialQuery);
      return;
    }
    const modal = document.getElementById('command-palette-modal');
    const input = document.getElementById('command-palette-input');

    if (!modal || !input) {
      return;
    }

    const show = force !== undefined ? force : modal.classList.contains('hidden');

    if (!show) {
      modal.classList.add('hidden');
      input.value = '';
      this.commandPaletteItems = [];
      this.commandPaletteIndex = 0;
      return;
    }

    this.closeAllModals();
    modal.classList.remove('hidden');
    input.value = initialQuery;
    this.refreshCommandPaletteResults(initialQuery);
    requestAnimationFrame(() => {
      input.focus();
      input.select();
    });
  }

  getCommandPaletteCommands() {
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
        title: this.sidebarOpen ? 'Hide Sidebar' : 'Show Sidebar',
        description: 'Collapse or expand the notes sidebar',
        keywords: ['sidebar', 'navigation', 'panel'],
      },
      {
        id: 'toggle-ai',
        title: this.aiSidebarOpen ? 'Hide AI Sidebar' : 'Show AI Sidebar',
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
    const activeNoteId = this.getEditor()?.noteId;
    const openNoteIds = new Set(this.openTabs.map(tab => tab.noteId));
    const noteCollections = [...this.notes, ...this.archivedNotes];

    return noteCollections.map(note => {
      const searchEntry = this.searchIndexByNoteId.get(note.id);
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
    if (this.shortcutsManager) {
      this.shortcutsManager.refreshCommandPaletteResults(query);
      return;
    }
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
      await this.openNoteById(item.noteId);
      return;
    }

    switch (item.commandId) {
      case 'new-note':
        await this.openNewTab();
        break;
      case 'open-daily-note': {
        const note = await Storage.ensureDailyNote();
        await this.refreshNotesList();
        await this.openNoteInNewTab(note.id);
        break;
      }
      case 'open-settings':
        await this.openSettingsModal();
        break;
      case 'toggle-sidebar':
        await this.toggleSidebar();
        break;
      case 'toggle-ai':
        this.toggleAISidebar();
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

  getAIPromptTemplateApi() {
    return typeof AIPromptTemplates !== 'undefined' ? AIPromptTemplates : null;
  }

  getDefaultAIPromptTemplates() {
    const api = this.getAIPromptTemplateApi();
    return api ? api.getDefaultAIPromptTemplates() : [];
  }

  sanitizeAIPromptTemplates(templates) {
    const api = this.getAIPromptTemplateApi();
    if (!api) {
      return Array.isArray(templates) ? templates.slice() : [];
    }
    return api.sanitizeAIPromptTemplates(templates);
  }

  getAIPromptTemplatesForScope(scope) {
    const api = this.getAIPromptTemplateApi();
    if (!api) {
      return [];
    }
    return api.getAIPromptTemplatesForScope(this.aiPromptTemplates, scope);
  }

  async loadAIPromptTemplates() {
    const savedTemplates = await Storage.getSetting('aiPromptTemplates', null);
    this.aiPromptTemplates = this.sanitizeAIPromptTemplates(savedTemplates);

    if (savedTemplates === null || !Array.isArray(savedTemplates)) {
      try {
        await Storage.setSetting('aiPromptTemplates', this.aiPromptTemplates);
      } catch (error) {
        console.warn('Failed to seed AI prompt templates:', error);
      }
    }

    this.renderAIPromptSuggestions();
    return this.aiPromptTemplates;
  }

  async persistAIPromptTemplates(templates, successMessage = '') {
    const sanitized = this.sanitizeAIPromptTemplates(templates);

    try {
      await Storage.setSetting('aiPromptTemplates', sanitized);
      this.aiPromptTemplates = sanitized;
      this.renderAIPromptSuggestions();
      this.renderAIPromptTemplateSettings();
      if (successMessage) {
        Utils.showToast(successMessage, 'success');
      }
      return true;
    } catch (error) {
      console.error('Failed to save AI prompt templates:', error);
      Utils.showToast('Failed to save AI prompt templates', 'error');
      return false;
    }
  }

  createAIPromptSuggestionButton(template, variant = 'note') {
    const button = document.createElement('button');
    button.type = 'button';
    button.dataset.templateId = template.id;
    button.title = template.prompt;
    button.textContent = template.label;

    if (variant === 'sticky') {
      button.className = 'ai-sticky-template-btn';
    } else if (variant === 'global') {
      button.className = 'global-chat-suggestion';
    } else {
      button.className = 'ai-suggestion-btn';
    }

    return button;
  }

  renderAIPromptSuggestions() {
    const noteSuggestions = document.getElementById('ai-note-suggestion-buttons');
    const stickySuggestions = document.getElementById('ai-sticky-template-buttons');
    const globalSuggestions = document.getElementById('ai-global-suggestion-buttons');

    if (noteSuggestions) {
      noteSuggestions.innerHTML = '';
      this.getAIPromptTemplatesForScope('note').forEach(template => {
        noteSuggestions.appendChild(this.createAIPromptSuggestionButton(template, 'note'));
      });
    }

    if (stickySuggestions) {
      stickySuggestions.innerHTML = '';
      this.getAIPromptTemplatesForScope('note').slice(0, 4).forEach(template => {
        stickySuggestions.appendChild(this.createAIPromptSuggestionButton(template, 'sticky'));
      });
    }

    if (globalSuggestions) {
      globalSuggestions.innerHTML = '';
      this.getAIPromptTemplatesForScope('global').forEach(template => {
        globalSuggestions.appendChild(this.createAIPromptSuggestionButton(template, 'global'));
      });
    }
  }

  applyAIPromptTemplate(template, scope) {
    const input = document.getElementById(scope === 'global' ? 'global-chat-input' : 'ai-chat-input');
    if (!input || !template) {
      return;
    }

    input.value = template.prompt;
    input.dispatchEvent(new Event('input', { bubbles: true }));

    if (template.behavior === 'prefill') {
      input.focus();
      if (typeof input.setSelectionRange === 'function') {
        const end = input.value.length;
        input.setSelectionRange(end, end);
      }
      return;
    }

    if (scope === 'global') {
      this.sendGlobalChatMessage();
    } else {
      this.sendAIChatMessage();
    }
  }

  handleAIPromptSuggestionClick(event, scope) {
    const button = event.target.closest('[data-template-id]');
    if (!button) {
      return;
    }

    const template = this.aiPromptTemplates.find(item => item.id === button.dataset.templateId);
    if (!template) {
      return;
    }

    this.applyAIPromptTemplate(template, scope);
  }

  setupAIPromptTemplateSettings() {
    const list = document.getElementById('ai-prompt-template-list');
    const addBtn = document.getElementById('ai-template-add-btn');
    const resetBtn = document.getElementById('ai-template-reset-btn');
    const form = document.getElementById('ai-prompt-template-form');
    const cancelBtn = document.getElementById('ai-template-cancel-btn');

    addBtn?.addEventListener('click', () => {
      this.openAIPromptTemplateEditor();
    });

    resetBtn?.addEventListener('click', async () => {
      await this.resetAIPromptTemplates();
    });

    list?.addEventListener('click', async (event) => {
      const button = event.target.closest('[data-action][data-template-id]');
      if (!button) {
        return;
      }

      const { action, templateId } = button.dataset;

      if (action === 'edit') {
        this.openAIPromptTemplateEditor(templateId);
        return;
      }

      if (action === 'delete') {
        await this.deleteAIPromptTemplate(templateId);
        return;
      }

      if (action === 'move-up' || action === 'move-down') {
        await this.moveAIPromptTemplateSetting(templateId, action === 'move-up' ? 'up' : 'down');
      }
    });

    form?.addEventListener('submit', async (event) => {
      event.preventDefault();
      await this.submitAIPromptTemplateForm();
    });

    cancelBtn?.addEventListener('click', () => {
      this.closeAIPromptTemplateEditor();
    });
  }

  renderAIPromptTemplateSettings() {
    const list = document.getElementById('ai-prompt-template-list');
    const empty = document.getElementById('ai-prompt-template-empty');
    if (!list || !empty) {
      return;
    }

    list.innerHTML = '';
    empty.classList.toggle('hidden', this.aiPromptTemplates.length > 0);

    this.aiPromptTemplates.forEach((template, index) => {
      const row = document.createElement('div');
      row.className = 'ai-prompt-template-item';

      const main = document.createElement('div');
      main.className = 'ai-prompt-template-main';

      const meta = document.createElement('div');
      meta.className = 'ai-prompt-template-meta';

      const label = document.createElement('span');
      label.className = 'ai-prompt-template-label';
      label.textContent = template.label;
      meta.appendChild(label);

      const scopeBadge = document.createElement('span');
      scopeBadge.className = 'ai-prompt-template-badge';
      scopeBadge.textContent = template.scope === 'both' ? 'Both' : template.scope === 'note' ? 'This Note' : 'All Notes';
      meta.appendChild(scopeBadge);

      const behaviorBadge = document.createElement('span');
      behaviorBadge.className = 'ai-prompt-template-badge';
      behaviorBadge.textContent = template.behavior === 'prefill' ? 'Prefill' : 'Send';
      meta.appendChild(behaviorBadge);

      const prompt = document.createElement('div');
      prompt.className = 'ai-prompt-template-prompt';
      prompt.textContent = template.prompt;

      main.appendChild(meta);
      main.appendChild(prompt);

      const actions = document.createElement('div');
      actions.className = 'ai-prompt-template-actions';

      const moveUpBtn = document.createElement('button');
      moveUpBtn.type = 'button';
      moveUpBtn.className = 'secondary-btn-small';
      moveUpBtn.dataset.action = 'move-up';
      moveUpBtn.dataset.templateId = template.id;
      moveUpBtn.textContent = 'Up';
      moveUpBtn.disabled = index === 0;
      actions.appendChild(moveUpBtn);

      const moveDownBtn = document.createElement('button');
      moveDownBtn.type = 'button';
      moveDownBtn.className = 'secondary-btn-small';
      moveDownBtn.dataset.action = 'move-down';
      moveDownBtn.dataset.templateId = template.id;
      moveDownBtn.textContent = 'Down';
      moveDownBtn.disabled = index === this.aiPromptTemplates.length - 1;
      actions.appendChild(moveDownBtn);

      const editBtn = document.createElement('button');
      editBtn.type = 'button';
      editBtn.className = 'secondary-btn-small';
      editBtn.dataset.action = 'edit';
      editBtn.dataset.templateId = template.id;
      editBtn.textContent = 'Edit';
      actions.appendChild(editBtn);

      const deleteBtn = document.createElement('button');
      deleteBtn.type = 'button';
      deleteBtn.className = 'secondary-btn-small';
      deleteBtn.dataset.action = 'delete';
      deleteBtn.dataset.templateId = template.id;
      deleteBtn.textContent = 'Delete';
      actions.appendChild(deleteBtn);

      row.appendChild(main);
      row.appendChild(actions);
      list.appendChild(row);
    });
  }

  openAIPromptTemplateEditor(templateId = '') {
    const form = document.getElementById('ai-prompt-template-form');
    const idInput = document.getElementById('ai-prompt-template-edit-id');
    const labelInput = document.getElementById('ai-prompt-template-label');
    const scopeInput = document.getElementById('ai-prompt-template-scope');
    const behaviorInput = document.getElementById('ai-prompt-template-behavior');
    const promptInput = document.getElementById('ai-prompt-template-prompt');
    const saveBtn = document.getElementById('ai-template-save-btn');

    if (!form || !labelInput || !scopeInput || !behaviorInput || !promptInput || !idInput) {
      return;
    }

    const template = templateId
      ? this.aiPromptTemplates.find(item => item.id === templateId)
      : null;

    this.aiPromptTemplateEditingId = template ? template.id : null;
    idInput.value = template ? template.id : '';
    labelInput.value = template ? template.label : '';
    scopeInput.value = template ? template.scope : 'note';
    behaviorInput.value = template ? template.behavior : 'send';
    promptInput.value = template ? template.prompt : '';
    if (saveBtn) {
      saveBtn.textContent = template ? 'Save changes' : 'Save template';
    }

    form.classList.remove('hidden');
    labelInput.focus();
  }

  closeAIPromptTemplateEditor() {
    const form = document.getElementById('ai-prompt-template-form');
    const idInput = document.getElementById('ai-prompt-template-edit-id');
    const labelInput = document.getElementById('ai-prompt-template-label');
    const scopeInput = document.getElementById('ai-prompt-template-scope');
    const behaviorInput = document.getElementById('ai-prompt-template-behavior');
    const promptInput = document.getElementById('ai-prompt-template-prompt');
    const saveBtn = document.getElementById('ai-template-save-btn');

    this.aiPromptTemplateEditingId = null;

    if (form) {
      form.classList.add('hidden');
    }
    if (idInput) {
      idInput.value = '';
    }
    if (labelInput) {
      labelInput.value = '';
    }
    if (scopeInput) {
      scopeInput.value = 'note';
    }
    if (behaviorInput) {
      behaviorInput.value = 'send';
    }
    if (promptInput) {
      promptInput.value = '';
    }
    if (saveBtn) {
      saveBtn.textContent = 'Save template';
    }
  }

  async submitAIPromptTemplateForm() {
    const idInput = document.getElementById('ai-prompt-template-edit-id');
    const labelInput = document.getElementById('ai-prompt-template-label');
    const scopeInput = document.getElementById('ai-prompt-template-scope');
    const behaviorInput = document.getElementById('ai-prompt-template-behavior');
    const promptInput = document.getElementById('ai-prompt-template-prompt');

    const label = labelInput?.value.trim() || '';
    const prompt = promptInput?.value.trim() || '';
    const scope = scopeInput?.value || 'note';
    const behavior = behaviorInput?.value || 'send';
    const editingId = idInput?.value || '';

    if (!label || !prompt) {
      Utils.showToast('Template label and prompt are required', 'error');
      return;
    }

    const nextTemplates = this.aiPromptTemplates.slice();
    const nextTemplate = {
      id: editingId || undefined,
      label,
      prompt,
      scope,
      behavior,
    };

    if (editingId) {
      const index = nextTemplates.findIndex(template => template.id === editingId);
      if (index !== -1) {
        nextTemplates[index] = nextTemplate;
      }
    } else {
      nextTemplates.push(nextTemplate);
    }

    const saved = await this.persistAIPromptTemplates(nextTemplates, 'AI prompt templates updated');
    if (saved) {
      this.closeAIPromptTemplateEditor();
    }
  }

  async moveAIPromptTemplateSetting(templateId, direction) {
    const api = this.getAIPromptTemplateApi();
    if (!api) {
      return;
    }

    const reordered = api.moveAIPromptTemplate(this.aiPromptTemplates, templateId, direction);
    await this.persistAIPromptTemplates(reordered);
  }

  async deleteAIPromptTemplate(templateId) {
    const nextTemplates = this.aiPromptTemplates.filter(template => template.id !== templateId);
    const saved = await this.persistAIPromptTemplates(nextTemplates, 'AI prompt template removed');
    if (saved && this.aiPromptTemplateEditingId === templateId) {
      this.closeAIPromptTemplateEditor();
    }
  }

  async resetAIPromptTemplates() {
    const saved = await this.persistAIPromptTemplates(this.getDefaultAIPromptTemplates(), 'Default AI prompt templates restored');
    if (saved) {
      this.closeAIPromptTemplateEditor();
    }
  }

  setupAIInsertPreview() {
    const modal = document.getElementById('ai-insert-preview-modal');
    const closeBtn = document.getElementById('ai-insert-preview-close');
    const cancelBtn = document.getElementById('ai-insert-preview-cancel');
    const confirmBtn = document.getElementById('ai-insert-preview-confirm');

    if (!modal) {
      return;
    }

    closeBtn?.addEventListener('click', () => {
      this.closeAIInsertPreview();
    });

    cancelBtn?.addEventListener('click', () => {
      this.closeAIInsertPreview();
    });

    confirmBtn?.addEventListener('click', async () => {
      await this.confirmAIInsertPreview();
    });

    modal.addEventListener('click', (e) => {
      if (e.target === modal) {
        this.closeAIInsertPreview();
      }
    });
  }

  closeAIInsertPreview() {
    const modal = document.getElementById('ai-insert-preview-modal');
    if (modal) {
      modal.classList.add('hidden');
    }
    this.aiInsertPreviewState = null;
  }

  buildAIInsertBlocks(content) {
    if (typeof AIResponseUtils === 'undefined') {
      return [{ type: 'text', content }];
    }

    return AIResponseUtils.parseAIResponseToBlocks(content);
  }

  getAIInsertPreviewData(blocks) {
    if (typeof AIResponseUtils === 'undefined') {
      return {
        totalBlocks: blocks.length,
        counts: [{ type: 'text', count: blocks.length }],
        summary: '',
        items: blocks.map(block => ({ type: block.type || 'text', content: block.content || '', checked: Boolean(block.checked) })),
      };
    }

    return AIResponseUtils.buildAIInsertPreview(blocks);
  }

  openAIInsertPreview(action, content) {
    const editor = this.getEditor();
    if (action === 'append' && (!editor || !editor.noteId)) {
      Utils.showToast('No note is currently open', 'error');
      return;
    }

    const modal = document.getElementById('ai-insert-preview-modal');
    if (!modal) {
      return;
    }

    const blocks = this.buildAIInsertBlocks(content);
    const preview = this.getAIInsertPreviewData(blocks);

    this.aiInsertPreviewState = {
      action,
      blocks,
      content,
      preview,
    };

    this.renderAIInsertPreview();
    this.closeAllModals();
    modal.classList.remove('hidden');
  }

  renderAIInsertPreview() {
    if (!this.aiInsertPreviewState) {
      return;
    }

    const titleEl = document.getElementById('ai-insert-preview-title');
    const summaryEl = document.getElementById('ai-insert-preview-summary');
    const countsEl = document.getElementById('ai-insert-preview-counts');
    const itemsEl = document.getElementById('ai-insert-preview-items');
    const confirmBtn = document.getElementById('ai-insert-preview-confirm');
    const { action, preview } = this.aiInsertPreviewState;

    if (titleEl) {
      titleEl.textContent = action === 'append' ? 'Preview Append to Note' : 'Preview New Note';
    }

    if (summaryEl) {
      summaryEl.textContent = preview.summary
        ? `This will insert ${preview.totalBlocks} block${preview.totalBlocks === 1 ? '' : 's'}: ${preview.summary}`
        : `This will insert ${preview.totalBlocks} block${preview.totalBlocks === 1 ? '' : 's'}.`;
    }

    if (confirmBtn) {
      confirmBtn.textContent = action === 'append' ? 'Append Blocks' : 'Create Note';
    }

    if (countsEl) {
      countsEl.innerHTML = '';
      preview.counts.forEach(entry => {
        const badge = document.createElement('span');
        badge.className = 'ai-insert-preview-count';
        badge.textContent = `${entry.count} ${entry.type}`;
        countsEl.appendChild(badge);
      });
    }

    if (itemsEl) {
      itemsEl.innerHTML = '';
      preview.items.forEach(item => {
        const row = document.createElement('div');
        row.className = 'ai-insert-preview-item';

        const typeEl = document.createElement('div');
        typeEl.className = 'ai-insert-preview-item-type';
        typeEl.textContent = item.checked ? `${item.type} (done)` : item.type;

        const textEl = document.createElement('div');
        textEl.className = `ai-insert-preview-item-text ${item.content ? '' : 'ai-insert-preview-item-empty'}`.trim();
        textEl.textContent = item.content || 'No text preview for this block';

        row.appendChild(typeEl);
        row.appendChild(textEl);
        itemsEl.appendChild(row);
      });
    }
  }

  async confirmAIInsertPreview() {
    if (!this.aiInsertPreviewState) {
      return;
    }

    const { action, blocks, content } = this.aiInsertPreviewState;
    this.closeAIInsertPreview();

    if (action === 'append') {
      await this.appendAIResponseToNote(blocks);
      return;
    }

    await this.createNoteFromAIResponse(blocks, content);
  }

  createPersistentBlocksForNote(noteId, blocks, startOrder = 0) {
    const timestamp = Date.now();

    return blocks.map((block, index) => ({
      ...block,
      id: Utils.generateId(),
      canvasId: noteId,
      order: startOrder + index,
      createdAt: timestamp,
      updatedAt: timestamp,
    }));
  }

  async refreshNoteMetadataAfterInsert(noteId) {
    const note = await Storage.getNote(noteId);
    if (!note) {
      return;
    }

    const blocks = (await Storage.getElementsByNote(noteId))
      .sort((left, right) => (left.order || 0) - (right.order || 0));

    if (typeof SidebarUtils !== 'undefined') {
      const metadata = SidebarUtils.buildNoteSaveMetadata(blocks);
      note.preview = metadata.preview;
      note.todoProgress = metadata.todoProgress;
    }

    await Storage.updateNote(note);

    const linkNames = Utils.extractWikiLinks(
      blocks
        .map(block => block.content || block.title || block.caption || '')
        .filter(Boolean)
        .join('\n')
    );
    await Storage.updateNoteLinks(noteId, linkNames);

    if (this.triggerIndexing) {
      this.triggerIndexing(noteId);
    }
  }

  /**
   * Setup AI chat sidebar functionality
   */
  async setupAI() {
    const aiSidebar = document.getElementById('ai-sidebar');
    const aiFloatingBtn = document.getElementById('ai-floating-btn');
    const aiCloseBtn = document.getElementById('ai-sidebar-close');
    const chatInput = document.getElementById('ai-chat-input');
    const chatSendBtn = document.getElementById('ai-chat-send');
    const settingsBtn = document.getElementById('ai-sidebar-open-settings');
    const noteSuggestions = document.getElementById('ai-note-suggestion-buttons');
    const stickyTemplateButtons = document.getElementById('ai-sticky-template-buttons');

    // Tab elements
    const tabNote = document.getElementById('ai-tab-note');
    const tabAll = document.getElementById('ai-tab-all');
    const tabSmart = document.getElementById('ai-tab-smart');
    const panelNote = document.getElementById('ai-panel-note');
    const panelAll = document.getElementById('ai-panel-all');
    const panelSmart = document.getElementById('ai-panel-smart');

    if (!aiSidebar) return;

    // Initialize chat state
    this.aiSidebarOpen = false;
    this.aiSidebarWidth = await Storage.getSetting('aiSidebarWidth', 360);
    this.aiActiveTab = 'note';

    // Load persisted chat history
    await this.loadChatHistory();

    // Toggle AI sidebar from floating button
    aiFloatingBtn?.addEventListener('click', () => {
      this.openAISidebar();
    });

    // Close AI sidebar
    aiCloseBtn?.addEventListener('click', () => {
      this.closeAISidebar();
    });

    // Tab switching
    tabNote?.addEventListener('click', () => {
      this.switchAITab('note');
    });

    tabAll?.addEventListener('click', () => {
      this.switchAITab('all');
    });

    tabSmart?.addEventListener('click', () => {
      this.switchAITab('smart');
    });

    // Send message (note chat)
    chatSendBtn?.addEventListener('click', () => {
      this.sendAIChatMessage();
    });

    // Handle Enter key in chat input
    chatInput?.addEventListener('keydown', async (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        this.sendAIChatMessage();
      }

      // Open new tab
      if ((e.ctrlKey || e.metaKey) && e.key === 't' && !e.shiftKey) {
        e.preventDefault();
        this.openNewTab();
      }

      // Daily Note shortcut (Alt + D)
      if (e.altKey && e.key.toLowerCase() === 'd') {
        e.preventDefault();
        const note = await Storage.ensureDailyNote();
        await this.refreshNotesList();
        await this.openNoteInNewTab(note.id);
      }
    });

    // Auto-resize textarea
    chatInput?.addEventListener('input', () => {
      chatInput.style.height = 'auto';
      chatInput.style.height = Math.min(chatInput.scrollHeight, 120) + 'px';
    });

    noteSuggestions?.addEventListener('click', (event) => {
      this.handleAIPromptSuggestionClick(event, 'note');
    });

    stickyTemplateButtons?.addEventListener('click', (event) => {
      this.handleAIPromptSuggestionClick(event, 'note');
    });

    document.querySelectorAll('.ai-extract-insights-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const action = btn.dataset.action;
        if (action === 'extract-insights') {
          this.extractInsightsFromChat();
        }
      });
    });

    // Open settings from sidebar
    settingsBtn?.addEventListener('click', async () => {
      await this.openSettingsModal();
    });

    // Clear note chat button
    const clearNoteBtn = document.getElementById('ai-chat-clear');
    clearNoteBtn?.addEventListener('click', () => {
      this.clearNoteChat();
    });

    // Setup sidebar resize
    this.setupAISidebarResize();

    // Setup Global Chat
    this.setupGlobalChat();

    // Setup LLM settings
    this.setupLLMSettings();
    this.setupAIPromptTemplateSettings();
    this.renderAIPromptSuggestions();

    // Update visibility based on LLM configuration
    this.updateAISidebarState();
  }

  /**
   * Switch between AI chat tabs
   */
  switchAITab(tab) {
    if (this.aiChatController) {
      this.aiChatController.switchAITab(tab);
      return;
    }
    const tabNote = document.getElementById('ai-tab-note');
    const tabAll = document.getElementById('ai-tab-all');
    const panelNote = document.getElementById('ai-panel-note');
    const panelAll = document.getElementById('ai-panel-all');

    this.aiActiveTab = tab;
    if (tab === 'note') {
      tabNote?.classList.add('active');
      tabAll?.classList.remove('active');
      panelNote?.classList.add('active');
      panelAll?.classList.remove('active');
      document.getElementById('ai-chat-input')?.focus();
    } else if (tab === 'all') {
      tabNote?.classList.remove('active');
      tabAll?.classList.add('active');
      const tabSmart = document.getElementById('ai-tab-smart');
      tabSmart?.classList.remove('active');
      panelNote?.classList.remove('active');
      panelAll?.classList.add('active');
      const panelSmart = document.getElementById('ai-panel-smart');
      panelSmart?.classList.remove('active');
      document.getElementById('global-chat-input')?.focus();
    } else if (tab === 'smart') {
      tabNote?.classList.remove('active');
      tabAll?.classList.remove('active');
      const tabSmart = document.getElementById('ai-tab-smart');
      tabSmart?.classList.add('active');
      panelNote?.classList.remove('active');
      panelAll?.classList.remove('active');
      const panelSmart = document.getElementById('ai-panel-smart');
      panelSmart?.classList.add('active');

      this.updateSmartSuggestions(true);
    }
  }

  /**
   * Setup AI sidebar resize functionality
   */
  setupAISidebarResize() {
    const sidebar = document.getElementById('ai-sidebar');
    const resizeHandle = document.getElementById('ai-sidebar-resize-handle');

    if (this.aiSidebarResizer) {
      this.aiSidebarResizer.destroy();
    }

    if (!sidebar || !resizeHandle) return;

    this.aiSidebarResizer = new ResizablePanel({
      panel: sidebar,
      handle: resizeHandle,
      min: 280,
      max: 600,
      direction: 'left',
      onResizeEnd: async (width) => {
        this.aiSidebarWidth = width;
        await Storage.setSetting('aiSidebarWidth', this.aiSidebarWidth);
      },
    });
  }

  /**
   * Toggle AI sidebar open/closed
   */
  toggleAISidebar() {
    if (this.aiChatController) {
      this.aiChatController.toggleAISidebar();
      this.aiSidebarOpen = this.aiChatController.aiSidebarOpen;
      return;
    }
    if (this.aiSidebarOpen) {
      this.closeAISidebar();
    } else {
      this.openAISidebar();
    }
  }

  /**
   * Open AI sidebar
   */
  openAISidebar() {
    if (this.aiChatController) {
      this.aiChatController.openAISidebar();
      this.aiSidebarOpen = this.aiChatController.aiSidebarOpen;
      return;
    }
    const sidebar = document.getElementById('ai-sidebar');
    const floatingBtn = document.getElementById('ai-floating-btn');

    if (sidebar) {
      sidebar.classList.remove('hidden');
      sidebar.style.width = this.aiSidebarWidth + 'px';
    }

    // Hide floating button when sidebar is open
    if (floatingBtn) {
      floatingBtn.classList.add('hidden');
    }

    this.aiSidebarOpen = true;
    this.updateAISidebarState();

    // Focus input
    setTimeout(() => {
      document.getElementById('ai-chat-input')?.focus();
    }, 100);
  }

  /**
   * Close AI sidebar
   */
  closeAISidebar() {
    if (this.aiChatController) {
      this.aiChatController.closeAISidebar();
      this.aiSidebarOpen = this.aiChatController.aiSidebarOpen;
      return;
    }
    const sidebar = document.getElementById('ai-sidebar');
    const floatingBtn = document.getElementById('ai-floating-btn');

    if (sidebar) {
      sidebar.classList.add('hidden');
    }

    // Show floating button when sidebar is closed
    if (floatingBtn) {
      floatingBtn.classList.remove('hidden');
    }

    this.aiSidebarOpen = false;
  }

  /**
   * Load chat history from storage and restore UI
   */
  async loadChatHistory() {
    // Load note chat history
    this.aiChatHistory = await Storage.getSetting('aiChatHistory', []);
    this.noteChatMessages = await Storage.getSetting('noteChatMessages', []);

    // Load global chat history
    this.globalChatHistory = await Storage.getSetting('globalChatHistory', []);
    this.globalChatMessages = await Storage.getSetting('globalChatMessages', []);

    // Restore note chat UI
    if (this.noteChatMessages.length > 0) {
      const messagesContainer = document.getElementById('ai-chat-messages');
      const welcome = messagesContainer?.querySelector('.ai-chat-welcome');
      const stickySuggestions = document.getElementById('ai-sticky-suggestions');

      if (welcome) {
        welcome.style.display = 'none';
      }
      if (stickySuggestions) {
        stickySuggestions.classList.remove('hidden');
      }

      // Restore messages
      this.noteChatMessages.forEach(msg => {
        this.addChatMessage(msg.content, msg.type, false);
      });
    }

    // Restore global chat UI
    if (this.globalChatMessages.length > 0) {
      const messagesContainer = document.getElementById('global-chat-messages');
      const welcome = messagesContainer?.querySelector('.global-chat-welcome');

      if (welcome) {
        welcome.style.display = 'none';
      }

      // Restore messages
      this.globalChatMessages.forEach(msg => {
        this.addGlobalChatMessage(msg.content, msg.type, msg.sourceNotes, false);
      });
    }
  }

  /**
   * Save note chat history to storage
   */
  async saveNoteChatHistory() {
    await Storage.setSetting('aiChatHistory', this.aiChatHistory);
    await Storage.setSetting('noteChatMessages', this.noteChatMessages);
  }

  /**
   * Save global chat history to storage
   */
  async saveGlobalChatHistory() {
    await Storage.setSetting('globalChatHistory', this.globalChatHistory);
    await Storage.setSetting('globalChatMessages', this.globalChatMessages);
  }

  /**
   * Clear the note chat history and UI
   */
  async clearNoteChat() {
    // Clear chat history
    this.aiChatHistory = [];
    this.noteChatMessages = [];

    // Save cleared state
    await this.saveNoteChatHistory();

    // Clear messages from UI (keep welcome message)
    const messagesContainer = document.getElementById('ai-chat-messages');
    if (messagesContainer) {
      // Remove all messages except welcome
      const messages = messagesContainer.querySelectorAll('.ai-chat-message');
      messages.forEach(msg => msg.remove());

      // Show welcome message again
      const welcome = messagesContainer.querySelector('.ai-chat-welcome');
      if (welcome) {
        welcome.style.display = '';
      }
    }

    // Hide sticky suggestions
    const stickySuggestions = document.getElementById('ai-sticky-suggestions');
    if (stickySuggestions) {
      stickySuggestions.classList.add('hidden');
    }

    // Clear and reset input
    const input = document.getElementById('ai-chat-input');
    if (input) {
      input.value = '';
      input.style.height = 'auto';
    }

    Utils.showToast('Chat cleared', 'success');
  }

  /**
   * Clear the global chat history and UI
   */
  async clearGlobalChat() {
    // Clear chat history
    this.globalChatHistory = [];
    this.globalChatMessages = [];

    // Save cleared state
    await this.saveGlobalChatHistory();

    // Clear messages from UI (keep welcome message)
    const messagesContainer = document.getElementById('global-chat-messages');
    if (messagesContainer) {
      // Remove all messages except welcome
      const messages = messagesContainer.querySelectorAll('.ai-chat-message');
      messages.forEach(msg => msg.remove());

      // Show welcome message again
      const welcome = messagesContainer.querySelector('.global-chat-welcome');
      if (welcome) {
        welcome.style.display = '';
      }
    }

    // Clear and reset input
    const input = document.getElementById('global-chat-input');
    if (input) {
      input.value = '';
      input.style.height = 'auto';
    }

    Utils.showToast('Chat cleared', 'success');
  }

  /**
   * Update AI sidebar state based on LLM configuration
   */
  updateAISidebarState() {
    if (this.aiChatController) {
      this.aiChatController.updateAISidebarState();
      return;
    }
    const notConfigured = document.getElementById('ai-not-configured-sidebar');
    const chatMessages = document.getElementById('ai-chat-messages');
    const chatInputArea = document.querySelector('.ai-chat-input-area');

    const isConfigured = LLM.isConfigured();

    if (notConfigured) {
      notConfigured.classList.toggle('hidden', isConfigured);
    }
    if (chatMessages) {
      chatMessages.style.display = isConfigured ? 'flex' : 'none';
    }
    if (chatInputArea) {
      chatInputArea.style.display = isConfigured ? 'flex' : 'none';
    }
  }

  /**
   * Send a message in AI chat
   */
  async sendAIChatMessage() {
    const input = document.getElementById('ai-chat-input');
    const message = input?.value.trim();

    if (!message) return;

    // Clear input
    input.value = '';
    input.style.height = 'auto';

    // Hide welcome message if visible and show sticky suggestions
    const welcome = document.querySelector('.ai-chat-welcome');
    const stickySuggestions = document.getElementById('ai-sticky-suggestions');
    if (welcome) {
      welcome.style.display = 'none';
    }
    if (stickySuggestions) {
      stickySuggestions.classList.remove('hidden');
    }

    // Add user message to chat
    this.addChatMessage(message, 'user');

    // Get note content for context
    const noteContent = this.getNoteContent();

    // Show loading
    const loading = document.getElementById('ai-chat-loading');
    loading?.classList.remove('hidden');

    // Disable send button
    const sendBtn = document.getElementById('ai-chat-send');
    if (sendBtn) sendBtn.disabled = true;

    try {
      // Build messages with context
      const systemPrompt = `You are a helpful AI assistant. The user is working on a note with the following content:

---
${noteContent || '(Empty note)'}
---

Help the user with their request about this note. You can:
- Summarize the note
- Expand on topics
- Generate titles
- Answer questions about the content
- Suggest improvements
- Generate related questions
- And more

Be concise but helpful. If the user asks to generate a title, respond with ONLY the title text.`;

      const messages = [
        { role: 'system', content: systemPrompt },
        ...this.aiChatHistory,
        { role: 'user', content: message }
      ];

      const response = await LLM.chat(messages);

      // Add to history
      this.aiChatHistory.push({ role: 'user', content: message });
      this.aiChatHistory.push({ role: 'assistant', content: response });

      // Keep history manageable (last 10 exchanges)
      if (this.aiChatHistory.length > 20) {
        this.aiChatHistory = this.aiChatHistory.slice(-20);
      }

      // Add assistant message to chat
      this.addChatMessage(response, 'assistant');

      // Check if this was a title generation request
      if (message.toLowerCase().includes('title') && message.toLowerCase().includes('generate')) {
        this.handleGeneratedTitle(response);
      }

    } catch (error) {
      console.error('AI chat error:', error);
      this.addChatMessage('Error: ' + error.message, 'error');
    } finally {
      loading?.classList.add('hidden');
      if (sendBtn) sendBtn.disabled = false;
    }
  }

  /**
   * Extract insights from the current note via AI Chat button
   */
  async extractInsightsFromChat() {
    if (!this.editor || !this.editor.noteId) {
      Utils.showToast('No note selected', 'error');
      return;
    }

    if (!LLM.isConfigured()) {
      Utils.showToast('AI not configured. Please set up in Settings.', 'error');
      return;
    }

    // Hide welcome message if visible and show sticky suggestions
    const welcome = document.querySelector('.ai-chat-welcome');
    const stickySuggestions = document.getElementById('ai-sticky-suggestions');
    if (welcome) {
      welcome.style.display = 'none';
    }
    if (stickySuggestions) {
      stickySuggestions.classList.remove('hidden');
    }

    // Add user message to chat
    this.addChatMessage('Extract insights from this note', 'user');

    // Show loading
    const loading = document.getElementById('ai-chat-loading');
    loading?.classList.remove('hidden');

    // Disable send button
    const sendBtn = document.getElementById('ai-chat-send');
    if (sendBtn) sendBtn.disabled = true;

    try {
      const noteContent = this.getNoteContent();

      if (!noteContent || noteContent.trim().length < 20) {
        this.addChatMessage('Not enough content in this note to extract insights. Please add more content first.', 'assistant');
        return;
      }

      const insights = await LLM.extractInsights(noteContent, this.editor.noteData?.name);

      if (!insights) {
        this.addChatMessage('Could not extract any insights from this note. The content may not contain actionable items, reminders, or deadlines.', 'assistant');
        return;
      }

      // Update note with insights
      if (this.editor.noteData) {
        this.editor.noteData.insights = insights;
        this.editor.noteData.lastInsightsExtractedAt = Date.now();
        await Storage.updateNote(this.editor.noteData);
        this.editor.renderInsights();
      }

      // Build response message
      let response = '✅ **Insights extracted and saved to note!**\n\n';

      if (insights.tags && insights.tags.length > 0) {
        response += '**🏷️ Tags:** ' + insights.tags.join(', ') + '\n\n';
      }

      if (insights.deadlines && insights.deadlines.length > 0) {
        response += '**📅 Deadlines:**\n';
        insights.deadlines.forEach(d => {
          const dateStr = d.date ? ` (${d.date})` : '';
          response += `- ${d.text}${dateStr}\n`;
        });
        response += '\n';
      }

      if (insights.todos && insights.todos.length > 0) {
        response += '**✓ Action Items:**\n';
        insights.todos.forEach(t => response += `- ${t}\n`);
        response += '\n';
      }

      if (insights.reminders && insights.reminders.length > 0) {
        response += '**💡 Reminders:**\n';
        insights.reminders.forEach(r => response += `- ${r}\n`);
        response += '\n';
      }

      if (insights.highlights && insights.highlights.length > 0) {
        response += '**⭐ Key Points:**\n';
        insights.highlights.forEach(h => response += `- ${h}\n`);
      }

      this.addChatMessage(response.trim(), 'assistant');
      Utils.showToast('Insights extracted', 'success');

    } catch (error) {
      console.error('Extract insights error:', error);
      this.addChatMessage('Error extracting insights: ' + error.message, 'error');
    } finally {
      loading?.classList.add('hidden');
      if (sendBtn) sendBtn.disabled = false;
    }
  }

  /**
   * Setup Global Chat (RAG across all notes)
   */
  setupGlobalChat() {
    const chatInput = document.getElementById('global-chat-input');
    const sendBtn = document.getElementById('global-chat-send');
    const suggestionButtons = document.getElementById('ai-global-suggestion-buttons');

    if (!chatInput) return;

    // Note: globalChatHistory and globalChatMessages are loaded in loadChatHistory()

    // Send message
    sendBtn?.addEventListener('click', () => {
      this.sendGlobalChatMessage();
    });

    // Handle Enter key
    chatInput?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        this.sendGlobalChatMessage();
      }
    });

    // Auto-resize textarea
    chatInput?.addEventListener('input', () => {
      chatInput.style.height = 'auto';
      chatInput.style.height = Math.min(chatInput.scrollHeight, 120) + 'px';
    });

    suggestionButtons?.addEventListener('click', (event) => {
      this.handleAIPromptSuggestionClick(event, 'global');
    });

    // Clear global chat button
    const clearGlobalBtn = document.getElementById('global-chat-clear');
    clearGlobalBtn?.addEventListener('click', () => {
      this.clearGlobalChat();
    });
  }

  /**
   * Send a message in Global Chat (RAG flow)
   */
  async sendGlobalChatMessage() {
    const input = document.getElementById('global-chat-input');
    const message = input?.value.trim();

    if (!message) return;

    // Clear input
    input.value = '';
    input.style.height = 'auto';

    // Hide welcome message
    const welcome = document.querySelector('.global-chat-welcome');
    if (welcome) {
      welcome.style.display = 'none';
    }

    // Add user message to chat
    this.addGlobalChatMessage(message, 'user');

    // Show loading
    const loading = document.getElementById('global-chat-loading');
    const loadingText = document.getElementById('global-chat-loading-text');
    loading?.classList.remove('hidden');
    if (loadingText) loadingText.textContent = 'Analyzing query...';

    // Disable send button
    const sendBtn = document.getElementById('global-chat-send');
    if (sendBtn) sendBtn.disabled = true;

    try {
      // Step 1: Get all notes metadata
      const allNotes = await Storage.getAllNotes();

      if (allNotes.length === 0) {
        this.addGlobalChatMessage('You don\'t have any notes yet. Create some notes first to search across them.', 'assistant');
        return;
      }

      // Build notes metadata for RAG analysis
      const notesMetadata = allNotes.map(note => ({
        id: note.id,
        title: note.name || 'Untitled',
        tags: note.insights?.tags || []
      }));

      // Step 2: Semantic Search - find semantically relevant notes (faster/better than LLM metadata analysis)
      if (loadingText) loadingText.textContent = 'Searching your notes...';

      // Sync search index data to SearchEngine before searching
      const searchIndexData = await Storage.getSearchIndex();
      this.searchEngine.updateIndex(searchIndexData);
      
      const searchResults = await this.searchEngine.search(message);

      // Take top 5 notes with decent scores
      const relevantResults = searchResults.slice(0, 5).filter(r => r.score > 0.3);

      if (relevantResults.length === 0) {
        this.addGlobalChatMessage('I couldn\'t find any notes that seem relevant to your question. Try adding more detail to your query.', 'assistant');
        return;
      }

      // Step 3: Retrieve full content of relevant notes
      if (loadingText) loadingText.textContent = 'Reading relevant notes...';

      const notesContent = [];
      for (const result of relevantResults) {
        const note = allNotes.find(n => n.id === result.id);
        if (note) {
          const blocks = await Storage.getElementsByNote(note.id);
          const content = blocks
            .sort((a, b) => (a.order || 0) - (b.order || 0))
            .map(b => this.extractBlockText(b))
            .filter(t => t.trim())
            .join('\n\n');

          if (content.trim()) {
            notesContent.push({
              id: note.id,
              title: note.name || 'Untitled',
              content: content
            });
          }
        }
      }

      if (notesContent.length === 0) {
        this.addGlobalChatMessage('The relevant notes appear to be empty. Please add content to your notes first.', 'assistant');
        return;
      }

      // Step 4: RAG Answer - get final response using note content
      if (loadingText) loadingText.textContent = 'Synthesizing answer...';

      const followUpPrompt = `Answer the user query based on the following ${notesContent.length} notes. Be thorough and mention the note titles in your explanation.`;
      const answer = await LLM.ragAnswerQuery(message, followUpPrompt, notesContent);

      if (!answer) {
        this.addGlobalChatMessage('I couldn\'t generate an answer based on your notes. Please try a different question.', 'assistant');
        return;
      }

      // Add response with source notes
      this.addGlobalChatMessage(answer, 'assistant', notesContent.map(n => ({ id: n.id, title: n.title })));

    } catch (error) {
      console.error('Global chat error:', error);
      this.addGlobalChatMessage('Error: ' + error.message, 'error');
    } finally {
      loading?.classList.add('hidden');
      if (sendBtn) sendBtn.disabled = false;
    }
  }

  /**
   * Add a message to the Global Chat UI
   */
  addGlobalChatMessage(content, type, sourceNotes = null, persist = true) {
    const messagesContainer = document.getElementById('global-chat-messages');
    if (!messagesContainer) return;

    // Save to messages array for persistence
    if (persist) {
      if (!this.globalChatMessages) this.globalChatMessages = [];
      this.globalChatMessages.push({ content, type, sourceNotes });
      this.saveGlobalChatHistory();
    }

    const messageEl = document.createElement('div');
    messageEl.className = `ai-chat-message ${type}`;

    const contentEl = document.createElement('div');
    contentEl.className = 'ai-message-content';

    if (type === 'assistant') {
      contentEl.innerHTML = sanitizeHtml(Utils.parseMarkdown(content));
    } else {
      contentEl.textContent = content;
    }
    messageEl.appendChild(contentEl);

    // Add source notes indicator for assistant messages
    if (type === 'assistant' && sourceNotes && sourceNotes.length > 0) {
      const sourcesEl = document.createElement('div');
      sourcesEl.className = 'ai-message-sources';

      const titleEl = document.createElement('div');
      titleEl.className = 'ai-sources-title';
      titleEl.textContent = 'Sources used:';
      sourcesEl.appendChild(titleEl);

      const listEl = document.createElement('div');
      listEl.className = 'ai-sources-list';

      sourceNotes.forEach(note => {
        const badgeEl = document.createElement('div');
        badgeEl.className = 'ai-source-badge';
        badgeEl.innerHTML = `
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path>
            <polyline points="14 2 14 8 20 8"></polyline>
          </svg>
        `;
        const badgeTitleSpan = document.createElement('span');
        badgeTitleSpan.textContent = note.title;
        badgeEl.appendChild(badgeTitleSpan);
        badgeEl.addEventListener('click', () => {
          this.closeAISidebar();
          this.openNoteById(note.id);
        });
        listEl.appendChild(badgeEl);
      });

      sourcesEl.appendChild(listEl);
      messageEl.appendChild(sourcesEl);
    }

    // Add action buttons for assistant messages
    if (type === 'assistant') {
      const actionsEl = document.createElement('div');
      actionsEl.className = 'ai-message-actions';

      // Copy button
      const copyBtn = document.createElement('button');
      copyBtn.className = 'ai-message-action-btn';
      copyBtn.title = 'Copy to clipboard';
      copyBtn.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect>
        <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>
      </svg>`;
      copyBtn.addEventListener('click', () => this.copyAIResponse(content, copyBtn));
      actionsEl.appendChild(copyBtn);

      // Create new note button
      const newNoteBtn = document.createElement('button');
      newNoteBtn.className = 'ai-message-action-btn';
      newNoteBtn.title = 'Create new note from this';
      newNoteBtn.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path>
        <polyline points="14 2 14 8 20 8"></polyline>
        <line x1="12" y1="18" x2="12" y2="12"></line>
        <line x1="9" y1="15" x2="15" y2="15"></line>
      </svg>`;
      newNoteBtn.addEventListener('click', () => this.openAIInsertPreview('new-note', content));
      actionsEl.appendChild(newNoteBtn);

      messageEl.appendChild(actionsEl);
    }

    messagesContainer.appendChild(messageEl);
    messagesContainer.scrollTop = messagesContainer.scrollHeight;
  }

  /**
   * Toggle the statistics dashboard
   */
  async toggleStats() {
    if (this.analyticsController) {
      this.analyticsController.notes = this.notes;
      this.analyticsController.folders = this.folders;
      await this.analyticsController.toggleStats();
      this.statsOpen = this.analyticsController.statsOpen;
      return;
    }
  }

  /**
   * Render analytics charts and stats
   */
  async renderAnalytics() {
    if (this.analyticsController) {
      this.analyticsController.notes = this.notes;
      this.analyticsController.folders = this.folders;
      await this.analyticsController.renderAnalytics();
      return;
    }
  }

  /**
   * Open a note by name (for wikilinks)
   * If note doesn't exist, it can potentially create a new one
   */
  async openNoteByName(name) {
    // Search in existing notes
    const note = this.notes.find(n => n.name === name) ||
      this.archivedNotes.find(n => n.name === name);

    if (note) {
      await this.openNoteById(note.id);
    } else {
      // Note doesn't exist - create a new one?
      if (await confirmDialog({ title: 'Create Note', message: `Note "${name}" does not exist. Create it?` })) {
        const newNote = await Storage.createNote(name);
        this.notes.unshift(newNote);
        await this.refreshNotesList();
        await this.openNoteById(newNote.id);
      }
    }
  }

  /**
   * Open a note by ID (for clicking source tags)
   */
  async openNoteById(noteId) {
    // Check if note is already open in a tab
    const existingTabIndex = this.openTabs.findIndex(t => t.noteId === noteId);
    if (existingTabIndex !== -1) {
      await this.switchToTab(existingTabIndex);
    } else {
      await this.openNoteInNewTab(noteId);
    }

    // Switch to note chat tab and close sidebar
    this.switchAITab('note');
    this.closeAISidebar();
  }

  /**
   * Add a message to the chat UI
   */
  addChatMessage(content, type, persist = true) {
    const messagesContainer = document.getElementById('ai-chat-messages');
    if (!messagesContainer) return;

    // Save to messages array for persistence
    if (persist) {
      if (!this.noteChatMessages) this.noteChatMessages = [];
      this.noteChatMessages.push({ content, type });
      this.saveNoteChatHistory();
    }

    const messageEl = document.createElement('div');
    messageEl.className = `ai-chat-message ${type}`;

    // Create content container
    const contentEl = document.createElement('div');
    contentEl.className = 'ai-message-content';

    // For assistant messages, render markdown; for user messages, use plain text
    if (type === 'assistant') {
      contentEl.innerHTML = sanitizeHtml(Utils.parseMarkdown(content));
    } else {
      contentEl.textContent = content;
    }
    messageEl.appendChild(contentEl);

    // Add action buttons for assistant messages
    if (type === 'assistant') {
      const actionsEl = document.createElement('div');
      actionsEl.className = 'ai-message-actions';

      // Append to note button
      const appendBtn = document.createElement('button');
      appendBtn.className = 'ai-message-action-btn';
      appendBtn.title = 'Append to current note';
      appendBtn.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <path d="M12 5v14M5 12h14"></path>
      </svg>`;
      appendBtn.addEventListener('click', () => this.openAIInsertPreview('append', content));
      actionsEl.appendChild(appendBtn);

      // Create new note button
      const newNoteBtn = document.createElement('button');
      newNoteBtn.className = 'ai-message-action-btn';
      newNoteBtn.title = 'Create new note';
      newNoteBtn.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path>
        <polyline points="14 2 14 8 20 8"></polyline>
        <line x1="12" y1="18" x2="12" y2="12"></line>
        <line x1="9" y1="15" x2="15" y2="15"></line>
      </svg>`;
      newNoteBtn.addEventListener('click', () => this.openAIInsertPreview('new-note', content));
      actionsEl.appendChild(newNoteBtn);

      // Copy button
      const copyBtn = document.createElement('button');
      copyBtn.className = 'ai-message-action-btn';
      copyBtn.title = 'Copy to clipboard';
      copyBtn.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect>
        <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>
      </svg>`;
      copyBtn.addEventListener('click', () => this.copyAIResponse(content, copyBtn));
      actionsEl.appendChild(copyBtn);

      messageEl.appendChild(actionsEl);
    }

    messagesContainer.appendChild(messageEl);

    // Scroll to bottom
    messagesContainer.scrollTop = messagesContainer.scrollHeight;
  }

  /**
   * Append AI response content to the current note
   */
  async appendAIResponseToNote(blocksOrContent) {
    const editor = this.getEditor();
    if (!editor || !editor.noteId) {
      Utils.showToast('No note is currently open', 'error');
      return;
    }

    try {
      const parsedBlocks = Array.isArray(blocksOrContent)
        ? blocksOrContent
        : this.buildAIInsertBlocks(blocksOrContent);

      await editor.save();
      const startOrder = await editor.getNextBlockOrder();
      const elements = this.createPersistentBlocksForNote(editor.noteId, parsedBlocks, startOrder);

      await Storage.saveElements(elements);
      await this.refreshNoteMetadataAfterInsert(editor.noteId);
      await editor.loadNote(editor.noteId);
      await this.refreshNotesList();

      Utils.showToast(`Added ${elements.length} AI block${elements.length === 1 ? '' : 's'} to note`, 'success');
    } catch (error) {
      console.error('Failed to append content:', error);
      Utils.showToast('Failed to add content', 'error');
    }
  }

  /**
   * Create a new note from AI response content
   */
  async createNoteFromAIResponse(blocksOrContent, rawContent = '') {
    try {
      const parsedBlocks = Array.isArray(blocksOrContent)
        ? blocksOrContent
        : this.buildAIInsertBlocks(blocksOrContent);
      const note = await Storage.createNote('AI Generated');
      const elements = this.createPersistentBlocksForNote(note.id, parsedBlocks, 0);

      await Storage.saveElements(elements);
      await this.refreshNoteMetadataAfterInsert(note.id);
      await this.refreshNotesList();
      await this.openNoteInNewTab(note.id);

      Utils.showToast('New note created from AI response', 'success');

      if (LLM.isConfigured()) {
        this.generateTitleForNewNote(note.id, rawContent || parsedBlocks.map(block => block.content || '').join('\n'));
      }
    } catch (error) {
      console.error('Failed to create note:', error);
      Utils.showToast('Failed to create note', 'error');
    }
  }

  /**
   * Generate title for a newly created note asynchronously
   */
  async generateTitleForNewNote(noteId, content) {
    try {
      const newTitle = await LLM.generateTitle(content);

      if (!newTitle || !newTitle.trim()) {
        return; // Silently fail - note already has default title
      }

      // Get the note and update it
      const note = await Storage.getNote(noteId);
      if (!note) return;

      note.name = newTitle;
      note.lastAutoTitleAt = Date.now();
      await Storage.updateNote(note);

      // Update UI if this note is currently open in editor
      if (this.editor && this.editor.noteId === noteId) {
        this.editor.setTitleProgrammatically(newTitle);
      }

      // Update tab name if open
      const tabIndex = this.openTabs.findIndex(t => t.noteId === noteId);
      if (tabIndex !== -1) {
        this.openTabs[tabIndex].name = newTitle;
        this.renderTabs();
        await this.saveTabs();
      }

      // Update sidebar
      this.renderNotesList();

      Utils.showToast(`Title generated: "${newTitle}"`, 'success');
    } catch (error) {
      console.error('Failed to generate title for new note:', error);
      // Don't show error toast - note was created successfully, title generation is optional
    }
  }

  /**
   * Copy AI response to clipboard
   */
  async copyAIResponse(content, button) {
    try {
      await navigator.clipboard.writeText(content);

      // Show feedback on button
      const originalHTML = button.innerHTML;
      button.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <polyline points="20 6 9 17 4 12"></polyline>
      </svg>`;
      button.classList.add('copied');

      setTimeout(() => {
        button.innerHTML = originalHTML;
        button.classList.remove('copied');
      }, 2000);

    } catch (error) {
      console.error('Failed to copy:', error);
      Utils.showToast('Failed to copy', 'error');
    }
  }

  /**
   * Handle a generated title from AI
   */
  async handleGeneratedTitle(response) {
    // Clean up the response - take first line, remove quotes
    let title = response.split('\n')[0].trim();
    title = title.replace(/^["']|["']$/g, '').trim();

    if (title && title.length < 100) {
      // Ask user if they want to apply the title
      const apply = await confirmDialog({ title: 'Apply Title', message: `Apply this title to your note?\n\n"${title}"` });
      if (apply) {
        this.applyGeneratedTitle(title);
      }
    }
  }

  /**
   * Apply a generated title to the current note
   */
  async applyGeneratedTitle(title) {
    if (!this.editor || !this.editor.noteId) return;

    try {
      const note = await Storage.getNote(this.editor.noteId);
      if (note) {
        note.name = title;
        note.lastAutoTitleAt = Date.now();
        await Storage.updateNote(note);

        this.editor.setTitleProgrammatically(title);

        // Update tab
        const tabIndex = this.openTabs.findIndex(t => t.noteId === this.editor.noteId);
        if (tabIndex !== -1) {
          this.openTabs[tabIndex].name = title;
          this.renderTabs();
          await this.saveTabs();
        }

        this.renderNotesList();
        Utils.showToast('Title updated', 'success');
      }
    } catch (error) {
      console.error('Failed to apply title:', error);
      Utils.showToast('Failed to apply title', 'error');
    }
  }

  /**
   * Clear AI chat history
   */
  clearAIChatHistory() {
    this.aiChatHistory = [];
    const messagesContainer = document.getElementById('ai-chat-messages');
    const stickySuggestions = document.getElementById('ai-sticky-suggestions');

    if (messagesContainer) {
      // Keep only the welcome message
      const welcome = messagesContainer.querySelector('.ai-chat-welcome');
      messagesContainer.innerHTML = '';
      if (welcome) {
        welcome.style.display = 'block';
        messagesContainer.appendChild(welcome);
      }
    }

    // Hide sticky suggestions when chat is cleared
    if (stickySuggestions) {
      stickySuggestions.classList.add('hidden');
    }
  }

  /**
   * Setup LLM settings in the settings modal
   */
  setupLLMSettings() {
    const providerSelect = document.getElementById('llm-provider-select');
    const apiKeyInput = document.getElementById('llm-api-key');
    const modelSelect = document.getElementById('llm-model-select');
    const ollamaUrlInput = document.getElementById('ollama-url');
    const refreshModelsBtn = document.getElementById('refresh-models-btn');

    // Provider change handler
    providerSelect.addEventListener('change', async (e) => {
      const provider = e.target.value;
      await LLM.setProvider(provider);
      this.updateLLMSettingsVisibility(provider);
      await this.loadAndPopulateModels(provider, LLM.apiKey);
      this.updateAISidebarState();
    });

    // API key change handler (debounced) - also triggers model refresh
    const debouncedApiKeySave = Utils.debounce(async (value) => {
      await LLM.setApiKey(value);
      // Refresh models when API key changes
      if (value && LLM.provider !== 'none') {
        await this.loadAndPopulateModels(LLM.provider, value);
      }
      this.updateAISidebarState();
    }, 800);

    apiKeyInput.addEventListener('input', (e) => {
      debouncedApiKeySave(e.target.value);
    });

    // Model change handler
    modelSelect.addEventListener('change', async (e) => {
      await LLM.setModel(e.target.value);
      this.updateAISidebarState();
    });

    // Ollama URL change handler
    if (ollamaUrlInput) {
      const debouncedOllamaUrlSave = Utils.debounce(async (value) => {
        await LLM.setOllamaUrl(value);
        if (LLM.provider === 'ollama') {
          await this.loadAndPopulateModels('ollama', '');
        }
        this.updateAISidebarState();
      }, 800);

      ollamaUrlInput.addEventListener('input', (e) => {
        debouncedOllamaUrlSave(e.target.value);
      });
    }

    // Refresh models button
    if (refreshModelsBtn) {
      refreshModelsBtn.addEventListener('click', async () => {
        await this.loadAndPopulateModels(LLM.provider, LLM.apiKey, true);
      });
    }

    // API key reveal toggle (Req 38.3)
    document.querySelectorAll('.api-key-toggle-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const group = btn.closest('.api-key-input-group');
        const input = group?.querySelector('input');
        if (!input) return;
        const isPassword = input.type === 'password';
        input.type = isPassword ? 'text' : 'password';
        btn.title = isPassword ? 'Hide API key' : 'Show API key';
        btn.querySelector('.eye-icon')?.classList.toggle('hidden', isPassword);
        btn.querySelector('.eye-off-icon')?.classList.toggle('hidden', !isPassword);
      });
    });

    // Clear API key button (Req 38.2)
    document.querySelectorAll('.api-key-clear-btn').forEach(btn => {
      btn.addEventListener('click', async () => {
        const group = btn.closest('.api-key-input-group');
        const input = group?.querySelector('input');
        if (!input || !input.value) return;
        await LLM.setApiKey('');
        document.querySelectorAll('#llm-api-key').forEach(el => { el.value = ''; });
        this.updateAISidebarState();
        Utils.showToast('API key cleared', 'success');
      });
    });

    // Auto-title settings
    const autoTitleEnabled = document.getElementById('auto-title-enabled');
    const autoTitleInterval = document.getElementById('auto-title-interval');

    if (autoTitleEnabled) {
      autoTitleEnabled.addEventListener('change', async (e) => {
        const enabled = e.target.checked;
        const interval = parseInt(autoTitleInterval?.value || '15');
        await this.updateAutoTitleSettings(enabled, interval);
        this.updateAutoTitleIntervalVisibility(enabled);
      });
    }

    if (autoTitleInterval) {
      autoTitleInterval.addEventListener('change', async (e) => {
        const interval = parseInt(e.target.value);
        const enabled = autoTitleEnabled?.checked || false;
        if (enabled) {
          await this.updateAutoTitleSettings(enabled, interval);
        } else {
          await Storage.setSetting('autoTitleInterval', interval);
        }
      });
    }

    // Insights extraction settings
    const insightsEnabled = document.getElementById('insights-enabled');
    const insightsInterval = document.getElementById('insights-interval');

    if (insightsEnabled) {
      insightsEnabled.addEventListener('change', async (e) => {
        const enabled = e.target.checked;
        const interval = parseInt(insightsInterval?.value || '360');
        await this.updateInsightsSettings(enabled, interval);
        this.updateInsightsIntervalVisibility(enabled);
      });
    }

    if (insightsInterval) {
      insightsInterval.addEventListener('change', async (e) => {
        const interval = parseInt(e.target.value);
        const enabled = insightsEnabled?.checked || false;
        if (enabled) {
          await this.updateInsightsSettings(enabled, interval);
        } else {
          await Storage.setSetting('insightsInterval', interval);
        }
      });
    }
  }

  /**
   * Update auto-title interval row visibility
   */
  updateAutoTitleIntervalVisibility(enabled) {
    const intervalRow = document.querySelector('.llm-auto-title-interval-row');
    if (intervalRow) {
      intervalRow.classList.toggle('hidden', !enabled);
    }
  }

  /**
   * Update insights interval row visibility
   */
  updateInsightsIntervalVisibility(enabled) {
    const intervalRow = document.querySelector('.llm-insights-interval-row');
    if (intervalRow) {
      intervalRow.classList.toggle('hidden', !enabled);
    }
  }

  /**
   * Update LLM settings visibility based on provider
   */
  updateLLMSettingsVisibility(provider) {
    const apiKeyRows = document.querySelectorAll('.llm-api-key-row');
    const modelRow = document.querySelector('.llm-model-row');
    const ollamaUrlRow = document.querySelector('.llm-ollama-url-row');
    const ollamaHint = document.querySelector('.llm-ollama-hint');
    const autoTitleRow = document.querySelector('.llm-auto-title-row');
    const autoTitleIntervalRow = document.querySelector('.llm-auto-title-interval-row');
    const autoTitleHint = document.querySelector('.llm-auto-title-hint');
    const insightsRow = document.querySelector('.llm-insights-row');
    const insightsIntervalRow = document.querySelector('.llm-insights-interval-row');
    const insightsHint = document.querySelector('.llm-insights-hint');

    const isConfigured = provider !== 'none';
    const isOllama = provider === 'ollama';

    if (provider === 'none') {
      apiKeyRows.forEach(el => el.classList.add('hidden'));
      modelRow.classList.add('hidden');
      if (ollamaUrlRow) ollamaUrlRow.classList.add('hidden');
    } else if (isOllama) {
      apiKeyRows.forEach(el => el.classList.add('hidden'));
      modelRow.classList.remove('hidden');
      if (ollamaUrlRow) ollamaUrlRow.classList.remove('hidden');
    } else {
      apiKeyRows.forEach(el => el.classList.remove('hidden'));
      modelRow.classList.remove('hidden');
      if (ollamaUrlRow) ollamaUrlRow.classList.add('hidden');
    }

    // Show Ollama CORS hint only when Ollama is selected
    if (ollamaHint) {
      ollamaHint.classList.toggle('hidden', !isOllama);
    }

    // Show/hide auto-title settings based on provider
    if (autoTitleRow) {
      autoTitleRow.classList.toggle('hidden', !isConfigured);
    }
    if (autoTitleHint) {
      autoTitleHint.classList.toggle('hidden', !isConfigured);
    }

    // Auto-title interval visibility depends on both provider and enabled state
    const autoTitleEnabled = document.getElementById('auto-title-enabled');
    if (autoTitleIntervalRow) {
      autoTitleIntervalRow.classList.toggle('hidden', !isConfigured || !autoTitleEnabled?.checked);
    }

    // Show/hide insights settings based on provider
    if (insightsRow) {
      insightsRow.classList.toggle('hidden', !isConfigured);
    }
    if (insightsHint) {
      insightsHint.classList.toggle('hidden', !isConfigured);
    }

    // Insights interval visibility depends on both provider and enabled state
    const insightsEnabled = document.getElementById('insights-enabled');
    if (insightsIntervalRow) {
      insightsIntervalRow.classList.toggle('hidden', !isConfigured || !insightsEnabled?.checked);
    }
  }

  /**
   * Load models from API and populate select
   */
  async loadAndPopulateModels(provider, apiKey, forceRefresh = false) {
    const modelSelect = document.getElementById('llm-model-select');
    const refreshBtn = document.getElementById('refresh-models-btn');

    if (!modelSelect) return;

    // Show loading state
    modelSelect.innerHTML = '<option value="">Loading models...</option>';
    modelSelect.disabled = true;
    if (refreshBtn) {
      refreshBtn.disabled = true;
      refreshBtn.classList.add('loading');
    }

    try {
      const models = await LLM.fetchModels(provider, apiKey);

      modelSelect.innerHTML = '';

      if (models.length === 0) {
        const option = document.createElement('option');
        option.value = '';
        option.textContent = provider === 'ollama'
          ? 'No models found. Is Ollama running?'
          : 'No models available';
        modelSelect.appendChild(option);
      } else {
        models.forEach((model) => {
          const option = document.createElement('option');
          option.value = model.id;
          option.textContent = model.name;
          option.selected = model.id === LLM.model;
          modelSelect.appendChild(option);
        });

        // If current model not in list, select first one
        if (!models.find(m => m.id === LLM.model) && models.length > 0) {
          await LLM.setModel(models[0].id);
          modelSelect.value = models[0].id;
        }
      }
    } catch (error) {
      console.error('Failed to load models:', error);
      modelSelect.innerHTML = '<option value="">Failed to load models</option>';
    } finally {
      modelSelect.disabled = false;
      if (refreshBtn) {
        refreshBtn.disabled = false;
        refreshBtn.classList.remove('loading');
      }
    }
  }

  /**
   * Populate model select based on provider (legacy - now uses loadAndPopulateModels)
   */
  async populateModelSelect(provider) {
    await this.loadAndPopulateModels(provider, LLM.apiKey);
  }

  /**
   * Get text content from current note blocks
   */
  getNoteContent() {
    const blocks = document.querySelectorAll('#blocks-container .block');
    const contentParts = [];

    blocks.forEach((block) => {
      const content = block.querySelector('.block-content');
      if (content) {
        const text = content.textContent.trim();
        if (text) {
          contentParts.push(text);
        }
      }
    });

    return contentParts.join('\n\n');
  }

  /**
   * Apply theme
   */
  async applyTheme() {
    const theme = await Storage.getSetting('theme', 'system');
    await Themes.applyTheme(theme);
  }

  /**
   * Apply font
   */
  async applyFont() {
    if (this.settingsController) {
      await this.settingsController.applyFont();
      return;
    }
    const font = await Storage.getSetting('font', 'default');
    document.documentElement.dataset.font = font;
  }

  /**
   * Apply editor width
   */
  async applyWidth() {
    if (this.settingsController) {
      await this.settingsController.applyWidth();
      return;
    }
    const width = await Storage.getSetting('width', 'default');
    document.documentElement.dataset.width = width;
    this.updateWidthSelectorPill(width);

    // Update wide content centering after width change
    if (this.editor) {
      requestAnimationFrame(() => this.editor.updateWideContentCentering());
    }
  }

  /**
   * Setup Theme Builder UI and logic
   */
  setupThemeBuilder() {
    if (this.themeBuilderController) return; // Handled by ThemeBuilderController
  }

  /**
   * Open Theme Builder modal
   */
  async openThemeBuilder() {
    if (this.themeBuilderController) {
      await this.themeBuilderController.openThemeBuilder();
      return;
    }
  }

  /**
   * Helper to convert various color formats to hex for <input type="color">
   */
  colorToHex(color) {
    if (this.themeBuilderController) {
      return this.themeBuilderController.colorToHex(color);
    }
    return '#000000';
  }

  /**
   * Setup cross-tab settings synchronization
   * Listens for settings changes from other tabs and applies them
   */
  setupSettingsSync() {
    if (this.settingsController) return; // Handled by SettingsController
  }

  /**
   * Setup header width selector
   */
  setupWidthSelectorPill() {
    if (this.settingsController) return; // Handled by SettingsController
  }

  /**
   * Update width selector active state
   */
  updateWidthSelectorPill(width) {
    if (this.settingsController) {
      this.settingsController.updateWidthSelectorPill(width);
      return;
    }
  }

  /**
   * Delete current note
   */
  async deleteCurrentNote() {
    if (this.settingsController) {
      await this.settingsController.deleteCurrentNote();
      return;
    }
  }

  /**
   * Export all data
   */
  async exportAll() {
    if (this.settingsController) {
      await this.settingsController.exportAll();
      return;
    }
  }

  /**
   * Export all notes as a ZIP file containing Markdown files
   */
  async exportAllAsMarkdown() {
    if (this.settingsController) {
      await this.settingsController.exportAllAsMarkdown();
      return;
    }
  }

  /**
   * Export current note only
   */
  async exportCurrentNote() {
    if (this.settingsController) {
      await this.settingsController.exportCurrentNote();
      return;
    }
  }

  /**
   * Create timestamped backup of all data
   */
  async createBackup() {
    if (this.settingsController) {
      await this.settingsController.createBackup();
      return;
    }
  }

  /**
   * Import from file
   */
  async importFromFile(file) {
    if (this.settingsController) {
      await this.settingsController.importFromFile(file);
      return;
    }
  }

  /**
   * Import a single note from file (.md, .txt, or .json)
   */
  async importNote(file) {
    if (this.notesManager) {
      await this.notesManager.importNote(file);
      return;
    }
    try {
      const text = await Utils.readFileAsText(file);
      const filename = file.name;
      const extension = filename.split('.').pop().toLowerCase();

      // Get title from filename (without extension)
      const title = filename.replace(/\.[^/.]+$/, '');

      if (extension === 'json') {
        // Try to import as backup format
        const data = JSON.parse(text);

        if (data.exportType === 'single-note' && data.note && data.blocks) {
          // Single note export format
          const note = await Storage.createNote(data.note.name || title);

          // Import blocks with new note ID
          for (const block of data.blocks) {
            const newBlock = {
              ...block,
              id: Utils.generateId(),
              canvasId: note.id,
              createdAt: Date.now(),
              updatedAt: Date.now(),
            };
            await Storage.saveElement(newBlock);
          }

          await this.refreshNotesList();
          await this.openNoteInNewTab(note.id);
          Utils.showToast('Note imported', 'success');
        } else if (data.version && data.canvases) {
          // Full backup format - use existing import
          await this.importFromFile(file);
        } else {
          throw new Error('Invalid JSON format');
        }
      } else {
        // .md or .txt file - parse into blocks
        const blocks = this.markdownToBlocks(text);
        // Use first H1 as title if found, otherwise use filename
        let noteTitle = title;
        if (blocks.length > 0 && blocks[0].type === 'h1') {
          noteTitle = blocks[0].content || title;
          blocks.shift(); // Remove the H1 since it becomes the note title
        }

        const note = await Storage.createNote(noteTitle);

        for (let i = 0; i < blocks.length; i++) {
          const block = {
            ...blocks[i],
            id: Utils.generateId(),
            canvasId: note.id,
            order: i,
            createdAt: Date.now(),
            updatedAt: Date.now(),
          };
          await Storage.saveElement(block);
        }

        await this.refreshNotesList();
        await this.openNoteInNewTab(note.id);
        Utils.showToast('Note imported', 'success');
      }
    } catch (error) {
      console.error('Import note failed:', error);
      Utils.showToast('Import failed: ' + error.message, 'error');
    }
  }

  /**
   * Show error state
   */
  showErrorState(error) {
    const appEl = document.getElementById('app');
    appEl.innerHTML = '';
    const wrapper = document.createElement('div');
    wrapper.style.cssText = 'display: flex; flex-direction: column; align-items: center; justify-content: center; height: 100vh; color: #666;';
    const heading = document.createElement('h2');
    heading.textContent = 'Failed to initialize';
    wrapper.appendChild(heading);
    const msg = document.createElement('p');
    msg.textContent = error.message;
    wrapper.appendChild(msg);
    const btn = document.createElement('button');
    btn.textContent = 'Reload';
    btn.style.cssText = 'margin-top: 20px; padding: 10px 20px; cursor: pointer;';
    btn.addEventListener('click', () => location.reload());
    wrapper.appendChild(btn);
    appEl.appendChild(wrapper);
  }

  // ============ Auto-Title Feature ============

  /**
   * Generate a simple hash of content for change detection
   */
  generateContentHash(content) {
    let hash = 0;
    const str = content.trim();
    for (let i = 0; i < str.length; i++) {
      const char = str.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash = hash & hash; // Convert to 32bit integer
    }
    return hash.toString(16);
  }

  /**
   * Setup auto-title feature
   */
  async setupAutoTitle() {
    if (this.notesManager) {
      await this.notesManager.setupAutoTitle();
      return;
    }
    const enabled = await Storage.getSetting('autoTitleEnabled', false);
    const interval = await Storage.getSetting('autoTitleInterval', 15);

    if (enabled && LLM.isConfigured()) {
      // Check if we missed any title generations while browser was closed
      await this.checkMissedAutoTitles(interval);

      // Start the regular interval
      this.startAutoTitleInterval(interval);
    }
  }

  /**
   * Check for missed auto-title generations (browser was closed)
   */
  async checkMissedAutoTitles(intervalMinutes) {
    const lastRunTimestamp = await Storage.getSetting('lastAutoTitleRun', 0);
    const intervalMs = intervalMinutes * 60 * 1000;
    const oneHourMs = 60 * 60 * 1000;

    // If last run was more than 1 hour ago, run immediately
    if (lastRunTimestamp && (Date.now() - lastRunTimestamp) > oneHourMs) {
      this.logger.debug('App', 'Missed auto-title window, running catch-up');
      await this.runAutoTitle(true); // Force run for catch-up
    }
  }

  /**
   * Start the auto-title interval
   */
  startAutoTitleInterval(intervalMinutes) {
    // Clear existing interval if any
    this.stopAutoTitleInterval();

    // Convert minutes to milliseconds
    const intervalMs = intervalMinutes * 60 * 1000;

    // Run immediately on start, then at intervals
    this.runAutoTitle();

    this.autoTitleIntervalId = setInterval(() => {
      this.runAutoTitle();
    }, intervalMs);

    this.logger.info('App', `Auto-title started with ${intervalMinutes} minute interval`);
  }

  /**
   * Stop the auto-title interval
   */
  stopAutoTitleInterval() {
    if (this.autoTitleIntervalId) {
      clearInterval(this.autoTitleIntervalId);
      this.autoTitleIntervalId = null;
      this.logger.debug('App', 'Auto-title stopped');
    }
  }

  /**
   * Run auto-title generation for eligible notes
   */
  async runAutoTitle(isCatchUp = false) {
    // Prevent concurrent runs
    if (this.autoTitleRunning) {
      this.logger.debug('App', 'Auto-title already running, skipping');
      return;
    }

    // Check if LLM is configured
    if (!LLM.isConfigured()) {
      this.logger.debug('App', 'LLM not configured, skipping auto-title');
      return;
    }

    this.autoTitleRunning = true;

    try {
      // Record this run timestamp
      await Storage.setSetting('lastAutoTitleRun', Date.now());

      const notes = await Storage.getAllNotes();

      for (const note of notes) {
        // Skip if title was manually set
        if (note.titleManuallySet) {
          continue;
        }

        // Only process notes with "Untitled" title
        const currentTitle = (note.name || '').trim();
        const isUntitled = !currentTitle ||
          currentTitle.toLowerCase() === 'untitled' ||
          currentTitle.toLowerCase().startsWith('untitled ');

        if (!isUntitled) {
          continue;
        }

        // Get note content
        const blocks = await Storage.getElementsByNote(note.id);
        const content = blocks
          .sort((a, b) => (a.order || 0) - (b.order || 0))
          .map(b => this.extractBlockText(b))
          .filter(t => t.trim())
          .join('\n\n');

        // Skip if not enough content
        if (content.trim().length < 20) {
          continue;
        }

        // Generate content hash
        const contentHash = this.generateContentHash(content);

        // Skip if content hasn't changed since last title generation
        if (note.lastTitleContentHash && note.lastTitleContentHash === contentHash) {
          continue;
        }

        try {
          this.logger.debug('App', `Generating title for note: ${note.id}`);

          // Show loading state
          const isCurrentNote = this.editor && this.editor.noteId === note.id;
          const pageTitle = document.getElementById('page-title');
          const sidebarItem = document.querySelector(`.sidebar-note-item[data-note-id="${note.id}"]`);

          if (isCurrentNote && pageTitle) {
            pageTitle.classList.add('title-generating');
          }
          if (sidebarItem) {
            sidebarItem.classList.add('generating');
          }

          const newTitle = await LLM.generateTitle(content);

          // Remove loading state
          if (pageTitle) {
            pageTitle.classList.remove('title-generating');
          }
          const updatedSidebarItem = document.querySelector(`.sidebar-note-item[data-note-id="${note.id}"]`);
          if (updatedSidebarItem) {
            updatedSidebarItem.classList.remove('generating');
          }

          if (newTitle && newTitle.trim()) {
            // Update note with new title and content hash
            note.name = newTitle;
            note.lastAutoTitleAt = Date.now();
            note.lastTitleContentHash = contentHash;
            await Storage.updateNote(note);

            // Update UI if this note is currently open
            if (isCurrentNote) {
              this.editor.setTitleProgrammatically(newTitle);
            }

            // Update tab name if open
            const tabIndex = this.openTabs.findIndex(t => t.noteId === note.id);
            if (tabIndex !== -1) {
              this.openTabs[tabIndex].name = newTitle;
              this.renderTabs();
              await this.saveTabs();
            }

            // Update sidebar
            this.renderNotesList();

            this.logger.info('App', `Auto-title generated: "${newTitle}" for note ${note.id}`);
          }
        } catch (error) {
          console.error(`Failed to generate title for note ${note.id}:`, error);

          // Ensure loading state is removed on error
          const pageTitle = document.getElementById('page-title');
          if (pageTitle) {
            pageTitle.classList.remove('title-generating');
          }
          const sidebarItem = document.querySelector(`.sidebar-note-item[data-note-id="${note.id}"]`);
          if (sidebarItem) {
            sidebarItem.classList.remove('generating');
          }
          // Continue with other notes even if one fails
        }

        // Small delay between API calls to avoid rate limiting
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
    } catch (error) {
      console.error('Auto-title run failed:', error);
    } finally {
      this.autoTitleRunning = false;
    }
  }

  /**
   * Extract text content from a block
   */
  extractBlockText(block) {
    if (!block) return '';

    // Handle different block types
    switch (block.type) {
      case 'text':
      case 'h1':
      case 'h2':
      case 'h3':
      case 'bullet':
      case 'numbered':
      case 'todo':
      case 'quote':
      case 'callout':
        // Strip HTML tags from content
        return this.stripHtml(block.content || '');

      case 'code':
        return block.content || '';

      case 'toggle':
        const mainText = this.stripHtml(block.content || '');
        const childText = this.stripHtml(block.children || '');
        return [mainText, childText].filter(t => t).join('\n');

      case 'table':
        if (block.tableData && Array.isArray(block.tableData)) {
          return block.tableData.map(row => row.join(' ')).join('\n');
        }
        return '';

      case 'bookmark':
        return block.title || block.url || '';

      case 'equation':
        return block.equation || '';

      default:
        return '';
    }
  }

  /**
   * Strip HTML tags from string
   */
  stripHtml(html) {
    if (!html) return '';
    const div = document.createElement('div');
    div.innerHTML = html;
    return div.textContent || div.innerText || '';
  }

  /**
   * High-fidelity HTML to Markdown converter for simple formatting
   */
  htmlToMarkdown(html) {
    if (!html) return '';

    // Create temporary element to parse HTML
    const div = document.createElement('div');
    div.innerHTML = html;

    // Replace formatting tags with markdown equivalents
    const replacements = [
      { sel: 'b, strong', tag: '**' },
      { sel: 'i, em', tag: '*' },
      { sel: 'u', tag: '__' },
      { sel: 'code', tag: '`' },
      { sel: 'del, s, strike', tag: '~~' }
    ];

    replacements.forEach(({ sel, tag }) => {
      div.querySelectorAll(sel).forEach(el => {
        el.textContent = `${tag}${el.textContent}${tag}`;
      });
    });

    // Links
    div.querySelectorAll('a').forEach(el => {
      const href = el.getAttribute('href') || '';
      el.textContent = `[${el.textContent}](${href})`;
    });

    // Colors/Highlights (span with style)
    div.querySelectorAll('span').forEach(el => {
      const color = el.style.color;
      const bg = el.style.backgroundColor;
      if (color || bg) {
        // Markdown doesn't support colors natively, but we can use HTML for high fidelity
        el.outerHTML = el.innerHTML; // Strip span but keep inner formatting for now
      }
    });

    return div.textContent || div.innerText || '';
  }

  /**
   * Update auto-title settings and restart interval if needed
   */
  async updateAutoTitleSettings(enabled, interval) {
    await Storage.setSetting('autoTitleEnabled', enabled);
    await Storage.setSetting('autoTitleInterval', interval);

    if (enabled && LLM.isConfigured()) {
      this.startAutoTitleInterval(interval);
    } else {
      this.stopAutoTitleInterval();
    }
  }

  // ============ Insights Extraction ============

  /**
   * Setup insights extraction feature
   */
  async setupInsightsExtraction() {
    if (this.notesManager) {
      await this.notesManager.setupInsightsExtraction();
      return;
    }
    const enabled = await Storage.getSetting('insightsEnabled', false);
    const interval = await Storage.getSetting('insightsInterval', 360);

    if (enabled && LLM.isConfigured()) {
      // Check if we missed any extractions while browser was closed
      await this.checkMissedInsightsExtraction(interval);

      // Start the regular interval
      this.startInsightsInterval(interval);
    }
  }

  /**
   * Check for missed insights extractions (browser was closed)
   */
  async checkMissedInsightsExtraction(intervalMinutes) {
    const lastRunTimestamp = await Storage.getSetting('lastInsightsRun', 0);
    const intervalMs = intervalMinutes * 60 * 1000;

    // If last run was more than the interval ago, run immediately
    if (lastRunTimestamp && (Date.now() - lastRunTimestamp) > intervalMs) {
      this.logger.debug('App', 'Missed insights extraction window, running catch-up');
      await this.runInsightsExtraction(true);
    }
  }

  /**
   * Start the insights extraction interval
   */
  startInsightsInterval(intervalMinutes) {
    // Clear existing interval if any
    this.stopInsightsInterval();

    // Convert minutes to milliseconds
    const intervalMs = intervalMinutes * 60 * 1000;

    // Run immediately on start, then at intervals
    this.runInsightsExtraction();

    this.insightsIntervalId = setInterval(() => {
      this.runInsightsExtraction();
    }, intervalMs);

    this.logger.info('App', `Insights extraction started with ${intervalMinutes} minute interval`);
  }

  /**
   * Stop the insights extraction interval
   */
  stopInsightsInterval() {
    if (this.insightsIntervalId) {
      clearInterval(this.insightsIntervalId);
      this.insightsIntervalId = null;
      this.logger.debug('App', 'Insights extraction stopped');
    }
  }

  /**
   * Run insights extraction for all notes
   */
  async runInsightsExtraction(isCatchUp = false) {
    // Prevent concurrent runs
    if (this.insightsRunning) {
      this.logger.debug('App', 'Insights extraction already running, skipping');
      return;
    }

    // Check if LLM is configured
    if (!LLM.isConfigured()) {
      this.logger.debug('App', 'LLM not configured, skipping insights extraction');
      return;
    }

    this.insightsRunning = true;

    try {
      // Record this run timestamp
      await Storage.setSetting('lastInsightsRun', Date.now());

      const notes = await Storage.getAllNotes();
      let extractedCount = 0;
      let authError = false;

      for (const note of notes) {
        // If we hit an auth error, stop trying
        if (authError) {
          break;
        }

        // Get note content
        const blocks = await Storage.getElementsByNote(note.id);
        const content = blocks
          .sort((a, b) => (a.order || 0) - (b.order || 0))
          .map(b => this.extractBlockText(b))
          .filter(t => t.trim())
          .join('\n\n');

        // Skip if not enough content
        if (content.trim().length < 50) {
          continue;
        }

        // Generate content hash to check if content changed
        const contentHash = this.generateContentHash(content);

        // Skip if content hasn't changed since last extraction
        if (note.lastInsightsContentHash && note.lastInsightsContentHash === contentHash) {
          continue;
        }

        try {
          this.logger.debug('App', `Extracting insights for note: ${note.id} (${note.name || 'Untitled'})`);

          const insights = await LLM.extractInsights(content, note.name);

          if (insights) {
            // Update note with insights
            note.insights = insights;
            note.lastInsightsExtractedAt = Date.now();
            note.lastInsightsContentHash = contentHash;
            await Storage.updateNote(note);

            // Update UI if this note is currently open
            const isCurrentNote = this.editor && this.editor.noteId === note.id;
            if (isCurrentNote) {
              this.editor.noteData = note;
              this.editor.renderInsights();
            }

            extractedCount++;
            this.logger.debug('App', `Insights extracted for note: ${note.name || 'Untitled'}`);
          }
        } catch (error) {
          const errorMsg = (error.message || '').toLowerCase();
          const errorName = (error.name || '').toLowerCase();
          
          // Check for authentication errors (401, invalid API key, auth cookie, etc.)
          if (errorMsg.includes('401') || 
              errorMsg.includes('unauthorized') || 
              errorMsg.includes('auth') ||
              errorMsg.includes('api key') ||
              errorMsg.includes('invalid') ||
              errorMsg.includes('cookie') ||
              errorMsg.includes('forbidden') ||
              errorMsg.includes('not authorized')) {
            console.warn('Insights extraction stopped: Authentication error. Please check your API key in Settings.');
            authError = true;
            break;
          }
          
          // Check for network/fetch errors - these usually mean connectivity issues
          if (errorName === 'typeerror' || 
              errorMsg.includes('failed to fetch') ||
              errorMsg.includes('network') ||
              errorMsg.includes('enotfound') ||
              errorMsg.includes('econnrefused') ||
              errorMsg.includes('econnreset')) {
            console.warn('Insights extraction stopped: Network error. Please check your internet connection.');
            authError = true;
            break;
          }
          
          // Log other errors but continue with other notes
          console.warn(`Failed to extract insights for note ${note.id}:`, error.message);
        }

        // Small delay between API calls to avoid rate limiting
        await new Promise(resolve => setTimeout(resolve, 1500));
      }

      if (extractedCount > 0) {
        this.logger.info('App', `Insights extraction complete: ${extractedCount} note(s) updated`);
      }
    } catch (error) {
      console.error('Insights extraction run failed:', error);
    } finally {
      this.insightsRunning = false;
    }
  }

  /**
   * Update insights settings and restart interval if needed
   */
  async updateInsightsSettings(enabled, interval) {
    await Storage.setSetting('insightsEnabled', enabled);
    await Storage.setSetting('insightsInterval', interval);

    if (enabled && LLM.isConfigured()) {
      this.startInsightsInterval(interval);
    } else {
      this.stopInsightsInterval();
    }
  }

  /**
   * Get all notes with their insights for daily summary
   */
  async getNotesWithInsights() {
    const notes = await Storage.getAllNotes();
    return notes.filter(note => note.insights && (
      (note.insights.todos && note.insights.todos.length > 0) ||
      (note.insights.reminders && note.insights.reminders.length > 0) ||
      (note.insights.deadlines && note.insights.deadlines.length > 0)
    ));
  }

  /**
   * Check if target folder is a child of parent folder
   */
  isChildFolder(parentId, targetId) {
    if (this.sidebarController) return this.sidebarController.isChildFolder(parentId, targetId);
    if (parentId === targetId) return true;
    const children = this.folders.filter(f => f.parentId === parentId);
    for (const child of children) {
      if (this.isChildFolder(child.id, targetId)) return true;
    }
    return false;
  }

  /**
   * Show folder context menu
   */
  async showFolderContextMenu(e, folder) {
    if (this.sidebarController) {
      await this.sidebarController.showFolderContextMenu(e, folder);
      return;
    }
    const menu = document.createElement('div');
    menu.className = 'context-menu';
    menu.style.left = `${e.pageX}px`;
    menu.style.top = `${e.pageY}px`;

    const items = [
      {
        label: 'Rename',
        icon: 'pencil',
        action: async () => {
          const newName = await promptDialog({ title: 'Rename Folder', message: 'New folder name:', defaultValue: folder.name });
          if (newName && newName !== folder.name) {
            folder.name = newName;
            await Storage.updateFolder(folder);
            await this.refreshNotesList();
          }
        }
      },
      {
        label: 'Delete Folder',
        icon: 'trash',
        action: async () => {
          if (await confirmDialog({ title: 'Delete Folder', message: `Are you sure you want to delete "${folder.name}"? Notes inside will be moved to root.`, confirmText: 'Delete', danger: true })) {
            await Storage.deleteFolder(folder.id);
            await this.refreshNotesList();
          }
        }
      },
      {
        label: 'Add Note to Folder',
        icon: 'plus',
        action: async () => {
          const note = await Storage.createNote('New Note');
          note.folderId = folder.id;
          await Storage.updateNote(note);
          await this.refreshNotesList();
          this.openNote(note.id);
        }
      },
      {
        label: 'Move to Root',
        icon: 'arrow-up',
        action: async () => {
          folder.parentId = null;
          await Storage.updateFolder(folder);
          await this.refreshNotesList();
        }
      }
    ];

    items.forEach(item => {
      const el = document.createElement('div');
      el.className = 'context-menu-item';
      el.innerHTML = `<span>${item.label}</span>`;
      el.addEventListener('click', () => {
        item.action();
        if (document.body.contains(menu)) {
          document.body.removeChild(menu);
        }
      });
      menu.appendChild(el);
    });

    document.body.appendChild(menu);

    const closeMenu = (event) => {
      if (!menu.contains(event.target)) {
        if (document.body.contains(menu)) {
          document.body.removeChild(menu);
        }
        document.removeEventListener('mousedown', closeMenu);
      }
    };
    setTimeout(() => {
      document.addEventListener('mousedown', closeMenu);
    });
  }

  /**
   * Toggle between single and split view
   */
  async toggleSplitView() {
    if (this.tabController) {
      await this.tabController.toggleSplitView();
      return;
    }
  }

  /**
   * Set the active editor side
   */
  setActiveEditorSide(side) {
    if (this.tabController) {
      this.tabController.setActiveEditorSide(side);
      return;
    }
  }

  /**
   * Get the editor instance for a side
   */
  getEditor(side = null) {
    if (this.tabController) {
      return this.tabController.getEditor(side);
    }
    const targetSide = side || this.activeEditorSide;
    return targetSide === 'left' ? this.editor : this.secondaryEditor;
  }

  /**
   * Open the current note in a Document Picture-in-Picture window
   */
  async openNoteInPiP(noteId) {
    if (this.tabController) {
      await this.tabController.openNoteInPiP(noteId);
      return;
    }
  }

  /**
   * Initialize embeddings and load existing vectors
   */
  async initEmbeddings() {
    if (this.notesManager) {
      await this.notesManager.initEmbeddings();
      return;
    }
    if (typeof Embeddings === 'undefined') return;

    // Load existing vectors into search engine
    const vectors = await Storage.getAllVectors();
    this.searchEngine.setVectors(vectors);

    // Initial check for missing embeddings
    this.updateMissingEmbeddings();
  }

  /**
   * Initialize search indexer
   */
  initIndexer() {
    if (this.notesManager) {
      this.notesManager.initIndexer();
      return;
    }
    if (typeof Worker === 'undefined') return;
    try {
      this.indexerWorker = new Worker('js/workers/indexer.js');
      this.indexerWorker.onmessage = async (e) => {
        if (e.data.type === 'INDEX_COMPLETE') {
          await Storage.setSearchIndex(e.data.data);
          await this.refreshSearchIndexEntries();
        }
      };

      this.rebuildSearchIndex();
    } catch (e) {
      console.warn('Failed to start indexer worker:', e);
    }
  }

  /**
   * Rebuild the search index
   */
  async rebuildSearchIndex() {
    if (this.notesManager) {
      await this.notesManager.rebuildSearchIndex();
      return;
    }
    if (!this.indexerWorker) return;
    const blocksByNote = {};
    for (const note of this.notes) {
      blocksByNote[note.id] = await Storage.getElementsByNote(note.id);
    }
    this.indexerWorker.postMessage({
      type: 'INDEX_NOTES',
      data: { notes: this.notes, blocks: blocksByNote }
    });
  }

  /**
   * Background process to update missing embeddings
   */
  async updateMissingEmbeddings() {
    if (typeof Embeddings === 'undefined') return;

    const vectors = await Storage.getAllVectors();
    const vectorMap = new Map(vectors.map(v => [v.noteId, v]));

    const notesToEmbed = this.notes.filter(note => {
      const vector = vectorMap.get(note.id);
      return !vector || vector.updatedAt < note.updatedAt;
    });

    if (notesToEmbed.length === 0) return;

    this.logger.debug('App', `Embeddings: Found ${notesToEmbed.length} notes needing updates`);

    // Process in small batches to avoid blocking
    for (let i = 0; i < notesToEmbed.length; i++) {
      const note = notesToEmbed[i];
      const elements = await Storage.getElementsByNote(note.id);
      const content = elements
        .filter(el => el.type === 'text')
        .map(el => el.content)
        .join(' ');

      const textToEmbed = `${note.name}\n${content}`;
      if (textToEmbed.trim().length > 0) {
        const vector = await Embeddings.generateEmbedding(textToEmbed);
        if (vector) {
          await Storage.saveVector(note.id, vector);
        }
      }

      // Yield to main thread
      if (i % 5 === 0) {
        await new Promise(resolve => setTimeout(resolve, 100));
      }
    }

    // Refresh vectors in engine after update
    const updatedVectors = await Storage.getAllVectors();
    this.searchEngine.setVectors(updatedVectors);
    this.logger.debug('App', 'Embeddings: Background indexing complete');
  }

  /**
   * Proactively update smart suggestions based on current note content
   */
  async updateSmartSuggestions(force = false) {
    if (this.aiChatController) {
      await this.aiChatController.updateSmartSuggestions(force);
      return;
    }
    if (this.aiActiveTab !== 'smart' && !force) return;

    const editor = this.getEditor();
    if (!editor || !editor.noteId) return;

    const text = editor.getAllBlocksTextContent();
    if (text.trim().length < 20) {
      document.getElementById('ai-smart-empty')?.classList.remove('hidden');
      document.getElementById('ai-smart-results')?.classList.add('hidden');
      return;
    }

    // Show loading if first time or forced
    const loading = document.getElementById('ai-smart-loading');
    if (force) loading?.classList.remove('hidden');

    try {
      // 1. Find Related Notes locally via Vector Search
      const searchResults = await this.searchEngine.search(text);
      // Filter out the current note and take top 5
      const relatedResults = searchResults
        .filter(r => r.id !== editor.noteId)
        .slice(0, 5)
        .filter(r => r.score > 0.4);

      // 2. Check if note already has stored insights
      let insights = null;
      const note = editor.noteData;
      
      if (note && note.insights) {
        // Use stored insights - check if content has changed since extraction
        const currentContentHash = this.generateContentHash(text);
        const storedContentHash = note.lastInsightsContentHash;
        
        // If content hasn't changed, use stored insights
        if (!storedContentHash || storedContentHash === currentContentHash) {
          insights = note.insights;
          this.logger.debug('App', 'Using stored insights from note');
        }
      }
      
      // 3. Only extract new insights if we don't have valid stored ones
      if (!insights) {
        this.logger.debug('App', 'Extracting new insights via LLM');
        insights = await LLM.extractInsights(text, editor.titleEl?.textContent || '');
      }

      // Render Results
      this.renderSmartInsights(insights, relatedResults);

    } catch (error) {
      console.error('Smart suggestions failed:', error);
    } finally {
      loading?.classList.add('hidden');
    }
  }

  /**
   * Render insights and related notes into the sidebar
   */
  renderSmartInsights(insights, related) {
    const emptyState = document.getElementById('ai-smart-empty');
    const resultsArea = document.getElementById('ai-smart-results');

    emptyState?.classList.add('hidden');
    resultsArea?.classList.remove('hidden');

    // Tags
    const tagsContainer = document.getElementById('ai-suggested-tags');
    if (tagsContainer) {
      tagsContainer.innerHTML = '';
      if (insights?.tags?.length > 0) {
        insights.tags.forEach(tag => {
          const el = document.createElement('span');
          el.className = 'global-chat-source-tag';
          el.textContent = `#${tag}`;
          el.addEventListener('click', () => {
            // Add tag to note if needed?
          });
          tagsContainer.appendChild(el);
        });
      } else {
        tagsContainer.innerHTML = '<span class="ai-sources-title" style="text-transform:none">No tags suggested</span>';
      }
    }

    // Action Items
    const actionContainer = document.getElementById('ai-extracted-actions');
    if (actionContainer) {
      actionContainer.innerHTML = '';
      const items = [
        ...(insights?.todos || []).map(t => ({ text: t, icon: 'check-square' })),
        ...(insights?.deadlines || []).map(d => ({ text: `${d.text} (${d.date || 'Soon'})`, icon: 'calendar' })),
        ...(insights?.reminders || []).map(r => ({ text: r, icon: 'bell' }))
      ];

      if (items.length > 0) {
        items.forEach(item => {
          const el = document.createElement('div');
          el.className = 'ai-action-item';
          const iconDiv = document.createElement('div');
          iconDiv.className = 'ai-action-icon';
          iconDiv.innerHTML = `
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                ${item.icon === 'check-square' ? '<rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect><polyline points="9 11 12 14 22 4"></polyline>' :
              item.icon === 'calendar' ? '<rect x="3" y="4" width="18" height="18" rx="2" ry="2"></rect><line x1="16" y1="2" x2="16" y2="6"></line><line x1="8" y1="2" x2="8" y2="6"></line><line x1="3" y1="10" x2="21" y2="10"></line>' :
                '<path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"></path><path d="M13.73 21a2 2 0 0 1-3.46 0"></path>'}
              </svg>
          `;
          el.appendChild(iconDiv);
          const textSpan = document.createElement('span');
          textSpan.textContent = item.text;
          el.appendChild(textSpan);
          actionContainer.appendChild(el);
        });
      } else {
        actionContainer.innerHTML = '<span class="ai-sources-title" style="text-transform:none">No action items found</span>';
      }
    }

    // Related Notes
    const relatedContainer = document.getElementById('ai-related-notes');
    if (relatedContainer) {
      relatedContainer.innerHTML = '';
      if (related.length > 0) {
        related.forEach(res => {
          const note = this.notes.find(n => n.id === res.id);
          const el = document.createElement('div');
          el.className = 'ai-related-item';
          el.innerHTML = `
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path>
              <polyline points="14 2 14 8 20 8"></polyline>
            </svg>
          `;
          const titleSpan = document.createElement('span');
          titleSpan.className = 'ai-related-title';
          titleSpan.textContent = note?.name || 'Untitled';
          el.appendChild(titleSpan);
          el.addEventListener('click', () => this.openNoteById(res.id));
          relatedContainer.appendChild(el);
        });
      } else {
        relatedContainer.innerHTML = '<span class="ai-sources-title" style="text-transform:none">No related notes found</span>';
      }
    }
  }

  /**
   * Check if a backup is due and remind the user
   */
  async checkBackupStatus() {
    if (this.settingsController) return; // Handled by SettingsController
  }

  /**
   * Setup global keyboard shortcuts
   */
  setupShortcuts() {
    if (this.shortcutsManager) {
      // Already initialized via initShortcutsManager
      return;
    }
    this.updateShortcutLabels();

    window.addEventListener('keydown', async (e) => {
      if (await this.handleCommandPaletteShortcuts(e)) {
        return;
      }

      // Don't trigger if user is typing in an input/textarea (except specific modifiers)
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
          this.toggleShortcutsModal();
          return;
        case 'escape':
          e.preventDefault();
          if (this.focusMode) {
            this.toggleFocusMode(false);
            return;
          }
          this.closeAllModals();
          return;
        case 'new-note':
        case 'legacy-new-note':
          e.preventDefault();
          await this.openNewTab();
          return;
        case 'command-palette':
          e.preventDefault();
          this.toggleCommandPalette();
          return;
        case 'toggle-ai':
          e.preventDefault();
          this.toggleAISidebar();
          return;
        case 'toggle-sidebar':
          e.preventDefault();
          await this.toggleSidebar();
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
          {
            const note = await Storage.ensureDailyNote();
            if (note) {
              await this.refreshNotesList();
              await this.openNoteInNewTab(note.id);
            }
          }
          return;
        case 'next-tab':
          e.preventDefault();
          if (this.tabController) this.tabController.cycleTab(1);
          return;
        case 'prev-tab':
          e.preventDefault();
          if (this.tabController) this.tabController.cycleTab(-1);
          return;
        case 'close-tab':
          e.preventDefault();
          if (this.tabController) await this.tabController.closeCurrentTab();
          return;
        default:
          return;
      }
    });
  }

  /**
   * Update shortcut labels in the UI based on OS
   */
  updateShortcutLabels() {
    const isMac = navigator.platform.toUpperCase().indexOf('MAC') >= 0;
    const modLabel = isMac ? '⌘' : 'Ctrl';
    const altLabel = isMac ? '⌥' : 'Alt';

    document.querySelectorAll('.mod-key').forEach(el => {
      el.textContent = modLabel;
    });

    // Update title tooltips if they contain placeholders or just add them
    if (isMac) {
      const statsBtn = document.getElementById('sidebar-stats');
      if (statsBtn) statsBtn.title = 'Analytics & Stats (Alt+I)'; // I'll add Alt+I for stats
      // etc.
    }
  }

  /**
   * Toggle the Shortcuts Help modal
   */
  toggleShortcutsModal(force) {
    if (this.settingsController) {
      this.settingsController.toggleShortcutsModal(force);
      return;
    }
    const modal = document.getElementById('shortcuts-modal');
    if (!modal) return;

    const show = force !== undefined ? force : modal.classList.contains('hidden');
    if (show) {
      modal.classList.remove('hidden');
    } else {
      modal.classList.add('hidden');
    }
  }

  /**
   * Close all open modals and menus
   */
  closeAllModals() {
    document.querySelectorAll('.modal').forEach(m => m.classList.add('hidden'));
    document.querySelectorAll('.context-menu').forEach(m => m.classList.add('hidden'));

    // Clean up focus traps
    if (this.settingsController) {
      if (this.settingsController._settingsFocusTrapCleanup) { this.settingsController._settingsFocusTrapCleanup(); this.settingsController._settingsFocusTrapCleanup = null; }
      if (this.settingsController._shortcutsFocusTrapCleanup) { this.settingsController._shortcutsFocusTrapCleanup(); this.settingsController._shortcutsFocusTrapCleanup = null; }
    }
    if (this.themeBuilderController && this.themeBuilderController._focusTrapCleanup) { this.themeBuilderController._focusTrapCleanup(); this.themeBuilderController._focusTrapCleanup = null; }
    if (this.shortcutsManager && this.shortcutsManager._commandPaletteFocusTrapCleanup) { this.shortcutsManager._commandPaletteFocusTrapCleanup(); this.shortcutsManager._commandPaletteFocusTrapCleanup = null; }

    // Also close slash menu if open in active editor
    this.getEditor()?.hideSlashMenu();
    this.getEditor()?.hideWikiMenu();
  }

  /**
   * Enter multi-selection mode
   */
  enterSelectionMode(noteId) {
    if (this.sidebarController) {
      this.sidebarController.enterSelectionMode(noteId);
      return;
    }
    this.selectionMode = true;
    this.selectedNoteIds.clear();
    if (noteId) {
      this.selectedNoteIds.add(noteId);
    }

    // Show bulk actions bar
    const bulkBar = document.getElementById('sidebar-bulk-actions');
    if (bulkBar) {
      bulkBar.classList.add('visible');
    }

    this.updateSelectionUI();
    this.renderNotesList();
  }

  /**
   * Exit multi-selection mode
   */
  exitSelectionMode() {
    if (this.sidebarController) {
      this.sidebarController.exitSelectionMode();
      return;
    }
    this.selectionMode = false;
    this.selectedNoteIds.clear();

    // Hide bulk actions bar
    const bulkBar = document.getElementById('sidebar-bulk-actions');
    if (bulkBar) {
      bulkBar.classList.remove('visible');
    }

    this.renderNotesList();
  }

  /**
   * Toggle a note's selection state
   */
  toggleNoteSelection(noteId) {
    if (this.selectedNoteIds.has(noteId)) {
      this.selectedNoteIds.delete(noteId);
    } else {
      this.selectedNoteIds.add(noteId);
    }

    if (this.selectedNoteIds.size === 0) {
      this.exitSelectionMode();
    } else {
      this.updateSelectionUI();
    }
  }

  /**
   * Update the selection UI (count and checkboxes)
   */
  updateSelectionUI() {
    const countEl = document.querySelector('.bulk-actions-count');
    if (countEl) {
      countEl.textContent = `${this.selectedNoteIds.size} selected`;
    }

    // Update checkboxes in the list without full re-render if possible
    document.querySelectorAll('.sidebar-note-item').forEach(el => {
      const id = el.dataset.id;
      const checkbox = el.querySelector('.sidebar-note-checkbox');
      if (checkbox) {
        checkbox.classList.toggle('checked', this.selectedNoteIds.has(id));
      }
    });
  }

  /**
   * Perform a bulk action on selected notes
   */
  async performBulkAction(action) {
    if (this.sidebarController) {
      await this.sidebarController.performBulkAction(action);
      // Sync data back
      this.notes = this.sidebarController.notes;
      this.archivedNotes = this.sidebarController.archivedNotes;
      this.trashedNotes = this.sidebarController.trashedNotes;
      this.templates = this.sidebarController.templates;
      return;
    }
    const ids = Array.from(this.selectedNoteIds);
    if (ids.length === 0) return;

    let confirmMsg = '';
    switch (action) {
      case 'trash': confirmMsg = `Move ${ids.length} notes to trash?`; break;
      case 'archive': confirmMsg = `Archive ${ids.length} notes?`; break;
      case 'delete': confirmMsg = `Permanently delete ${ids.length} notes? This cannot be undone.`; break;
    }

    if (confirmMsg && !await confirmDialog({ title: 'Confirm', message: confirmMsg, confirmText: action === 'delete' ? 'Delete' : 'OK', danger: action === 'delete' })) return;

    try {
      await Storage.bulkNoteAction(ids, action);
      Utils.showToast(`${ids.length} notes ${action}ed`, 'success');

      // Refresh local data
      this.notes = await Storage.getAllNotes();
      this.archivedNotes = await Storage.getArchivedNotes();
      this.trashedNotes = await Storage.getTrashedNotes();
      this.templates = await Storage.getTemplates();

      this.exitSelectionMode();
      this.updateBadgeCounts();
    } catch (error) {
      console.error('Bulk action failed:', error);
      Utils.showToast('Bulk action failed', 'error');
    }
  }
}

// Initialize app when DOM is ready
document.addEventListener('DOMContentLoaded', () => {
  const app = new App();
  window.app = app; // Make globally available for editor callbacks
  app.init().catch(error => {
    console.error('App initialization failed:', error);
  });
});
