/**
 * Main application entry point
 */

/** What the new tab shows when it can't open the notes database, by the codes Storage.init threw. */
const STORAGE_GUARD_TEXT = {
  NEWER_SCHEMA: {
    title: 'Your notes were upgraded by a newer NewTabNote version',
    body: "This version can't open them safely, so it won't change anything. Update NewTabNote to keep working, or export a copy now.",
  },
  MISSING_CORE_STORES: {
    title: 'Your notes database is incomplete',
    body: "Part of it is missing, so this version won't change anything. Export a copy of what's there now.",
  },
};

/**
 * What the error state says when the tab's kernel couldn't open or maintain storage, by the
 * outcome's messageKey: an outcome carries no error message, which is what 1.4.x showed
 * there. #26 gives every outcome its copy.
 */
const STARTUP_FAILURES = {
  'unavailable.quota': "There's no room left to store your notes.",
};
const STARTUP_FAILED = "NewTabNote couldn't open your notes.";

/**
 * What App.init shows when the tab's kernel couldn't open or maintain storage: the guard, by
 * the code Storage.init threw, for a database a newer build upgraded or one missing its notes
 * or blocks, and otherwise the error state, saying why in words. The error's message is what
 * the page shows, and its cause the outcome, so the console says both, with the cause and code.
 * @param {{cause: string, code: string, messageKey: string}} failure - the outcome whenReady answered with
 * @returns {Error & {code?: string, cause?: unknown}}
 */
function storageFailure(failure) {
  let code = null;
  if (failure.cause === 'newer-schema') code = 'NEWER_SCHEMA';
  else if (failure.code === 'missing-core-stores') code = 'MISSING_CORE_STORES';
  const shown = code ? STORAGE_GUARD_TEXT[code].title : STARTUP_FAILURES[failure.messageKey] || STARTUP_FAILED;
  const error = /** @type {Error & {code?: string, cause?: unknown}} */ (new Error(shown));
  error.cause = failure;
  if (code) error.code = code;
  return error;
}

/** Features that are off while an auxiliary store is missing. `settings` has none: settings live in chrome.storage.local. */
const MISSING_STORE_FEATURES = {
  media: 'imported media',
  search_index: 'search',
  folders: 'folders',
  links: 'backlinks and graph',
  themes: 'custom themes',
  vectors: 'semantic search',
  snapshots: 'version history',
};

class App {
  /**
   * The new-tab composition root (js/kernel/composition/newtab.js) constructs App with the
   * tab's kernel client (js/kernel/composition/host.js describes it), the document client
   * every editor reads and writes its note through (js/kernel/composition/document.js), the
   * AI port every editor and NotesManager call the provider through (js/services/ai-port.mjs),
   * and the tab's note list (js/kernel/core/application/note-list.js), the one copy of the note
   * lists that App, the controllers, the palette, and analytics read. The settings client
   * (js/kernel/composition/settings.js) is the tab's settings port, which the controllers
   * write their preferences, the workspace session, AI chat history, themes, onboarding, and
   * backups through. `events` are the tab's failure events
   * (js/kernel/composition/lazy-failure-events.js), which init gives the logger the
   * controllers share, as its `event` method, and Embeddings. `removal` is the tab's
   * removeNotes (js/kernel/composition/removal.js). `storageState` is what the tab knows of its
   * database outside the kernel, whether it's open and which stores it lacks; `recovery` the
   * storage guard's raw export; `validateBackup` an import's check of a backup, which writes
   * nothing; and `legacyStorage` js/storage.js's, which the graph view (#22), the search index
   * and vectors (#22), and sync (#19) still go through until their issues move them.
   * @param {{kernel?: any, documentClient?: any, settings?: any, ai?: any, noteList?: any, events?: any, removal?: any,
   *   storageState?: any, recovery?: any, validateBackup?: any, legacyStorage?: any}} [options]
   */
  constructor({
    kernel, documentClient, settings, ai, noteList, events = null, removal,
    storageState, recovery, validateBackup, legacyStorage,
  } = {}) {
    this.kernel = kernel;
    // removeNotes (js/kernel/composition/removal.js): every path that takes notes out of the
    // active set goes through it, and it moves this tab's panes around the write
    this.removal = removal;
    this.documentClient = documentClient;
    this.settings = settings;
    this.ai = ai;
    this.noteList = noteList;
    this.events = events;
    this.storageState = storageState;
    this.recovery = recovery;
    this.validateBackup = validateBackup;
    this.legacyStorage = legacyStorage;
    this.editor = null;
    this.secondaryEditor = null;
    // Search Indexer
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
    this.domRefs = null;
    this.logger = null;
    this.triggerIndexing = Utils.debounce((noteId) => {
      if (noteId && this.notesManager) {
        this.notesManager.updateNoteIndex(noteId);
      } else {
        this.rebuildSearchIndex();
      }
    }, 300);
  }

