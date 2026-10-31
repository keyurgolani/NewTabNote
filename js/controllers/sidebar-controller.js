/**
 * SidebarController — manages sidebar UI: note list rendering, folder operations,
 * search filtering, sort modes, view toggling (list/cards), calendar, bulk actions,
 * context menus, and multi-select.
 *
 * @param {Object} deps
 * @param {Object} deps.settings - The page's settings port (js/kernel/composition/settings.js),
 *   which its preferences are read and saved through
 * @param {DomRefs} deps.domRefs
 * @param {Logger} deps.logger
 * @param {Object} [deps.documentClient] - What the sidebar's note writes go through
 *   (js/kernel/composition/document.js): new notes, the Daily Note, pins, a dropped block's
 *   append, folders, and moving a note into one, as kernel commands. The note list shows each
 *   one from the commit feed, with no refresh.
 * @param {{missingStores: readonly string[]}} deps.storageState - What the page knows of its
 *   database outside the kernel (js/kernel/composition/newtab.js): the stores it lacks
 */
class SidebarController {
  constructor({ settings, domRefs, logger, documentClient = null, storageState }) {
    /** @type {any} The page's settings port (js/kernel/composition/settings.js), which its preferences are read and saved through */
    this.settings = settings;
    /** @type {{missingStores: readonly string[]}} The stores the page's database lacks, read when asked */
    this.storageState = storageState;
    this.domRefs = domRefs;
    this.logger = logger;
    this.documentClient = documentClient;

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

    // The tab's note list (js/kernel/core/application/note-list.js), set by App: the lists
    // below read it, and each change to it renders the sidebar once
    /** @type {any} */
    this._noteList = null;
    /** @type {(() => void) | null} */
    this._unsubscribeNoteList = null;
    // How many changes the sidebar has rendered, so a reload that changed nothing still renders
    this._listRenders = 0;
    // Whether the list has rendered at all since the page started
    this.listRendered = false;

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
    /**
     * removeNotes (js/kernel/composition/removal.js), set by App: Empty trash, trash retention,
     * and bulk actions take notes out of the active set through it
     * @type {any}
     */
    this.removal = null;
  }

  /**
   * The note list the sidebar lists. Setting it subscribes the sidebar to its changes.
   * @returns {any}
   */
  get noteList() {
    return this._noteList;
  }

  set noteList(list) {
    if (this._unsubscribeNoteList) this._unsubscribeNoteList();
    this._noteList = list;
    this._unsubscribeNoteList = list ? list.subscribe((change) => this._onNoteListChanged(change)) : null;
  }

  /**
   * The lists the sidebar shows, from the note list. Each is frozen: nothing here changes a
   * note or folder it lists.
   * @returns {ReadonlyArray<any>}
   */
  get notes() {
    return this._noteList ? this._noteList.view('active') : [];
  }

  /** @returns {ReadonlyArray<any>} */
  get archivedNotes() {
    return this._noteList ? this._noteList.view('archived') : [];
  }

  /** @returns {ReadonlyArray<any>} */
  get trashedNotes() {
    return this._noteList ? this._noteList.view('trashed') : [];
  }

  /** @returns {ReadonlyArray<any>} */
  get templates() {
    return this._noteList ? this._noteList.view('templates') : [];
  }

  /** @returns {ReadonlyArray<any>} */
  get folders() {
    return this._noteList ? this._noteList.folders() : [];
  }

  /**
   * Each note's search entry, by note id
   * @returns {{get(noteId: string): any, has(noteId: string): boolean}}
   */
  get searchIndexByNoteId() {
    const list = this._noteList;
    const entry = (noteId) => (list ? list.searchEntry(noteId) : undefined);
    return { get: entry, has: (noteId) => entry(noteId) !== undefined };
  }

  /**
   * The note list changed: the counts, the list, the calendar, and the view tabs render once,
   * and a long flat list keeps its virtual scroller and scroll position. Search entries the
   * indexer wrote change nothing shown until the next render, as before.
   * @param {{reason: 'reload' | 'commit' | 'search'}} change
   * @returns {Promise<void>}
   */
  async _onNoteListChanged(change) {
    if (change.reason === 'search') return;
    this._listRenders += 1;
    await this._renderLists();
  }

  /** @returns {Promise<void>} */
  async _renderLists() {
    this.updateBadgeCounts();
    await this.renderNotesList();
    this.renderCalendar();
    this.updateSidebarTabs();
  }

