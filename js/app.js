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
    this.sidebarViewMode = 'list'; // 'list' or 'cards'
    this.notes = [];
    this.archivedNotes = [];
    this.trashedNotes = [];
    this.templates = []; // NEW: templates list
    this.folders = []; // NEW: folders list
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
    this.aiChatHistory = [];
    // Virtual Scroller
    this.notesScroller = null;
    // Search Indexer
    this.indexerWorker = null;
    this.searchEngine = new SearchEngine();
    // Analytics
    this.statsOpen = false;
    this.charts = {};
    // Multi-select
    this.selectionMode = false;
    this.selectedNoteIds = new Set();
  }

  /**
   * Initialize the application
   */
  async init() {
    try {
      // Initialize storage
      await Storage.init();

      // Initialize LLM service
      await LLM.init();

      // Get notes and folders
      this.notes = await Storage.getAllNotes();
      this.archivedNotes = await Storage.getArchivedNotes();
      this.trashedNotes = await Storage.getTrashedNotes();
      this.templates = await Storage.getTemplates();
      this.folders = await Storage.getAllFolders();

      // Initialize editors
      const editorChangeHandler = Utils.debounce(() => {
        this.updateSmartSuggestions();
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

      // Split view toggle
      const splitViewToggle = document.getElementById('split-view-toggle');
      if (splitViewToggle) {
        splitViewToggle.addEventListener('click', () => this.toggleSplitView());
      }

      // PiP toggle
      const pipToggle = document.getElementById('pip-toggle');
      if (pipToggle) {
        if ('documentPictureInPicture' in window) {
          pipToggle.addEventListener('click', () => {
            const editor = this.getEditor();
            if (editor && editor.noteId) {
              this.openNoteInPiP(editor.noteId);
            }
          });
        } else {
          pipToggle.classList.add('hidden');
        }
      }

      // Pane focus listeners
      document.getElementById('editor-container').addEventListener('click', () => {
        this.setActiveEditorSide('left');
      }, true);
      document.getElementById('secondary-editor-container').addEventListener('click', () => {
        this.setActiveEditorSide('right');
      }, true);

      // Setup UI
      this.setupPageSelector(this.notes);
      this.setupSettings();
      this.setupSidebar();
      await this.setupAI();
      this.setupWidthSelectorPill();
      this.setupTabs();
      this.setupEmptyState();
      this.setupAutoTitle();
      this.setupInsightsExtraction();
      this.applyFont();
      this.applyWidth();
      this.setupShortcuts();

      // Initialize Theme Engine
      await Themes.init();
      this.setupThemeBuilder();

      // Listen for settings changes from other tabs
      this.setupSettingsSync();

      // Check if we have notes to display
      if (this.notes.length === 0 && this.archivedNotes.length === 0) {
        // Create a new untitled note so user can start typing immediately
        await this.createFirstNote();
      } else if (this.notes.length > 0) {
        // Load first note and tabs
        await this.editor.loadNote(this.notes[0].id);
        await this.loadSavedTabs();
      } else {
        // Onboarding for new users
        await this.runOnboarding();
      }

      this.updateEmptyState();
      // Auto-backup check
      this.checkBackupStatus();
      this.updateBadgeCounts();

      // Initialize search indexer
      this.initIndexer();

      // Initialize Embeddings and load Vectors
      await this.initEmbeddings();

      // Setup Stats listeners
      const statsBtn = document.getElementById('sidebar-stats');
      if (statsBtn) {
        statsBtn.addEventListener('click', () => this.toggleStats());
      }
      const statsCloseBtn = document.getElementById('stats-close-btn');
      if (statsCloseBtn) {
        statsCloseBtn.addEventListener('click', () => this.toggleStats());
      }

      console.log('New Tab Note initialized successfully');
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

    // 2. Create Welcome Note
    const note = await Storage.createNote('Welcome to NewTabNote 🚀');

    // Add onboarding blocks
    const blocks = Onboarding.getWelcomeNoteContent();
    for (let i = 0; i < blocks.length; i++) {
      const blockData = blocks[i];
      await Storage.createElement(note.id, blockData.type, blockData.content, i);
    }

    // 3. Mark onboarding as seen
    await Storage.saveSetting('hasCompletedOnboarding', true);

    // 4. Load the note
    await this.refreshNotesList();
    await this.openNoteInNewTab(note.id);

    // 5. Trigger feature highlights after a short delay
    setTimeout(() => this.showFeatureHighlights(), 3000);
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
   * Setup sidebar functionality
   */
  async setupSidebar() {
    const sidebar = document.getElementById('sidebar');
    const toggleBtn = document.getElementById('sidebar-toggle');
    const newNoteBtn = document.getElementById('sidebar-new-note');
    const searchInput = document.getElementById('sidebar-search');
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
    this.sidebarViewMode = await Storage.getSetting('sidebarViewMode', 'list');

    this.updateSidebarState();
    this.applySidebarWidth();
    this.applySidebarViewMode();

    // Toggle sidebar
    toggleBtn.addEventListener('click', async () => {
      this.sidebarOpen = !this.sidebarOpen;
      this.updateSidebarState();
      await Storage.setSetting('sidebarOpen', this.sidebarOpen);
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
        const name = prompt('Folder name:', 'New Folder');
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

    if (!resizeHandle) return;

    let isResizing = false;
    let startX = 0;
    let startWidth = 0;

    resizeHandle.addEventListener('mousedown', (e) => {
      if (e.button !== 0) return;

      isResizing = true;
      startX = e.clientX;
      startWidth = sidebar.offsetWidth;

      sidebar.classList.add('resizing');
      resizeHandle.classList.add('dragging');
      document.body.style.cursor = 'col-resize';
      document.body.style.userSelect = 'none';

      e.preventDefault();
    });

    document.addEventListener('mousemove', (e) => {
      if (!isResizing) return;

      const delta = e.clientX - startX;
      const newWidth = Math.min(500, Math.max(180, startWidth + delta));

      sidebar.style.width = newWidth + 'px';
    });

    document.addEventListener('mouseup', async () => {
      if (!isResizing) return;

      isResizing = false;
      sidebar.classList.remove('resizing');
      resizeHandle.classList.remove('dragging');
      document.body.style.cursor = '';
      document.body.style.userSelect = '';

      // Save the new width
      this.sidebarWidth = sidebar.offsetWidth;
      await Storage.setSetting('sidebarWidth', this.sidebarWidth);
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
    const sidebar = document.getElementById('sidebar');
    if (sidebar && this.sidebarWidth) {
      sidebar.style.width = this.sidebarWidth + 'px';
    }
  }

  /**
   * Apply sidebar view mode (list/cards)
   */
  applySidebarViewMode() {
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

      console.log('Extracting insights for note content length:', content.length);
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
    await Storage.unarchiveNote(noteId);
    await this.refreshNotesList();
    Utils.showToast('Note restored from archive', 'success');
  }

  /**
   * Move note to trash by ID
   */
  async trashNoteById(noteId) {
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
    await Storage.restoreNote(noteId);
    await this.refreshNotesList();
    Utils.showToast('Note restored from trash', 'success');
  }

  /**
   * Permanently delete note by ID
   */
  async permanentlyDeleteNoteById(noteId) {
    if (!confirm('Delete this note permanently? This cannot be undone.')) {
      return;
    }

    await Storage.permanentlyDeleteNote(noteId);
    Utils.showToast('Note permanently deleted', 'success');
  }

  /**
   * Close tab for a specific note if open
   */
  closeTabForNote(noteId) {
    const tabIndex = this.openTabs.findIndex(t => t.noteId === noteId);
    if (tabIndex !== -1) {
      this.closeTab(tabIndex);
    }
  }

  /**
   * Convert a note to a template
   */
  async convertNoteToTemplate(noteId) {
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
    if (this.trashedNotes.length === 0) {
      Utils.showToast('Trash is already empty', 'info');
      return;
    }

    if (!confirm(`Permanently delete ${this.trashedNotes.length} note(s)? This cannot be undone.`)) {
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
        console.log(`Auto-deleted ${deletedCount} expired note(s) from trash`);
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
   * Refresh notes list from storage
   */
  async refreshNotesList() {
    this.notes = await Storage.getAllNotes();
    this.archivedNotes = await Storage.getArchivedNotes();
    this.trashedNotes = await Storage.getTrashedNotes();
    this.templates = await Storage.getTemplates();
    this.folders = await Storage.getAllFolders();
    this.updateBadgeCounts();
    await this.renderNotesList();
    this.renderCalendar();
    this.refreshPageSelector();
    this.updateEmptyState();
    this.updateSidebarTabs();
  }

  /**
   * Update badge counts for archive and trash tabs
   */
  updateBadgeCounts() {
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
  }

  /**
   * Render notes list in sidebar (with folders)
   */
  async renderNotesList() {
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
        this.templates.forEach(note => {
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
    rootNotes.forEach(note => {
      list.appendChild(this.createSidebarNoteItem(note));
    });
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
      const notes = notesInFolders[folder.id] || [];
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

    const name = note.name || 'Untitled';
    const firstLine = note.preview || '';

    el.innerHTML += `
      <div class="sidebar-note-content">
        <div class="sidebar-note-title">${name}</div>
        <div class="sidebar-note-preview">${firstLine}</div>
      </div>
    `;

    // Add back the checkbox click listener since innerHTML clears it
    const newCheckbox = el.querySelector('.sidebar-note-checkbox');
    newCheckbox.addEventListener('click', (e) => {
      e.stopPropagation();
      this.toggleNoteSelection(note.id);
    });

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

  /**
   * Render search results (flat list)
   */
  async renderSearchResults(list) {
    // Sync search index data to SearchEngine
    const searchIndexData = await Storage.getSearchIndex();
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
    const newTabBtn = document.getElementById('new-tab-btn');

    if (newTabBtn) {
      newTabBtn.addEventListener('click', async () => {
        await this.openNewTab();
      });
    }

    // Middle-click on tab bar to open new tab
    const tabsContainer = document.getElementById('note-tabs');
    if (tabsContainer) {
      tabsContainer.addEventListener('auxclick', async (e) => {
        if (e.button === 1 && e.target === tabsContainer) {
          e.preventDefault();
          await this.openNewTab();
        }
      });
    }
  }

  /**
   * Load saved tabs from storage or create initial tab
   */
  async loadSavedTabs() {
    const savedTabs = await Storage.getSetting('openTabs', null);
    const savedActiveIndex = await Storage.getSetting('activeTabIndex', 0);
    this.splitViewEnabled = await Storage.getSetting('splitViewEnabled', false);
    const secondaryNoteId = await Storage.getSetting('secondaryNoteId', null);

    if (savedTabs && savedTabs.length > 0) {
      // Validate that saved tabs still exist
      const validTabs = [];
      for (const tab of savedTabs) {
        const note = await Storage.getNote(tab.noteId);
        if (note) {
          validTabs.push({ noteId: note.id, name: note.name || 'Untitled' });
        }
      }

      if (validTabs.length > 0) {
        this.openTabs = validTabs;
        this.activeTabIndex = Math.min(savedActiveIndex, validTabs.length - 1);
        await this.switchToTab(this.activeTabIndex);

        if (this.splitViewEnabled) {
          // Force toggle to enable UI
          this.splitViewEnabled = false;
          await this.toggleSplitView();
          if (secondaryNoteId) {
            await this.secondaryEditor.loadNote(secondaryNoteId);
          }
        }

        this.renderTabs();
        return;
      }
    }

    // No saved tabs or all invalid - create initial tab with first note
    if (this.notes.length > 0) {
      this.openTabs = [{ noteId: this.notes[0].id, name: this.notes[0].name || 'Untitled' }];
      this.activeTabIndex = 0;
      await this.editor.loadNote(this.notes[0].id);
    }

    if (this.splitViewEnabled) {
      this.splitViewEnabled = false;
      await this.toggleSplitView();
      if (secondaryNoteId) {
        await this.secondaryEditor.loadNote(secondaryNoteId);
      }
    }

    this.renderTabs();
  }

  /**
   * Save tabs to storage
   */
  async saveTabs() {
    await Storage.setSetting('openTabs', this.openTabs);
    await Storage.setSetting('activeTabIndex', this.activeTabIndex);
    await Storage.setSetting('splitViewEnabled', this.splitViewEnabled);
    if (this.secondaryEditor && this.secondaryEditor.noteId) {
      await Storage.setSetting('secondaryNoteId', this.secondaryEditor.noteId);
    }
  }

  /**
   * Render tabs in the header
   */
  renderTabs() {
    const container = document.getElementById('note-tabs');
    if (!container) return;

    container.innerHTML = '';

    this.openTabs.forEach((tab, index) => {
      const tabEl = document.createElement('button');
      tabEl.className = 'note-tab';
      if (index === this.activeTabIndex) {
        tabEl.classList.add('active');
      }
      tabEl.dataset.index = index;

      const nameSpan = document.createElement('span');
      nameSpan.className = 'note-tab-name';
      nameSpan.textContent = tab.name || 'Untitled';
      tabEl.appendChild(nameSpan);

      // Close button (only show if more than one tab)
      if (this.openTabs.length > 1) {
        const closeBtn = document.createElement('span');
        closeBtn.className = 'note-tab-close';
        closeBtn.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <line x1="18" y1="6" x2="6" y2="18"></line>
          <line x1="6" y1="6" x2="18" y2="18"></line>
        </svg>`;
        closeBtn.addEventListener('click', async (e) => {
          e.stopPropagation();
          await this.closeTab(index);
        });
        tabEl.appendChild(closeBtn);
      }

      // Click to switch tab
      tabEl.addEventListener('click', async () => {
        await this.switchToTab(index);
      });

      // Middle-click to close tab
      tabEl.addEventListener('auxclick', async (e) => {
        if (e.button === 1) {
          e.preventDefault();
          await this.closeTab(index);
        }
      });

      container.appendChild(tabEl);
    });
  }

  /**
   * Switch to a specific tab
   */
  async switchToTab(index) {
    if (index < 0 || index >= this.openTabs.length) return;

    this.activeTabIndex = index;
    const tab = this.openTabs[index];

    await this.getEditor().loadNote(tab.noteId);
    this.renderTabs();
    this.renderNotesList();
    await this.saveTabs();
  }

  /**
   * Open a note in a new tab
   */
  async openNoteInNewTab(noteId) {
    const note = await Storage.getNote(noteId);
    if (!note) return;

    // Check if already open
    const existingIndex = this.openTabs.findIndex(t => t.noteId === noteId);
    if (existingIndex !== -1) {
      await this.switchToTab(existingIndex);
      return;
    }

    // Add new tab
    this.openTabs.push({ noteId: note.id, name: note.name || 'Untitled' });
    this.activeTabIndex = this.openTabs.length - 1;

    await this.getEditor().loadNote(noteId);
    this.renderTabs();
    this.renderNotesList();
    await this.saveTabs();
  }

  /**
   * Open a new tab with a new note
   */
  async openNewTab() {
    const note = await Storage.createNote('Untitled');
    await this.refreshNotesList();
    await this.openNoteInNewTab(note.id);
    document.getElementById('page-title').focus();
  }

  /**
   * Close a tab
   */
  async closeTab(index) {
    if (this.openTabs.length <= 1) return; // Don't close last tab

    this.openTabs.splice(index, 1);

    // Adjust active index if needed
    if (this.activeTabIndex >= this.openTabs.length) {
      this.activeTabIndex = this.openTabs.length - 1;
    } else if (this.activeTabIndex > index) {
      this.activeTabIndex--;
    } else if (this.activeTabIndex === index) {
      // Stay at same index (which now points to next tab) or go to previous
      this.activeTabIndex = Math.min(index, this.openTabs.length - 1);
    }

    await this.switchToTab(this.activeTabIndex);
  }

  /**
   * Update tab name when note title changes
   */
  updateCurrentTabName(name) {
    if (this.openTabs[this.activeTabIndex]) {
      this.openTabs[this.activeTabIndex].name = name || 'Untitled';
      this.renderTabs();
      this.saveTabs();
    }
  }

  /**
   * Open note in current tab or new tab based on modifier key
   */
  async openNoteWithModifier(noteId, event) {
    if (event && (event.ctrlKey || event.metaKey)) {
      // Ctrl/Cmd+click opens in new tab
      await this.openNoteInNewTab(noteId);
    } else {
      // Regular click opens in current tab
      const note = await Storage.getNote(noteId);
      if (!note) return;

      this.openTabs[this.activeTabIndex] = { noteId: note.id, name: note.name || 'Untitled' };
      await this.getEditor().loadNote(noteId);
      this.renderTabs();
      this.renderNotesList();
      await this.saveTabs();
    }
  }

  /**
   * Setup settings modal
   */
  setupSettings() {
    const modal = document.getElementById('settings-modal');
    const settingsBtn = document.getElementById('settings-btn');
    if (!modal || !settingsBtn) return;

    const closeBtn = modal.querySelector('.close-btn');

    settingsBtn.addEventListener('click', () => {
      modal.classList.remove('hidden');
      this.updateSettingsUI();
    });

    if (closeBtn) {
      closeBtn.addEventListener('click', () => {
        modal.classList.add('hidden');
      });
    }

    modal.addEventListener('click', (e) => {
      if (e.target === modal) {
        modal.classList.add('hidden');
      }
    });

    // Theme select
    const themeSelect = document.getElementById('theme-select');
    if (themeSelect) {
      themeSelect.addEventListener('change', async (e) => {
        await Storage.setSetting('theme', e.target.value);
        this.applyTheme();
      });
    }

    // Font select
    const fontSelect = document.getElementById('font-select');
    if (fontSelect) {
      fontSelect.addEventListener('change', async (e) => {
        await Storage.setSetting('font', e.target.value);
        this.applyFont();
      });
    }

    // Width select
    const widthSelect = document.getElementById('width-select');
    if (widthSelect) {
      widthSelect.addEventListener('change', async (e) => {
        await Storage.setSetting('width', e.target.value);
        this.applyWidth();
      });
    }

    // Export All
    const exportAllBtn = document.getElementById('export-all-btn');
    if (exportAllBtn) {
      exportAllBtn.addEventListener('click', async () => {
        await this.exportAll();
      });
    }

    // Export Current Note
    const exportCurrentBtn = document.getElementById('export-current-btn');
    if (exportCurrentBtn) {
      exportCurrentBtn.addEventListener('click', async () => {
        await this.exportCurrentNote();
      });
    }

    // Export ZIP
    const exportZipBtn = document.getElementById('export-zip-btn');
    if (exportZipBtn) {
      exportZipBtn.addEventListener('click', async () => {
        await this.exportAllAsMarkdown();
      });
    }

    // Create Backup
    const backupBtn = document.getElementById('backup-btn');
    if (backupBtn) {
      backupBtn.addEventListener('click', async () => {
        await this.createBackup();
      });
    }

    // Import
    const importBtn = document.getElementById('import-btn');
    const importInput = document.getElementById('import-input');
    if (importBtn && importInput) {
      importBtn.addEventListener('click', () => {
        importInput.click();
      });

      importInput.addEventListener('change', async (e) => {
        const file = e.target.files[0];
        if (file) {
          await this.importFromFile(file);
        }
        e.target.value = '';
      });
    }
    // Delete note
    const deletePageBtn = document.getElementById('delete-page-btn');
    if (deletePageBtn) {
      deletePageBtn.addEventListener('click', async () => {
        await this.deleteCurrentNote();
      });
    }

    // Trash retention setting
    const trashRetentionSelect = document.getElementById('trash-retention-select');
    if (trashRetentionSelect) {
      trashRetentionSelect.addEventListener('change', async (e) => {
        await Storage.setSetting('trashRetention', parseInt(e.target.value));
      });
    }

    // Daily Note template
    const dailyNoteTemplateSelect = document.getElementById('daily-note-template-select');
    if (dailyNoteTemplateSelect) {
      dailyNoteTemplateSelect.addEventListener('change', async (e) => {
        await Storage.setSetting('dailyNoteTemplate', e.target.value);
      });
    }

    // Auto Backup settings
    const autoBackupToggle = document.getElementById('auto-backup-toggle');
    if (autoBackupToggle) {
      autoBackupToggle.addEventListener('change', async (e) => {
        await Storage.setSetting('autoBackupEnabled', e.target.checked);
      });
    }

    const backupFrequencySelect = document.getElementById('backup-frequency-select');
    if (backupFrequencySelect) {
      backupFrequencySelect.addEventListener('change', async (e) => {
        await Storage.setSetting('autoBackupFrequency', parseInt(e.target.value));
      });
    }

    // Theme Builder button
    const openThemeBuilderBtn = document.getElementById('open-theme-builder-btn');
    if (openThemeBuilderBtn) {
      openThemeBuilderBtn.addEventListener('click', () => {
        const modal = document.getElementById('settings-modal');
        if (modal) modal.classList.add('hidden');
        this.openThemeBuilder();
      });
    }

    // Help / Shortcuts button
    const shortcutsBtn = document.getElementById('shortcuts-btn');
    if (shortcutsBtn) {
      shortcutsBtn.addEventListener('click', () => {
        this.toggleShortcutsModal();
      });
    }

    const shortcutsModal = document.getElementById('shortcuts-modal');
    if (shortcutsModal) {
      const closeBtn = shortcutsModal.querySelector('.close-btn');
      closeBtn?.addEventListener('click', () => this.toggleShortcutsModal(false));
      shortcutsModal.addEventListener('click', (e) => {
        if (e.target === shortcutsModal) this.toggleShortcutsModal(false);
      });
    }
  }

  /**
   * Update settings UI
   */
  async updateSettingsUI() {
    // Theme
    const themeSelect = document.getElementById('theme-select');
    if (themeSelect) {
      const options = await Themes.getThemeOptions();
      const currentTheme = await Storage.getSetting('theme', 'system');

      themeSelect.innerHTML = '';
      options.forEach(opt => {
        const option = document.createElement('option');
        option.value = opt.id;
        option.textContent = opt.name;
        option.selected = opt.id === currentTheme;
        themeSelect.appendChild(option);
      });
      themeSelect.value = currentTheme;
    }

    // Font
    const font = await Storage.getSetting('font', 'default');
    document.getElementById('font-select').value = font;

    // Width
    const width = await Storage.getSetting('width', 'default');
    document.getElementById('width-select').value = width;

    // LLM settings
    const provider = await Storage.getSetting('llmProvider', 'none');
    const apiKey = await Storage.getSetting('llmApiKey', '');
    const model = await Storage.getSetting('llmModel', '');
    const ollamaUrl = await Storage.getSetting('ollamaUrl', 'http://localhost:11434');

    document.getElementById('llm-provider-select').value = provider;
    document.getElementById('llm-api-key').value = apiKey;

    const ollamaUrlInput = document.getElementById('ollama-url');
    if (ollamaUrlInput) {
      ollamaUrlInput.value = ollamaUrl;
    }

    this.updateLLMSettingsVisibility(provider);
    await this.loadAndPopulateModels(provider, apiKey);

    if (model) {
      const modelSelect = document.getElementById('llm-model-select');
      if (modelSelect) {
        modelSelect.value = model;
      }
    }

    // Auto-title settings
    const autoTitleEnabled = await Storage.getSetting('autoTitleEnabled', false);
    const autoTitleInterval = await Storage.getSetting('autoTitleInterval', 15);

    const autoTitleEnabledCheckbox = document.getElementById('auto-title-enabled');
    const autoTitleIntervalSelect = document.getElementById('auto-title-interval');

    if (autoTitleEnabledCheckbox) {
      autoTitleEnabledCheckbox.checked = autoTitleEnabled;
    }
    if (autoTitleIntervalSelect) {
      autoTitleIntervalSelect.value = autoTitleInterval.toString();
    }

    // Update auto-title interval visibility based on enabled state
    this.updateAutoTitleIntervalVisibility(autoTitleEnabled);

    // Insights extraction settings
    const insightsEnabled = await Storage.getSetting('insightsEnabled', false);
    const insightsInterval = await Storage.getSetting('insightsInterval', 360);

    const insightsEnabledCheckbox = document.getElementById('insights-enabled');
    const insightsIntervalSelect = document.getElementById('insights-interval');

    if (insightsEnabledCheckbox) {
      insightsEnabledCheckbox.checked = insightsEnabled;
    }

    // Auto Backup settings
    const autoBackupEnabled = await Storage.getSetting('autoBackupEnabled', false);
    const autoBackupFrequency = await Storage.getSetting('autoBackupFrequency', 7);

    const autoBackupToggle = document.getElementById('auto-backup-toggle');
    const backupFrequencySelect = document.getElementById('backup-frequency-select');

    if (autoBackupToggle) {
      autoBackupToggle.checked = autoBackupEnabled;
    }
    if (backupFrequencySelect) {
      backupFrequencySelect.value = autoBackupFrequency.toString();
    }
    if (insightsIntervalSelect) {
      insightsIntervalSelect.value = insightsInterval.toString();
    }

    // Update insights interval visibility based on enabled state
    this.updateInsightsIntervalVisibility(insightsEnabled);

    // Trash retention
    const trashRetention = await Storage.getSetting('trashRetention', 30);
    const trashRetentionSelect = document.getElementById('trash-retention-select');
    if (trashRetentionSelect) {
      trashRetentionSelect.value = (await Storage.getSetting('trashRetention', 30)).toString();
    }

    // Daily Note Template
    const dailyNoteTemplateSelect = document.getElementById('daily-note-template-select');
    if (dailyNoteTemplateSelect) {
      const templates = await Storage.getTemplates();
      const currentTemplateId = await Storage.getSetting('dailyNoteTemplate', '');

      dailyNoteTemplateSelect.innerHTML = '<option value="">No template</option>';
      templates.forEach(t => {
        const option = document.createElement('option');
        option.value = t.id;
        option.textContent = t.name;
        option.selected = t.id === currentTemplateId;
        dailyNoteTemplateSelect.appendChild(option);
      });
    }
    // Notes list
    await this.updateNotesList();
  }

  /**
   * Update notes list in settings
   */
  async updateNotesList() {
    const list = document.getElementById('pages-list');
    const notes = await Storage.getAllNotes();

    list.innerHTML = '';

    notes.forEach((note) => {
      const item = document.createElement('div');
      item.className = 'page-item';
      if (note.id === this.editor.noteId) {
        item.classList.add('active');
      }

      item.innerHTML = `
        <span class="page-item-name">${note.name || 'Untitled'}</span>
        <span class="page-item-date">${Utils.formatDate(note.updatedAt)}</span>
      `;

      item.addEventListener('click', async () => {
        await this.editor.loadNote(note.id);
        await this.refreshNotesList();
        document.getElementById('settings-modal').classList.add('hidden');
      });

      list.appendChild(item);
    });
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

    // Suggestion buttons (welcome area)
    document.querySelectorAll('.ai-suggestion-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const action = btn.dataset.action;
        if (action === 'extract-insights') {
          this.extractInsightsFromChat();
          return;
        }
        const prompt = btn.dataset.prompt;
        if (prompt) {
          chatInput.value = prompt;
          this.sendAIChatMessage();
        }
      });
    });

    // Sticky suggestion buttons
    document.querySelectorAll('.ai-sticky-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const action = btn.dataset.action;
        if (action === 'extract-insights') {
          this.extractInsightsFromChat();
          return;
        }
        const prompt = btn.dataset.prompt;
        if (prompt) {
          chatInput.value = prompt;
          this.sendAIChatMessage();
        }
      });
    });

    // Open settings from sidebar
    settingsBtn?.addEventListener('click', () => {
      document.getElementById('settings-modal').classList.remove('hidden');
      this.updateSettingsUI();
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

    // Update visibility based on LLM configuration
    this.updateAISidebarState();
  }

  /**
   * Switch between AI chat tabs
   */
  switchAITab(tab) {
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

    if (!resizeHandle) return;

    let isResizing = false;
    let startX = 0;
    let startWidth = 0;

    resizeHandle.addEventListener('mousedown', (e) => {
      if (e.button !== 0) return;

      isResizing = true;
      startX = e.clientX;
      startWidth = sidebar.offsetWidth;

      sidebar.classList.add('resizing');
      resizeHandle.classList.add('dragging');
      document.body.style.cursor = 'col-resize';
      document.body.style.userSelect = 'none';

      e.preventDefault();
    });

    document.addEventListener('mousemove', (e) => {
      if (!isResizing) return;

      const delta = startX - e.clientX;
      const newWidth = Math.min(600, Math.max(280, startWidth + delta));

      sidebar.style.width = newWidth + 'px';
    });

    document.addEventListener('mouseup', async () => {
      if (!isResizing) return;

      isResizing = false;
      sidebar.classList.remove('resizing');
      resizeHandle.classList.remove('dragging');
      document.body.style.cursor = '';
      document.body.style.userSelect = '';

      this.aiSidebarWidth = sidebar.offsetWidth;
      await Storage.setSetting('aiSidebarWidth', this.aiSidebarWidth);
    });
  }

  /**
   * Toggle AI sidebar open/closed
   */
  toggleAISidebar() {
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

    // Suggestion buttons
    document.querySelectorAll('.global-chat-suggestion').forEach(btn => {
      btn.addEventListener('click', () => {
        const prompt = btn.dataset.prompt;
        if (prompt) {
          chatInput.value = prompt;
          if (prompt.endsWith('...')) {
            chatInput.focus();
          } else {
            this.sendGlobalChatMessage();
          }
        }
      });
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
      contentEl.innerHTML = Utils.parseMarkdown(content);
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
          <span>${note.title}</span>
        `;
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
      newNoteBtn.addEventListener('click', () => this.createNoteFromAIResponse(content));
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
    const dashboard = document.getElementById('stats-dashboard');
    const main = document.querySelector('main');
    const sidebar = document.getElementById('sidebar');
    const aiSidebar = document.getElementById('ai-sidebar');

    if (this.statsOpen) {
      // Closing stats
      dashboard.classList.add('hidden');
      dashboard.classList.remove('active');
      main.classList.remove('hidden');
      if (this.sidebarOpen) sidebar.classList.remove('hidden');
      if (this.aiSidebarOpen) aiSidebar.classList.remove('hidden');
      this.statsOpen = false;
    } else {
      // Opening stats
      this.statsOpen = true;
      dashboard.classList.remove('hidden');
      setTimeout(() => dashboard.classList.add('active'), 10);
      main.classList.add('hidden');
      sidebar.classList.add('hidden');
      aiSidebar.classList.add('hidden');

      await this.renderAnalytics();
    }
  }

  /**
   * Render analytics charts and stats
   */
  async renderAnalytics() {
    if (typeof Analytics === 'undefined') return;

    // Show loading state or refresh counts
    const stats = await Analytics.getGlobalStats();
    document.getElementById('stat-total-notes').textContent = stats.totalNotes;
    document.getElementById('stat-total-words').textContent = stats.totalWords.toLocaleString();

    const dailyNotes = this.notes.filter(n => n.name && /^\d{4}-\d{2}-\d{2}$/.test(n.name));
    document.getElementById('stat-daily-notes').textContent = dailyNotes.length;

    const allText = this.notes.map(n => n.name).join(' ');
    const tags = Analytics.extractTags(allText); // Just a rough count for now
    document.getElementById('stat-active-tags').textContent = tags.length;

    // Destroy existing charts to prevent memory leaks/overlap
    Object.values(this.charts).forEach(chart => chart.destroy());

    // 1. Activity Chart
    const activityData = await Analytics.getActivityData(30);
    this.charts.activity = new Chart(document.getElementById('activity-chart'), {
      type: 'line',
      data: {
        labels: activityData.map(d => d.date),
        datasets: [{
          label: 'Updates',
          data: activityData.map(d => d.updated),
          borderColor: '#4d9eff',
          backgroundColor: 'rgba(77, 158, 255, 0.1)',
          fill: true,
          tension: 0.4
        }, {
          label: 'Created',
          data: activityData.map(d => d.created),
          borderColor: '#8e44ad',
          backgroundColor: 'rgba(142, 68, 173, 0.1)',
          fill: true,
          tension: 0.4
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: { legend: { display: true, position: 'bottom' } },
        scales: { y: { beginAtZero: true, ticks: { precision: 0 } } }
      }
    });

    // 2. Content Type Chart
    const typeBreakdown = await Analytics.getContentTypeBreakdown();
    this.charts.type = new Chart(document.getElementById('content-chart'), {
      type: 'doughnut',
      data: {
        labels: Object.keys(typeBreakdown),
        datasets: [{
          data: Object.values(typeBreakdown),
          backgroundColor: ['#4d9eff', '#27ae60', '#f1c40f', '#e67e22', '#e74c3c', '#95a5a6', '#34495e']
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: { legend: { position: 'right' } }
      }
    });

    // 3. Tags Chart
    const topTags = await Analytics.getTagDistribution();
    this.charts.tags = new Chart(document.getElementById('tags-chart'), {
      type: 'bar',
      data: {
        labels: topTags.map(t => t[0]),
        datasets: [{
          label: 'Usage Count',
          data: topTags.map(t => t[1]),
          backgroundColor: '#4d9eff'
        }]
      },
      options: {
        indexAxis: 'y',
        responsive: true,
        maintainAspectRatio: false,
        plugins: { legend: { display: false } }
      }
    });

    // 4. Folders Chart
    const folderStats = this.folders.map(f => ({
      name: f.name,
      count: this.notes.filter(n => n.folderId === f.id).length
    })).sort((a, b) => b.count - a.count).slice(0, 7);

    this.charts.folders = new Chart(document.getElementById('folders-chart'), {
      type: 'polarArea',
      data: {
        labels: folderStats.map(f => f.name),
        datasets: [{
          data: folderStats.map(f => f.count),
          backgroundColor: ['rgba(77, 158, 255, 0.6)', 'rgba(46, 204, 113, 0.6)', 'rgba(231, 76, 60, 0.6)', 'rgba(241, 196, 15, 0.6)']
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: { legend: { position: 'right' } }
      }
    });
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
      if (confirm(`Note "${name}" does not exist. Create it?`)) {
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
    const existingTab = this.openTabs.find(t => t.noteId === noteId);
    if (existingTab) {
      await this.switchToTab(noteId);
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
      contentEl.innerHTML = Utils.parseMarkdown(content);
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
      appendBtn.addEventListener('click', () => this.appendAIResponseToNote(content));
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
      newNoteBtn.addEventListener('click', () => this.createNoteFromAIResponse(content));
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
  async appendAIResponseToNote(content) {
    if (!this.editor || !this.editor.noteId) {
      Utils.showToast('No note is currently open', 'error');
      return;
    }

    try {
      // Create a new text block with the AI content
      const block = {
        id: Utils.generateId(),
        canvasId: this.editor.noteId,
        type: 'text',
        content: content,
        order: await this.editor.getNextBlockOrder(),
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };

      await Storage.saveElement(block);

      // Reload the note to show the new block
      await this.editor.loadNote(this.editor.noteId);

      Utils.showToast('Content added to note', 'success');
    } catch (error) {
      console.error('Failed to append content:', error);
      Utils.showToast('Failed to add content', 'error');
    }
  }

  /**
   * Create a new note from AI response content
   */
  async createNoteFromAIResponse(content) {
    try {
      // Create a new note with temporary title
      const note = await Storage.createNote('AI Generated');

      // Create a text block with the content
      const block = {
        id: Utils.generateId(),
        canvasId: note.id,
        type: 'text',
        content: content,
        order: 0,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };

      await Storage.saveElement(block);

      // Refresh and open the new note
      await this.refreshNotesList();
      await this.openNoteInNewTab(note.id);

      Utils.showToast('New note created', 'success');

      // Async generate title if LLM is configured (don't block UI)
      if (LLM.isConfigured()) {
        this.generateTitleForNewNote(note.id, content);
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
  handleGeneratedTitle(response) {
    // Clean up the response - take first line, remove quotes
    let title = response.split('\n')[0].trim();
    title = title.replace(/^["']|["']$/g, '').trim();

    if (title && title.length < 100) {
      // Ask user if they want to apply the title
      const apply = confirm(`Apply this title to your note?\n\n"${title}"`);
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
    const apiKeyRow = document.querySelector('.llm-api-key-row');
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
      apiKeyRow.classList.add('hidden');
      modelRow.classList.add('hidden');
      if (ollamaUrlRow) ollamaUrlRow.classList.add('hidden');
    } else if (isOllama) {
      apiKeyRow.classList.add('hidden');
      modelRow.classList.remove('hidden');
      if (ollamaUrlRow) ollamaUrlRow.classList.remove('hidden');
    } else {
      apiKeyRow.classList.remove('hidden');
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
    const font = await Storage.getSetting('font', 'default');
    document.documentElement.dataset.font = font;
  }

  /**
   * Apply editor width
   */
  async applyWidth() {
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
    const modal = document.getElementById('theme-builder-modal');
    if (!modal) return;

    const closeBtn = modal.querySelector('.close-btn');
    const cancelBtn = document.getElementById('theme-builder-cancel');
    const saveBtn = document.getElementById('theme-builder-save');
    const nameInput = document.getElementById('theme-builder-name');

    if (closeBtn) {
      closeBtn.addEventListener('click', () => {
        modal.classList.add('hidden');
        this.applyTheme(); // Reset preview
      });
    }

    if (cancelBtn) {
      cancelBtn.addEventListener('click', () => {
        modal.classList.add('hidden');
        this.applyTheme(); // Reset preview
      });
    }

    if (saveBtn) {
      saveBtn.addEventListener('click', async () => {
        const name = (nameInput && nameInput.value.trim()) || 'Custom Theme';
        const theme = {
          name: name,
          properties: this.tempThemeProperties
        };
        const savedTheme = await Storage.saveCustomTheme(theme);
        await Storage.setSetting('theme', savedTheme.id);
        await this.applyTheme();
        modal.classList.add('hidden');
        Utils.showToast('Theme saved!', 'success');
      });
    }
  }

  /**
   * Open Theme Builder modal
   */
  async openThemeBuilder() {
    const modal = document.getElementById('theme-builder-modal');
    const controls = document.getElementById('theme-color-controls');
    const nameInput = document.getElementById('theme-builder-name');

    if (!modal || !controls) return;

    modal.classList.remove('hidden');
    controls.innerHTML = '';

    // Start with current properties
    const currentThemeId = await Storage.getSetting('theme', 'light');
    const options = await Themes.getThemeOptions();
    const currentTheme = options.find(o => o.id === currentThemeId);

    // Determine base properties to start from
    let baseProps = { ...Themes.defaultProperties };
    if (currentThemeId === 'dark' || (currentThemeId === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches)) {
      baseProps = { ...Themes.darkProperties };
    }

    // If current is custom, use its name and props
    if (currentTheme && currentTheme.isCustom) {
      const allCustom = await Storage.getCustomThemes();
      const fullTheme = allCustom.find(t => t.id === currentThemeId);
      if (fullTheme) {
        baseProps = { ...fullTheme.properties };
        if (nameInput) nameInput.value = fullTheme.name;
      }
    } else {
      if (nameInput) nameInput.value = '';
    }

    this.tempThemeProperties = { ...baseProps };

    // Create color pickers for each property
    for (const [prop, value] of Object.entries(this.tempThemeProperties)) {
      // Create control row
      const row = document.createElement('div');
      row.className = 'setting-row';

      const label = document.createElement('label');
      // Humanize label: --bg-primary -> Background Primary
      label.textContent = prop.replace('--', '').split('-').map(word => word.charAt(0).toUpperCase() + word.slice(1)).join(' ');

      const picker = document.createElement('input');
      picker.type = 'color';
      picker.value = this.colorToHex(value);

      picker.addEventListener('input', (e) => {
        this.tempThemeProperties[prop] = e.target.value;
        Themes.injectProperties(this.tempThemeProperties); // Live preview
      });

      row.appendChild(label);
      row.appendChild(picker);
      controls.appendChild(row);
    }
  }

  /**
   * Helper to convert various color formats to hex for <input type="color">
   */
  colorToHex(color) {
    if (!color) return '#000000';
    if (color.startsWith('#')) return color.substring(0, 7);
    if (color.startsWith('rgba') || color.startsWith('rgb')) {
      const parts = color.match(/[\d.]+/g);
      if (parts && parts.length >= 3) {
        const r = parseInt(parts[0]);
        const g = parseInt(parts[1]);
        const b = parseInt(parts[2]);
        return "#" + ((1 << 24) + (r << 16) + (g << 8) + b).toString(16).slice(1);
      }
    }
    return '#000000';
  }

  /**
   * Setup cross-tab settings synchronization
   * Listens for settings changes from other tabs and applies them
   */
  setupSettingsSync() {
    Storage.onSettingsChange(async (changes) => {
      // Apply theme changes
      if (changes.theme) {
        await this.applyTheme();
      }

      // Apply font changes
      if (changes.font) {
        await this.applyFont();
      }

      // Apply width changes
      if (changes.width) {
        await this.applyWidth();
      }

      // Apply sidebar state changes
      if (changes.sidebarOpen !== undefined) {
        this.sidebarOpen = changes.sidebarOpen.newValue;
        this.updateSidebarState();
      }

      if (changes.sidebarWidth) {
        this.sidebarWidth = changes.sidebarWidth.newValue;
        this.applySidebarWidth();
      }

      if (changes.sidebarViewMode) {
        this.sidebarViewMode = changes.sidebarViewMode.newValue;
        this.applySidebarViewMode();
      }

      // Apply AI sidebar width changes
      if (changes.aiSidebarWidth) {
        this.aiSidebarWidth = changes.aiSidebarWidth.newValue;
        const aiSidebar = document.getElementById('ai-sidebar');
        if (aiSidebar && this.aiSidebarOpen) {
          aiSidebar.style.width = this.aiSidebarWidth + 'px';
        }
      }

      // Reinitialize LLM if provider settings changed
      if (changes.llmProvider || changes.llmApiKey || changes.llmModel || changes.ollamaUrl) {
        await LLM.init();
        this.updateAISidebarState();
      }

      // Update auto-title settings
      if (changes.autoTitleEnabled !== undefined || changes.autoTitleInterval) {
        this.setupAutoTitle();
      }

      // Update insights settings
      if (changes.insightsEnabled !== undefined || changes.insightsInterval) {
        this.setupInsightsExtraction();
      }
    });
  }

  /**
   * Setup header width selector
   */
  setupWidthSelectorPill() {
    const widthSelector = document.getElementById('width-selector-header');
    if (!widthSelector) return;

    widthSelector.addEventListener('click', async (e) => {
      const btn = e.target.closest('.width-option');
      if (!btn) return;

      const width = btn.dataset.width;
      await Storage.setSetting('width', width);
      this.applyWidth();

      // Also update the settings modal select if it's open
      const widthSelect = document.getElementById('width-select');
      if (widthSelect) {
        widthSelect.value = width;
      }
    });
  }

  /**
   * Update width selector active state
   */
  updateWidthSelectorPill(width) {
    const widthSelector = document.getElementById('width-selector-header');
    if (!widthSelector) return;

    widthSelector.querySelectorAll('.width-option').forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.width === width);
    });
  }

  /**
   * Delete current note
   */
  async deleteCurrentNote() {
    if (!confirm('Move this note to trash?')) {
      return;
    }

    const currentId = this.editor.noteId;
    await Storage.deleteNote(currentId);
    await this.closeTabForNote(currentId);
    await this.refreshNotesList();
    await this.handleNoteRemoved(currentId);

    // Close settings modal
    document.getElementById('settings-modal').classList.add('hidden');

    Utils.showToast('Note moved to trash', 'success');
  }

  /**
   * Export all data
   */
  async exportAll() {
    try {
      const data = await Storage.exportAll();
      const json = JSON.stringify(data, null, 2);
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      Utils.downloadFile(json, `new-tab-note-export-${timestamp}.json`);
      Utils.showToast('All notes exported as JSON', 'success');
      await Storage.setSetting('lastBackupAt', Date.now());
    } catch (error) {
      console.error('Export failed:', error);
      Utils.showToast('Export failed', 'error');
    }
  }

  /**
   * Export all notes as a ZIP file containing Markdown files
   */
  async exportAllAsMarkdown() {
    try {
      const zip = new JSZip();
      const folder = zip.folder("NewTabNote-Export");

      const notes = await Storage.getAllNotes();

      for (const note of notes) {
        if (note.isTrash) continue;

        const blocks = await Storage.getElementsByNote(note.id);
        const sortedBlocks = blocks.sort((a, b) => (a.order || 0) - (b.order || 0));

        let markdown = `# ${note.name || 'Untitled'}\n\n`;
        for (const block of sortedBlocks) {
          markdown += this.blockToMarkdown(block);
        }

        const safeName = (note.name || 'Untitled')
          .replace(/[^a-z0-9\s-]/gi, '')
          .replace(/\s+/g, '-')
          .toLowerCase() || 'note-' + note.id;

        folder.file(`${safeName}.md`, markdown);
      }

      const content = await zip.generateAsync({ type: "blob" });
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const filename = `new-tab-note-markdown-${timestamp}.zip`;

      const url = URL.createObjectURL(content);
      const link = document.createElement('a');
      link.href = url;
      link.download = filename;
      link.click();
      URL.revokeObjectURL(url);

      Utils.showToast('All notes exported as ZIP', 'success');
      await Storage.setSetting('lastBackupAt', Date.now());
    } catch (error) {
      console.error('ZIP export failed:', error);
      Utils.showToast('Export failed', 'error');
    }
  }

  /**
   * Export current note only
   */
  async exportCurrentNote() {
    try {
      if (!this.editor.noteId) {
        Utils.showToast('No note selected', 'error');
        return;
      }

      const note = await Storage.getNote(this.editor.noteId);
      const blocks = await Storage.getElementsByNote(this.editor.noteId);

      const data = {
        version: 1,
        exportType: 'single-note',
        exportedAt: new Date().toISOString(),
        note: note,
        blocks: blocks,
      };

      const json = JSON.stringify(data, null, 2);
      const noteName = (note.name || 'Untitled').replace(/[^a-z0-9]/gi, '-').toLowerCase();
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      Utils.downloadFile(json, `new-tab-note-note-${noteName}-${timestamp}.json`);
      Utils.showToast('Note exported', 'success');
    } catch (error) {
      console.error('Export current note failed:', error);
      Utils.showToast('Export failed', 'error');
    }
  }

  /**
   * Create timestamped backup of all data
   */
  async createBackup() {
    try {
      const data = await Storage.exportAll();

      // Add backup metadata
      data.backupType = 'full-backup';
      data.backupCreatedAt = new Date().toISOString();
      data.backupVersion = 1;

      const json = JSON.stringify(data, null, 2);
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      Utils.downloadFile(json, `new-tab-note-backup-${timestamp}.json`);
      Utils.showToast('Backup created', 'success');
    } catch (error) {
      console.error('Backup failed:', error);
      Utils.showToast('Backup failed', 'error');
    }
  }

  /**
   * Import from file
   */
  async importFromFile(file) {
    try {
      const text = await Utils.readFileAsText(file);
      const data = JSON.parse(text);

      if (!data.version || !data.canvases) {
        throw new Error('Invalid backup file');
      }

      const merge = confirm(
        'Merge with existing data?\n\nOK = Merge\nCancel = Replace all'
      );

      await Storage.importData(data, merge);

      Utils.showToast('Import complete', 'success');

      // Reload
      const notes = await Storage.getAllNotes();
      await this.editor.loadNote(notes[0].id);
      await this.refreshNotesList();
    } catch (error) {
      console.error('Import failed:', error);
      Utils.showToast('Import failed: ' + error.message, 'error');
    }
  }

  /**
   * Import a single note from file (.md, .txt, or .json)
   */
  async importNote(file) {
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
    document.getElementById('app').innerHTML = `
      <div style="display: flex; flex-direction: column; align-items: center; justify-content: center; height: 100vh; color: #666;">
        <h2>Failed to initialize</h2>
        <p>${error.message}</p>
        <button onclick="location.reload()" style="margin-top: 20px; padding: 10px 20px; cursor: pointer;">Reload</button>
      </div>
    `;
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
      console.log('Missed auto-title window, running catch-up');
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

    console.log(`Auto-title started with ${intervalMinutes} minute interval`);
  }

  /**
   * Stop the auto-title interval
   */
  stopAutoTitleInterval() {
    if (this.autoTitleIntervalId) {
      clearInterval(this.autoTitleIntervalId);
      this.autoTitleIntervalId = null;
      console.log('Auto-title stopped');
    }
  }

  /**
   * Run auto-title generation for eligible notes
   */
  async runAutoTitle(isCatchUp = false) {
    // Prevent concurrent runs
    if (this.autoTitleRunning) {
      console.log('Auto-title already running, skipping');
      return;
    }

    // Check if LLM is configured
    if (!LLM.isConfigured()) {
      console.log('LLM not configured, skipping auto-title');
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
          console.log(`Generating title for note: ${note.id}`);

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

            console.log(`Auto-title generated: "${newTitle}" for note ${note.id}`);
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
      console.log('Missed insights extraction window, running catch-up');
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

    console.log(`Insights extraction started with ${intervalMinutes} minute interval`);
  }

  /**
   * Stop the insights extraction interval
   */
  stopInsightsInterval() {
    if (this.insightsIntervalId) {
      clearInterval(this.insightsIntervalId);
      this.insightsIntervalId = null;
      console.log('Insights extraction stopped');
    }
  }

  /**
   * Run insights extraction for all notes
   */
  async runInsightsExtraction(isCatchUp = false) {
    // Prevent concurrent runs
    if (this.insightsRunning) {
      console.log('Insights extraction already running, skipping');
      return;
    }

    // Check if LLM is configured
    if (!LLM.isConfigured()) {
      console.log('LLM not configured, skipping insights extraction');
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
          console.log(`Extracting insights for note: ${note.id} (${note.name || 'Untitled'})`);

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
            console.log(`Insights extracted for note: ${note.name || 'Untitled'}`);
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
        console.log(`Insights extraction complete: ${extractedCount} note(s) updated`);
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
    const menu = document.createElement('div');
    menu.className = 'context-menu';
    menu.style.left = `${e.pageX}px`;
    menu.style.top = `${e.pageY}px`;

    const items = [
      {
        label: 'Rename',
        icon: 'pencil',
        action: async () => {
          const newName = prompt('New folder name:', folder.name);
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
          if (confirm(`Are you sure you want to delete "${folder.name}"? Notes inside will be moved to root.`)) {
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
    this.splitViewEnabled = !this.splitViewEnabled;
    const workspace = document.getElementById('workspace-container');
    const secondaryPane = document.getElementById('secondary-editor-container');
    const splitBtn = document.getElementById('split-view-toggle');

    if (this.splitViewEnabled) {
      workspace.classList.add('split-mode');
      secondaryPane.classList.remove('hidden');
      splitBtn.classList.add('active');

      // If secondary editor has no note, load a blank one or last open
      if (!this.secondaryEditor.noteId) {
        // Find a note that's not open in the primary editor
        const otherNote = this.notes.find(n => n.id !== this.editor.noteId);
        if (otherNote) {
          await this.secondaryEditor.loadNote(otherNote.id);
        }
      }
    } else {
      workspace.classList.remove('split-mode');
      secondaryPane.classList.add('hidden');
      splitBtn.classList.remove('active');
      this.setActiveEditorSide('left');
    }

    // Resize observers/centering update
    if (this.editor) this.editor.updateWideContentCentering();
    if (this.secondaryEditor) this.secondaryEditor.updateWideContentCentering();
  }

  /**
   * Set the active editor side
   */
  setActiveEditorSide(side) {
    if (this.activeEditorSide === side) return;

    this.activeEditorSide = side;

    const leftPane = document.getElementById('editor-container');
    const rightPane = document.getElementById('secondary-editor-container');

    if (side === 'left') {
      leftPane.classList.add('active');
      rightPane.classList.remove('active');
    } else {
      rightPane.classList.add('active');
      leftPane.classList.remove('active');
    }
  }

  /**
   * Get the editor instance for a side
   */
  getEditor(side = null) {
    const targetSide = side || this.activeEditorSide;
    return targetSide === 'left' ? this.editor : this.secondaryEditor;
  }

  /**
   * Open the current note in a Document Picture-in-Picture window
   */
  async openNoteInPiP(noteId) {
    if (!('documentPictureInPicture' in window)) {
      console.error('Document Picture-in-Picture API not supported');
      return;
    }

    // Close existing PiP if any
    if (this.pipWindow) {
      this.pipWindow.close();
    }

    try {
      // Request a PiP window
      this.pipWindow = await documentPictureInPicture.requestWindow({
        width: 500,
        height: 600,
      });

      // Copy stylesheets to the PiP window
      [...document.styleSheets].forEach((styleSheet) => {
        try {
          if (styleSheet.href) {
            const link = document.createElement('link');
            link.rel = 'stylesheet';
            link.href = styleSheet.href;
            this.pipWindow.document.head.appendChild(link);
          } else {
            const style = document.createElement('style');
            for (const rule of styleSheet.cssRules) {
              style.appendChild(document.createTextNode(rule.cssText));
            }
            this.pipWindow.document.head.appendChild(style);
          }
        } catch (e) {
          console.error('Could not copy stylesheet to PiP window:', e);
        }
      });

      // Add common styles
      const customStyle = document.createElement('style');
      customStyle.textContent = `
        body { margin: 0; padding: 0; background: var(--bg-primary); color: var(--text-primary); }
        .pip-editor-wrapper { height: 100vh; overflow-y: auto; padding: 20px; }
        /* Hide UI elements that don't make sense in PiP */
        .slash-menu { z-index: 2000; }
      `;
      this.pipWindow.document.head.appendChild(customStyle);

      // Create editor structure
      const wrapper = document.createElement('div');
      wrapper.className = 'pip-editor-wrapper editor-pane active';
      wrapper.id = 'pip-editor-container';
      wrapper.innerHTML = `
        <div class="editor">
          <div class="page-title" contenteditable="true" data-placeholder="Untitled" spellcheck="false"></div>
          <div class="page-timestamp"></div>
          <div class="blocks-container"></div>
          <div class="add-block-hint">
            <span>Press Enter to add a new block, or type / for commands</span>
          </div>
          
          <div class="backlinks-panel hidden">
            <div class="backlinks-header"><span>Backlinks</span></div>
            <div class="backlinks-list"></div>
          </div>

          <div class="slash-menu hidden">
            <div class="slash-menu-header">Basic blocks</div>
            <div class="slash-menu-items"></div>
          </div>

          <div class="wiki-menu slash-menu hidden">
            <div class="slash-menu-header">Link to note</div>
            <div class="slash-menu-items"></div>
          </div>

          <div class="template-menu slash-menu hidden">
            <div class="slash-menu-header">Insert template</div>
            <div class="slash-menu-items"></div>
          </div>
        </div>
      `;
      this.pipWindow.document.body.appendChild(wrapper);

      // Copy theme properties from main document
      this.pipWindow.document.documentElement.style.cssText = document.documentElement.style.cssText;
      this.pipWindow.document.documentElement.className = document.documentElement.className;

      // Initialize editor in PiP window
      this.pipEditor = new BlockEditor({
        root: wrapper
      });

      await this.pipEditor.loadNote(noteId);

      // Handle PiP window closing
      this.pipWindow.addEventListener('pagehide', () => {
        this.pipWindow = null;
        this.pipEditor = null;
      });

    } catch (e) {
      console.error('Failed to open PiP window:', e);
    }
  }

  /**
   * Initialize embeddings and load existing vectors
   */
  async initEmbeddings() {
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
    if (typeof Worker === 'undefined') return;
    try {
      this.indexerWorker = new Worker('js/workers/indexer.js');
      this.indexerWorker.onmessage = async (e) => {
        if (e.data.type === 'INDEX_COMPLETE') {
          await Storage.setSearchIndex(e.data.data);
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

    console.log(`Embeddings: Found ${notesToEmbed.length} notes needing updates`);

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
    console.log('Embeddings: Background indexing complete');
  }

  /**
   * Proactively update smart suggestions based on current note content
   */
  async updateSmartSuggestions(force = false) {
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
          console.log('Using stored insights from note');
        }
      }
      
      // 3. Only extract new insights if we don't have valid stored ones
      if (!insights) {
        console.log('Extracting new insights via LLM');
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
          el.innerHTML = `
            <div class="ai-action-icon">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                ${item.icon === 'check-square' ? '<rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect><polyline points="9 11 12 14 22 4"></polyline>' :
              item.icon === 'calendar' ? '<rect x="3" y="4" width="18" height="18" rx="2" ry="2"></rect><line x1="16" y1="2" x2="16" y2="6"></line><line x1="8" y1="2" x2="8" y2="6"></line><line x1="3" y1="10" x2="21" y2="10"></line>' :
                '<path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"></path><path d="M13.73 21a2 2 0 0 1-3.46 0"></path>'}
              </svg>
            </div>
            <span>${item.text}</span>
          `;
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
            <span class="ai-related-title">${note?.name || 'Untitled'}</span>
          `;
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
    const enabled = await Storage.getSetting('autoBackupEnabled', false);
    if (!enabled) return;

    const frequency = await Storage.getSetting('autoBackupFrequency', 7);
    const lastBackup = await Storage.getSetting('lastBackupAt', 0);
    const now = Date.now();
    const daysSinceBackup = (now - lastBackup) / (1000 * 60 * 60 * 24);

    if (daysSinceBackup >= frequency) {
      Utils.showToast('Backup Reminder: It has been a while since your last backup! Click to Export.', 'info', 10000, () => {
        document.getElementById('settings-btn').click();
        // Wait for modal to open
        setTimeout(() => {
          document.getElementById('export-zip-btn')?.classList.add('feature-highlight-pulse');
        }, 500);
      });
    }
  }

  /**
   * Setup global keyboard shortcuts
   */
  setupShortcuts() {
    this.updateShortcutLabels();

    window.addEventListener('keydown', (e) => {
      // Don't trigger if user is typing in an input/textarea (except specific modifiers)
      const isInput = e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.getAttribute('contenteditable') === 'true';

      const modKey = (navigator.platform.toUpperCase().indexOf('MAC') >= 0) ? e.metaKey : e.ctrlKey;
      const altKey = e.altKey;

      // ? for help (only if not in input)
      if (e.key === '?' && !isInput) {
        e.preventDefault();
        this.toggleShortcutsModal();
        return;
      }

      // Esc to close all modals/menus
      if (e.key === 'Escape') {
        this.closeAllModals();
        return;
      }

      // Alt + N: New Note
      if (altKey && e.code === 'KeyN') {
        e.preventDefault();
        this.createFirstNote();
        return;
      }

      // Alt + A: AI Sidebar
      if (altKey && e.code === 'KeyA') {
        e.preventDefault();
        this.toggleAISidebar();
        return;
      }

      // Mod + \: Toggle Sidebar
      if (modKey && e.code === 'Backslash') {
        e.preventDefault();
        this.toggleSidebar();
        return;
      }

      // Mod + K: Search
      if (modKey && e.code === 'KeyK') {
        e.preventDefault();
        document.getElementById('sidebar-search')?.focus();
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

    // Also close slash menu if open in active editor
    this.getEditor()?.hideSlashMenu();
    this.getEditor()?.hideWikiMenu();
  }

  /**
   * Enter multi-selection mode
   */
  enterSelectionMode(noteId) {
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
    const ids = Array.from(this.selectedNoteIds);
    if (ids.length === 0) return;

    let confirmMsg = '';
    switch (action) {
      case 'trash': confirmMsg = `Move ${ids.length} notes to trash?`; break;
      case 'archive': confirmMsg = `Archive ${ids.length} notes?`; break;
      case 'delete': confirmMsg = `Permanently delete ${ids.length} notes? This cannot be undone.`; break;
    }

    if (confirmMsg && !confirm(confirmMsg)) return;

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
  app.init();
});