  /**
   * The note lists, read from the tab's note list (js/kernel/core/application/note-list.js).
   * Each is frozen: nothing changes a note or folder it lists, and a change to the lists
   * arrives as new ones.
   * @returns {ReadonlyArray<any>}
   */
  get notes() {
    return this.noteList.view('active');
  }

  /** @returns {ReadonlyArray<any>} */
  get archivedNotes() {
    return this.noteList.view('archived');
  }

  /**
   * removeNotes' leave (js/kernel/composition/removal.js): panes on the notes write what they
   * have pending and move to other notes before the write, and its answer finishes the move or
   * undoes it after (TabController.leaveNotes). A failure there is logged and never stops the
   * write.
   * @param {Array<string>} ids
   * @returns {Promise<{arrive: Function, restore: Function}|null>}
   */
  async leaveNotes(ids) {
    try {
      // A new note a pane gets comes through the kernel (createTabNote), so the lists have it
      // from the commit feed
      return await this.tabController.leaveNotes(ids);
    } catch (error) {
      console.error('Moving panes off notes that are leaving failed:', error);
      return null;
    }
  }

  /**
   * Notes left the active set: the other new tabs refresh their lists.
   * @param {Array<string>} ids
   * @returns {void}
   */
  notesLeft(ids) {
    if (this.tabController) this.tabController.announceNotesLeft(ids);
  }

  /**
   * The failure sites report through the tab's failure events (#20, "Diagnostic journal"):
   * the controllers through `logger.event`, and the embedding model's load through
   * Embeddings.events. Without events the logger has no `event`, and each site does only
   * what it did before.
   */
  attachFailureEvents() {
    if (!this.events) return;
    this.logger.event = this.events.event;
    if (typeof Embeddings !== 'undefined') Embeddings.events = this.events;
    // Sightings held in chrome.storage.local reconcile now; with none it loads no trust code
    if (typeof this.events.reconcile === 'function') this.events.reconcile();
  }

