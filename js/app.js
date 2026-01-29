/**
 * Main application entry point
 */

class App {
  constructor() {
    this.editor = null;
    this.sidebarOpen = true;
    this.sidebarView = 'notes'; // 'notes', 'archive', or 'trash'
    this.sidebarWidth = 260;
    this.sidebarViewMode = 'list'; // 'list' or 'cards'
    this.notes = [];
    this.archivedNotes = [];
    this.trashedNotes = [];
    this.searchQuery = '';
    this.contextMenuNoteId = null;
    // Tab management
    this.openTabs = []; // Array of { noteId, name }
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

      // Get notes
      this.notes = await Storage.getAllNotes();
      this.archivedNotes = await Storage.getArchivedNotes();
      this.trashedNotes = await Storage.getTrashedNotes();

      // Initialize editor
      this.editor = new BlockEditor();
      window.editor = this.editor;

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
      this.applyTheme();
      this.applyFont();
      this.applyWidth();

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
        // Only archived notes exist - create new note but user can restore from archive
        await this.createFirstNote();
      }

      this.updateEmptyState();
      this.updateBadgeCounts();

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
   * Setup sidebar functionality
   */
  async setupSidebar() {
    const sidebar = document.getElementById('sidebar');
    const toggleBtn = document.getElementById('sidebar-toggle');
    const newNoteBtn = document.getElementById('sidebar-new-note');
    const searchInput = document.getElementById('sidebar-search');
    const tabNotes = document.getElementById('sidebar-tab-notes');
    const tabArchive = document.getElementById('sidebar-tab-archive');
    const tabTrash = document.getElementById('sidebar-tab-trash');
    const emptyTrashBtn = document.getElementById('empty-trash-btn');

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
    searchInput.addEventListener('input', (e) => {
      this.searchQuery = e.target.value;
      this.renderNotesList();
    });

    // Sidebar tabs
    tabNotes.addEventListener('click', () => {
      this.sidebarView = 'notes';
      this.updateSidebarTabs();
      this.renderNotesList();
    });

    tabArchive.addEventListener('click', () => {
      this.sidebarView = 'archive';
      this.updateSidebarTabs();
      this.renderNotesList();
    });

    tabTrash.addEventListener('click', () => {
      this.sidebarView = 'trash';
      this.updateSidebarTabs();
      this.renderNotesList();
    });

    // Empty trash button
    emptyTrashBtn.addEventListener('click', async () => {
      await this.emptyTrash();
    });

    // Setup sidebar resize
    this.setupSidebarResize();

    // Setup view toggle
    this.setupSidebarViewToggle();

    // Setup context menu
    this.setupNoteContextMenu();

    // Initial render
    await this.refreshNotesList();

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
    const tabArchive = document.getElementById('sidebar-tab-archive');
    const tabTrash = document.getElementById('sidebar-tab-trash');
    const noteActions = document.querySelector('.sidebar-note-actions');
    const trashActions = document.getElementById('sidebar-trash-actions');
    
    tabNotes.classList.toggle('active', this.sidebarView === 'notes');
    tabArchive.classList.toggle('active', this.sidebarView === 'archive');
    tabTrash.classList.toggle('active', this.sidebarView === 'trash');
    
    // Hide note actions (new note + import) in archive/trash view
    if (noteActions) {
      noteActions.style.display = this.sidebarView === 'notes' ? 'flex' : 'none';
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
    const content = this.stripHtml(block.content || '');
    
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
        const childContent = this.stripHtml(block.children || '');
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
   * Show context menu for a note
   */
  showNoteContextMenu(e, noteId, viewType) {
    e.preventDefault();
    e.stopPropagation();
    
    const contextMenu = document.getElementById('note-context-menu');
    const openBtn = document.getElementById('ctx-open-note');
    const generateTitleBtn = document.getElementById('ctx-generate-title');
    const exportBtn = document.getElementById('ctx-export-note');
    const extractInsightsBtn = document.getElementById('ctx-extract-insights');
    const archiveBtn = document.getElementById('ctx-archive-note');
    const unarchiveBtn = document.getElementById('ctx-unarchive-note');
    const restoreBtn = document.getElementById('ctx-restore-note');
    const deleteBtn = document.getElementById('ctx-delete-note');
    const deletePermanentBtn = document.getElementById('ctx-delete-permanent');
    
    this.contextMenuNoteId = noteId;
    
    // Show/hide buttons based on view type
    const isNotes = viewType === 'notes';
    const isArchive = viewType === 'archive';
    const isTrash = viewType === 'trash';
    
    openBtn.classList.toggle('hidden', isTrash);
    generateTitleBtn.classList.toggle('hidden', isTrash);
    exportBtn.classList.toggle('hidden', isTrash);
    extractInsightsBtn.classList.toggle('hidden', isTrash);
    archiveBtn.classList.toggle('hidden', !isNotes);
    unarchiveBtn.classList.toggle('hidden', !isArchive);
    restoreBtn.classList.toggle('hidden', !isTrash);
    deleteBtn.classList.toggle('hidden', isTrash);
    deletePermanentBtn.classList.toggle('hidden', !isTrash);
    
    // Position context menu
    const x = Math.min(e.clientX, window.innerWidth - 180);
    const y = Math.min(e.clientY, window.innerHeight - 150);
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

      const insights = await LLM.extractInsights(content, note.name);

      if (!insights) {
        Utils.showToast('No insights found in this note', 'info');
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
    await this.refreshNotesList();
    Utils.showToast('Note permanently deleted', 'success');
  }

  /**
   * Close tab for a specific note if open
   */
  async closeTabForNote(noteId) {
    const tabIndex = this.openTabs.findIndex(t => t.noteId === noteId);
    if (tabIndex !== -1) {
      await this.closeTab(tabIndex);
    }
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
    this.updateBadgeCounts();
    this.renderNotesList();
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
   * Render notes list in sidebar
   */
  renderNotesList() {
    const list = document.getElementById('sidebar-notes-list');
    list.innerHTML = '';

    // Get notes based on current view
    let sourceNotes;
    if (this.sidebarView === 'archive') {
      sourceNotes = this.archivedNotes;
    } else if (this.sidebarView === 'trash') {
      sourceNotes = this.trashedNotes;
    } else {
      sourceNotes = this.notes;
    }

    // Apply fuzzy search filter
    const filteredNotes = this.searchQuery 
      ? Utils.fuzzySearchNotes(sourceNotes, this.searchQuery)
      : sourceNotes;

    if (filteredNotes.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'sidebar-empty';
      if (this.searchQuery) {
        empty.textContent = 'No matching notes';
      } else if (this.sidebarView === 'archive') {
        empty.textContent = 'No archived notes';
      } else if (this.sidebarView === 'trash') {
        empty.textContent = 'Trash is empty';
      } else {
        empty.textContent = 'No notes yet';
      }
      list.appendChild(empty);
      return;
    }

    const retentionDays = 30; // Will be loaded from settings

    filteredNotes.forEach((note) => {
      const item = document.createElement('div');
      item.className = 'sidebar-note-item';
      item.dataset.noteId = note.id;
      if (note.id === this.editor?.noteId) {
        item.classList.add('active');
      }
      if (this.sidebarView === 'archive') {
        item.classList.add('archived');
      }
      if (this.sidebarView === 'trash') {
        item.classList.add('trashed');
      }

      const content = document.createElement('div');
      content.className = 'sidebar-note-content';

      const name = document.createElement('div');
      name.className = 'sidebar-note-name';
      name.textContent = note.name || 'Untitled';

      const date = document.createElement('div');
      date.className = 'sidebar-note-date';
      
      if (this.sidebarView === 'trash' && note.trashedAt) {
        date.textContent = `Deleted ${Utils.formatDate(note.trashedAt)}`;
      } else if (this.sidebarView === 'archive' && note.archivedAt) {
        date.textContent = `Archived ${Utils.formatDate(note.archivedAt)}`;
      } else {
        date.textContent = Utils.formatDate(note.updatedAt);
      }

      content.appendChild(name);
      content.appendChild(date);
      
      // Show expiry info for trashed notes
      if (this.sidebarView === 'trash' && note.trashedAt) {
        const expiryDate = new Date(note.trashedAt + (retentionDays * 24 * 60 * 60 * 1000));
        const daysLeft = Math.ceil((expiryDate - Date.now()) / (24 * 60 * 60 * 1000));
        if (daysLeft > 0) {
          const expiry = document.createElement('div');
          expiry.className = 'sidebar-note-expiry';
          expiry.textContent = `Auto-deletes in ${daysLeft} day${daysLeft !== 1 ? 's' : ''}`;
          content.appendChild(expiry);
        }
      }
      
      item.appendChild(content);

      // More button for context menu
      const moreBtn = document.createElement('button');
      moreBtn.className = 'sidebar-note-more';
      moreBtn.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
        <circle cx="12" cy="5" r="2"></circle>
        <circle cx="12" cy="12" r="2"></circle>
        <circle cx="12" cy="19" r="2"></circle>
      </svg>`;
      moreBtn.addEventListener('click', (e) => {
        this.showNoteContextMenu(e, note.id, this.sidebarView);
      });
      item.appendChild(moreBtn);

      // Click to open note (not for trashed notes)
      if (this.sidebarView !== 'trash') {
        item.addEventListener('click', async (e) => {
          if (e.target.closest('.sidebar-note-more')) return;
          await this.openNoteWithModifier(note.id, e);
        });

        // Double-click to open in new tab
        item.addEventListener('dblclick', async (e) => {
          if (e.target.closest('.sidebar-note-more')) return;
          await this.openNoteInNewTab(note.id);
        });
      }

      // Right-click context menu
      item.addEventListener('contextmenu', (e) => {
        this.showNoteContextMenu(e, note.id, this.sidebarView);
      });

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
    this.renderTabs();
  }

  /**
   * Save tabs to storage
   */
  async saveTabs() {
    await Storage.setSetting('openTabs', this.openTabs);
    await Storage.setSetting('activeTabIndex', this.activeTabIndex);
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
    
    await this.editor.loadNote(tab.noteId);
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
    
    await this.editor.loadNote(noteId);
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
      await this.editor.loadNote(noteId);
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
    const closeBtn = modal.querySelector('.close-btn');

    settingsBtn.addEventListener('click', () => {
      modal.classList.remove('hidden');
      this.updateSettingsUI();
    });

    closeBtn.addEventListener('click', () => {
      modal.classList.add('hidden');
    });

    modal.addEventListener('click', (e) => {
      if (e.target === modal) {
        modal.classList.add('hidden');
      }
    });

    // Theme select
    document.getElementById('theme-select').addEventListener('change', async (e) => {
      await Storage.setSetting('theme', e.target.value);
      this.applyTheme();
    });

    // Font select
    document.getElementById('font-select').addEventListener('change', async (e) => {
      await Storage.setSetting('font', e.target.value);
      this.applyFont();
    });

    // Width select
    document.getElementById('width-select').addEventListener('change', async (e) => {
      await Storage.setSetting('width', e.target.value);
      this.applyWidth();
    });

    // Export All
    document.getElementById('export-all-btn').addEventListener('click', async () => {
      await this.exportAll();
    });

    // Export Current Note
    document.getElementById('export-current-btn').addEventListener('click', async () => {
      await this.exportCurrentNote();
    });

    // Create Backup
    document.getElementById('backup-btn').addEventListener('click', async () => {
      await this.createBackup();
    });

    // Import
    document.getElementById('import-btn').addEventListener('click', () => {
      document.getElementById('import-input').click();
    });

    document.getElementById('import-input').addEventListener('change', async (e) => {
      const file = e.target.files[0];
      if (file) {
        await this.importFromFile(file);
      }
      e.target.value = '';
    });

    // Delete note
    document.getElementById('delete-page-btn').addEventListener('click', async () => {
      await this.deleteCurrentNote();
    });

    // Trash retention setting
    const trashRetentionSelect = document.getElementById('trash-retention-select');
    if (trashRetentionSelect) {
      trashRetentionSelect.addEventListener('change', async (e) => {
        await Storage.setSetting('trashRetention', parseInt(e.target.value));
      });
    }
  }

  /**
   * Update settings UI
   */
  async updateSettingsUI() {
    // Theme
    const theme = await Storage.getSetting('theme', 'system');
    document.getElementById('theme-select').value = theme;

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
    if (insightsIntervalSelect) {
      insightsIntervalSelect.value = insightsInterval.toString();
    }
    
    // Update insights interval visibility based on enabled state
    this.updateInsightsIntervalVisibility(insightsEnabled);

    // Trash retention
    const trashRetention = await Storage.getSetting('trashRetention', 30);
    const trashRetentionSelect = document.getElementById('trash-retention-select');
    if (trashRetentionSelect) {
      trashRetentionSelect.value = trashRetention.toString();
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
    const panelNote = document.getElementById('ai-panel-note');
    const panelAll = document.getElementById('ai-panel-all');
    
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

    // Send message (note chat)
    chatSendBtn?.addEventListener('click', () => {
      this.sendAIChatMessage();
    });

    // Handle Enter key in chat input
    chatInput?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        this.sendAIChatMessage();
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
    } else {
      tabNote?.classList.remove('active');
      tabAll?.classList.add('active');
      panelNote?.classList.remove('active');
      panelAll?.classList.add('active');
      document.getElementById('global-chat-input')?.focus();
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

      // Step 2: RAG Analysis - determine which notes to retrieve
      if (loadingText) loadingText.textContent = 'Finding relevant notes...';
      
      const analysis = await LLM.ragAnalyzeQuery(message, notesMetadata);
      
      if (!analysis || analysis.noteIds.length === 0) {
        this.addGlobalChatMessage('I couldn\'t find any notes that seem relevant to your question. Try rephrasing your query or make sure your notes have descriptive titles.', 'assistant');
        return;
      }

      // Step 3: Retrieve full content of selected notes
      if (loadingText) loadingText.textContent = 'Reading notes...';
      
      const notesContent = [];
      for (const noteId of analysis.noteIds) {
        const note = allNotes.find(n => n.id === noteId);
        if (note) {
          const blocks = await Storage.getElementsByNote(noteId);
          const content = blocks
            .sort((a, b) => (a.order || 0) - (b.order || 0))
            .map(b => this.extractBlockText(b))
            .filter(t => t.trim())
            .join('\n\n');
          
          if (content.trim()) {
            notesContent.push({
              id: noteId,
              title: note.name || 'Untitled',
              content: content
            });
          }
        }
      }

      // Also include notes matching relevant tags
      if (analysis.relevantTags && analysis.relevantTags.length > 0) {
        for (const note of allNotes) {
          if (notesContent.find(n => n.id === note.id)) continue; // Already included
          
          const noteTags = note.insights?.tags || [];
          const hasMatchingTag = analysis.relevantTags.some(tag => 
            noteTags.some(nt => nt.toLowerCase().includes(tag.toLowerCase()))
          );
          
          if (hasMatchingTag) {
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
      }

      if (notesContent.length === 0) {
        this.addGlobalChatMessage('The selected notes appear to be empty. Please add content to your notes first.', 'assistant');
        return;
      }

      // Step 4: RAG Answer - get final response using note content
      if (loadingText) loadingText.textContent = 'Generating answer...';
      
      const answer = await LLM.ragAnswerQuery(message, analysis.followUpPrompt, notesContent);
      
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
      sourcesEl.className = 'global-chat-sources';
      
      const labelEl = document.createElement('span');
      labelEl.className = 'global-chat-sources-label';
      labelEl.textContent = 'Sources:';
      sourcesEl.appendChild(labelEl);
      
      sourceNotes.forEach(note => {
        const tagEl = document.createElement('span');
        tagEl.className = 'global-chat-source-tag';
        tagEl.textContent = note.title;
        tagEl.addEventListener('click', () => this.openNoteById(note.id));
        sourcesEl.appendChild(tagEl);
      });
      
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

    if (theme === 'system') {
      const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
      document.documentElement.dataset.theme = prefersDark ? 'dark' : 'light';
    } else {
      document.documentElement.dataset.theme = theme;
    }
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
      Utils.showToast('Export complete', 'success');
    } catch (error) {
      console.error('Export failed:', error);
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
        // .md or .txt file - create note with content as text block
        const note = await Storage.createNote(title);
        
        // Create a text block with the file content
        const block = {
          id: Utils.generateId(),
          canvasId: note.id,
          type: 'text',
          content: text,
          order: 0,
          createdAt: Date.now(),
          updatedAt: Date.now(),
        };
        
        await Storage.saveElement(block);
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

      for (const note of notes) {
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
          console.error(`Failed to extract insights for note ${note.id}:`, error);
          // Continue with other notes even if one fails
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
}

// Initialize app when DOM is ready
document.addEventListener('DOMContentLoaded', () => {
  const app = new App();
  window.app = app; // Make globally available for editor callbacks
  app.init();
});
