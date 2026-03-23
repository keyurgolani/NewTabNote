/**
 * SidebarController — manages sidebar UI: note list rendering, folder operations,
 * search filtering, sort modes, view toggling (list/cards), calendar, bulk actions,
 * context menus, and multi-select.
 *
 * @param {Object} deps
 * @param {DatabaseManager} deps.storage
 * @param {EventBus} deps.eventBus
 * @param {DomRefs} deps.domRefs
 * @param {Logger} deps.logger
 */
class SidebarController {
  constructor({ storage, eventBus, domRefs, logger }) {
    this.storage = storage;
    this.eventBus = eventBus;
    this.domRefs = domRefs;
    this.logger = logger;

    // Sidebar state
    this.sidebarOpen = true;
    this.sidebarView = 'notes';
    this.sidebarWidth = 260;
    this.sidebarSortMode = 'updated';
    this.sidebarViewMode = 'list';
    this.searchQuery = '';
    this.contextMenuNoteId = null;

    // Calendar state
    const now = new Date();
    this.calendarMonth = now.getMonth();
    this.calendarYear = now.getFullYear();

    // Multi-select state
    this.selectionMode = false;
    this.selectedNoteIds = new Set();

    // Data arrays (synced from App)
    this.notes = [];
    this.archivedNotes = [];
    this.trashedNotes = [];
    this.templates = [];
    this.folders = [];
    this.searchIndexByNoteId = new Map();

    // Resizer instance
    this.sidebarResizer = null;
    // SearchEngine reference (set by App)
    this.searchEngine = null;

    // Virtual scroller instance for large flat lists
    /** @type {VirtualScroller|null} */
    this.virtualScroller = null;

    // App-level callbacks (set by App after construction)
    this.onOpenNoteInNewTab = null;
    this.onOpenNewTab = null;
    this.getEditor = null;
    this.onArchiveNote = null;
    this.onUnarchiveNote = null;
    this.onTrashNote = null;
    this.onRestoreNote = null;
    this.onPermanentlyDeleteNote = null;
    this.onGenerateTitle = null;
    this.onExportNote = null;
    this.onExtractInsights = null;
    this.onConvertNoteToTemplate = null;
    this.onConvertTemplateToNote = null;
    this.onImportNote = null;
  }

  /** Initialize sidebar: load persisted state, wire DOM listeners. */
  async init() {
    const storage = this.storage;

    this.sidebarOpen = await storage.getSetting('sidebarOpen', true);
    this.sidebarWidth = await storage.getSetting('sidebarWidth', 260);
    this.sidebarSortMode = await storage.getSetting('sidebarSortMode', 'updated');
    this.sidebarViewMode = await storage.getSetting('sidebarViewMode', 'list');

    const sortSelect = document.getElementById('sidebar-sort');
    if (sortSelect) sortSelect.value = this.sidebarSortMode;

    this.updateSidebarState();
    this.applySidebarWidth();
    this.applySidebarViewMode();
    this._bindSidebarListeners();
    this.setupCalendar();
    this.setupSidebarResize();
    this.setupSidebarViewToggle();
    this.setupNoteContextMenu();
    this._bindBulkActions();
    this._bindSidebarDropHandlers();
    await this.runTrashCleanup();
  }

  /** Tear down listeners and resizer. */
  destroy() {
    if (this.sidebarResizer) {
      this.sidebarResizer.destroy();
      this.sidebarResizer = null;
    }
    this._destroyVirtualScroller();
  }

  /**
   * Destroy the current VirtualScroller instance if active.
   * @private
   */
  _destroyVirtualScroller() {
    if (this.virtualScroller) {
      this.virtualScroller.destroy();
      this.virtualScroller = null;
    }
  }

  // ─── Private: bind sidebar button/tab listeners ───

  _bindSidebarListeners() {
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
    const importNoteBtn = document.getElementById('sidebar-import-note');
    const noteImportInput = document.getElementById('note-import-input');

    toggleBtn.addEventListener('click', () => this.toggleSidebar());

    newNoteBtn.addEventListener('click', async () => {
      if (this.sidebarView !== 'notes') {
        this.sidebarView = 'notes';
        this.updateSidebarTabs();
      }
      if (this.onOpenNewTab) await this.onOpenNewTab();
    });

    if (dailyNoteBtn) {
      dailyNoteBtn.addEventListener('click', async () => {
        const note = await this.storage.ensureDailyNote();
        await this.refreshNotesList();
        if (this.onOpenNoteInNewTab) await this.onOpenNoteInNewTab(note.id);
      });
    }

    if (newFolderBtn) {
      newFolderBtn.addEventListener('click', async () => {
        const name = await promptDialog({ title: 'New Folder', message: 'Folder name:', defaultValue: 'New Folder' });
        if (name) {
          await this.storage.createFolder(name);
          await this.refreshNotesList();
        }
      });
    }

    if (importNoteBtn && noteImportInput) {
      importNoteBtn.addEventListener('click', () => {
        if (this.sidebarView !== 'notes') {
          this.sidebarView = 'notes';
          this.updateSidebarTabs();
        }
        noteImportInput.click();
      });
      noteImportInput.addEventListener('change', async (e) => {
        const file = e.target.files[0];
        if (file && this.onImportNote) await this.onImportNote(file);
        e.target.value = '';
      });
    }

    searchInput.addEventListener('input', async (e) => {
      this.searchQuery = e.target.value;
      await this.renderNotesList();
    });

    if (sortSelect) {
      sortSelect.addEventListener('change', async (e) => {
        this.sidebarSortMode = e.target.value;
        await this.storage.setSetting('sidebarSortMode', this.sidebarSortMode);
        await this.renderNotesList();
      });
    }

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

    emptyTrashBtn.addEventListener('click', () => this.emptyTrash());
  }