  /**
   * Initialize the application
   */
  async init() {
    try {
      // Initialize core infrastructure
      this.logger = createLogger();
      this.attachFailureEvents();
      this.domRefs = createDomRefs();

      // The tab's kernel opens storage and runs startup maintenance, as Storage.init did here
      const failure = await this.kernel.whenReady();
      if (failure) throw storageFailure(failure);
      this.reportMissingStores();
      // Every controller exists before init binds a listener, so a click while they start reaches its own
      this.buildControllers();
      // The theme engine reads the saved theme and the custom themes through the settings port,
      // from before any other tab's theme change can reach it
      Themes.connect({ settings: this.settings });

      // The export notice decides now, before any note renders and before a first note exists
      this.exportNotice = new ExportNotice({
        storageState: this.storageState,
        settings: this.settings,
        onExport: () => this.settingsController.exportAll(),
        onClose: (returnFocus) => this.focusAfterExportNotice(returnFocus),
      });
      const startupReads = Promise.all([
        Onboarding.hasCompleted(this.settings),
        this.exportNotice.isDue().catch((error) => {
          console.error('Export notice: could not decide whether to show it', error);
          return false;
        }),
      ]);

      // Populate DOM cache after document is ready
      this.domRefs.init();
      // Settings > Data & Backup says what the export holds in the notice's words
      const exportHint = document.getElementById('export-contents-hint');
      if (exportHint) exportHint.textContent = ExportNotice.TEXT.hint;

      // Initialize LLM service
      await LLM.init();

      // Global unhandled rejection handler
      window.addEventListener('unhandledrejection', (event) => {
        this.logger.error('App', 'Unhandled promise rejection', event.reason);
        Utils.showToast('An unexpected error occurred', 'error');
      });

      // The tab's note list read every note, folder, and search entry in one read once the
      // kernel was ready, and the sidebar's first render needs them
      await this.noteList.settled();
      const lists = this.noteList.state();
      if (lists.kind === 'failed') throw storageFailure({ ...lists, messageKey: `unavailable.${lists.cause}` });

      // Initialize editors
      const editorChangeHandler = Utils.debounce(() => {
        this.aiChatController.updateSmartSuggestions();
      }, 2000);

      // The PiP editor gets the same ports from TabController
      this.editorPorts = { documentClient: this.documentClient, navigation: this.editorNavigation(), ai: this.ai };
      this.editor = new BlockEditor({
        root: document.getElementById('editor-container'),
        onChange: editorChangeHandler,
        ...this.editorPorts,
      });
      this.secondaryEditor = new BlockEditor({
        root: document.getElementById('secondary-editor-container'),
        onChange: editorChangeHandler,
        ...this.editorPorts,
      });
      // Share editor references, and what the PiP editor gets
      this.tabController.editor = this.editor;
      this.tabController.secondaryEditor = this.secondaryEditor;
      this.tabController.editorPorts = this.editorPorts;

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
      const [hasCompletedOnboarding, exportNoticeDue] = await startupReads;
      const runsOnboarding = this.notes.length === 0 && this.archivedNotes.length === 0 && !hasCompletedOnboarding;
      // Before a note loads, so the note lays out once
      if (exportNoticeDue && !runsOnboarding) this.showExportNotice();
      if (runsOnboarding) {
        // First-run: show onboarding walkthrough
        await this.runOnboarding();
      } else if (this.notes.length === 0 && this.archivedNotes.length === 0) {
        // Returning user with no notes
        await this.createFirstNote();
      } else if (this.notes.length > 0) {
        // Try loading cached last-opened note for fast startup (Req 27.2)
        const cachedNoteId = await this.tabController.lastOpenedNoteId();
        const cachedNote = cachedNoteId ? this.notes.find(n => n.id === cachedNoteId) : null;
        if (cachedNote) {
          await this.editor.loadNote(cachedNote.id);
        } else {
          await this.editor.loadNote(this.notes[0].id);
        }
        await this.tabController.loadSavedTabs();
      }
      // From here on, another new tab's trash, archive, or delete refreshes this one's lists
      this.tabController.workspaceReady();
      // Trash retention once this tab's panes and tabs can move off what it deletes; the other tabs refresh their lists
      await this.sidebarController.runTrashCleanup().catch((error) => this.logger.error('App', 'Trash cleanup failed', error));

      this.updateEmptyState();
      this.updateBadgeCounts();
      // A start that restored no saved tab rendered no list yet, so 1.4.x showed the badge's
      // count over an empty list until something refreshed it
      if (!this.sidebarController.listRendered) await this.sidebarController.renderNotesList();

      // Defer non-critical initialization until after first render (Req 27.1)
      const deferWork = async () => {
        await this.initAnalyticsController();
        await this.initGraphView();
        await this.initSyncService();
        if (this.notesManager) {
          await this.notesManager.deferredInit();
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
      if (error && (error.code === 'NEWER_SCHEMA' || error.code === 'MISSING_CORE_STORES')) {
        this.showStorageGuard(error.code);
      } else {
        this.showErrorState(error);
      }
    }
  }

  /**
   * Show the one-time notice to export a copy before the next update changes
   * how notes are stored (js/ui/export-notice.js), in #export-notice between
   * the note's title and its blocks. Nothing here stops the new tab from starting.
   * @returns {void}
   */
  showExportNotice() {
    try {
      this.exportNotice.show(/** @type {HTMLElement} */ (document.getElementById('export-notice')));
    } catch (error) {
      console.error('Export notice failed to show:', error);
    }
  }

  /**
   * The export notice closed while it held focus: focus goes back where it was
   * in a pane before it moved into the notice, caret included. Else to the end
   * of the active pane's first text block, else that pane's title, else the
   * pane itself, never the page body.
   * @param {{element: Element|null, range: Range|null}|null} returnFocus
   * @returns {void}
   */
  focusAfterExportNotice(returnFocus) {
    const previous = /** @type {HTMLElement|null} */ (returnFocus && returnFocus.element);
    if (previous && previous.isConnected && previous.closest('.editor-pane')) {
      previous.focus();
      const selection = document.getSelection();
      if (returnFocus.range && selection) {
        selection.removeAllRanges();
        selection.addRange(returnFocus.range);
      }
      return;
    }
    const editor = this.getEditor();
    const textBlock = editor.blocks.find((block) => {
      const element = editor.getBlockElement(block.id);
      return Boolean(element && element.querySelector('.block-content'));
    });
    if (textBlock) {
      editor.focusBlock(textBlock.id, true);
    } else if (editor.noteId) {
      editor.titleEl.focus();
    } else {
      // Focusable only until focus moves on
      const pane = editor.root;
      pane.setAttribute('tabindex', '-1');
      pane.addEventListener('blur', () => pane.removeAttribute('tabindex'), { once: true });
      pane.focus();
    }
  }

  /**
   * On each start with auxiliary stores missing, a toast names the features
   * that are off and points to Export. A missing settings store alone shows nothing.
   * @returns {void}
   */
  reportMissingStores() {
    const features = this.storageState.missingStores
      .map((store) => MISSING_STORE_FEATURES[store])
      .filter(Boolean);
    if (features.length === 0) return;
    Utils.showToast(
      `Your notes database is incomplete, so these are off: ${features.join(', ')}. `
      + 'Export a copy from Settings > Data & Backup.',
      'error',
      10000
    );
  }

  /**
   * Full-page state for a database this build can't open: a newer build
   * upgraded it, or its notes or blocks store is missing. Nothing here
   * writes; Export reads every store except settings.
   * @param {'NEWER_SCHEMA'|'MISSING_CORE_STORES'} code
   * @returns {void}
   */
  showStorageGuard(code) {
    const text = STORAGE_GUARD_TEXT[code];
    const appEl = document.getElementById('app');
    appEl.innerHTML = '';

    const wrapper = document.createElement('main');
    wrapper.className = 'storage-guard';
    wrapper.setAttribute('aria-labelledby', 'storage-guard-title');

    const heading = document.createElement('h1');
    heading.id = 'storage-guard-title';
    heading.className = 'storage-guard-title';
    heading.textContent = text.title;
    wrapper.appendChild(heading);

    const body = document.createElement('p');
    body.className = 'storage-guard-body';
    body.textContent = text.body;
    wrapper.appendChild(body);

    const actions = document.createElement('div');
    actions.className = 'storage-guard-actions';

    const exportBtn = document.createElement('button');
    exportBtn.type = 'button';
    exportBtn.className = 'primary-btn storage-guard-btn';
    exportBtn.textContent = 'Export';
    exportBtn.addEventListener('click', () => this.exportRawCopy(exportBtn));
    actions.appendChild(exportBtn);

    const reloadBtn = document.createElement('button');
    reloadBtn.type = 'button';
    reloadBtn.className = 'secondary-btn storage-guard-btn';
    reloadBtn.textContent = 'Reload';
    reloadBtn.addEventListener('click', () => location.reload());
    actions.appendChild(reloadBtn);

    wrapper.appendChild(actions);
    appEl.appendChild(wrapper);
    exportBtn.focus();
  }

  /**
   * Download `newtabnote-raw-v<version>-<timestamp>.json`: every store except
   * settings, read without changing anything.
   * @param {HTMLButtonElement} [button] - Disabled while the export runs
   * @returns {Promise<void>}
   */
  async exportRawCopy(button) {
    if (button) button.disabled = true;
    try {
      const raw = await this.recovery.exportRawStores();
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      Utils.downloadFile(JSON.stringify(raw, null, 2), `newtabnote-raw-v${raw.onDiskVersion}-${timestamp}.json`);
      Utils.showToast('Exported a copy of your notes. Settings are left out.', 'success');
    } catch (error) {
      console.error('Raw export failed:', error);
      Utils.showToast(`Export failed: ${error.message}`, 'error');
    } finally {
      if (button) button.disabled = false;
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
    const noteId = await this.createListedNote({ name: 'Untitled' });
    if (!noteId) return;
    await this.openNoteInNewTab(noteId);
    document.getElementById('page-title').focus();
  }

  /**
   * After a note-list write through the kernel (a new note, the Daily Note): once it
   * committed, the tab's note list has it, from the commit feed with no refresh, and the empty
   * state follows, as the refresh after the Storage write showed them. A write that didn't
   * commit is logged by its outcome's kind and code, never the note's content, and its toast
   * says `action` failed and why (Utils.writeFailureMessage).
   * @param {{kind: string, reason?: string, code?: string}} outcome
   * @param {string} action - such as "Failed to create note"
   * @returns {Promise<boolean>} whether it committed
   */
  async listWriteDone(outcome, action) {
    if (outcome.kind !== 'committed') {
      console.error(`${action}:`, outcome.kind, outcome.code);
      Utils.showToast(Utils.writeFailureMessage(action, outcome), 'error');
      return false;
    }
    await this.noteList.settled();
    this.updateEmptyState();
    return true;
  }

  /**
   * A new note through the kernel's createNote, under an id taken now: `fields` give its name
   * and first blocks, which land with it in one unit
   * @param {{name: string, blocks?: Array<Object>}} fields
   * @returns {Promise<string|null>} its id, or null when it wasn't stored
   */
  async createListedNote(fields) {
    const noteId = this.documentClient.newId();
    const outcome = await this.documentClient.createNote({ ...fields, noteId });
    return (await this.listWriteDone(outcome, 'Failed to create note')) ? noteId : null;
  }

  /**
   * The Daily Note for `dateStr`, or today's: the kernel's ensureDailyNote makes it whole in
   * one unit when there's none, so asking twice at once makes one, and findDailyNote reads it,
   * whether it was made or found
   * @param {string} [dateStr] - `YYYY-MM-DD`
   * @returns {Promise<{id: string}|null>} the note, or null when it couldn't be found or made
   */
  async ensureDailyNote(dateStr) {
    const action = 'Failed to open the Daily Note';
    const { outcome, note } = await this.documentClient.ensureDailyNote(dateStr);
    if (!(await this.listWriteDone(outcome, action))) return null;
    if (!note) {
      console.error(`${action}:`, 'not-read');
      Utils.showToast(Utils.writeFailureMessage(action, { kind: 'failed' }), 'error');
    }
    return note;
  }

  /**
   * A new Untitled note for TabController, when a pane has nothing left to show or a new tab
   * opens. Its caller shows it.
   * @returns {Promise<{id: string, name: string}|null>} the note, or null when it wasn't stored
   */
  async createTabNote() {
    const noteId = this.documentClient.newId();
    const outcome = await this.documentClient.createNote({ noteId, name: 'Untitled' });
    if (outcome.kind !== 'committed') {
      console.error('Failed to create note:', outcome.kind, outcome.code);
      Utils.showToast(Utils.writeFailureMessage('Failed to create note', outcome), 'error');
      return null;
    }
    return { id: noteId, name: 'Untitled' };
  }

  /**
   * Run onboarding for new users
   */
  async runOnboarding() {
    // 1. Setup default settings
    await Onboarding.setupFirstRun(this.settings);

    // 2. Create Welcome Note with example blocks, which land with it
    const now = Date.now();
    const blocks = Onboarding.getWelcomeNoteContent().map((blockData, i) => ({
      id: this.documentClient.newId(),
      type: blockData.type,
      content: blockData.content || '',
      order: i,
      checked: blockData.checked || false,
      indentLevel: 0,
      createdAt: now,
      updatedAt: now,
    }));
    const noteId = await this.createListedNote({ name: 'Welcome to NewTabNote 🚀', blocks });
    if (!noteId) return;
    const note = { id: noteId };

    // 3. Load the welcome note so the editor is visible during walkthrough
    await this.openNoteInNewTab(note.id);

    // 4. Run interactive tooltip walkthrough (dismiss at any step marks complete)
    await Onboarding.runWalkthrough();

    // 5. Mark onboarding as complete
    await Onboarding.markComplete(this.settings);

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
   * Build every controller and wire its callbacks once the kernel is ready, before init binds a
   * listener or starts a controller (#12 slice 7a). So each `this.<controller>` App calls
   * exists from the first click or key on, and one that comes while the later controllers
   * still start reaches the controller that owns it. The constructors only take their
   * dependencies, and each controller's init still runs in init's order. A database the tab
   * can't open stops init before this, as it stopped before the first controller.
   * @returns {void}
   */
  buildControllers() {
    this.sidebarController = new SidebarController({
      settings: this.settings,
      domRefs: this.domRefs,
      logger: this.logger,
      documentClient: this.documentClient,
      storageState: this.storageState,
    });

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
    // Trash, Empty trash, bulk actions, and trash retention take notes out through removeNotes
    this.sidebarController.removal = this.removal;

    this.tabController = new TabController({
      settings: this.settings,
      domRefs: this.domRefs,
      logger: this.logger,
      documentClient: this.documentClient,
    });

    // Wire callbacks so the controller can trigger App-level actions
    this.tabController.onCreateNote = () => this.createTabNote();
    this.tabController.onRefreshNotesList = (options) => this.refreshNotesList(options);
    this.tabController.onRenderNotesList = () => this.renderNotesList();
    this.tabController.noteList = this.noteList;
    this.tabController.onUpdateEmptyState = () => this.updateEmptyState();

    this.aiChatController = new AIChatController({
      settings: this.settings,
      domRefs: this.domRefs,
      logger: this.logger,
      llm: LLM,
      documentClient: this.documentClient,
    });

    // Share search engine reference
    this.aiChatController.searchEngine = this.searchEngine;

    // Wire callbacks so the controller can trigger App-level actions
    this.aiChatController.getEditor = () => this.getEditor();
    this.aiChatController.onOpenNoteInNewTab = (noteId) => this.openNoteInNewTab(noteId);
    this.aiChatController.onOpenNoteById = (noteId) => this.openNoteById(noteId);
    this.aiChatController.onRefreshNotesList = () => this.refreshNotesList();
    this.aiChatController.onEnsureDailyNote = () => this.ensureDailyNote();
    this.aiChatController.onOpenNewTab = () => this.openNewTab();
    this.aiChatController.onOpenSettingsModal = () => this.openSettingsModal();
    this.aiChatController.onCloseAllModals = () => this.closeAllModals();
    // A title it applies names the note's tab through TabController; the list shows it from the commit feed
    this.aiChatController.noteTabs = this.tabController.noteTabs;
    this.aiChatController.noteList = this.noteList;
    this.aiChatController.onTriggerIndexing = () => this.triggerIndexing();
    this.aiChatController.onLoadEmbeddingsModel = () => {
      if (this.notesManager) this.notesManager.loadEmbeddingsModel();
    };

    this.settingsController = new SettingsController({
      settings: this.settings,
      documentClient: this.documentClient,
      validateBackup: this.validateBackup,
      domRefs: this.domRefs,
      logger: this.logger,
    });

    // Wire callbacks so the controller can trigger App-level actions
    this.settingsController.getEditor = () => this.getEditor();
    this.settingsController.onFlushEditors = () => this.tabController.flushEditorsForImport();
    this.settingsController.onSaveOpenEditors = () => this.tabController.saveOpenEditors();
    this.settingsController.onReloadEditors = (trashedIds, trashedAt) =>
      this.tabController.reloadEditorsAfterImport(trashedIds, trashedAt);
    this.settingsController.onApplyTheme = () => this.applyTheme();
    this.settingsController.onOpenThemeBuilder = () => {
      this.themeBuilderController.openThemeBuilder();
    };
    this.settingsController.onCloseAllModals = () => this.closeAllModals();
    this.settingsController.onRefreshNotesList = () => this.refreshNotesList();
    this.settingsController.onOpenImportedNote = (noteId) => this.tabController.openImportedNote(noteId);
    this.settingsController.removal = this.removal;
    this.settingsController.onRenderAIPromptTemplateSettings = () => {
      this.aiChatController.renderAIPromptTemplateSettings();
    };

    // Settings sync callbacks
    this.settingsController.onSidebarStateChanged = (key, value) => {
      if (key === 'sidebarOpen') {
        // Another tab's open state isn't this sidebar's, which stays as it is, as in 1.4.x
        this.updateSidebarState();
      } else if (key === 'sidebarWidth') {
        this.applySidebarWidth();
      } else if (key === 'sidebarViewMode') {
        this.applySidebarViewMode();
      } else if (key === 'sidebarSortMode') {
        const sortSelect = document.getElementById('sidebar-sort');
        if (sortSelect) sortSelect.value = value;
        this.renderNotesList();
      }
    };
    this.settingsController.onAISidebarWidthChanged = (value) => {
      if (this.aiChatController) {
        this.aiChatController.aiSidebarWidth = value;
      }
      const aiSidebar = document.getElementById('ai-sidebar');
      if (aiSidebar && this.aiChatController.aiSidebarOpen) {
        aiSidebar.style.width = value + 'px';
      }
    };
    this.settingsController.onLLMSettingsChanged = async () => {
      await LLM.init();
      this.updateAISidebarState();
    };
    this.settingsController.onAIPromptTemplatesChanged = (newValue) => {
      this.aiChatController.aiPromptTemplates = this.aiChatController.sanitizeAIPromptTemplates(newValue);
      this.aiChatController.renderAIPromptSuggestions();
      this.aiChatController.renderAIPromptTemplateSettings();
    };

    this.notesManager = new NotesManager({
      // The search index and vectors (#22)
      storage: this.legacyStorage,
      domRefs: this.domRefs,
      logger: this.logger,
      llm: this.ai,
      documentClient: this.documentClient,
      settings: this.settings,
    });
    // Its jobs follow their switches and intervals through the settings port from now on, so
    // one flipped while the later controllers start sets its job up, once
    this.notesManager.followJobSettings();

    // The note list it reads, and tells when the indexer wrote search entries
    this.notesManager.noteList = this.noteList;
    this.notesManager.searchEngine = this.searchEngine;

    // Wire callbacks so the manager can trigger App-level actions
    this.notesManager.onRefreshNotesList = () => this.refreshNotesList();
    this.notesManager.removal = this.removal;
    this.notesManager.onOpenNoteInNewTab = (noteId) => this.openNoteInNewTab(noteId);
    this.notesManager.onCreateFirstNote = () => this.createFirstNote();
    this.notesManager.onUpdateEmptyState = () => this.updateEmptyState();
    this.notesManager.getEditor = () => this.getEditor();
    // A title a job derives names the note's tab through TabController, as AI chat's does
    this.notesManager.noteTabs = this.tabController.noteTabs;

    this.shortcutsManager = new ShortcutsManager({
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
    // The note list and the empty state show the Daily Note once it's there, with no refresh
    this.shortcutsManager.onEnsureDailyNote = () => this.ensureDailyNote();
    this.shortcutsManager.onCycleTab = (dir) => {
      if (this.tabController) this.tabController.cycleTab(dir);
    };
    this.shortcutsManager.onCloseCurrentTab = () => {
      if (this.tabController) return this.tabController.closeCurrentTab();
    };
    this.shortcutsManager.getEditor = () => this.getEditor();
    // The palette marks the notes open in tabs, as TabController has them
    this.shortcutsManager.noteTabs = this.tabController.noteTabs;
    // The palette's Show and Hide labels say what the sidebars show
    this.shortcutsManager.getSidebarOpen = () => this.sidebarController.sidebarOpen;
    this.shortcutsManager.getAISidebarOpen = () => this.aiChatController.aiSidebarOpen;

    this.exportImportService = new ExportImportService({
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

    this.themeBuilderController = new ThemeBuilderController({
      settings: this.settings,
      domRefs: this.domRefs,
      logger: this.logger,
    });

    // Wire callbacks so the controller can trigger App-level actions
    this.themeBuilderController.onApplyTheme = () => this.applyTheme();

    this.analyticsController = new AnalyticsController({
      domRefs: this.domRefs,
      logger: this.logger,
    });

    // Closing Stats puts back the sidebars as they are, however they were opened or closed
    this.analyticsController.onGetSidebarOpen = () => this.sidebarController.sidebarOpen;
    this.analyticsController.onGetAISidebarOpen = () => this.aiChatController.aiSidebarOpen;
  }

  /**
   * Start the SidebarController on the tab's note list
   */
  async initSidebarController() {
    // The note list it renders, once per change
    this.sidebarController.noteList = this.noteList;
    await this.sidebarController.init();
  }

  /**
   * Start the TabController
   */
  async initTabController() {
    await this.tabController.init();
  }

  /**
   * Start the AIChatController
   */
  async initAIChatController() {
    await this.aiChatController.init();
  }

  /**
   * Start the SettingsController
   */
  async initSettingsController() {
    await this.settingsController.init();
  }

  /**
   * Start the ThemeBuilderController, after the theme engine
   */
  async initThemeBuilderController() {
    await this.themeBuilderController.init();
  }

  /**
   * Start the AnalyticsController, after the first render
   */
  async initAnalyticsController() {
    // Analytics counts what the note list lists, and reads blocks through the document client
    this.analyticsController.noteList = this.noteList;
    Analytics.connect({ noteList: this.noteList, getNoteBlocks: (noteId) => this.documentClient.blocksOf(noteId) });
    await this.analyticsController.init();
  }

  async initGraphView() {
    if (typeof GraphView === 'undefined') return;

    this.graphView = new GraphView({
      // The notes and links it draws (#22)
      storage: this.legacyStorage,
      logger: this.logger,
    });

    this.graphView.onOpenNote = (noteId) => this.openNoteInNewTab(noteId);
    // Closing Graph puts back the sidebars as they are, however they were opened or closed
    this.graphView.onGetSidebarOpen = () => this.sidebarController.sidebarOpen;
    this.graphView.onGetAISidebarOpen = () => this.aiChatController.aiSidebarOpen;

    await this.graphView.init();
  }

  /**
   * Initialize the SyncService for cross-device sync (Req 35).
   */
  async initSyncService() {
    if (typeof SyncService === 'undefined') return;

    this.syncService = new SyncService({
      // Sync's settings and data (#19)
      storage: this.legacyStorage,
      logger: this.logger,
    });

    await this.syncService.init();

    // sync.stateChanged has no error text, so the indicator reads the state, errorMessage
    // included, from getState() until #19 replaces both
    this.syncService.onStateChanged(() => {
      this._updateSyncStatusUI(this.syncService.getState());
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
   * Start the NotesManager
   */
  async initNotesManager() {
    await this.notesManager.init();
  }

  /**
   * Start the ShortcutsManager on the tab's note list
   */
  async initShortcutsManager() {
    this.shortcutsManager.noteList = this.noteList;
    await this.shortcutsManager.init();
  }

  /**
   * Start the ExportImportService
   */
  async initExportImportService() {
    await this.exportImportService.init();
  }

  /**
   * Apply sidebar width from settings
   */
  applySidebarWidth() {
    this.sidebarController.applySidebarWidth();
  }

  /**
   * Apply sidebar view mode (list/cards)
   */
  applySidebarViewMode() {
    this.sidebarController.applySidebarViewMode();
  }

  /**
   * Export a note by ID as markdown
   */
  async exportNoteById(noteId) {
    await this.notesManager.exportNoteById(noteId);
  }

  /**
   * Generate title for a note using AI (ignores all configurations)
   */
  async generateTitleForNote(noteId) {
    await this.notesManager.generateTitleForNote(noteId);
  }

  /**
   * Extract insights for a note by ID
   */
  async extractInsightsForNote(noteId) {
    await this.notesManager.extractInsightsForNote(noteId);
  }

  /**
   * Archive a note by ID
   */
  async archiveNote(noteId) {
    await this.notesManager.archiveNote(noteId);
  }

  /**
   * Unarchive a note by ID
   */
  async unarchiveNote(noteId) {
    await this.notesManager.unarchiveNote(noteId);
  }

  /**
   * Move note to trash by ID
   */
  async trashNoteById(noteId) {
    await this.notesManager.trashNoteById(noteId);
  }

  /**
   * Restore note from trash by ID
   */
  async restoreNoteById(noteId) {
    await this.notesManager.restoreNoteById(noteId);
  }

  /**
   * Permanently delete note by ID
   */
  async permanentlyDeleteNoteById(noteId) {
    await this.notesManager.permanentlyDeleteNoteById(noteId);
  }

  /**
   * Convert a note to a template
   */
  async convertNoteToTemplate(noteId) {
    await this.notesManager.convertNoteToTemplate(noteId);
  }

  /**
   * Convert a template back to a note
   */
  async convertTemplateToNote(noteId) {
    await this.notesManager.convertTemplateToNote(noteId);
  }

  /**
   * Update sidebar open/closed state
   */
  updateSidebarState() {
    this.sidebarController.updateSidebarState();
  }

  /**
   * Toggle sidebar open/closed and persist the state
   */
  async toggleSidebar(force) {
    await this.sidebarController.toggleSidebar(force);
  }

  toggleFocusMode(force) {
    this.shortcutsManager.toggleFocusMode(force);
  }

  /**
   * Read the note lists again, after a write made outside the kernel or another tab's change,
   * and show them, as this refresh always did: the sidebar's lists, counts, calendar, and
   * tabs, keeping its virtual scroller, the empty state, and the palette while it's open. With
   * `listsOnly`, as for another tab's change, the lists and counts refresh and the editor
   * area stays as it is. A reload shim until #12 slice 7: a write routed through a command
   * reaches the list from the commit feed instead.
   * @param {{listsOnly?: boolean}} [options]
   * @returns {Promise<void>}
   */
  async refreshNotesList({ listsOnly = false } = {}) {
    await this.sidebarController.reloadLists();

    if (!listsOnly) this.updateEmptyState();
    if (this.shortcutsManager.isCommandPaletteOpen()) this.shortcutsManager.refreshCommandPaletteResults();
  }

  /**
   * Update badge counts for archive and trash tabs
   */
  updateBadgeCounts() {
    this.sidebarController.updateBadgeCounts();
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
   * The navigation port the note editors get in place of window.app (#12 slice 4): what an
   * editor asks of the page around it. See EditorNavigation in js/editor.js.
   * @returns {Object}
   */
  editorNavigation() {
    return {
      titleChanged: (name) => this.updateCurrentTabName(name),
      // The sidebar shows the save once the note list reads it from the commit feed
      noteSaved: (note) => this.triggerIndexing(note.id),
      // A backlink opens its note: 1.4.x called an App.openNote that never existed, so it threw
      openNote: (noteId) => this.openNoteById(noteId),
      openNoteByName: (name) => this.openNoteByName(name),
      noteReplaced: (editor, goneId, note) => this.tabController.noteReplaced(editor, goneId, note),
      // The new tab's, from the PiP window too, since the PiP window closes with it
      reloadPage: () => window.location.reload(),
    };
  }

  /**
   * Render notes list in sidebar (with folders)
   */
  async renderNotesList() {
    await this.sidebarController.renderNotesList();
  }

  /**
   * Switch to a specific tab
   */
  async switchToTab(index) {
    await this.tabController.switchToTab(index);
  }

  /**
   * Open a note in a new tab
   */
  async openNoteInNewTab(noteId) {
    await this.tabController.openNoteInNewTab(noteId);
  }

  /**
   * Open a new tab with a new note
   */
  async openNewTab() {
    await this.tabController.openNewTab();
  }

  /**
   * Update tab name when note title changes
   */
  updateCurrentTabName(name) {
    this.tabController.updateCurrentTabName(name);
  }

  async openSettingsModal() {
    await this.settingsController.openSettingsModal();
  }

  /**
   * Switch between AI chat tabs
   */
  switchAITab(tab) {
    this.aiChatController.switchAITab(tab);
  }

  /**
   * Toggle AI sidebar open/closed
   */
  toggleAISidebar() {
    this.aiChatController.toggleAISidebar();
  }

  /**
   * Close AI sidebar
   */
  closeAISidebar() {
    this.aiChatController.closeAISidebar();
  }

  /**
   * Update AI sidebar state based on LLM configuration
   */
  updateAISidebarState() {
    this.aiChatController.updateAISidebarState();
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
        const noteId = await this.createListedNote({ name });
        if (noteId) await this.openNoteById(noteId);
      }
    }
  }

  /**
   * Open a note by ID (for clicking source tags)
   */
  async openNoteById(noteId) {
    // Check if note is already open in a tab
    const existingTabIndex = this.tabController.noteTabs.openNoteIds().indexOf(noteId);
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
   * Apply theme
   */
  async applyTheme() {
    const { theme } = await this.settings.preferencesOr({ theme: 'system' });
    await Themes.applyTheme(theme);
  }

  /**
   * Import a single note from file (.md, .txt, or .json)
   */
  async importNote(file) {
    await this.notesManager.importNote(file);
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

  /**
   * Get the editor instance for a side
   */
  getEditor(side = null) {
    return this.tabController.getEditor(side);
  }

  /**
   * Rebuild the search index
   */
  async rebuildSearchIndex() {
    await this.notesManager.rebuildSearchIndex();
  }

  /**
   * Toggle the Shortcuts Help modal
   */
  toggleShortcutsModal(force) {
    this.settingsController.toggleShortcutsModal(force);
  }

  /**
   * Close all open modals and menus
   */
  closeAllModals() {
    // Keyboard Shortcuts gives focus back where it was
    if (this.settingsController) this.settingsController.toggleShortcutsModal(false);
    document.querySelectorAll('.modal').forEach(m => m.classList.add('hidden'));
    document.querySelectorAll('.context-menu').forEach(m => m.classList.add('hidden'));

    // Clean up focus traps
    if (this.settingsController) {
      if (this.settingsController._settingsFocusTrapCleanup) { this.settingsController._settingsFocusTrapCleanup(); this.settingsController._settingsFocusTrapCleanup = null; }
      if (this.settingsController._shortcutsFocusTrapCleanup) { this.settingsController._shortcutsFocusTrapCleanup(); this.settingsController._shortcutsFocusTrapCleanup = null; }
    }
    if (this.themeBuilderController && this.themeBuilderController._focusTrapCleanup) { this.themeBuilderController._focusTrapCleanup(); this.themeBuilderController._focusTrapCleanup = null; }
    if (this.shortcutsManager && this.shortcutsManager._commandPaletteFocusTrapCleanup) { this.shortcutsManager._commandPaletteFocusTrapCleanup(); this.shortcutsManager._commandPaletteFocusTrapCleanup = null; }

    // The editors' menus, in both panes: an open one holds the keys pressed outside the note
    for (const editor of [this.editor, this.secondaryEditor]) {
      if (editor) editor.hideMenus();
    }
  }
}

// The new-tab composition root (js/kernel/composition/newtab.js) constructs App with the
// tab's kernel client and starts it once the DOM is ready
/** @type {any} */ (window).App = App;