  /**
   * Read the note lists again and render them, as a refresh always rendered, even when the
   * read found nothing new. With `resetScroller`, as the sidebar's own refresh did, the
   * virtual scroller starts over; App's refresh keeps it.
   * @param {{resetScroller?: boolean}} [options]
   * @returns {Promise<void>}
   */
  async reloadLists({ resetScroller = false } = {}) {
    if (resetScroller) this._destroyVirtualScroller();
    const rendered = this._listRenders;
    await this._noteList.reload();
    if (this._listRenders === rendered) await this._renderLists();
  }

  /** Initialize sidebar: load persisted state, wire DOM listeners. */
  async init() {
    // Each as stored, or its default where nothing is or the read fails
    const stored = await this.settings.preferencesOr({
      sidebarOpen: true,
      sidebarWidth: 260,
      sidebarSortMode: 'updated',
      sidebarViewMode: 'list',
    });
    this.sidebarOpen = stored.sidebarOpen;
    this.sidebarWidth = stored.sidebarWidth;
    this.sidebarSortMode = stored.sidebarSortMode;
    this.sidebarViewMode = stored.sidebarViewMode;

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
    // Trash retention runs from App.init once the tabs are ready, so this tab's panes move off what it deletes
  }

  /** Tear down listeners and resizer. */
  destroy() {
    this.noteList = null;
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
        const noteId = await this.ensureDailyNote();
        if (noteId && this.onOpenNoteInNewTab) await this.onOpenNoteInNewTab(noteId);
      });
    }

    if (newFolderBtn) {
      newFolderBtn.addEventListener('click', async () => {
        const name = await promptDialog({ title: 'New Folder', message: 'Folder name:', defaultValue: 'New Folder' });
        if (name) {
          const outcome = await this.documentClient.createFolder(this.documentClient.newId(), name, null);
          await this._filed(outcome, 'Failed to create folder');
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
        await this.settings.setPreferences({ sidebarSortMode: this.sidebarSortMode });
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
      const now = Date.now();
      // The note and its block land together, under ids taken now
      const blockData = {
        id: this.documentClient.newId(),
        type: blockType,
        content: htmlContent || textContent || '',
        order: 0,
        createdAt: now,
        updatedAt: now,
        indentLevel: 0,
        checked: false,
      };
      const noteId = await this.createNote({ name: title, blocks: [blockData] });
      if (!noteId) return;
      if (this.onOpenNoteInNewTab) await this.onOpenNoteInNewTab(noteId);
      Utils.showToast('Note created from block', 'success');
    } catch (error) {
      console.error('Failed to create note from block:', error);
      Utils.showToast('Failed to create note', 'error');
    }
  }

  /**
   * After one of the sidebar's note writes through the kernel: once it committed, the note
   * list has it, from the commit feed, and the sidebar has rendered it. One that didn't
   * commit is logged by its outcome's kind and code, never the note's content, and its toast
   * says `action` failed and why (Utils.writeFailureMessage).
   * @param {{kind: string, reason?: string, code?: string}} outcome
   * @param {string} action - such as "Failed to pin note"
   * @param {string} [gone] - what a note deleted elsewhere reads as
   * @returns {Promise<boolean>} whether it committed
   */
  async _noteWriteDone(outcome, action, gone) {
    if (outcome.kind !== 'committed') {
      console.error(`${action}:`, outcome.kind, outcome.code);
      Utils.showToast(Utils.writeFailureMessage(action, outcome, gone), 'error');
      return false;
    }
    if (this._noteList) await this._noteList.settled();
    return true;
  }

  /**
   * A new note through the kernel's createNote, under an id taken now, with its first blocks
   * and its folder in one unit
   * @param {{name: string, blocks?: Array<Object>, folderId?: string}} fields
   * @returns {Promise<string|null>} its id, or null when it wasn't stored
   */
  async createNote(fields) {
    const noteId = this.documentClient.newId();
    const outcome = await this.documentClient.createNote({ ...fields, noteId });
    return (await this._noteWriteDone(outcome, 'Failed to create note')) ? noteId : null;
  }

  /**
   * The Daily Note for `dateStr`, or today's: the kernel's ensureDailyNote makes it whole in
   * one unit when there's none, so two clicks at once make one, and findDailyNote reads it,
   * whether it was made or found
   * @param {string} [dateStr] - `YYYY-MM-DD`
   * @returns {Promise<string|null>} its id, or null when it couldn't be found or made
   */
  async ensureDailyNote(dateStr) {
    const action = 'Failed to open the Daily Note';
    const { outcome, note } = await this.documentClient.ensureDailyNote(dateStr);
    if (!(await this._noteWriteDone(outcome, action))) return null;
    if (note) return note.id;
    console.error(`${action}:`, 'not-read');
    Utils.showToast(Utils.writeFailureMessage(action, { kind: 'failed' }), 'error');
    return null;
  }

  /**
   * Append block content to an existing note, with the kernel's insertBlocks: the block goes
   * after the note's last one, and the note's updatedAt, preview, and todo progress follow, in
   * one unit that writes no other field of the note. The list shows it from the commit feed.
   * @param {string} noteId - Target note ID
   * @param {string} blockType - Block type
   * @param {string} htmlContent - HTML content
   */
  async _appendBlockToNote(noteId, blockType, htmlContent) {
    try {
      const blockData = {
        id: this.documentClient.newId(),
        type: blockType,
        content: htmlContent || '',
        indentLevel: 0,
        checked: false,
      };
      const outcome = await this.documentClient.insertBlocks(noteId, [blockData]);
      if (!(await this._noteWriteDone(outcome, 'Failed to append block', 'that note was deleted'))) return;
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
    await this.settings.setPreferences({ sidebarOpen: this.sidebarOpen });
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
        await this.settings.setPreferences({ sidebarWidth: this.sidebarWidth });
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
      await this.settings.setPreferences({ sidebarViewMode: 'list' });
    });
    cardsBtn.addEventListener('click', async () => {
      this.sidebarViewMode = 'cards';
      this.applySidebarViewMode();
      await this.settings.setPreferences({ sidebarViewMode: 'cards' });
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
      const noteId = await this.ensureDailyNote(dateStr);
      if (noteId && this.onOpenNoteInNewTab) await this.onOpenNoteInNewTab(noteId);
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

    // Measured, so a low note's menu opens above the pointer, inside the window
    Utils.placeMenu(contextMenu, e.clientX, e.clientY);
  }

  // ─── Trash ───

  async emptyTrash() {
    if (this.trashedNotes.length === 0) {
      Utils.showToast('Trash is already empty', 'info');
      return;
    }
    if (!await confirmDialog({ title: 'Empty Trash', message: `Permanently delete ${this.trashedNotes.length} note(s)? This cannot be undone.`, confirmText: 'Delete', danger: true })) return;
    // The notes in the trash as this tab lists them leave first; the kernel deletes what's in
    // the trash as committed, in one transaction
    const noteIds = this.trashedNotes.map((note) => note.id);
    const outcome = await this.removal.removeNotes({ type: 'emptyTrash', noteIds });
    if (!this._done(outcome, 'Failed to empty trash')) return;
    Utils.showToast('Trash emptied', 'success');
  }

  /**
   * Trash retention, once this tab's workspace is ready (App.init): the kernel's
   * runTrashCleanup deletes the notes in the trash longer than trashRetention keeps them, and
   * names them, then panes on them move off, keeping any text they couldn't save with "Save as
   * a new note", and the other new tabs hear of it (removeNotes).
   * @returns {Promise<void>}
   */
  async runTrashCleanup() {
    // Skipped while any store is missing, as it always was: nothing is deleted for good on a
    // database an older build left damaged
    const { missingStores } = this.storageState;
    if (missingStores && missingStores.length > 0) return;
    const outcome = await this.removal.removeNotes({ type: 'runTrashCleanup' });
    if (outcome.kind !== 'committed') {
      this.logger.warn('SidebarController', `Trash cleanup didn't run (${outcome.kind}: ${outcome.code})`);
      return;
    }
    if (outcome.changedIds.length > 0) {
      this.logger.info('SidebarController', `Auto-deleted ${outcome.changedIds.length} expired note(s) from trash`);
    }
  }

  /**
   * Whether a kernel write committed. One that didn't is logged by its outcome's kind and
   * code, never the note's content, and its toast says `action` failed and why
   * (Utils.writeFailureMessage).
   * @param {{kind: string, code?: string, reason?: string}} outcome
   * @param {string} action - such as "Failed to empty trash"
   * @param {{gone?: string, reasons?: Object<string, string>}} [why] - what a gone record and a
   *   refusal's code read as
   * @returns {boolean}
   */
  _done(outcome, action, { gone, reasons } = {}) {
    if (outcome.kind === 'committed') return true;
    console.error(`${action}:`, outcome.kind, outcome.code);
    Utils.showToast(Utils.writeFailureMessage(action, outcome, gone, reasons), 'error');
    return false;
  }

  /**
   * After a filing write (folders, moving a note): once it committed, the note list has it,
   * from the commit feed, and the sidebar has rendered it. One that didn't says `action`
   * failed and why (_done). One refused because a folder or note it named is gone (another tab
   * deleted it) reads the lists again, so the sidebar stops offering what isn't there.
   * @param {{kind: string, code?: string, reason?: string}} outcome
   * @param {string} action
   * @param {{gone?: string, reasons?: Object<string, string>}} [why]
   * @returns {Promise<boolean>} whether it committed
   */
  async _filed(outcome, action, why) {
    if (this._noteList) await this._noteList.settled();
    if (outcome.kind === 'rejected' && outcome.reason === 'not-found') await this.reloadLists();
    return this._done(outcome, action, why);
  }

  /**
   * File a note in a folder, or at the root with null, with the kernel's moveNoteToFolder,
   * which writes its folderId and nothing else. A note the sidebar shows there already is left
   * alone, and a folder deleted since the sidebar showed it is refused.
   * @param {string} noteId
   * @param {string|null} folderId
   * @returns {Promise<void>}
   */
  async moveNoteToFolder(noteId, folderId) {
    const shown = this._noteList ? this._noteList.note(noteId) : undefined;
    if (shown && (shown.folderId || null) === folderId) return;
    const outcome = await this.documentClient.moveNoteToFolder(noteId, folderId);
    await this._filed(outcome, 'Failed to move note');
  }

  /**
   * Put a folder inside another, or at the root with null, with the kernel's moveFolder, which
   * refuses a move into the folder itself or a folder inside it as committed, whatever the
   * sidebar showed
   * @param {string} folderId
   * @param {string|null} parentId
   * @returns {Promise<void>}
   */
  async moveFolder(folderId, parentId) {
    const outcome = await this.documentClient.moveFolder(folderId, parentId);
    await this._filed(outcome, 'Failed to move folder', {
      gone: 'that folder no longer exists',
      reasons: { 'folder-into-itself': "it can't go inside itself" },
    });
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

  /**
   * Read the note lists again, after a write made outside the kernel, and render them with the
   * virtual scroller started over, as this refresh did. Every other reader of the note list
   * sees it too.
   * @returns {Promise<void>}
   */
  async refreshNotesList() {
    await this.reloadLists({ resetScroller: true });
  }

  /**
   * Every note's search entry, read again, as a search reads them
   * @returns {Promise<ReadonlyArray<any>>}
   */
  async refreshSearchIndexEntries() {
    await this._noteList.searchEntriesChanged('all');
    return this._noteList.searchEntries();
  }

  /** @private */
  static get VIRTUAL_SCROLL_THRESHOLD() { return 50; }
  /** @private */
  static get VIRTUAL_SCROLL_ITEM_HEIGHT() { return 68; }

  /**
   * A folder row's arrow and folder icons, packaged markup
   * @private
   */
  static get FOLDER_ICONS() {
    return `<svg class="folder-arrow" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <polyline points="6 9 12 15 18 9"></polyline>
        </svg>
        <svg class="folder-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"></path>
        </svg>`;
  }

  async renderNotesList() {
    const list = document.getElementById('sidebar-notes-list');
    if (!list) return;
    this.listRendered = true;

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
    /** @type {ReadonlyArray<any>} */
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
   * @param {ReadonlyArray<Object>} notes - Flat array of notes to render, which it never changes
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
      // The icons are packaged markup; the name is set as text, so it shows exactly as typed
      header.innerHTML = SidebarController.FOLDER_ICONS;
      const name = document.createElement('span');
      name.className = 'folder-name';
      name.textContent = folder.name;
      header.appendChild(name);

      header.addEventListener('click', async (e) => {
        e.stopPropagation();
        // Shown now, and written as that one field, so a rename made meanwhile stays
        const collapsed = !folderEl.classList.contains('collapsed');
        folderEl.classList.toggle('collapsed', collapsed);
        const outcome = await this.documentClient.setFolderCollapsed(folder.id, collapsed);
        if (this._noteList) await this._noteList.settled();
        if (outcome.kind !== 'committed') {
          // Shown as stored again, with the reason in the log and nothing of the folder's
          console.error('Failed to collapse folder:', outcome.kind, outcome.code);
          folderEl.classList.toggle('collapsed', !collapsed);
        }
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
          await this.moveNoteToFolder(noteId, folder.id);
        } else if (draggedFolderId && draggedFolderId !== folder.id) {
          // The kernel checks the move against the folders as committed too
          if (!this.isChildFolder(draggedFolderId, folder.id) && this.folders.some(f => f.id === draggedFolderId)) {
            await this.moveFolder(draggedFolderId, folder.id);
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
    // What a folder's drop files; the folder's own dragstart doesn't take the drag over
    el.addEventListener('dragstart', (e) => { e.stopPropagation(); e.dataTransfer.setData('noteId', note.id); });

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

  /**
   * Pin a note the list shows unpinned, or unpin one it shows pinned, with the kernel's
   * setPinned, which writes the pin and nothing else, so a save of the open note that's in
   * flight keeps it, whichever commits first
   * @param {string} noteId
   * @returns {Promise<void>}
   */
  async toggleNotePin(noteId) {
    const shown = this._noteList ? this._noteList.note(noteId) : undefined;
    if (!shown) return;
    const pinned = !shown.pinned;
    const outcome = await this.documentClient.setPinned(noteId, pinned);
    if (!(await this._noteWriteDone(outcome, pinned ? 'Failed to pin note' : 'Failed to unpin note'))) return;
    Utils.showToast(pinned ? 'Note pinned' : 'Note unpinned', 'success');
  }

  // ─── Search ───

  async renderSearchResults(list) {
    const searchIndexData = await this.refreshSearchIndexEntries();
    // Fuse.js builds from every entry before the search runs: it loads at the first one (#27 slice 3)
    if (this.searchEngine) await this.searchEngine.updateIndex(searchIndexData);
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

    const items = [
      { label: 'Rename', action: async () => {
        const newName = await promptDialog({ title: 'Rename Folder', message: 'New folder name:', defaultValue: folder.name });
        if (newName && newName !== folder.name) {
          await this._filed(await this.documentClient.renameFolder(folder.id, newName), 'Failed to rename folder', {
            gone: 'that folder no longer exists',
          });
        }
      }},
      { label: 'Delete Folder', action: async () => {
        if (await confirmDialog({ title: 'Delete Folder', message: `Are you sure you want to delete "${folder.name}"? Notes inside will be moved to root.`, confirmText: 'Delete', danger: true })) {
          await this._filed(await this.documentClient.deleteFolder(folder.id), 'Failed to delete folder', {
            gone: 'that folder no longer exists',
          });
        }
      }},
      { label: 'Add Note to Folder', action: async () => {
        // Made in the folder, in the one unit that creates it
        const noteId = await this.createNote({ name: 'New Note', folderId: folder.id });
        if (noteId && this.onOpenNoteInNewTab) this.onOpenNoteInNewTab(noteId);
      }},
      { label: 'Move to Root', action: async () => {
        await this.moveFolder(folder.id, null);
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
    // Measured, so a low folder's menu opens above the pointer, inside the window
    Utils.placeMenu(menu, e.clientX, e.clientY);
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

    // One kernel command per note, through removeNotes, which moves this tab's panes off the
    // notes that trash, archive, and delete take out of the active set. Each note answers on
    // its own, and only the ones that committed count.
    const outcome = await this.removal.removeNotes({ type: 'runBulkAction', action, noteIds: ids });
    const done = SidebarController.bulkDone(action, outcome);
    const gone = SidebarController.bulkGone(action, outcome);
    const message = SidebarController.bulkMessage(action, outcome);
    if (outcome.kind !== 'bulk') {
      console.error('Bulk action failed:', outcome.kind, outcome.code);
    } else if (done.length + gone.length < outcome.items.length) {
      // Codes and ids, never what the notes hold
      const failed = outcome.items.filter((item) => !done.includes(item.id) && !gone.includes(item.id));
      console.error('Bulk action left notes as they were:', failed.map((item) => [item.id, item.outcome.kind, item.outcome.code]));
    }
    Utils.showToast(message.text, message.kind);
    if (outcome.kind !== 'bulk') return;
    // Only the notes it couldn't change stay selected, so the user can try them again: not the
    // ones another tab deleted, which no try changes
    for (const id of [...done, ...gone]) this.selectedNoteIds.delete(id);
    if (this.selectedNoteIds.size === 0) this.exitSelectionMode();
    else this.updateSelectionUI();
  }

  /**
   * The notes a bulk action is done with: the ones it committed, and, for a trash or a delete,
   * the ones another tab already deleted, which are gone either way, as a single trash or delete
   * counts them (NotesManager._removed). An archive, restore, or unarchive of a deleted note
   * didn't happen, so it counts as one it couldn't change.
   * @param {string} action
   * @param {{kind: string, items?: Array<{id: string, outcome: {kind: string, reason?: string}}>}} outcome
   * @returns {Array<string>}
   */
  static bulkDone(action, outcome) {
    if (outcome.kind !== 'bulk') return [];
    const goneIsDone = action === 'trash' || action === 'delete';
    return outcome.items
      .filter(({ outcome: item }) => item.kind === 'committed'
        || (goneIsDone && item.kind === 'rejected' && item.reason === 'not-found'))
      .map((item) => item.id);
  }

  /**
   * The notes an archive, restore, or unarchive found deleted, by another tab: no try can
   * change them, so they leave the selection, and the toast counts them apart. A trash or a
   * delete counts them as done (bulkDone).
   * @param {string} action
   * @param {{kind: string, items?: Array<{id: string, outcome: {kind: string, reason?: string}}>}} outcome
   * @returns {Array<string>}
   */
  static bulkGone(action, outcome) {
    if (outcome.kind !== 'bulk' || action === 'trash' || action === 'delete') return [];
    return outcome.items
      .filter(({ outcome: item }) => item.kind === 'rejected' && item.reason === 'not-found')
      .map((item) => item.id);
  }

  /**
   * What a bulk action's toast says, one pattern for every action: how many notes it changed,
   * or how many of them it couldn't, which stay selected, and how many another tab deleted
   * @param {string} action
   * @param {{kind: string, items?: Array<Object>}} outcome
   * @returns {{text: string, kind: 'success' | 'error'}}
   */
  static bulkMessage(action, outcome) {
    const copy = SidebarController.BULK_COPY[action];
    if (outcome.kind !== 'bulk') {
      return { text: Utils.writeFailureMessage(copy.failed, outcome), kind: 'error' };
    }
    const total = outcome.items.length;
    const done = SidebarController.bulkDone(action, outcome).length;
    const gone = SidebarController.bulkGone(action, outcome).length;
    const failed = total - done - gone;
    const notes = (n) => `${n} ${n === 1 ? 'note' : 'notes'}`;
    const were = (n) => (n === 1 ? 'was' : 'were');
    if (gone === total) {
      // Every one is deleted, said as one note's write says it (Utils.writeFailureMessage)
      const deleted = outcome.items[0].outcome;
      const text = total === 1
        ? Utils.writeFailureMessage(copy.failedOne, deleted)
        : Utils.writeFailureMessage(copy.failed, deleted, 'they were deleted');
      return { text, kind: 'error' };
    }
    if (failed === 0 && gone === 0) return { text: `${notes(total)} ${copy.done}`, kind: 'success' };
    if (failed === 0) return { text: `${done} of ${notes(total)} ${copy.done}. ${gone} ${were(gone)} deleted.`, kind: 'success' };
    const still = failed === 1 ? "It's still selected." : "They're still selected.";
    if (total === 1) return { text: `The note couldn't be ${copy.undone}. ${still}`, kind: 'error' };
    const others = gone === 0 ? '' : ` ${gone} ${gone === 1 ? 'other' : 'others'} ${were(gone)} deleted.`;
    return { text: `${failed} of ${total} notes couldn't be ${copy.undone}. ${still}${others}`, kind: 'error' };
  }

  /**
   * What each bulk action did to a note, what it couldn't, and what it says when it never ran,
   * or found the one note it ran on deleted (failedOne)
   * @private
   */
  static get BULK_COPY() {
    return {
      archive: { done: 'archived', undone: 'archived', failed: 'Failed to archive notes', failedOne: 'Failed to archive note' },
      unarchive: {
        done: 'restored from Archive',
        undone: 'restored from Archive',
        failed: 'Failed to restore notes from Archive',
        failedOne: 'Failed to restore note from Archive',
      },
      trash: { done: 'moved to Trash', undone: 'moved to Trash', failed: 'Failed to move notes to Trash' },
      restore: {
        done: 'restored from Trash',
        undone: 'restored from Trash',
        failed: 'Failed to restore notes from Trash',
        failedOne: 'Failed to restore note from Trash',
      },
      delete: { done: 'permanently deleted', undone: 'permanently deleted', failed: 'Failed to permanently delete notes' },
    };
  }
}

// Dual export: CommonJS (tests) + browser global
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { SidebarController };
} else if (typeof window !== 'undefined') {
  window.SidebarController = SidebarController;
}