  _bindBulkActions() {
    const bulkArchiveBtn = document.getElementById('bulk-archive-btn');
    const bulkDeleteBtn = document.getElementById('bulk-delete-btn');
    const bulkCancelBtn = document.getElementById('bulk-cancel-btn');
    if (bulkArchiveBtn) bulkArchiveBtn.addEventListener('click', () => this.performBulkAction('archive'));
    if (bulkDeleteBtn) bulkDeleteBtn.addEventListener('click', () => this.performBulkAction('trash'));
    if (bulkCancelBtn) bulkCancelBtn.addEventListener('click', () => this.exitSelectionMode());
  }

  // ─── Drag-to-sidebar (Req 46.1, 46.2, 46.3) ───

  _bindSidebarDropHandlers() {
    const notesList = document.getElementById('sidebar-notes-list');
    if (!notesList) return;

    notesList.addEventListener('dragover', (e) => this._onSidebarDragOver(e));
    notesList.addEventListener('dragleave', (e) => this._onSidebarDragLeave(e));
    notesList.addEventListener('drop', (e) => this._onSidebarDrop(e));
  }

  /**
   * Check if a drag event carries block content from the editor.
   * @param {DragEvent} e
   * @returns {boolean}
   */
  _isBlockDrag(e) {
    return e.dataTransfer.types.includes('application/x-block-content');
  }

  /**
   * Show the "Create New Note" drop zone overlay at the top of the sidebar notes list.
   * @private
   */
  _showDropOverlay() {
    if (document.getElementById('sidebar-drop-overlay')) return;
    const notesList = document.getElementById('sidebar-notes-list');
    if (!notesList) return;

    const overlay = document.createElement('div');
    overlay.id = 'sidebar-drop-overlay';
    overlay.className = 'sidebar-drop-overlay';
    overlay.innerHTML = `
      <div class="sidebar-drop-zone-new" data-action="new-note">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M12 5v14M5 12h14"></path>
        </svg>
        <span>Create New Note</span>
      </div>`;
    notesList.prepend(overlay);
  }

  _removeDropOverlay() {
    const overlay = document.getElementById('sidebar-drop-overlay');
    if (overlay) overlay.remove();
    const notesList = document.getElementById('sidebar-notes-list');
    if (notesList) {
      notesList.querySelectorAll('.sidebar-note-item.sidebar-drop-target').forEach(el => {
        el.classList.remove('sidebar-drop-target');
      });
    }
  }

  _onSidebarDragOver(e) {
    if (!this._isBlockDrag(e)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';

    this._showDropOverlay();

    // Highlight note item under cursor
    const notesList = document.getElementById('sidebar-notes-list');
    if (notesList) {
      notesList.querySelectorAll('.sidebar-note-item.sidebar-drop-target').forEach(el => {
        el.classList.remove('sidebar-drop-target');
      });
    }
    const noteItem = e.target.closest('.sidebar-note-item');
    if (noteItem && noteItem.dataset.id) {
      noteItem.classList.add('sidebar-drop-target');
    }
  }

  _onSidebarDragLeave(e) {
    if (!this._isBlockDrag(e)) return;
    const notesList = document.getElementById('sidebar-notes-list');
    // Only remove overlay when leaving the notes list entirely
    if (notesList && !notesList.contains(e.relatedTarget)) {
      this._removeDropOverlay();
    }
  }

  async _onSidebarDrop(e) {
    if (!this._isBlockDrag(e)) return;
    e.preventDefault();
    e.stopPropagation();

    const blockContent = e.dataTransfer.getData('application/x-block-content');
    const blockType = e.dataTransfer.getData('application/x-block-type') || 'text';
    const blockHtml = e.dataTransfer.getData('application/x-block-html') || blockContent;

    this._removeDropOverlay();

    if (!blockContent && !blockHtml) return;

    // Check if dropped on "Create New Note" zone
    const dropZone = e.target.closest('[data-action="new-note"]');
    const noteItem = e.target.closest('.sidebar-note-item');

    if (dropZone || (!noteItem)) {
      // Create new note with dragged block content (Req 46.2)
      await this._createNoteFromBlock(blockContent, blockType, blockHtml);
    } else if (noteItem && noteItem.dataset.id) {
      // Append to existing note (Req 46.3)
      await this._appendBlockToNote(noteItem.dataset.id, blockType, blockHtml);
    }
  }

  /**
   * Create a new note containing the dragged block's content.
   * @param {string} textContent - Plain text content
   * @param {string} blockType - Block type
   * @param {string} htmlContent - HTML content
   */
  async _createNoteFromBlock(textContent, blockType, htmlContent) {
    try {
      const title = (textContent || '').substring(0, 60).trim() || 'Untitled';
      const note = await this.storage.createNote(title);

      const blockData = {
        id: typeof Utils !== 'undefined' ? Utils.generateId() : Date.now().toString(36),
        type: blockType,
        content: htmlContent || textContent || '',
        canvasId: note.id,
        order: 0,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        indentLevel: 0,
        checked: false,
      };
      await this.storage.saveElement(blockData);

      await this.refreshNotesList();
      if (this.onOpenNoteInNewTab) await this.onOpenNoteInNewTab(note.id);
      Utils.showToast('Note created from block', 'success');
    } catch (error) {
      console.error('Failed to create note from block:', error);
      Utils.showToast('Failed to create note', 'error');
    }
  }

  /**
   * Append block content to an existing note.
   * @param {string} noteId - Target note ID
   * @param {string} blockType - Block type
   * @param {string} htmlContent - HTML content
   */
  async _appendBlockToNote(noteId, blockType, htmlContent) {
    try {
      const existingBlocks = await this.storage.getElementsByNote(noteId);
      const maxOrder = existingBlocks.length > 0
        ? Math.max(...existingBlocks.map(b => b.order || 0))
        : -1;

      const blockData = {
        id: typeof Utils !== 'undefined' ? Utils.generateId() : Date.now().toString(36),
        type: blockType,
        content: htmlContent || '',
        canvasId: noteId,
        order: maxOrder + 1,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        indentLevel: 0,
        checked: false,
      };
      await this.storage.saveElement(blockData);

      // Update note's updatedAt
      const note = await this.storage.getNote(noteId);
      if (note) {
        note.updatedAt = Date.now();
        await this.storage.updateNote(note);
      }

      await this.refreshNotesList();
      Utils.showToast('Block appended to note', 'success');
    } catch (error) {
      console.error('Failed to append block to note:', error);
      Utils.showToast('Failed to append block', 'error');
    }
  }

  // ─── Sidebar state ───

  updateSidebarState() {
    const sidebar = document.getElementById('sidebar');
    const toggleBtn = document.getElementById('sidebar-toggle');
    const headerLeft = document.querySelector('.header-left');
    const sidebarToggleContainer = document.getElementById('sidebar-toggle-container');

    if (this.sidebarOpen) {
      sidebar.classList.remove('collapsed');
      toggleBtn.classList.add('active');
      if (sidebarToggleContainer && toggleBtn.parentElement !== sidebarToggleContainer) {
        sidebarToggleContainer.appendChild(toggleBtn);
      }
    } else {
      sidebar.classList.add('collapsed');
      toggleBtn.classList.remove('active');
      if (headerLeft && toggleBtn.parentElement !== headerLeft) {
        headerLeft.appendChild(toggleBtn);
      }
    }
  }

  async toggleSidebar(force) {
    this.sidebarOpen = force !== undefined ? force : !this.sidebarOpen;
    this.updateSidebarState();
    await this.storage.setSetting('sidebarOpen', this.sidebarOpen);
  }

  applySidebarWidth() {
    const sidebar = document.getElementById('sidebar');
    if (sidebar && this.sidebarWidth) {
      sidebar.style.width = this.sidebarWidth + 'px';
    }
  }

  applySidebarViewMode() {
    const notesList = document.getElementById('sidebar-notes-list');
    const listBtn = document.getElementById('sidebar-view-list');
    const cardsBtn = document.getElementById('sidebar-view-cards');
    if (notesList) notesList.classList.toggle('cards-view', this.sidebarViewMode === 'cards');
    if (listBtn && cardsBtn) {
      listBtn.classList.toggle('active', this.sidebarViewMode === 'list');
      cardsBtn.classList.toggle('active', this.sidebarViewMode === 'cards');
    }
  }

  updateSidebarTabs() {
    const tabNotes = document.getElementById('sidebar-tab-notes');
    const tabTemplates = document.getElementById('sidebar-tab-templates');
    const tabArchive = document.getElementById('sidebar-tab-archive');
    const tabTrash = document.getElementById('sidebar-tab-trash');
    const noteActions = document.querySelector('.sidebar-note-actions');
    const trashActions = document.getElementById('sidebar-trash-actions');

    tabNotes.classList.toggle('active', this.sidebarView === 'notes');
    if (tabTemplates) tabTemplates.classList.toggle('active', this.sidebarView === 'templates');
    if (tabArchive) tabArchive.classList.toggle('active', this.sidebarView === 'archive');
    if (tabTrash) tabTrash.classList.toggle('active', this.sidebarView === 'trash');

    const isNotesView = this.sidebarView === 'notes';
    if (noteActions) noteActions.style.display = isNotesView ? 'flex' : 'none';
    const calendar = document.getElementById('sidebar-calendar');
    if (calendar) calendar.style.display = isNotesView ? 'block' : 'none';
    trashActions.classList.toggle('hidden', this.sidebarView !== 'trash' || this.trashedNotes.length === 0);
  }

  // ─── Sidebar resize ───

  setupSidebarResize() {
    const sidebar = document.getElementById('sidebar');
    const resizeHandle = document.getElementById('sidebar-resize-handle');
    if (this.sidebarResizer) this.sidebarResizer.destroy();
    if (!sidebar || !resizeHandle) return;

    this.sidebarResizer = new ResizablePanel({
      panel: sidebar,
      handle: resizeHandle,
      min: 180,
      max: 500,
      direction: 'right',
      onResizeEnd: async (width) => {
        this.sidebarWidth = width;
        await this.storage.setSetting('sidebarWidth', this.sidebarWidth);
      },
    });
  }

  // ─── View toggle (list / cards) ───

  setupSidebarViewToggle() {
    const listBtn = document.getElementById('sidebar-view-list');
    const cardsBtn = document.getElementById('sidebar-view-cards');
    if (!listBtn || !cardsBtn) return;

    listBtn.addEventListener('click', async () => {
      this.sidebarViewMode = 'list';
      this.applySidebarViewMode();
      await this.storage.setSetting('sidebarViewMode', 'list');
    });
    cardsBtn.addEventListener('click', async () => {
      this.sidebarViewMode = 'cards';
      this.applySidebarViewMode();
      await this.storage.setSetting('sidebarViewMode', 'cards');
    });
  }

  // ─── Calendar ───

  setupCalendar() {
    const prevBtn = document.getElementById('calendar-prev');
    const nextBtn = document.getElementById('calendar-next');
    const todayBtn = document.getElementById('calendar-today');

    if (prevBtn) {
      prevBtn.addEventListener('click', () => {
        this.calendarMonth--;
        if (this.calendarMonth < 0) { this.calendarMonth = 11; this.calendarYear--; }
        this.renderCalendar();
      });
    }
    if (nextBtn) {
      nextBtn.addEventListener('click', () => {
        this.calendarMonth++;
        if (this.calendarMonth > 11) { this.calendarMonth = 0; this.calendarYear++; }
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

  renderCalendar() {
    const daysContainer = document.getElementById('calendar-days');
    const monthLabel = document.getElementById('calendar-month-label');
    if (!daysContainer || !monthLabel) return;

    const year = this.calendarYear;
    const month = this.calendarMonth;
    const monthDate = new Date(year, month, 1);
    monthLabel.textContent = monthDate.toLocaleDateString('en-US', { month: 'short', year: 'numeric' });

    const dailyNoteDates = new Set();
    const allNotes = [...this.notes, ...this.archivedNotes];
    allNotes.forEach(n => { if (n.isDaily && n.dateStr) dailyNoteDates.add(n.dateStr); });

    const today = new Date();
    const todayStr = today.toISOString().split('T')[0];
    const firstDay = new Date(year, month, 1).getDay();
    const daysInMonth = new Date(year, month + 1, 0).getDate();
    const daysInPrevMonth = new Date(year, month, 0).getDate();

    daysContainer.innerHTML = '';

    // Previous month padding
    for (let i = firstDay - 1; i >= 0; i--) {
      const day = daysInPrevMonth - i;
      const prevMonth = month === 0 ? 11 : month - 1;
      const prevYear = month === 0 ? year - 1 : year;
      const dateStr = `${prevYear}-${String(prevMonth + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
      daysContainer.appendChild(this.createCalendarDay(day, dateStr, 'other-month', dailyNoteDates, todayStr));
    }

    // Current month
    for (let day = 1; day <= daysInMonth; day++) {
      const dateStr = `${year}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
      daysContainer.appendChild(this.createCalendarDay(day, dateStr, '', dailyNoteDates, todayStr));
    }

    // Next month padding
    const totalCells = firstDay + daysInMonth;
    const remaining = totalCells % 7 === 0 ? 0 : 7 - (totalCells % 7);
    for (let day = 1; day <= remaining; day++) {
      const nextMonth = month === 11 ? 0 : month + 1;
      const nextYear = month === 11 ? year + 1 : year;
      const dateStr = `${nextYear}-${String(nextMonth + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
      daysContainer.appendChild(this.createCalendarDay(day, dateStr, 'other-month', dailyNoteDates, todayStr));
    }
  }

  createCalendarDay(day, dateStr, extraClass, dailyNoteDates, todayStr) {
    const el = document.createElement('div');
    el.className = 'calendar-day';
    if (extraClass) el.classList.add(extraClass);
    if (dateStr === todayStr) el.classList.add('today');
    if (dailyNoteDates.has(dateStr)) el.classList.add('has-note');
    el.textContent = day;
    el.dataset.date = dateStr;

    el.addEventListener('click', async () => {
      const note = await this.storage.ensureDailyNoteForDate(dateStr);
      await this.refreshNotesList();
      if (this.onOpenNoteInNewTab) await this.onOpenNoteInNewTab(note.id);
    });
    return el;
  }

  // ─── Note context menu ───

  setupNoteContextMenu() {
    const contextMenu = document.getElementById('note-context-menu');

    document.addEventListener('click', (e) => {
      if (!contextMenu.contains(e.target)) {
        contextMenu.classList.add('hidden');
        this.contextMenuNoteId = null;
      }
    });

    document.getElementById('ctx-pin-note').addEventListener('click', async () => {
      const noteId = this.contextMenuNoteId;
      contextMenu.classList.add('hidden');
      if (noteId) await this.toggleNotePin(noteId);
    });

    document.getElementById('ctx-open-note').addEventListener('click', async () => {
      const noteId = this.contextMenuNoteId;
      contextMenu.classList.add('hidden');
      if (noteId && this.onOpenNoteInNewTab) await this.onOpenNoteInNewTab(noteId);
    });

    document.getElementById('ctx-generate-title').addEventListener('click', async () => {
      const noteId = this.contextMenuNoteId;
      contextMenu.classList.add('hidden');
      if (noteId && this.onGenerateTitle) await this.onGenerateTitle(noteId);
    });

    document.getElementById('ctx-export-note').addEventListener('click', async () => {
      const noteId = this.contextMenuNoteId;
      contextMenu.classList.add('hidden');
      if (noteId && this.onExportNote) await this.onExportNote(noteId);
    });

    document.getElementById('ctx-extract-insights').addEventListener('click', async () => {
      const noteId = this.contextMenuNoteId;
      contextMenu.classList.add('hidden');
      if (noteId && this.onExtractInsights) await this.onExtractInsights(noteId);
    });

    document.getElementById('ctx-archive-note').addEventListener('click', async () => {
      const noteId = this.contextMenuNoteId;
      contextMenu.classList.add('hidden');
      if (noteId && this.onArchiveNote) await this.onArchiveNote(noteId);
    });

    document.getElementById('ctx-unarchive-note').addEventListener('click', async () => {
      const noteId = this.contextMenuNoteId;
      contextMenu.classList.add('hidden');
      if (noteId && this.onUnarchiveNote) await this.onUnarchiveNote(noteId);
    });

    document.getElementById('ctx-delete-note').addEventListener('click', async () => {
      const noteId = this.contextMenuNoteId;
      contextMenu.classList.add('hidden');
      if (noteId && this.onTrashNote) await this.onTrashNote(noteId);
    });

    document.getElementById('ctx-restore-note').addEventListener('click', async () => {
      const noteId = this.contextMenuNoteId;
      contextMenu.classList.add('hidden');
      if (noteId && this.onRestoreNote) await this.onRestoreNote(noteId);
    });

    document.getElementById('ctx-delete-permanent').addEventListener('click', async () => {
      const noteId = this.contextMenuNoteId;
      contextMenu.classList.add('hidden');
      if (noteId && this.onPermanentlyDeleteNote) await this.onPermanentlyDeleteNote(noteId);
    });

    document.getElementById('ctx-convert-template').addEventListener('click', async () => {
      const noteId = this.contextMenuNoteId;
      contextMenu.classList.add('hidden');
      if (noteId && this.onConvertNoteToTemplate) await this.onConvertNoteToTemplate(noteId);
    });

    document.getElementById('ctx-back-to-note').addEventListener('click', async () => {
      const noteId = this.contextMenuNoteId;
      contextMenu.classList.add('hidden');
      if (noteId && this.onConvertTemplateToNote) await this.onConvertTemplateToNote(noteId);
    });
  }

  showNoteContextMenu(e, noteId, viewType) {
    e.preventDefault();
    e.stopPropagation();

    const contextMenu = document.getElementById('note-context-menu');
    const selectBtn = document.getElementById('ctx-select-note');
    const pinBtn = document.getElementById('ctx-pin-note');
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

    const isNotes = viewType === 'notes';
    const isArchive = viewType === 'archive';
    const isTrash = viewType === 'trash';
    const isTemplates = viewType === 'templates';

    openBtn.classList.toggle('hidden', isTrash);
    if (pinBtn) {
      const canPin = isNotes && !isTrash;
      pinBtn.classList.toggle('hidden', !canPin);
      if (canPin) {
        const note = this.notes.find(n => n.id === noteId);
        const isPinned = note && note.pinned;
        pinBtn.textContent = '';
        pinBtn.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M12 17v5"></path>
          <path d="M5 3h14l-3 7v4l-4-2-4 2v-4z"></path>
        </svg>
        ${isPinned ? 'Unpin Note' : 'Pin Note'}`;
      }
    }
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

    const x = Math.min(e.clientX, window.innerWidth - 180);
    const y = Math.min(e.clientY, window.innerHeight - 200);
    contextMenu.style.left = x + 'px';
    contextMenu.style.top = y + 'px';
    contextMenu.classList.remove('hidden');
  }

  // ─── Trash ───

  async emptyTrash() {
    if (this.trashedNotes.length === 0) {
      Utils.showToast('Trash is already empty', 'info');
      return;
    }
    if (!await confirmDialog({ title: 'Empty Trash', message: `Permanently delete ${this.trashedNotes.length} note(s)? This cannot be undone.`, confirmText: 'Delete', danger: true })) return;
    await this.storage.emptyTrash();
    await this.refreshNotesList();
    Utils.showToast('Trash emptied', 'success');
  }

  async runTrashCleanup() {
    const retentionDays = await this.storage.getSetting('trashRetention', 30);
    if (retentionDays > 0) {
      const deletedCount = await this.storage.cleanupTrash(retentionDays);
      if (deletedCount > 0) {
        this.logger.info('SidebarController', `Auto-deleted ${deletedCount} expired note(s) from trash`);
        await this.refreshNotesList();
      }
    }
  }

  // ─── Badge counts ───

  updateBadgeCounts() {
    const notesBadge = document.getElementById('notes-count');
    const archiveBadge = document.getElementById('archive-count');
    const trashBadge = document.getElementById('trash-count');

    if (notesBadge) {
      if (this.notes.length > 0) {
        notesBadge.textContent = this.notes.length;
        notesBadge.classList.remove('hidden');
      } else {
        notesBadge.classList.add('hidden');
      }
    }
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

  // ─── Refresh & render ───

  async refreshNotesList() {
    // Destroy virtual scroller on full refresh to ensure clean state
    this._destroyVirtualScroller();
    this.notes = await this.storage.getAllNotes();
    this.archivedNotes = await this.storage.getArchivedNotes();
    this.trashedNotes = await this.storage.getTrashedNotes();
    this.templates = await this.storage.getTemplates();
    this.folders = await this.storage.getAllFolders();
    await this.refreshSearchIndexEntries();
    this.updateBadgeCounts();
    await this.renderNotesList();
    this.renderCalendar();
    this.updateSidebarTabs();
  }

  async refreshSearchIndexEntries() {
    const entries = await this.storage.getSearchIndex();
    this.searchIndexByNoteId = new Map(entries.map(entry => [entry.noteId, entry]));
    return entries;
  }

  /** @private */
  static get VIRTUAL_SCROLL_THRESHOLD() { return 50; }
  /** @private */
  static get VIRTUAL_SCROLL_ITEM_HEIGHT() { return 68; }

  async renderNotesList() {
    const list = document.getElementById('sidebar-notes-list');
    if (!list) return;

    const isSearch = this.searchQuery.trim() !== '';

    if (isSearch) {
      await this.renderSearchResults(list);
      return;
    }

    // Notes view uses folder tree — not compatible with virtual scrolling
    if (this.sidebarView === 'notes') {
      this._destroyVirtualScroller();
      list.innerHTML = '';
      if (this.notes.length === 0 && this.folders.length === 0) {
        this.renderEmptySidebar(list);
        return;
      }

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

      this.renderFolderTree(list, null, notesInFolders);
      this.getSortedSidebarNotes(rootNotes).forEach(note => list.appendChild(this.createSidebarNoteItem(note)));
      return;
    }

    // Flat views: archive, trash, templates
    let flatNotes = [];
    if (this.sidebarView === 'archive') {
      flatNotes = this.archivedNotes;
    } else if (this.sidebarView === 'trash') {
      flatNotes = this.trashedNotes;
    } else if (this.sidebarView === 'templates') {
      flatNotes = this.getSortedSidebarNotes(this.templates);
    }

    if (flatNotes.length === 0) {
      this._destroyVirtualScroller();
      list.innerHTML = '';
      this.renderEmptySidebar(list);
      return;
    }

    this._renderFlatNoteList(list, flatNotes);
  }

  /**
   * Render a flat list of notes, using VirtualScroller when count exceeds threshold.
   * @param {HTMLElement} list - The sidebar notes list container
   * @param {Array<Object>} notes - Flat array of notes to render
   * @private
   */
  _renderFlatNoteList(list, notes) {
    if (notes.length > SidebarController.VIRTUAL_SCROLL_THRESHOLD && typeof VirtualScroller !== 'undefined') {
      if (this.virtualScroller) {
        // Reuse existing scroller — update items without full DOM rebuild
        this.virtualScroller.setItems(notes);
      } else {
        list.innerHTML = '';
        this.virtualScroller = new VirtualScroller({
          container: list,
          itemHeight: SidebarController.VIRTUAL_SCROLL_ITEM_HEIGHT,
          renderItem: (note) => this.createSidebarNoteItem(note),
          items: notes,
          buffer: 3,
        });
      }
    } else {
      this._destroyVirtualScroller();
      list.innerHTML = '';
      notes.forEach(note => list.appendChild(this.createSidebarNoteItem(note)));
    }
  }

  getSortedSidebarNotes(notes) {
    if (typeof SidebarUtils === 'undefined') return notes;
    return SidebarUtils.sortNotes(notes, this.sidebarSortMode);
  }

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
        await this.storage.updateFolder(folder);
      });

      header.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        this.showFolderContextMenu(e, folder);
      });

      header.addEventListener('dragover', (e) => { e.preventDefault(); header.classList.add('drag-over'); });
      header.addEventListener('dragleave', () => { header.classList.remove('drag-over'); });
      header.addEventListener('drop', async (e) => {
        e.preventDefault();
        header.classList.remove('drag-over');
        const noteId = e.dataTransfer.getData('noteId');
        const draggedFolderId = e.dataTransfer.getData('folderId');
        if (noteId) {
          await this.storage.moveNoteToFolder(noteId, folder.id);
          await this.refreshNotesList();
        } else if (draggedFolderId && draggedFolderId !== folder.id) {
          if (!this.isChildFolder(draggedFolderId, folder.id)) {
            const draggedFolder = this.folders.find(f => f.id === draggedFolderId);
            if (draggedFolder) {
              draggedFolder.parentId = folder.id;
              await this.storage.updateFolder(draggedFolder);
              await this.refreshNotesList();
            }
          }
        }
      });

      folderEl.appendChild(header);

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
      this.renderFolderTree(contents, folder.id, notesInFolders);
      const notes = this.getSortedSidebarNotes(notesInFolders[folder.id] || []);
      notes.forEach(note => contents.appendChild(this.createSidebarNoteItem(note)));
      folderEl.appendChild(contents);
      container.appendChild(folderEl);
    });
  }

  isChildFolder(parentId, targetId) {
    if (parentId === targetId) return true;
    const children = this.folders.filter(f => f.parentId === parentId);
    for (const child of children) {
      if (this.isChildFolder(child.id, targetId)) return true;
    }
    return false;
  }

  renderEmptySidebar(list, isSearch = false) {
    const empty = document.createElement('div');
    empty.className = 'sidebar-empty';
    if (isSearch) { empty.textContent = 'No matching notes'; }
    else if (this.sidebarView === 'archive') { empty.textContent = 'No archived notes'; }
    else if (this.sidebarView === 'trash') { empty.textContent = 'Trash is empty'; }
    else { empty.textContent = 'No notes yet'; }
    list.appendChild(empty);
  }

  createSidebarNoteItem(note) {
    const editorRef = this.getEditor ? this.getEditor() : null;
    const isActive = editorRef && editorRef.noteId === note.id;
    const el = document.createElement('div');
    el.className = `sidebar-note-item ${isActive ? 'active' : ''}`;
    if (this.selectionMode) el.classList.add('selection-mode');
    if (note.archived || note.trashed) el.classList.add('archived');
    el.dataset.id = note.id;
    el.draggable = !this.selectionMode;

    // Checkbox for multi-select
    const checkbox = document.createElement('div');
    checkbox.className = `sidebar-note-checkbox ${this.selectedNoteIds.has(note.id) ? 'checked' : ''}`;
    checkbox.addEventListener('click', (e) => { e.stopPropagation(); this.toggleNoteSelection(note.id); });
    el.appendChild(checkbox);

    const model = typeof SidebarUtils !== 'undefined'
      ? SidebarUtils.buildSidebarNoteModel(note, { searchIndexEntry: this.searchIndexByNoteId.get(note.id) })
      : { title: note.name || 'Untitled', preview: note.preview || '', relativeTime: '', tags: [], todoSummary: '', isPinned: Boolean(note.pinned) };

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
      if (this.selectionMode) { this.toggleNoteSelection(note.id); }
      else if (this.onOpenNoteInNewTab) { this.onOpenNoteInNewTab(note.id); }
    });

    el.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      this.showNoteContextMenu(e, note.id, this.sidebarView);
    });

    return el;
  }

  async toggleNotePin(noteId) {
    const note = await this.storage.getNote(noteId);
    if (!note) return;
    note.pinned = !note.pinned;
    await this.storage.updateNote(note);
    await this.refreshNotesList();
    Utils.showToast(note.pinned ? 'Note pinned' : 'Note unpinned', 'success');
  }

  // ─── Search ───

  async renderSearchResults(list) {
    const searchIndexData = await this.refreshSearchIndexEntries();
    if (this.searchEngine) this.searchEngine.updateIndex(searchIndexData);
    const searchResults = this.searchEngine ? await this.searchEngine.search(this.searchQuery) : [];

    let sourceNotes = this.notes;
    if (this.sidebarView === 'archive') sourceNotes = this.archivedNotes;
    if (this.sidebarView === 'trash') sourceNotes = this.trashedNotes;

    const searchResultIds = new Set(searchResults.map(r => r.id));
    const filteredNotes = sourceNotes.filter(n => searchResultIds.has(n.id));
    const scoreMap = new Map(searchResults.map(r => [r.id, r.score]));
    filteredNotes.sort((a, b) => (scoreMap.get(b.id) || 0) - (scoreMap.get(a.id) || 0));

    if (filteredNotes.length === 0) {
      this._destroyVirtualScroller();
      list.innerHTML = '';
      this.renderEmptySidebar(list, true);
    } else {
      this._renderFlatNoteList(list, filteredNotes);
    }
  }

  // ─── Folder context menu ───

  async showFolderContextMenu(e, folder) {
    const menu = document.createElement('div');
    menu.className = 'context-menu';
    menu.style.left = `${e.pageX}px`;
    menu.style.top = `${e.pageY}px`;

    const items = [
      { label: 'Rename', action: async () => {
        const newName = await promptDialog({ title: 'Rename Folder', message: 'New folder name:', defaultValue: folder.name });
        if (newName && newName !== folder.name) {
          folder.name = newName;
          await this.storage.updateFolder(folder);
          await this.refreshNotesList();
        }
      }},
      { label: 'Delete Folder', action: async () => {
        if (await confirmDialog({ title: 'Delete Folder', message: `Are you sure you want to delete "${folder.name}"? Notes inside will be moved to root.`, confirmText: 'Delete', danger: true })) {
          await this.storage.deleteFolder(folder.id);
          await this.refreshNotesList();
        }
      }},
      { label: 'Add Note to Folder', action: async () => {
        const note = await this.storage.createNote('New Note');
        note.folderId = folder.id;
        await this.storage.updateNote(note);
        await this.refreshNotesList();
        if (this.onOpenNoteInNewTab) this.onOpenNoteInNewTab(note.id);
      }},
      { label: 'Move to Root', action: async () => {
        folder.parentId = null;
        await this.storage.updateFolder(folder);
        await this.refreshNotesList();
      }}
    ];

    items.forEach(item => {
      const el = document.createElement('div');
      el.className = 'context-menu-item';
      el.innerHTML = `<span>${item.label}</span>`;
      el.addEventListener('click', () => {
        item.action();
        if (document.body.contains(menu)) document.body.removeChild(menu);
      });
      menu.appendChild(el);
    });

    document.body.appendChild(menu);
    const closeMenu = (event) => {
      if (!menu.contains(event.target)) {
        if (document.body.contains(menu)) document.body.removeChild(menu);
        document.removeEventListener('mousedown', closeMenu);
      }
    };
    setTimeout(() => document.addEventListener('mousedown', closeMenu));
  }

  // ─── Multi-select / bulk actions ───

  enterSelectionMode(noteId) {
    this.selectionMode = true;
    this.selectedNoteIds.clear();
    if (noteId) this.selectedNoteIds.add(noteId);
    const bulkBar = document.getElementById('sidebar-bulk-actions');
    if (bulkBar) bulkBar.classList.add('visible');
    this.updateSelectionUI();
    this.renderNotesList();
  }

  exitSelectionMode() {
    this.selectionMode = false;
    this.selectedNoteIds.clear();
    const bulkBar = document.getElementById('sidebar-bulk-actions');
    if (bulkBar) bulkBar.classList.remove('visible');
    this.renderNotesList();
  }

  toggleNoteSelection(noteId) {
    if (this.selectedNoteIds.has(noteId)) this.selectedNoteIds.delete(noteId);
    else this.selectedNoteIds.add(noteId);
    if (this.selectedNoteIds.size === 0) this.exitSelectionMode();
    else this.updateSelectionUI();
  }

  updateSelectionUI() {
    const countEl = document.querySelector('.bulk-actions-count');
    if (countEl) countEl.textContent = `${this.selectedNoteIds.size} selected`;
    document.querySelectorAll('.sidebar-note-item').forEach(el => {
      const id = el.dataset.id;
      const checkbox = el.querySelector('.sidebar-note-checkbox');
      if (checkbox) checkbox.classList.toggle('checked', this.selectedNoteIds.has(id));
    });
  }

  async performBulkAction(action) {
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
      await this.storage.bulkNoteAction(ids, action);
      Utils.showToast(`${ids.length} notes ${action}ed`, 'success');
      this.notes = await this.storage.getAllNotes();
      this.archivedNotes = await this.storage.getArchivedNotes();
      this.trashedNotes = await this.storage.getTrashedNotes();
      this.templates = await this.storage.getTemplates();
      this.exitSelectionMode();
      this.updateBadgeCounts();
    } catch (error) {
      console.error('Bulk action failed:', error);
      Utils.showToast('Bulk action failed', 'error');
    }
  }
}

// Dual export: CommonJS (tests) + browser global
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { SidebarController };
} else if (typeof window !== 'undefined') {
  window.SidebarController = SidebarController;
}
